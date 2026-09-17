'use strict';
// Thorley Park Timelapse: local web app that captures 4K frames from IP cameras on a schedule
// and stitches them into MP4 timelapses. Zero npm dependencies; ffmpeg via Homebrew.
//
//   PORT=3006 TIMELAPSE_DATA_DIR=~/TimelapseData node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./lib/config');
const log = require('./lib/log');
const store = require('./lib/store');
const router = require('./lib/router');
const staticFiles = require('./lib/static');
const ffmpeg = require('./lib/ffmpeg');
const disk = require('./lib/disk');
const cameras = require('./lib/cameras');
const capture = require('./lib/capture');
const jobs = require('./lib/jobs');
const schedule = require('./lib/schedule');
const scheduler = require('./lib/scheduler');
const render = require('./lib/render');
const sun = require('./lib/sun');
const zip = require('./lib/zip');
const alerts = require('./lib/alerts');
const power = require('./lib/power');
const time = require('./lib/time');

const { HttpError } = router;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '1.0.0';
const startedAt = Date.now();

config.load();
store.ensureDirs();
ffmpeg.locate();

function mustJob(id) {
  const job = store.getJob(id);
  if (!job) throw new HttpError(404, 'Job not found');
  return job;
}

function mustCamInJob(job, camId) {
  if (!job.cameras[camId]) throw new HttpError(404, 'Camera not in this job');
  return camId;
}

function safeName(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) throw new HttpError(400, 'Bad file name');
  return name;
}

// ---- health / settings ----
router.add('GET', '/api/health', async () => {
  await disk.refreshIfStale();
  return {
    version: VERSION,
    now: new Date().toISOString(),
    timezone: time.timezone(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    platform: process.platform,
    hostname: os.hostname(),
    baseUrl: config.baseUrl(),
    dataDir: config.dataDir(),
    ffmpeg: ffmpeg.locate(),
    disk: disk.current(),
    scheduler: scheduler.state(),
    renderQueue: render.status(),
    caffeinate: power.isActive(),
    alerts: { enabled: !!(config.get().alerts || {}).enabled, recipient: (config.get().alerts || {}).imessageTo || '' },
  };
});

router.add('GET', '/api/settings', async () => ({ settings: config.get(), dataDir: config.dataDir(), defaults: config.DEFAULTS }));

router.add('PUT', '/api/settings', async ({ body }) => {
  const patch = {};
  const num = (v, lo, hi, label) => {
    const n = Number(v);
    if (!(n >= lo && n <= hi)) throw new HttpError(400, `${label} must be between ${lo} and ${hi}`);
    return n;
  };
  if (body.lat !== undefined) patch.lat = num(body.lat, -90, 90, 'Latitude');
  if (body.lon !== undefined) patch.lon = num(body.lon, -180, 180, 'Longitude');
  if (body.dataDir !== undefined) patch.dataDir = String(body.dataDir).trim();
  if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl).trim();
  if (body.ffmpegPath !== undefined) patch.ffmpegPath = String(body.ffmpegPath).trim();
  if (body.captureTimeoutSec !== undefined) patch.captureTimeoutSec = num(body.captureTimeoutSec, 3, 120, 'Capture timeout');
  if (body.maxConcurrentCaptures !== undefined) patch.maxConcurrentCaptures = Math.round(num(body.maxConcurrentCaptures, 1, 8, 'Concurrent captures'));
  if (body.minFreeGB !== undefined) patch.minFreeGB = num(body.minFreeGB, 0, 10000, 'Min free GB');
  if (body.alertAfterFailures !== undefined) patch.alertAfterFailures = Math.round(num(body.alertAfterFailures, 1, 1000, 'Alert after failures'));
  if (body.thumbWidth !== undefined) patch.thumbWidth = Math.round(num(body.thumbWidth, 120, 1280, 'Thumbnail width'));
  if (body.render) {
    patch.render = {};
    const r = body.render;
    if (r.encoder !== undefined) {
      if (!['libx264', 'h264_videotoolbox'].includes(r.encoder)) throw new HttpError(400, 'Unknown encoder');
      patch.render.encoder = r.encoder;
    }
    if (r.crf !== undefined) patch.render.crf = Math.round(num(r.crf, 0, 51, 'CRF'));
    if (r.preset !== undefined) {
      if (!['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(r.preset)) throw new HttpError(400, 'Unknown preset');
      patch.render.preset = r.preset;
    }
    if (r.maxWidth !== undefined) patch.render.maxWidth = Math.round(num(r.maxWidth, 320, 7680, 'Max width'));
    if (r.maxFps !== undefined) patch.render.maxFps = Math.round(num(r.maxFps, 1, 120, 'Max fps'));
  }
  if (body.alerts) {
    patch.alerts = {};
    if (body.alerts.enabled !== undefined) patch.alerts.enabled = !!body.alerts.enabled;
    if (body.alerts.imessageTo !== undefined) patch.alerts.imessageTo = String(body.alerts.imessageTo).trim();
  }
  const before = config.get();
  const after = config.save(patch);
  if (patch.ffmpegPath !== undefined && patch.ffmpegPath !== before.ffmpegPath) ffmpeg.locate(true);
  return { settings: after, restartRequired: patch.dataDir !== undefined && patch.dataDir !== before.dataDir };
});

router.add('POST', '/api/alerts/test', async () => {
  const r = await alerts.send(`📷 Thorley Park Timelapse test alert from ${os.hostname()} at ${new Date().toLocaleString()}`, { force: true });
  return r;
});

router.add('GET', '/api/alerts', async () => ({ alerts: alerts.recentAlerts() }));
router.add('GET', '/api/log', async ({ query }) => ({ lines: log.recent(Math.min(500, parseInt(query.limit, 10) || 200)) }));

router.add('GET', '/api/sun', async ({ query }) => {
  const s = config.get();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query.date || '');
  const date = m ? { y: +m[1], m: +m[2], d: +m[3] } : time.localDate(Date.now());
  const t = sun.times(date, s.lat, s.lon);
  return {
    date: `${date.y}-${time.pad(date.m)}-${time.pad(date.d)}`,
    lat: s.lat, lon: s.lon,
    sunrise: t.sunrise ? time.isoWithOffset(t.sunrise) : null,
    sunset: t.sunset ? time.isoWithOffset(t.sunset) : null,
    solarNoon: time.isoWithOffset(t.solarNoon),
    polar: t.polar,
  };
});

// ---- cameras ----
router.add('GET', '/api/cameras', async () => ({ cameras: cameras.list().map(cameras.redact) }));
router.add('POST', '/api/cameras', async ({ body }) => ({ camera: cameras.redact(cameras.create(body)) }));
router.add('PUT', '/api/cameras/:id', async ({ params, body }) => ({ camera: cameras.redact(cameras.update(params.id, body)) }));
router.add('DELETE', '/api/cameras/:id', async ({ params }) => { cameras.remove(params.id); return { ok: true }; });
router.add('POST', '/api/cameras/test-adhoc', async ({ body }) => {
  const existing = body.id ? cameras.get(body.id) : null;
  const cam = cameras.validate(body, existing);
  if (!existing) cam.id = 'adhoc';
  return { result: await cameras.test(cam, { persist: !!existing }) };
});
router.add('POST', '/api/cameras/:id/test', async ({ params }) => ({ result: await cameras.test(cameras.mustGet(params.id)) }));
router.add('GET', '/api/cameras/:id/test.jpg', async ({ req, res, params }) => {
  safeName(params.id);
  staticFiles.sendFile(req, res, cameras.testImagePath(params.id), { cacheControl: 'no-store' });
});

// ---- jobs ----
router.add('GET', '/api/jobs', async () => {
  const s = config.get();
  const list = store.allJobs().map((j) => jobs.summary(j, s));
  const order = { capturing: 0, finishing: 1, scheduled: 2, errored: 3, completed: 4, cancelled: 5 };
  list.sort((a, b) => (order[a.status] - order[b.status]) || (b.createdAt > a.createdAt ? 1 : -1));
  return { jobs: list };
});
router.add('POST', '/api/jobs', async ({ body }) => {
  const job = jobs.create(body);
  scheduler.tick();
  return { job: jobs.detail(job, config.get()) };
});
router.add('POST', '/api/jobs/estimate', async ({ body }) => jobs.estimate(body));
router.add('GET', '/api/jobs/:id', async ({ params }) => ({ job: jobs.detail(mustJob(params.id), config.get()) }));
router.add('PUT', '/api/jobs/:id', async ({ params, body }) => ({ job: jobs.detail(jobs.update(mustJob(params.id), body), config.get()) }));
router.add('DELETE', '/api/jobs/:id', async ({ params }) => {
  const job = mustJob(params.id);
  if (['scheduled', 'capturing', 'finishing'].includes(job.status)) throw new HttpError(409, 'Cancel the job before deleting it');
  for (const r of render.list(job.id)) if (r.status === 'queued' || r.status === 'running') render.remove(job, r.id);
  render.forget(job.id);
  store.deleteJob(job.id);
  return { ok: true };
});

function action(fn) {
  return async ({ params }) => {
    const job = mustJob(params.id);
    try { fn(job); } catch (e) { throw new HttpError(409, e.message); }
    return { job: jobs.detail(job, config.get()) };
  };
}
router.add('POST', '/api/jobs/:id/cancel', action(scheduler.cancel));
router.add('POST', '/api/jobs/:id/end-now', action(scheduler.endNow));
router.add('POST', '/api/jobs/:id/retry-final', action(scheduler.retryFinal));

router.add('GET', '/api/jobs/:id/log', async ({ params, query }) => {
  const job = mustJob(params.id);
  return { lines: store.readCaptureLog(job.id, { limit: Math.min(1000, parseInt(query.limit, 10) || 200), cam: query.cam || null }) };
});

// ---- frames ----
router.add('GET', '/api/jobs/:id/frames/:cam/frames.zip', async ({ req, res, params }) => {
  const job = mustJob(params.id);
  const camId = mustCamInJob(job, params.cam);
  const dir = store.framesDir(job.id, camId);
  if (!store.listFrameNames(job.id, camId).length) throw new HttpError(404, 'No frames yet');
  const camSlug = time.slug(job.cameraNames[camId] || camId);
  zip.streamDirAsZip(req, res, dir, `${job.slug}_${camSlug}_frames.zip`);
});

router.add('GET', '/api/jobs/:id/frames/:cam/latest.jpg', async ({ req, res, params }) => {
  const job = mustJob(params.id);
  const camId = mustCamInJob(job, params.cam);
  const names = store.listFrameNames(job.id, camId);
  if (!names.length) throw new HttpError(404, 'No frames yet');
  staticFiles.sendFile(req, res, path.join(store.framesDir(job.id, camId), names[names.length - 1]), { cacheControl: 'no-store' });
});

router.add('GET', '/api/jobs/:id/frames/:cam', async ({ params, query }) => {
  const job = mustJob(params.id);
  const camId = mustCamInJob(job, params.cam);
  const names = store.listFrameNames(job.id, camId);
  const order = query.order === 'asc' ? 'asc' : 'desc';
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 60));
  const ordered = order === 'desc' ? names.slice().reverse() : names;
  const page = ordered.slice(offset, offset + limit);
  const dir = store.framesDir(job.id, camId);
  const items = page.map((name) => {
    let bytes = null;
    try { bytes = fs.statSync(path.join(dir, name)).size; } catch (e) { /* ignore */ }
    const ms = time.parseStamp(name);
    return { name, ts: isNaN(ms) ? null : new Date(ms).toISOString(), bytes };
  });
  return { total: names.length, offset, limit, order, items };
});

router.add('GET', '/api/jobs/:id/frames/:cam/:name', async ({ req, res, params }) => {
  const job = mustJob(params.id);
  const camId = mustCamInJob(job, params.cam);
  const name = safeName(params.name);
  staticFiles.sendFile(req, res, path.join(store.framesDir(job.id, camId), name), { cacheControl: 'public, max-age=31536000, immutable' });
});

router.add('GET', '/api/jobs/:id/thumbs/:cam/:name', async ({ req, res, params }) => {
  const job = mustJob(params.id);
  const camId = mustCamInJob(job, params.cam);
  const name = safeName(params.name);
  const thumb = path.join(store.thumbsDir(job.id, camId), name);
  if (!fs.existsSync(thumb)) {
    const src = path.join(store.framesDir(job.id, camId), name);
    if (!fs.existsSync(src)) throw new HttpError(404, 'Frame not found');
    await capture.makeThumb(src, thumb, config.get().thumbWidth || 320);
  }
  staticFiles.sendFile(req, res, fs.existsSync(thumb) ? thumb : path.join(store.framesDir(job.id, camId), name), { cacheControl: 'public, max-age=31536000, immutable' });
});

// ---- renders ----
router.add('GET', '/api/jobs/:id/renders', async ({ params }) => ({ renders: render.list(mustJob(params.id).id) }));
router.add('POST', '/api/jobs/:id/renders', async ({ params, body }) => {
  const job = mustJob(params.id);
  if (!ffmpeg.locate().ok) throw new HttpError(409, ffmpeg.locate().error);
  const mode = body.mode === 'duration' ? 'duration' : 'fps';
  const fps = Number(body.fps) || (job.playback && job.playback.fps) || 30;
  const targetDurationSec = Number(body.targetDurationSec) || (job.playback && job.playback.targetDurationSec) || 60;
  if (!(fps >= 1 && fps <= 120)) throw new HttpError(400, 'fps must be between 1 and 120');
  if (!(targetDurationSec >= 1 && targetDurationSec <= 3600)) throw new HttpError(400, 'Target duration must be 1 to 3600 seconds');
  let cameraIds = Array.isArray(body.cameraIds) && body.cameraIds.length ? body.cameraIds : job.cameraIds;
  cameraIds = cameraIds.filter((id) => job.cameras[id]);
  if (!cameraIds.length) throw new HttpError(400, 'No valid cameras selected');
  const type = body.type === 'final' ? 'final' : 'interim';
  const created = render.enqueue(job, { cameraIds, type, mode, fps, targetDurationSec });
  return { renders: created };
});
router.add('DELETE', '/api/jobs/:id/renders/:rid', async ({ params }) => {
  const job = mustJob(params.id);
  if (!render.remove(job, params.rid)) throw new HttpError(404, 'Render not found');
  return { ok: true };
});
router.add('GET', '/api/jobs/:id/renders/:rid/file', async ({ req, res, params, query }) => {
  const job = mustJob(params.id);
  const r = render.get(job.id, params.rid);
  if (!r || r.status !== 'done') throw new HttpError(404, 'Render not ready');
  staticFiles.sendFile(req, res, render.filePath(job, r), {
    mime: 'video/mp4',
    download: query.download === '1',
    filename: r.file,
    cacheControl: 'public, max-age=31536000, immutable',
  });
});

// ---- server ----
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const handled = await router.dispatch(req, res);
      if (!handled) router.sendError(res, 404, 'Not found');
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    staticFiles.serveStatic(req, res, PUBLIC_DIR, pathname);
  } catch (e) {
    log.error('request failed', req.method, req.url, e);
    if (!res.headersSent) router.sendError(res, 500, 'Internal error', e.message);
  }
});

store.loadAllJobs();
render.init();
scheduler.start();

server.listen(config.PORT, '0.0.0.0', () => {
  log.info(`Thorley Park Timelapse v${VERSION} on http://0.0.0.0:${config.PORT} (${config.baseUrl()}), data in ${config.dataDir()}`);
});

function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  scheduler.stop();
  store.flushAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log.error('uncaughtException', e); });
process.on('unhandledRejection', (e) => { log.error('unhandledRejection', e); });
