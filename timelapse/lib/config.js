'use strict';
// Settings + paths. Secrets and settings live in timelapse/config/ (gitignored).
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = process.env.TIMELAPSE_CONFIG_DIR || path.join(APP_DIR, 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const CAMERAS_FILE = path.join(CONFIG_DIR, 'cameras.json');
const PORT = parseInt(process.env.PORT, 10) || 3006;

const DEFAULTS = {
  dataDir: '',                 // '' = ~/TimelapseData (env TIMELAPSE_DATA_DIR overrides)
  baseUrl: '',                 // '' = http://<lan ip>:<port>, used in alert links
  lat: -33.87,
  lon: 151.21,
  ffmpegPath: '',              // '' = auto-detect
  captureTimeoutSec: 20,
  maxConcurrentCaptures: 2,
  minFreeGB: 5,
  alertAfterFailures: 10,
  thumbWidth: 320,
  render: {
    encoder: 'libx264',        // or 'h264_videotoolbox'
    crf: 18,
    preset: 'medium',
    maxWidth: 3840,
    maxFps: 60,
  },
  alerts: {
    enabled: false,
    imessageTo: '',
  },
};

let settings = null;

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function load() {
  settings = deepMerge(DEFAULTS, readJsonSafe(SETTINGS_FILE, {}));
  return settings;
}

function get() {
  if (!settings) load();
  return settings;
}

function save(patch) {
  settings = deepMerge(get(), patch);
  writeJsonAtomic(SETTINGS_FILE, settings);
  return settings;
}

// Resolved once at boot; changing dataDir in settings requires a restart.
let resolvedDataDir = null;
function dataDir() {
  if (!resolvedDataDir) {
    resolvedDataDir = process.env.TIMELAPSE_DATA_DIR || get().dataDir || path.join(os.homedir(), 'TimelapseData');
    resolvedDataDir = path.resolve(resolvedDataDir);
  }
  return resolvedDataDir;
}

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function baseUrl() {
  return get().baseUrl || `http://${lanIp()}:${PORT}`;
}

module.exports = {
  APP_DIR, CONFIG_DIR, SETTINGS_FILE, CAMERAS_FILE, PORT, DEFAULTS,
  load, get, save, dataDir, baseUrl, lanIp, readJsonSafe, writeJsonAtomic, deepMerge,
};
