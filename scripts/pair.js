#!/usr/bin/env node
'use strict';

// Standalone Somfy RTS pairing helper — does NOT require Homebridge.
// Useful on macOS/Linux where the official RFXmngr tool (Windows-only) is not available.
//
// Usage:
//   node scripts/pair.js <tty> <deviceId>
//   node scripts/pair.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1
//
// deviceId is a code YOU choose (format 0xAABBCC/unitCode, unitCode 1-4).
// Pick a distinct one per shutter and reuse it in config.json.

const readline = require('readline');
const rfxcom = require('rfxcom');

const [, , tty, deviceId] = process.argv;

if (!tty || !deviceId) {
  console.error('Usage: node scripts/pair.js <tty> <deviceId>');
  console.error('Example: node scripts/pair.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const conn = new rfxcom.RfxCom(tty, { debug: true });
const rfy = new rfxcom.Rfy(conn, rfxcom.rfy.RFY);

conn.on('connectfailed', () => {
  console.error('Could not open the RFXtrx on', tty);
  process.exit(1);
});

conn.initialise(() => {
  console.log('RFXtrx ready.\n');
  console.log('Somfy RTS pairing procedure for deviceId', deviceId + ':');
  console.log('  1. Take a remote that is ALREADY paired with this shutter\'s motor.');
  console.log('  2. Press and hold its PROG button (~2s) until the shutter jogs up/down briefly.');
  console.log('     -> The motor is now in pairing mode for the next 2 minutes.');
  console.log('  3. Come back here and press Enter. This sends the PROG command for', deviceId + '.');
  console.log('  4. The shutter should jog again: pairing succeeded, deviceId is now valid to use in config.json.\n');

  rl.question('Press Enter once the motor is in pairing mode (step 2 done)... ', () => {
    rfy.program(deviceId, () => {
      console.log('\nPROGRAM command sent for', deviceId + '.');
      console.log('If the shutter jogged, pairing worked. If not, retry from step 1 (the 2 minute window may have expired).');
      rl.close();
      conn.close();
      process.exit(0);
    });
  });
});
