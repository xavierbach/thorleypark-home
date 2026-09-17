'use strict';
// Persistence: jobs live in <dataDir>/jobs/<id>/job.json, cameras in config/cameras.json.
// All JSON writes are atomic (tmp + rename). Job writes are throttled: saveJob() marks dirty
// and a flush runs at most once per second, plus on demand (state transitions, shutdown).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

const jobs = new Map();       // id -> job
const dirty = new Set();      // job ids awaiting flush
let flushTimer = null;

function jobsDir() { return path.join(config.dataDir(), 'jobs'); }
function jobDir(id) { return path.join(jobsDir(), id); }
function jobFile(id) { return path.join(jobDir(id), 'job.json'); }
function framesDir(id, camId) { return path.join(jobDir(id), 'frames', camId); }
function thumbsDir(id, camId) { return path.join(jobDir(id), 'thumbs', camId); }
function rendersDir(id) { return path.join(jobDir(id), 'renders'); }
function captureLogFile(id) { return path.join(jobDir(id), 'captures.jsonl'); }
function tmpDir() { return path.join(config.dataDir(), 'tmp'); }

function ensureDirs() {
  fs.mkdirSync(jobsDir(), { recursive: true });
  fs.mkdirSync(tmpDir(), { recursive: true });
}

function loadAllJobs() {
  ensureDirs();
  jobs.clear();
  for (const entry of fs.readdirSync(jobsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const job = config.readJsonSafe(jobFile(entry.name), null);
    if (!job || !job.id) { log.warn('Skipping job dir without job.json:', entry.name); continue; }
    jobs.set(job.id, job);
  }
  log.info(`Loaded ${jobs.size} job(s) from ${jobsDir()}`);
  return jobs;
}

function allJobs() { return [...jobs.values()]; }
function getJob(id) { return jobs.get(id) || null; }

function activeJobs() {
  return allJobs().filter((j) => ['scheduled', 'capturing', 'finishing'].includes(j.status));
}

function addJob(job) {
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  jobs.set(job.id, job);
  flushJob(job.id);
  return job;
}

function flushJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.updatedAt = new Date().toISOString();
  try {
    config.writeJsonAtomic(jobFile(id), job);
  } catch (e) {
    log.error('Failed to write job', id, e.message);
  }
  dirty.delete(id);
}

function saveJob(job, { now = false } = {}) {
  if (now) return flushJob(job.id);
  dirty.add(job.id);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const id of [...dirty]) flushJob(id);
    }, 1000);
  }
}

function flushAll() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  for (const id of [...dirty]) flushJob(id);
}

function deleteJob(id) {
  jobs.delete(id);
  dirty.delete(id);
  fs.rmSync(jobDir(id), { recursive: true, force: true });
}

// Recount frames + bytes on disk for each camera of a job (used at boot to reconcile).
function recountFrames(job) {
  for (const camId of Object.keys(job.cameras || {})) {
    const cs = job.cameras[camId];
    const dir = framesDir(job.id, camId);
    let frames = 0, bytes = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jpg')) continue;
        frames++;
        try { bytes += fs.statSync(path.join(dir, name)).size; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* no dir yet */ }
    cs.frames = frames;
    cs.bytes = bytes;
  }
}

function appendCaptureLog(jobId, entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFile(captureLogFile(jobId), line, (err) => {
    if (err) log.error('captures.jsonl append failed', jobId, err.message);
  });
}

// Read the tail of captures.jsonl (last ~64 KB) and return parsed lines, newest last.
function readCaptureLog(jobId, { limit = 200, cam = null } = {}) {
  const file = captureLogFile(jobId);
  let text = '';
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    if (size < st.size) text = text.slice(text.indexOf('\n') + 1);
  } catch (e) {
    return [];
  }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch (e) { /* skip partial line */ }
  }
  const filtered = cam ? lines.filter((l) => !l.cam || l.cam === cam) : lines;
  return filtered.slice(-limit);
}

// Frame listing for a camera in a job: sorted names (chronological because of the stamp format).
function listFrameNames(jobId, camId) {
  try {
    return fs.readdirSync(framesDir(jobId, camId)).filter((n) => n.endsWith('.jpg')).sort();
  } catch (e) {
    return [];
  }
}

// ---- cameras (config/cameras.json) ----
let cameraCache = null;
function loadCameras() {
  if (!cameraCache) {
    const data = config.readJsonSafe(config.CAMERAS_FILE, { cameras: [] });
    cameraCache = Array.isArray(data.cameras) ? data.cameras : [];
  }
  return cameraCache;
}
function saveCameras(list) {
  cameraCache = list;
  config.writeJsonAtomic(config.CAMERAS_FILE, { cameras: list });
}

module.exports = {
  jobsDir, jobDir, jobFile, framesDir, thumbsDir, rendersDir, captureLogFile, tmpDir, ensureDirs,
  loadAllJobs, allJobs, getJob, activeJobs, addJob, saveJob, flushJob, flushAll, deleteJob,
  recountFrames, appendCaptureLog, readCaptureLog, listFrameNames, loadCameras, saveCameras,
};
