'use strict';
// Alerts via iMessage (Messages.app driven by osascript). Falls back to logging on non-macOS
// or when alerts are disabled. Each alert kind can be deduplicated for a period.
const path = require('path');
const config = require('./config');
const ffmpeg = require('./ffmpeg');
const log = require('./log');

const SCRIPT = path.join(config.APP_DIR, 'scripts', 'alert.applescript');
const recent = new Map();  // dedupeKey -> ts
const history = [];        // last 50 alerts for the UI

function record(entry) {
  history.push(entry);
  if (history.length > 50) history.shift();
}

// Returns { sent, reason }.
async function send(text, { dedupeKey = null, dedupeMs = 0, force = false } = {}) {
  const s = config.get().alerts || {};
  const entry = { t: new Date().toISOString(), text, sent: false, reason: null };
  if (dedupeKey && dedupeMs > 0) {
    const last = recent.get(dedupeKey) || 0;
    if (Date.now() - last < dedupeMs) { entry.reason = 'deduplicated'; record(entry); return entry; }
    recent.set(dedupeKey, Date.now());
  }
  if (!force && !s.enabled) { entry.reason = 'alerts disabled'; log.info('ALERT (disabled):', text); record(entry); return entry; }
  if (!s.imessageTo) { entry.reason = 'no iMessage recipient configured'; log.warn('ALERT (no recipient):', text); record(entry); return entry; }
  if (process.platform !== 'darwin') { entry.reason = 'osascript unavailable (not macOS)'; log.info('ALERT (not macOS):', text); record(entry); return entry; }
  const r = await ffmpeg.run('osascript', [SCRIPT, s.imessageTo, text], { timeoutMs: 30000 });
  if (r.code === 0) {
    entry.sent = true;
    log.info('ALERT sent to', s.imessageTo, ':', text);
  } else {
    entry.reason = `osascript failed: ${(r.stderrTail || '').split('\n').pop() || r.code}`;
    log.error('ALERT failed:', entry.reason);
  }
  record(entry);
  return entry;
}

function recentAlerts() { return history.slice().reverse(); }

module.exports = { send, recentAlerts };
