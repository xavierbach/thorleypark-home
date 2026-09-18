'use strict';
// Render queue: stitch a camera's frames into an H.264 MP4 with ffmpeg. One render at a time.
// Frames are exposed to ffmpeg as a numbered symlink sequence so frame dropping (duration mode)
// and exact timing (-framerate) both work uniformly.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const config = require('./config');
const store = require('./store');
const ffmpeg = require('./ffmpeg');
const log = require('./log');
const time = require('./time');
const alerts = require('./alerts');

const events = new EventEmitter();
const queue = [];            // [{ jobId, rid }]
let running = null;          // { jobId, rid, child, lastProgressAt }
const manifests = new Map(); // jobId -> { renders: [] }
const WATCHDOG_MS = 10 * 60 * 1000;
const MAX_RENDER_MS = 24 * 60 * 60 * 1000;

function manifestFile(jobId) { return path.join(store.rendersDir(jobId), 'renders.json'); }

function manifest(jobId) {
  if (!manifests.has(jobId)) {
    const m = config.readJsonSafe(manifestFile(jobId), { renders: [] });
    if (!Array.isArray(m.renders)) m.renders = [];
    manifests.set(jobId, m);
  }
  return manifests.get(jobId);
}

let saveTimers = new Map();
function saveManifest(jobId, { now = false } = {}) {
  const write = () => {
    saveTimers.delete(jobId);
    try { config.writeJsonAtomic(manifestFile(jobId), manifest(jobId)); } catch (e) { log.error('renders.json write failed', e.message); }
  };
  if (now) { const t = saveTimers.get(jobId); if (t) clearTimeout(t); return write(); }
  if (!saveTimers.has(jobId)) saveTimers.set(jobId, setTimeout(write, 2000));
}

function list(jobId) { return manifest(jobId).renders.slice().reverse(); }
function get(jobId, rid) { return manifest(jobId).renders.find((r) => r.id === rid) || null; }
function forget(jobId) { manifests.delete(jobId); }

// Pure: choose which of N frames to use and the playback fps.
// Returns { indices: null | number[], fpsUsed, framesUsed }. indices === null means all frames.
function selectFrames(N, mode, fps, targetDurationSec, maxFps) {
  maxFps = maxFps || 60;
  if (mode === 'duration') {
    const dur = Math.max(0.5, Number(targetDurationSec) || 30);
    const needed = N / dur;
    if (needed <= maxFps) {
      return { indices: null, fpsUsed: Math.max(1, Math.round(needed * 100) / 100), framesUsed: N };
    }
    const keep = Math.max(2, Math.min(N, Math.round(maxFps * dur)));
    const indices = [];
    for (let i = 0; i < keep; i++) indices.push(Math.round((i * (N - 1)) / (keep - 1)));
    return { indices, fpsUsed: maxFps, framesUsed: keep };
  }
  const f = Math.min(120, Math.max(1, Number(fps) || 30));
  return { indices: null, fpsUsed: f, framesUsed: N };
}

function outputName(job, cam, type, nowMs) {
  const dir = store.rendersDir(job.id);
  const camSlug = cam.slug || time.slug(cam.name || cam.id);
  if (type === 'interim') return `${job.slug}_${camSlug}_interim_${time.fmtLocalCompact(nowMs)}.mp4`;
  let name = `${job.slug}_${camSlug}_final.mp4`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${job.slug}_${camSlug}_final_${n}.mp4`;
  return name;
}

function cameraInfo(job, camId) {
  const cameras = store.loadCameras();
  const cam = cameras.find((c) => c.id === camId);
  const name = (cam && cam.name) || (job.cameraNames && job.cameraNames[camId]) || camId;
  return { id: camId, name, slug: time.slug(name) };
}

function enqueue(job, { cameraIds, type = 'interim', mode = 'fps', fps = 30, targetDurationSec = null } = {}) {
  const ids = (cameraIds && cameraIds.length ? cameraIds : job.cameraIds).filter((id) => job.cameras[id]);
  const created = [];
  const now = Date.now();
  for (const camId of ids) {
    const cam = cameraInfo(job, camId);
    const r = {
      id: time.randomId('r', 5),
      cameraId: camId,
      cameraName: cam.name,
      type,
      mode,
      fps: mode === 'fps' ? Number(fps) || 30 : null,
      targetDurationSec: mode === 'duration' ? Number(targetDurationSec) || 30 : null,
      file: outputName(job, cam, type, now),
      status: 'queued',
      requestedAt: new Date(now).toISOString(),
      startedAt: null,
      finishedAt: null,
      framesAvailable: null,
      framesUsed: null,
      fpsUsed: null,
      durationSec: null,
      width: null,
      height: null,
      bytes: null,
      progress: { frame: 0, total: 0 },
      error: null,
      stderrTail: null,
    };
    manifest(job.id).renders.push(r);
    queue.push({ jobId: job.id, rid: r.id });
    created.push(r);
  }
  saveManifest(job.id, { now: true });
  setImmediate(processNext);
  return created;
}

// Final renders for every camera that has at least two frames. Cameras that never captured are
// skipped (their failure is visible on the job page) rather than failing the whole job.
function enqueueFinal(job) {
  const p = job.playback || {};
  const ids = job.cameraIds.filter((id) => job.cameras[id] && !job.cameras[id].removed && store.listFrameNames(job.id, id).length >= 2);
  if (!ids.length) {
    log.warn(`job ${job.id}: no camera has enough frames for a final render`);
    setImmediate(() => events.emit('finalsSettled', job, { anyFailed: false }));
    return [];
  }
  return enqueue(job, { cameraIds: ids, type: 'final', mode: p.mode || 'fps', fps: p.fps, targetDurationSec: p.targetDurationSec });
}

// State of the most recent batch of final renders (a retry starts a new batch, older failures don't count).
function finalsState(jobId) {
  let rs = manifest(jobId).renders.filter((r) => r.type === 'final');
  const latest = rs.reduce((m, r) => (r.requestedAt > m ? r.requestedAt : m), '');
  rs = rs.filter((r) => r.requestedAt === latest);
  return {
    pending: rs.filter((r) => r.status === 'queued' || r.status === 'running').length,
    failed: rs.filter((r) => r.status === 'failed').length,
    done: rs.filter((r) => r.status === 'done').length,
  };
}

function isQueuedOrRunning(jobId) {
  return queue.some((q) => q.jobId === jobId) || (running && running.jobId === jobId);
}

async function processNext() {
  if (running || !queue.length) return;
  const item = queue.shift();
  const job = store.getJob(item.jobId);
  const r = job && get(job.id, item.rid);
  if (!job || !r || r.status !== 'queued') return setImmediate(processNext);
  running = { jobId: job.id, rid: r.id, child: null, lastProgressAt: Date.now() };
  try {
    await runRender(job, r);
  } catch (e) {
    r.status = 'failed';
    r.error = e.message;
    r.finishedAt = new Date().toISOString();
    log.error('render crashed', r.id, e);
  }
  running = null;
  saveManifest(job.id, { now: true });
  events.emit('renderDone', job, r);
  if (r.type === 'final') {
    const st = finalsState(job.id);
    if (st.pending === 0) events.emit('finalsSettled', job, { anyFailed: st.failed > 0 });
  }
  setImmediate(processNext);
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

async function runRender(job, r) {
  const settings = config.get();
  const rs = settings.render || {};
  const info = ffmpeg.locate();
  r.status = 'running';
  r.startedAt = new Date().toISOString();
  saveManifest(job.id, { now: true });
  log.info(`render ${r.id} start: job=${job.id} cam=${r.cameraId} type=${r.type} mode=${r.mode}`);

  if (!info.ok) { fail(r, info.error); return; }
  const names = store.listFrameNames(job.id, r.cameraId);
  r.framesAvailable = names.length;
  if (names.length < 2) { fail(r, `Not enough frames to render (${names.length})`); return; }

  const sel = selectFrames(names.length, r.mode, r.fps, r.targetDurationSec, rs.maxFps || 60);
  r.fpsUsed = sel.fpsUsed;
  r.framesUsed = sel.framesUsed;
  r.progress = { frame: 0, total: sel.framesUsed };

  const rendersDir = store.rendersDir(job.id);
  const tmpDir = path.join(rendersDir, 'tmp', r.id);
  const framesDir = store.framesDir(job.id, r.cameraId);
  rmrf(tmpDir);
  fs.mkdirSync(tmpDir, { recursive: true });
  const chosen = sel.indices ? sel.indices.map((i) => names[i]) : names;
  chosen.forEach((name, i) => {
    fs.symlinkSync(path.join(framesDir, name), path.join(tmpDir, `${time.pad(i + 1, 6)}.jpg`));
  });

  const outFile = path.join(rendersDir, r.file);
  const partFile = outFile + '.part.mp4';
  const maxWidth = rs.maxWidth || 3840;
  const vf = `scale=w='min(iw,${maxWidth})':h=-2,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p`;
  const codec = rs.encoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-allow_sw', '1', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', rs.preset || 'medium', '-crf', String(rs.crf ?? 18), '-pix_fmt', 'yuv420p'];
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(sel.fpsUsed), '-i', path.join(tmpDir, '%06d.jpg'),
    '-vf', vf, ...codec, '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    partFile,
  ];
  log.info('render cmd:', ffmpeg.redactArgs([info.ffmpeg, ...args]));

  let killedByWatchdog = false;
  const watchdog = setInterval(() => {
    if (running && running.rid === r.id && Date.now() - running.lastProgressAt > WATCHDOG_MS && running.child) {
      killedByWatchdog = true;
      try { running.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  }, 30000);

  const res = await ffmpeg.run(info.ffmpeg, args, {
    timeoutMs: MAX_RENDER_MS,
    nice: 10,
    onSpawn: (child) => { if (running) running.child = child; },
    onStdoutLine: (line) => {
      const m = /^frame=\s*(\d+)/.exec(line);
      if (m) {
        r.progress.frame = parseInt(m[1], 10);
        if (running) running.lastProgressAt = Date.now();
        saveManifest(job.id);
      }
    },
  });
  clearInterval(watchdog);
  rmrf(tmpDir);
  try { fs.rmdirSync(path.dirname(tmpDir)); } catch (e) { /* not empty or missing */ }

  if (res.code !== 0 || !fs.existsSync(partFile)) {
    rmrf(partFile);
    if (r.status === 'failed') return; // cancelled
    const why = killedByWatchdog ? 'stalled (no progress for 10 min)' : res.timedOut ? 'timed out' : `ffmpeg exited ${res.code}`;
    fail(r, why, res.stderrTail);
    return;
  }
  fs.renameSync(partFile, outFile);
  r.bytes = fs.statSync(outFile).size;
  r.durationSec = Math.round((sel.framesUsed / sel.fpsUsed) * 10) / 10;
  const dims = await ffmpeg.probeDimensions(outFile);
  if (dims) { r.width = dims.width; r.height = dims.height; }
  r.progress.frame = sel.framesUsed;
  r.status = 'done';
  r.finishedAt = new Date().toISOString();
  log.info(`render ${r.id} done: ${r.file} ${r.framesUsed} frames @ ${r.fpsUsed} fps, ${r.durationSec}s, ${Math.round(r.bytes / 1e6)} MB in ${Math.round(res.ms / 1000)}s`);

  const link = `${config.baseUrl()}/#/jobs/${job.id}`;
  await alerts.send(
    `🎬 Timelapse "${job.name}" · ${r.cameraName} ${r.type} render ready: ${r.framesUsed.toLocaleString()} frames, ${r.durationSec}s @ ${r.fpsUsed} fps, ${Math.round(r.bytes / 1e6)} MB. ${link}`,
  );
}

function fail(r, error, stderrTail) {
  r.status = 'failed';
  r.error = error;
  r.stderrTail = stderrTail || null;
  r.finishedAt = new Date().toISOString();
  log.error(`render ${r.id} failed: ${error}`);
}

// Cancel (if queued/running) and delete a render record + file.
function remove(job, rid) {
  const r = get(job.id, rid);
  if (!r) return false;
  const qi = queue.findIndex((q) => q.rid === rid);
  if (qi >= 0) queue.splice(qi, 1);
  if (running && running.rid === rid) {
    r.status = 'failed';
    r.error = 'cancelled';
    if (running.child) { try { running.child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
  }
  const m = manifest(job.id);
  m.renders = m.renders.filter((x) => x.id !== rid);
  rmrf(path.join(store.rendersDir(job.id), r.file));
  rmrf(path.join(store.rendersDir(job.id), r.file + '.part.mp4'));
  saveManifest(job.id, { now: true });
  return true;
}

function filePath(job, r) { return path.join(store.rendersDir(job.id), r.file); }

function status() {
  return {
    running: running ? { jobId: running.jobId, rid: running.rid } : null,
    queued: queue.length,
  };
}

// At boot: interrupted interim renders fail, interrupted or queued finals are re-queued.
function init() {
  for (const job of store.allJobs()) {
    const m = manifest(job.id);
    for (const r of m.renders) {
      if (r.status === 'running' || r.status === 'queued') {
        if (r.type === 'final') {
          r.status = 'queued';
          queue.push({ jobId: job.id, rid: r.id });
        } else {
          r.status = 'failed';
          r.error = 'interrupted by restart';
          r.finishedAt = new Date().toISOString();
        }
      }
    }
    rmrf(path.join(store.rendersDir(job.id), 'tmp'));
    saveManifest(job.id, { now: true });
  }
  setImmediate(processNext);
}

module.exports = {
  events, init, list, get, forget, enqueue, enqueueFinal, finalsState, isQueuedOrRunning, remove, filePath, status, selectFrames,
};
