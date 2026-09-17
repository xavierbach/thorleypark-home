'use strict';
// Job validation, creation, editing and API views.
const store = require('./store');
const cameras = require('./cameras');
const config = require('./config');
const schedule = require('./schedule');
const render = require('./render');
const time = require('./time');
const { HttpError } = require('./router');

const WINDOW_MODES = ['none', 'daily', 'sun'];
const EDITABLE_ACTIVE = ['name', 'end', 'intervalSec', 'window', 'playback', 'cameraIds'];
const EDITABLE_DONE = ['name', 'playback'];
const EST_BYTES_PER_FRAME = 2.2e6;

function validateWindow(w) {
  const out = { mode: 'none', dailyStart: '06:30', dailyEnd: '19:00', sunBeforeMin: 30, sunAfterMin: 30 };
  if (!w || typeof w !== 'object') return out;
  if (w.mode && !WINDOW_MODES.includes(w.mode)) throw new HttpError(400, 'window.mode must be none, daily or sun');
  out.mode = w.mode || 'none';
  if (out.mode === 'daily') {
    if (time.parseHHMM(w.dailyStart) == null || time.parseHHMM(w.dailyEnd) == null) throw new HttpError(400, 'Daily window needs start and end times as HH:MM');
    out.dailyStart = w.dailyStart; out.dailyEnd = w.dailyEnd;
    if (time.parseHHMM(w.dailyStart) === time.parseHHMM(w.dailyEnd)) throw new HttpError(400, 'Daily window start and end must differ');
  }
  if (out.mode === 'sun') {
    out.sunBeforeMin = Math.max(-240, Math.min(240, Number(w.sunBeforeMin) || 0));
    out.sunAfterMin = Math.max(-240, Math.min(240, Number(w.sunAfterMin) || 0));
  }
  return out;
}

function validatePlayback(p) {
  const out = { mode: 'fps', fps: 30, targetDurationSec: 60 };
  if (!p || typeof p !== 'object') return out;
  if (p.mode && !['fps', 'duration'].includes(p.mode)) throw new HttpError(400, 'playback.mode must be fps or duration');
  out.mode = p.mode || 'fps';
  if (p.fps !== undefined) {
    out.fps = Number(p.fps);
    if (!(out.fps >= 1 && out.fps <= 120)) throw new HttpError(400, 'fps must be between 1 and 120');
  }
  if (p.targetDurationSec !== undefined) {
    out.targetDurationSec = Number(p.targetDurationSec);
    if (!(out.targetDurationSec >= 1 && out.targetDurationSec <= 3600)) throw new HttpError(400, 'Target duration must be 1 to 3600 seconds');
  }
  return out;
}

function validateInterval(v) {
  const n = Math.round(Number(v));
  if (!(n >= 1 && n <= 7 * 86400)) throw new HttpError(400, 'Interval must be between 1 second and 7 days');
  return n;
}

function validateCameraIds(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Pick at least one camera');
  const out = [];
  for (const id of ids) {
    const cam = cameras.get(id);
    if (!cam) throw new HttpError(400, `Unknown camera: ${id}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function parseWhen(v, label) {
  const ms = time.parseDateTime(v);
  if (isNaN(ms)) throw new HttpError(400, `${label} is not a valid date/time`);
  return ms;
}

function newCamState(nowMs, job) {
  return {
    frames: 0, bytes: 0,
    lastSlotMs: job ? schedule.slotFor(job, nowMs) - schedule.intervalMs(job) : null,
    lastCaptureAt: null, lastOk: null, lastError: null, lastMs: null,
    consecutiveFailures: 0, alerted: false, removed: false,
  };
}

function create(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new HttpError(400, 'Job name is required');
  const startMs = parseWhen(input.start, 'Start');
  const endMs = parseWhen(input.end, 'End');
  const now = Date.now();
  if (endMs <= startMs) throw new HttpError(400, 'End must be after start');
  if (endMs <= now) throw new HttpError(400, 'End must be in the future');
  const cameraIds = validateCameraIds(input.cameraIds);
  const job = {
    id: `job_${time.fmtLocalCompact(now).slice(0, 8)}_${time.randomId('x', 4).slice(2)}`,
    name,
    slug: time.slug(name),
    cameraIds,
    cameraNames: Object.fromEntries(cameraIds.map((id) => [id, cameras.get(id).name])),
    start: time.isoWithOffset(startMs),
    end: time.isoWithOffset(endMs),
    intervalSec: validateInterval(input.intervalSec),
    window: validateWindow(input.window),
    playback: validatePlayback(input.playback),
    status: 'scheduled',
    pausedReason: null,
    cameras: {},
    gaps: 0,
    error: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  for (const id of cameraIds) job.cameras[id] = newCamState(now, null);
  store.addJob(job);
  return job;
}

function update(job, input) {
  const active = ['scheduled', 'capturing'].includes(job.status);
  const allowed = active ? EDITABLE_ACTIVE.concat(job.status === 'scheduled' ? ['start'] : []) : EDITABLE_DONE;
  const now = Date.now();
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new HttpError(400, `Field "${key}" cannot be changed while the job is ${job.status}`);
  }
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new HttpError(400, 'Job name is required');
    job.name = name; job.slug = time.slug(name);
  }
  if (input.start !== undefined) {
    const s = parseWhen(input.start, 'Start');
    job.start = time.isoWithOffset(s);
  }
  if (input.end !== undefined) {
    const e = parseWhen(input.end, 'End');
    if (e <= schedule.startMs(job)) throw new HttpError(400, 'End must be after start');
    if (e <= now && job.status !== 'scheduled') throw new HttpError(400, 'End must be in the future (use End now to stop early)');
    job.end = time.isoWithOffset(e);
  }
  if (input.intervalSec !== undefined) job.intervalSec = validateInterval(input.intervalSec);
  if (input.window !== undefined) job.window = validateWindow(input.window);
  if (input.playback !== undefined) job.playback = validatePlayback(input.playback);
  if (input.cameraIds !== undefined) {
    const ids = validateCameraIds(input.cameraIds);
    for (const id of ids) {
      if (!job.cameras[id]) job.cameras[id] = newCamState(now, job);
      job.cameras[id].removed = false;
      job.cameraNames[id] = cameras.get(id).name;
    }
    for (const id of Object.keys(job.cameras)) {
      if (!ids.includes(id)) job.cameras[id].removed = true;
    }
    job.cameraIds = ids;
  }
  store.saveJob(job, { now: true });
  return job;
}

function estimate(input) {
  const startMs = parseWhen(input.start, 'Start');
  const endMs = parseWhen(input.end, 'End');
  if (endMs <= startMs) throw new HttpError(400, 'End must be after start');
  const job = {
    start: time.isoWithOffset(startMs),
    end: time.isoWithOffset(endMs),
    intervalSec: validateInterval(input.intervalSec),
    window: validateWindow(input.window),
  };
  const playback = validatePlayback(input.playback);
  const settings = config.get();
  const est = schedule.estimateFrames(job, settings);
  let finalDurationSec, fpsUsed;
  if (playback.mode === 'duration') {
    const sel = render.selectFrames(Math.max(2, est.frames), 'duration', null, playback.targetDurationSec, (settings.render || {}).maxFps || 60);
    fpsUsed = sel.fpsUsed; finalDurationSec = sel.framesUsed / sel.fpsUsed;
  } else {
    fpsUsed = playback.fps; finalDurationSec = est.frames / playback.fps;
  }
  const camCount = Array.isArray(input.cameraIds) ? Math.max(1, input.cameraIds.length) : 1;
  return {
    frames: est.frames,
    perDay: Math.round(est.perDay),
    days: Math.round(est.days * 10) / 10,
    fpsUsed,
    finalDurationSec: Math.round(finalDurationSec * 10) / 10,
    estBytesPerCamera: Math.round(est.frames * EST_BYTES_PER_FRAME),
    estBytesTotal: Math.round(est.frames * EST_BYTES_PER_FRAME * camCount),
  };
}

function cameraView(job, camId, settings, nowMs) {
  const cs = job.cameras[camId];
  const next = job.status === 'capturing' && !cs.removed ? schedule.nextCaptureAt(job, cs, nowMs, settings) : null;
  return {
    id: camId,
    name: job.cameraNames[camId] || camId,
    ...cs,
    lastSlot: cs.lastSlotMs != null ? new Date(cs.lastSlotMs).toISOString() : null,
    nextCaptureAt: next ? new Date(next).toISOString() : null,
  };
}

function summary(job, settings, nowMs = Date.now()) {
  const cams = job.cameraIds.map((id) => cameraView(job, id, settings, nowMs));
  const nexts = cams.map((c) => c.nextCaptureAt).filter(Boolean).sort();
  const rs = render.status();
  return {
    id: job.id, name: job.name, status: job.status, pausedReason: job.pausedReason, error: job.error,
    start: job.start, end: job.end, intervalSec: job.intervalSec, window: job.window, playback: job.playback,
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    gaps: job.gaps || 0,
    cameras: cams,
    totalFrames: cams.reduce((n, c) => n + (c.frames || 0), 0),
    totalBytes: cams.reduce((n, c) => n + (c.bytes || 0), 0),
    nextCaptureAt: nexts[0] || null,
    renderRunning: !!(rs.running && rs.running.jobId === job.id),
    renderQueued: render.isQueuedOrRunning(job.id),
  };
}

function detail(job, settings) {
  const now = Date.now();
  const est = schedule.estimateFrames(job, settings);
  return {
    ...summary(job, settings, now),
    startInput: time.toLocalInput(schedule.startMs(job)),
    endInput: time.toLocalInput(schedule.endMs(job)),
    estimatedFrames: est.frames,
    renders: render.list(job.id),
    log: store.readCaptureLog(job.id, { limit: 60 }),
  };
}

module.exports = { create, update, estimate, summary, detail, validateWindow, validatePlayback };
