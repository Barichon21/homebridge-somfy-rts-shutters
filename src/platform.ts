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
