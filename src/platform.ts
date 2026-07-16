import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import rfxcom from 'rfxcom';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { ShutterAccessory } from './accessories/shutterAccessory';

/**
 * Outcome of an RFY command, as reported by the RFXtrx:
 * - 'ack': the box confirmed the radio transmission;
 * - 'ambiguous': no confirmation arrived (the frame may or may not have aired) —
 *   callers must NEVER blind-retry on this (a duplicate "stop" on a motor that DID
 *   receive the first one would trigger its "my" favourite-position move);
 * - 'failed': the box refused the command (unknown remote id, NAK): nothing was sent.
 */
export type CommandOutcome = 'ack' | 'ambiguous' | 'failed';

/**
 * One entry of the "shutters" array in config.json.
 */
export interface ShutterConfig {
  name: string;
  /** RFY device id, format "0xAABBCC/unitCode", e.g. "0x0A1B2C/1" */
  deviceId: string;
  /** Swap up/down if the shutter was paired/wired the other way round */
  reversed?: boolean;
  /** Time in seconds for a full close -> open ("up") run */
  openDurationSeconds: number;
  /** Time in seconds for a full open -> close ("down") run */
  closeDurationSeconds: number;
  /** Send a full "down" at Homebridge startup to guarantee a known (closed) position */
  forceCloseAtStartup?: boolean;
  /**
   * For a group accessory (one RFY remote paired on several motors): deviceIds of the
   * member shutters. When the group moves, the members' simulated positions follow
   * (no extra RF), and the group reflects the average of its members.
   */
  members?: string[];
}

export interface SomfyRTSPlatformConfig extends PlatformConfig {
  tty: string;
  debug?: boolean;
  shutters?: ShutterConfig[];
}

export class SomfyRTSShuttersPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public rfxcom?: typeof rfxcom.RfxCom;

  /** Live shutter handlers by deviceId — lets group accessories reach their members. */
  public readonly shutterHandlers: Map<string, ShutterAccessory> = new Map();

  /** Commands awaiting the box's response, keyed by RFXtrx sequence number: used to
   *  attribute responses in the logs and to feed the outcome back to the sender. */
  private readonly pendingCommands: Map<number, {
    shutter: string;
    command: string;
    sentAt: number;
    onResult?: (outcome: CommandOutcome) => void;
  }> = new Map();

  constructor(
    public readonly log: Logger,
    public readonly config: SomfyRTSPlatformConfig,
    public readonly api: API,
  ) {
    // Never throw out of the constructor: an unhandled error here kills the whole
    // (child) bridge. Without a serial port the platform stays idle instead.
    if (!this.config.tty) {
      this.log.error('Missing "tty" in platform config: the plugin will stay idle until it is configured.');
      return;
    }

    try {
      this.rfxcom = new rfxcom.RfxCom(this.config.tty, {
        debug: this.config.debug === true,
      });

      this.rfxcom.on('disconnect', () => this.log.error('ERROR: RFXtrx disconnected'));
      this.rfxcom.on('connectfailed', () =>
        this.log.error(`ERROR: RFXtrx connection failed — check that ${this.config.tty} exists and is not in use`));
      // Without an explicit listener, a serial-port 'error' event would crash the bridge.
      this.rfxcom.on('error', (err: Error) => this.log.error('RFXtrx serial error:', err?.message ?? err));

      // Surface the box's per-command responses. Silent non-ACKs (unknown remote id,
      // NAK, missing acknowledgements) previously made failures invisible: a shutter
      // would simply not move while the plugin believed everything was fine.
      this.rfxcom.on('response', (message: string, seqnbr: number, responseCode: number) => {
        const pending = this.pendingCommands.get(seqnbr);
        this.pendingCommands.delete(seqnbr);
        const origin = pending ? `[${pending.shutter}] RFY "${pending.command}"` : `RFY command (seq ${seqnbr})`;
        let outcome: CommandOutcome;
        if (responseCode === 0 || responseCode === 1) {
          outcome = 'ack';
          this.log.debug(`${origin} → ${message}`);
        } else if (responseCode === 6) {
          outcome = 'ambiguous';
          this.log.warn(`${origin} → no confirmation from the RFXtrx (${message}) — the frame may or may not have been transmitted.`);
        } else {
          outcome = 'failed';
          this.log.warn(`${origin} → NOT transmitted: ${message} (code ${responseCode}) — the motor did not receive this order.`);
        }
        pending?.onResult?.(outcome);
      });

      this.rfxcom.initialise(() => {
        this.log.info('RFXtrx initialised!');
      });
    } catch (err) {
      this.log.error(`Could not open the RFXtrx on ${this.config.tty}:`, (err as Error)?.message ?? err);
      this.rfxcom = undefined;
    }

    this.api.on('didFinishLaunching', () => {
      this.discoverShutters();
      this.cleanStaleAccessories();
    });
  }

  /**
   * Invoked by Homebridge for every accessory restored from its on-disk cache at startup,
   * before didFinishLaunching. We just keep them around so discoverShutters() can match them.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  registerShutterHandler(deviceId: string, handler: ShutterAccessory) {
    this.shutterHandlers.set(deviceId, handler);
  }

  /** Remember which shutter sent the command carrying this sequence number. */
  registerPendingCommand(seqnbr: number, shutter: string, command: string, onResult?: (outcome: CommandOutcome) => void) {
    const now = Date.now();
    for (const [key, value] of this.pendingCommands) {
      if (now - value.sentAt > 60000) {
        this.pendingCommands.delete(key);
      }
    }
    this.pendingCommands.set(seqnbr, { shutter, command, sentAt: now, onResult });
  }

  shutterHandler(deviceId: string): ShutterAccessory | undefined {
    return this.shutterHandlers.get(deviceId);
  }

  /** Called whenever a shutter's simulated state settles, so groups can re-average. */
  notifyShutterSettled(deviceId: string) {
    for (const handler of this.shutterHandlers.values()) {
      handler.refreshFromMembers(deviceId);
    }
  }

  private shutterUuid(shutter: ShutterConfig): string {
    return this.api.hap.uuid.generate(PLATFORM_NAME + shutter.deviceId);
  }

  private discoverShutters() {
    const shutters = this.config.shutters ?? [];

    for (const shutter of shutters) {
      if (!shutter.deviceId || !shutter.name) {
        this.log.warn('Skipping shutter with missing "name" or "deviceId":', JSON.stringify(shutter));
        continue;
      }

      const uuid = this.shutterUuid(shutter);
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

      if (existingAccessory) {
        existingAccessory.context.shutter = shutter;
        new ShutterAccessory(this, existingAccessory);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info('Adding new shutter accessory:', shutter.name);
        const accessory = new this.api.platformAccessory(shutter.name, uuid);
        accessory.context.shutter = shutter;
        new ShutterAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    }
  }

  private cleanStaleAccessories() {
    const configuredUuids = (this.config.shutters ?? []).map((shutter) => this.shutterUuid(shutter));
    const stale = this.accessories.filter((accessory) => !configuredUuids.includes(accessory.UUID));

    if (stale.length > 0) {
      this.log.info('Removing stale accessories no longer present in config:', stale.map((a) => a.displayName));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
