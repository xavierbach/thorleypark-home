'use strict';
// Keep the Mac awake while a job is capturing or finishing, using `caffeinate -i -s -w <pid>`.
// -i prevents idle sleep, -s prevents system sleep while on AC power. Lid-close sleep is not covered.
const { spawn } = require('child_process');
const log = require('./log');

let child = null;
let wanted = false;

function setActive(active) {
  wanted = !!active;
  if (process.platform !== 'darwin') return;
  if (wanted && !child) {
    try {
      child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
      child.on('exit', () => { child = null; });
      log.info('caffeinate started');
    } catch (e) {
      log.warn('caffeinate failed to start:', e.message);
      child = null;
    }
  } else if (!wanted && child) {
    try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    child = null;
    log.info('caffeinate stopped');
  }
}

function isActive() { return !!child; }
function stop() { setActive(false); }

module.exports = { setActive, isActive, stop, wanted: () => wanted };
