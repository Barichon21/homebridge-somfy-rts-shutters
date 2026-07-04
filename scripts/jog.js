#!/usr/bin/env node
'use strict';

// Sends a single RFY command (up / down / stop) for calibration purposes:
// run "up" or "down" with a stopwatch to measure openDurationSeconds /
// closeDurationSeconds for config.json, then "stop" to interrupt it.
//
// Usage:
//   node scripts/jog.js <tty> <deviceId> <up|down|stop|erase>
//   node scripts/jog.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1 down

const rfxcom = require('rfxcom');

const [, , tty, deviceId, command] = process.argv;
const validCommands = ['up', 'down', 'stop', 'erase'];

if (!tty || !deviceId || !validCommands.includes(command)) {
  console.error('Usage: node scripts/jog.js <tty> <deviceId> <up|down|stop|erase>');
  console.error('Example: node scripts/jog.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1 down');
  process.exit(1);
}

const conn = new rfxcom.RfxCom(tty, { debug: false });
const rfy = new rfxcom.Rfy(conn, rfxcom.rfy.RFY);

conn.on('connectfailed', () => {
  console.error('Could not open the RFXtrx on', tty);
  process.exit(1);
});

conn.initialise(() => {
  console.log(`Sending "${command}" to ${deviceId}...`);
  if (command === 'erase') {
    rfy.erase(deviceId, done);
  } else {
    rfy.doCommand(deviceId, command, done);
  }

  function done() {
    console.log('Sent.');
    conn.close();
    process.exit(0);
  }
});
