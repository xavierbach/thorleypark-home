'use strict';
// Camera definitions (config/cameras.json): validation, password masking, test capture.
const path = require('path');
const fs = require('fs');
const store = require('./store');
const capture = require('./capture');
const config = require('./config');
const time = require('./time');
const { HttpError } = require('./router');

const KINDS = ['ip', 'lavfi', 'file'];
const MASK = '***';

// Replace the password in "scheme://user:pass@host" with ***
function maskUrl(url) {
  if (!url) return url;
  return String(url).replace(/^(\w+:\/\/[^:@\/]*:)[^@\/]*@/, `$1${MASK}@`);
}

// If the incoming URL still carries the mask as password, keep the stored password.
function mergeUrl(incoming, existing) {
  if (!incoming) return incoming;
  const m = /^(\w+:\/\/[^:@\/]*:)([^@\/]*)@(.*)$/s.exec(incoming);
  if (!m || m[2] !== MASK) return incoming;
  const e = existing && /^(\w+:\/\/[^:@\/]*:)([^@\/]*)@(.*)$/s.exec(existing);
  if (!e) return incoming;
  return `${m[1]}${e[2]}@${m[3]}`;
}

function redact(cam) {
  if (!cam) return cam;
  return {
    ...cam,
    rtspUrl: maskUrl(cam.rtspUrl),
    snapshotUrl: maskUrl(cam.snapshotUrl),
    hasCredentials: /^\w+:\/\/[^:@\/]*:[^@\/]*@/.test(cam.rtspUrl || '') || /^\w+:\/\/[^:@\/]*:[^@\/]*@/.test(cam.snapshotUrl || ''),
  };
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

// Build a validated camera object from user input. `existing` supplies id/createdAt and hidden passwords.
function validate(input, existing = null) {
  const name = str(input.name);
  if (!name) throw new HttpError(400, 'Camera name is required');
  const kind = str(input.kind) || 'ip';
  if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  const cam = {
    id: existing ? existing.id : time.randomId('cam'),
    name,
    slug: time.slug(name),
    kind,
    rtspUrl: mergeUrl(str(input.rtspUrl), existing && existing.rtspUrl),
    snapshotUrl: mergeUrl(str(input.snapshotUrl), existing && existing.snapshotUrl),
    lavfiSpec: str(input.lavfiSpec),
    filePath: str(input.filePath),
    enabled: input.enabled === undefined ? (existing ? existing.enabled !== false : true) : !!input.enabled,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTest: existing ? existing.lastTest || null : null,
  };
  if (kind === 'ip') {
    if (!cam.rtspUrl && !cam.snapshotUrl) throw new HttpError(400, 'An RTSP URL or a snapshot URL is required');
    if (cam.rtspUrl && !/^rtsps?:\/\//i.test(cam.rtspUrl)) throw new HttpError(400, 'RTSP URL must start with rtsp://');
    if (cam.snapshotUrl && !/^https?:\/\//i.test(cam.snapshotUrl)) throw new HttpError(400, 'Snapshot URL must start with http:// or https://');
  } else if (kind === 'lavfi') {
    if (!cam.lavfiSpec) cam.lavfiSpec = 'testsrc2=size=3840x2160:rate=1';
  } else if (kind === 'file') {
    if (!cam.filePath) throw new HttpError(400, 'File path is required');
  }
  return cam;
}

function list() { return store.loadCameras(); }
function get(id) { return list().find((c) => c.id === id) || null; }
function mustGet(id) {
  const c = get(id);
  if (!c) throw new HttpError(404, 'Camera not found');
  return c;
}

function create(input) {
  const cam = validate(input);
  store.saveCameras([...list(), cam]);
  return cam;
}

function update(id, input) {
  const existing = mustGet(id);
  const cam = validate(input, existing);
  store.saveCameras(list().map((c) => (c.id === id ? cam : c)));
  return cam;
}

function remove(id) {
  mustGet(id);
  const used = store.activeJobs().filter((j) => (j.cameraIds || []).includes(id) && !(j.cameras[id] && j.cameras[id].removed));
  if (used.length) throw new HttpError(409, `Camera is used by active job "${used[0].name}"`);
  store.saveCameras(list().filter((c) => c.id !== id));
}

function testImagePath(id) {
  return path.join(store.tmpDir(), `test_${id}.jpg`);
}

// Grab a test frame. Records lastTest for saved cameras.
async function test(cam, { persist = true } = {}) {
  const outPath = testImagePath(cam.id);
  try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
  const r = await capture.grabFrame(cam, { outPath, timeoutMs: 30000, wantDims: true });
  const lastTest = { at: new Date().toISOString(), ok: r.ok, ms: r.ms, width: r.width, height: r.height, error: r.error };
  if (persist && get(cam.id)) {
    store.saveCameras(list().map((c) => (c.id === cam.id ? { ...c, lastTest } : c)));
  }
  return {
    ...lastTest,
    bytes: r.bytes,
    stderrTail: r.stderrTail,
    imageUrl: r.ok ? `/api/cameras/${encodeURIComponent(cam.id)}/test.jpg?ts=${Date.now()}` : null,
  };
}

module.exports = { KINDS, maskUrl, mergeUrl, redact, validate, list, get, mustGet, create, update, remove, test, testImagePath };
