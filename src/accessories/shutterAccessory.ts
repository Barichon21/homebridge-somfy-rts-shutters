import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
} from 'homebridge';
import rfxcom from 'rfxcom';

import { SomfyRTSShuttersPlatform, ShutterConfig } from '../platform';

type RtsDirection = 'up' | 'down';

interface PersistedState {
  currentPosition: number;
  targetPosition: number;
  positionState: number;
}

/**
 * Somfy RTS motors have no position feedback: the RFXtrx can only fire and forget
 * "up" / "down" / "stop" commands. This accessory simulates an absolute position by
 * timing how long a move has been running for and comparing that to the calibrated
 * openDurationSeconds/closeDurationSeconds for the shutter, then stopping the motor
 * once the estimated position matches the target requested from HomeKit.
 *
 * The simulated position is saved into accessory.context so it survives a Homebridge
 * restart. It is only ever a best guess: if the motor is also driven by its original
 * RTS remote outside of Homebridge, the simulated position will drift from reality
 * until forceCloseAtStartup (or a manual full open/close) re-syncs it.
 */
export class ShutterAccessory {
  private readonly service: Service;
  private readonly rfy?: typeof rfxcom.Rfy;
  private readonly shutter: ShutterConfig;
  /** False when deviceId is malformed or the RFXtrx is unavailable: the accessory
   *  stays visible in HomeKit but commands become no-ops instead of crashing. */
  private readonly operational: boolean;

  private state: PersistedState;

  private moveTimeout?: ReturnType<typeof setTimeout>;
  private moveStartedAt = 0;
  private moveStartPosition = 0;
  /** Logical direction of the move: true = position increasing (opening). With
   *  `reversed` the RTS command sent may be the opposite one, so position
   *  estimation must never be derived from the command direction. */
  private moveIncreasing: boolean | null = null;
  private moveFullDurationSeconds = 0;

  constructor(
    private readonly platform: SomfyRTSShuttersPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.shutter = accessory.context.shutter as ShutterConfig;

    this.state = (accessory.context.state as PersistedState) ?? {
      currentPosition: 0,
      targetPosition: 0,
      positionState: this.platform.Characteristic.PositionState.STOPPED,
    };

    // Reconcile a state persisted in the middle of a move (Homebridge restarted while
    // a shutter was running): the timers are gone, but an RTS motor keeps running
    // until its end limit once commanded, so the best estimate is the extreme in the
    // direction of travel. Without this, HomeKit shows "Opening…" forever.
    const { INCREASING, DECREASING, STOPPED } = this.platform.Characteristic.PositionState;
    if (this.state.positionState !== STOPPED || this.state.targetPosition !== this.state.currentPosition) {
      const assumed =
        this.state.positionState === INCREASING ? 100 :
        this.state.positionState === DECREASING ? 0 :
        this.state.currentPosition;
      this.platform.log.warn(
        `[${this.shutter.name}] Restored a mid-move state (restart during a run): assuming the motor ` +
        `finished its travel at ${assumed}%.`,
      );
      this.state.currentPosition = assumed;
      this.state.targetPosition = assumed;
      this.state.positionState = STOPPED;
    }

    accessory.context.state = this.state;

    // Register even when not operational, so group membership stays resolvable.
    this.platform.registerShutterHandler(this.shutter.deviceId, this);

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(this.platform.Characteristic.Model, 'RTS (via RFXCOM RFY)')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.shutter.deviceId);

    this.service =
      this.accessory.getService(this.platform.Service.WindowCovering) ||
      this.accessory.addService(this.platform.Service.WindowCovering);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.shutter.name);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, this.state.currentPosition));

    this.service
      .getCharacteristic(this.platform.Characteristic.PositionState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, this.state.positionState));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, this.state.targetPosition))
      .on('set', this.setTargetPosition.bind(this));

    // Optional characteristic of WindowCovering: lets automations / the Eve app send
    // an explicit STOP mid-move (stock Home app does not expose a stop button).
    this.service
      .getCharacteristic(this.platform.Characteristic.HoldPosition)
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        if (value) {
          this.stopMovement();
        }
        callback();
      });

    const deviceIdOk = ShutterAccessory.isValidDeviceId(this.shutter.deviceId);
    if (!deviceIdOk) {
      this.platform.log.error(
        `[${this.shutter.name}] Invalid deviceId "${this.shutter.deviceId}" — expected 0xID/unitCode with ` +
        'ID between 0x00001 and 0xFFFFF and unitCode between 0 and 4 (RFY). Commands for this shutter are disabled.',
      );
    }
    this.operational = deviceIdOk && this.platform.rfxcom !== undefined;

    if (!this.operational) {
      this.syncCharacteristics();
      return;
    }

    this.rfy = new rfxcom.Rfy(this.platform.rfxcom, rfxcom.rfy.RFY);

    this.platform.rfxcom.on('ready', () => {
      if (this.shutter.forceCloseAtStartup) {
        // The command that physically closes this shutter ("down", unless reversed).
        const closeCommand: RtsDirection = this.shutter.reversed ? 'up' : 'down';
        this.platform.log.info(`[${this.shutter.name}] forceCloseAtStartup: sending full "${closeCommand}" (close)`);
        this.sendCommand(closeCommand);
        this.moveIncreasing = false;
        this.moveStartedAt = Date.now();
        // Real position is unknown (that is the point of the forced close): assume the
        // worst case, a full run from 100%, so the estimate stays coherent if interrupted.
        this.moveStartPosition = 100;
        this.state.currentPosition = 100;
        this.state.targetPosition = 0;
        this.moveFullDurationSeconds = this.shutter.closeDurationSeconds;
        this.setPositionState(this.platform.Characteristic.PositionState.DECREASING);
        this.scheduleStop(this.shutter.closeDurationSeconds * 1000, 0);
        this.syncCharacteristics();
      }
    });

    this.syncCharacteristics();
  }

  private setTargetPosition(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const target = Math.max(0, Math.min(100, +value));
    this.platform.log.debug(`[${this.shutter.name}] SET TargetPosition: ${target}`);

    if (!this.operational) {
      this.platform.log.warn(`[${this.shutter.name}] Ignoring TargetPosition ${target}: shutter is not operational (bad deviceId or RFXtrx unavailable).`);
      this.state.targetPosition = this.state.currentPosition;
      this.syncCharacteristics();
      return callback();
    }

    const isGroup = (this.shutter.members?.length ?? 0) > 0;
    const fullRun = target === 0 || target === 100;

    if (isGroup && !fullRun) {
      // Intermediate group target: one shared RF frame + one shared stop cannot land
      // members that start from different positions on the same percentage (motors all
      // run for the same time). Dispatch individually instead: each member emits its
      // own command and its own timed stop, so every one truly reaches the target.
      // The group accessory only simulates (no RF) and re-averages as members settle.
      this.startSimulatedMove(target, false);
      this.forEachMember((member) => member.moveTo(target));
    } else {
      // Full runs (and non-group shutters): end limits make a single frame exact for
      // every member regardless of starting position — keep the synchronized ballet.
      this.startSimulatedMove(target, true);
      this.forEachMember((member) => member.followMove(target));
    }

    callback();
  }

  /**
   * Group support: individually dispatched move — the member emits its own RF command
   * and timed stop, so it genuinely reaches the requested position.
   */
  moveTo(target: number) {
    if (!this.operational) {
      this.platform.log.warn(`[${this.shutter.name}] Ignoring group-dispatched move to ${target}%: shutter is not operational.`);
      return;
    }
    this.platform.log.debug(`[${this.shutter.name}] Group-dispatched move to ${target}%`);
    this.startSimulatedMove(target, true);
  }

  /**
   * Group support: mirror a movement commanded through a group remote. Updates this
   * shutter's simulated position with its own calibrated timings, without emitting RF.
   */
  followMove(target: number) {
    this.platform.log.debug(`[${this.shutter.name}] Following group move to ${target}%`);
    this.startSimulatedMove(target, false);
  }

  /** Group support: mirror a HoldPosition/stop issued through a group remote. */
  followStop() {
    if (!this.moveTimeout) {
      return;
    }
    clearTimeout(this.moveTimeout);
    this.moveTimeout = undefined;
    this.state.currentPosition = this.estimateCurrentPosition();
    this.state.targetPosition = this.state.currentPosition;
    this.moveIncreasing = null;
    this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
    this.syncCharacteristics(true);
  }

  /**
   * Group support: when a member's state settles, a group accessory refreshes its own
   * position to the average of its members (only while the group itself is idle).
   */
  refreshFromMembers(settledDeviceId: string) {
    const members = this.shutter.members ?? [];
    if (!members.includes(settledDeviceId) || this.moveTimeout) {
      return;
    }
    const positions = members
      .map((id) => this.platform.shutterHandler(id)?.simulatedPosition)
      .filter((p): p is number => typeof p === 'number');
    if (positions.length === 0) {
      return;
    }
    const average = Math.round(positions.reduce((a, b) => a + b, 0) / positions.length);
    if (average === this.state.currentPosition && average === this.state.targetPosition) {
      return;
    }
    this.state.currentPosition = average;
    this.state.targetPosition = average;
    this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
    this.syncCharacteristics(true);
  }

  get simulatedPosition(): number {
    return this.state.currentPosition;
  }

  private forEachMember(fn: (member: ShutterAccessory) => void) {
    for (const id of this.shutter.members ?? []) {
      const member = this.platform.shutterHandler(id);
      if (member && member !== this) {
        fn(member);
      } else if (!member) {
        this.platform.log.warn(`[${this.shutter.name}] Unknown group member deviceId "${id}" — check the "members" list.`);
      }
    }
  }

  /** Shared movement engine; emitRf=false when mirroring a group command. */
  private startSimulatedMove(target: number, emitRf: boolean) {
    // If a move is already in progress, fold its elapsed progress into currentPosition
    // before computing the new one, instead of trusting the stale snapshot.
    const wasMoving = this.moveTimeout !== undefined;
    if (this.moveTimeout) {
      this.state.currentPosition = this.estimateCurrentPosition();
      clearTimeout(this.moveTimeout);
      this.moveTimeout = undefined;
    }

    this.state.targetPosition = target;

    if (this.state.currentPosition === target) {
      // The motor may still be physically running (target caught up with the
      // estimated position mid-move): it must be stopped explicitly.
      if (wasMoving && emitRf) {
        this.sendCommand('stop');
      }
      this.moveIncreasing = null;
      this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
      this.syncCharacteristics(wasMoving);
      return;
    }

    // Logical travel (position increasing = opening) drives the duration and the
    // HomeKit PositionState; the RTS command only depends on it and on `reversed`.
    const increasing = target > this.state.currentPosition;
    const command: RtsDirection = increasing !== !!this.shutter.reversed ? 'up' : 'down';
    const fullDurationSeconds =
      increasing ? this.shutter.openDurationSeconds : this.shutter.closeDurationSeconds;

    this.setPositionState(
      increasing
        ? this.platform.Characteristic.PositionState.INCREASING
        : this.platform.Characteristic.PositionState.DECREASING,
    );

    if (emitRf) {
      this.sendCommand(command);
    }

    this.moveIncreasing = increasing;
    this.moveStartedAt = Date.now();
    this.moveStartPosition = this.state.currentPosition;
    this.moveFullDurationSeconds = fullDurationSeconds;

    const deltaPercent = Math.abs(target - this.state.currentPosition);
    const moveDurationMs = Math.round((fullDurationSeconds * 1000 * deltaPercent) / 100);

    // Somfy RTS motors have their own end-of-travel limit switches, so when the
    // target is a full open/close we don't need to (and shouldn't) send an explicit
    // "stop": we just let the full run finish and mark the state as STOPPED for HomeKit.
    const sendStopCommand = emitRf && target !== 0 && target !== 100;
    this.scheduleStop(moveDurationMs, target, sendStopCommand);

    this.syncCharacteristics();
  }

  private scheduleStop(delayMs: number, finalPosition: number, sendStopCommand = false) {
    this.moveTimeout = setTimeout(() => {
      if (sendStopCommand) {
        this.sendCommand('stop');
      }
      this.state.currentPosition = finalPosition;
      this.moveTimeout = undefined;
      this.moveIncreasing = null;
      this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
      this.syncCharacteristics(true);
    }, delayMs);
  }

  get isMoving(): boolean {
    return this.moveTimeout !== undefined;
  }

  private stopMovement() {
    // For a group, members may be moving (individually dispatched) even when the
    // group's own simulation is idle. Never send a stop when nothing moves at all:
    // a stray RTS "stop" frame on an idle motor triggers its "my" favourite move.
    const anyMemberMoving = (this.shutter.members ?? [])
      .some((id) => this.platform.shutterHandler(id)?.isMoving === true);
    if (!this.moveTimeout && !anyMemberMoving) {
      return;
    }
    if (this.moveTimeout) {
      clearTimeout(this.moveTimeout);
      this.moveTimeout = undefined;
      this.state.currentPosition = this.estimateCurrentPosition();
    }
    this.sendCommand('stop');
    this.state.targetPosition = this.state.currentPosition;
    this.moveIncreasing = null;
    this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
    this.syncCharacteristics(true);

    // Freeze member simulations too — this also cancels their pending timed stops
    // (which would otherwise land on stopped motors and trigger "my" moves).
    this.forEachMember((member) => member.followStop());
  }

  private estimateCurrentPosition(): number {
    if (this.moveIncreasing === null || this.moveFullDurationSeconds <= 0) {
      return this.state.currentPosition;
    }
    const elapsedSeconds = (Date.now() - this.moveStartedAt) / 1000;
    const deltaPercent = (elapsedSeconds / this.moveFullDurationSeconds) * 100;
    const signedDelta = this.moveIncreasing ? deltaPercent : -deltaPercent;
    return Math.max(0, Math.min(100, Math.round(this.moveStartPosition + signedDelta)));
  }

  /** deviceId format: 0xID/unitCode — ID 0x00001-0xFFFFF, unitCode 0-4 (RFY subtype). */
  private static isValidDeviceId(deviceId: string): boolean {
    const match = /^0x([0-9A-Fa-f]{1,5})\/([0-9]{1,2})$/.exec(deviceId ?? '');
    if (!match) {
      return false;
    }
    const id = parseInt(match[1], 16);
    const unitCode = parseInt(match[2], 10);
    return id >= 0x00001 && id <= 0xfffff && unitCode >= 0 && unitCode <= 4;
  }

  private sendCommand(command: RtsDirection | 'stop') {
    if (!this.operational || !this.rfy) {
      this.platform.log.warn(`[${this.shutter.name}] Ignoring "${command}": shutter is not operational (bad deviceId or RFXtrx unavailable).`);
      return;
    }
    this.platform.log.debug(`[${this.shutter.name}] RFY command: ${command} (${this.shutter.deviceId})`);
    try {
      this.rfy.doCommand(this.shutter.deviceId, command);
    } catch (err) {
      this.platform.log.error(`[${this.shutter.name}] RFY command "${command}" failed:`, (err as Error)?.message ?? err);
    }
  }

  private setPositionState(state: number) {
    this.state.positionState = state;
  }

  private syncCharacteristics(persist = false) {
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.state.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.state.currentPosition);

    if (persist) {
      this.accessory.context.state = this.state;
      this.platform.api.updatePlatformAccessories([this.accessory]);
      // Settled state: let group accessories re-average their members.
      this.platform.notifyShutterSettled(this.shutter.deviceId);
    }
  }
}
