'use strict';
// Free disk space for the data dir via `df -k` (works on macOS and Linux), cached for 60 s.
const { execFile } = require('child_process');
const config = require('./config');

let cache = { ts: 0, freeBytes: null, totalBytes: null, error: null };
const TTL = 60 * 1000;

function query(dir) {
  return new Promise((resolve) => {
    execFile('df', ['-k', dir], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ freeBytes: null, totalBytes: null, error: err.message });
      const lines = stdout.trim().split('\n');
      const last = lines[lines.length - 1].trim().split(/\s+/);
      // Filesystem 1K-blocks Used Available ... (macOS adds iused/ifree columns after Capacity)
      const total = parseInt(last[1], 10), avail = parseInt(last[3], 10);
      if (isNaN(total) || isNaN(avail)) return resolve({ freeBytes: null, totalBytes: null, error: 'df parse failed' });
      resolve({ freeBytes: avail * 1024, totalBytes: total * 1024, error: null });
    });
  });
}

async function refresh() {
  const r = await query(config.dataDir());
  cache = { ts: Date.now(), ...r };
  return cache;
}

async function refreshIfStale() {
  if (Date.now() - cache.ts > TTL) await refresh();
  return cache;
}

function current() { return cache; }

module.exports = { refresh, refreshIfStale, current };
