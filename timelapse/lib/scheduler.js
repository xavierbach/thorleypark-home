'use strict';
// Capture scheduler: a 5 s tick drives every active job through its state machine and launches
// frame captures on the job's slot grid. Missed slots (sleep, restart, camera down) are logged
// as gaps and never caught up.
//
//   scheduled -> capturing -> finishing -> completed | errored
//        \           \-> cancelled
//         \-> cancelled
const path = require('path');
const config = require('./config');
const store = require('./store');
const cameras = require('./cameras');
const capture = require('./capture');
const schedule = require('./schedule');
const render = require('./render');
const disk = require('./disk');
const power = require('./power');
const alerts = require('./alerts');
const time = require('./time');
const log = require('./log');

const TICK_MS = 5000;
const STALL_MS = 30000;
const inFlight = new Map(); // "jobId:camId" -> startedAt
let timer = null;
let ticking = false;
let lastTickMs = 0;

function key(job, camId) { return `${job.id}:${camId}`; }

function transition(job, to, extra = {}) {
  const from = job.status;
  if (from === to) return;
  job.status = to;
  Object.assign(job, extra);
  if (to === 'capturing' && !job.startedAt) job.startedAt = new Date().toISOString();
  if (['completed', 'cancelled', 'errored'].includes(to)) job.finishedAt = new Date().toISOString();
  store.appendCaptureLog(job.id, { type: 'state', from, to });
  store.saveJob(job, { now: true });
  log.info(`job ${job.id} "${job.name}": ${from} -> ${to}`);
}

function logGap(job, camId, fromSlot, toSlot, missed, reason) {
  job.gaps = (job.gaps || 0) + 1;
  store.appendCaptureLog(job.id, {
    type: 'gap', cam: camId,
    from: fromSlot != null ? time.fmtStamp(fromSlot) : null,
    to: time.fmtStamp(toSlot),
    missed, reason,
  });
  log.warn(`job ${job.id} cam ${camId}: ${missed} missed slot(s) (${reason})`);
}

async function runCapture(job, camId, slotMs) {
  const k = key(job, camId);
  inFlight.set(k, Date.now());
  const settings = config.get();
  const cs = job.cameras[camId];
  const cam = cameras.get(camId);
  const stamp = time.fmtStamp(slotMs);
  const camName = job.cameraNames[camId] || camId;
  try {
    if (!cam || cam.enabled === false) {
      throw new Error(cam ? 'camera disabled' : 'camera deleted');
    }
    const outPath = path.join(store.framesDir(job.id, camId), `${stamp}.jpg`);
    const thumbPath = path.join(store.thumbsDir(job.id, camId), `${stamp}.jpg`);
    const timeoutMs = (settings.captureTimeoutSec || 20) * 1000;
    let r = await capture.grabFrame(cam, { outPath, thumbPath, timeoutMs });
    const iv = schedule.intervalMs(job);
    if (!r.ok && iv >= 10000 && Date.now() + 3000 + timeoutMs < slotMs + iv) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await capture.grabFrame(cam, { outPath, thumbPath, timeoutMs });
    }
    cs.lastCaptureAt = new Date().toISOString();
    cs.lastMs = r.ms;
    cs.lastOk = r.ok;
    if (r.ok) {
      cs.frames = (cs.frames || 0) + 1;
      cs.bytes = (cs.bytes || 0) + r.bytes;
      cs.lastError = null;
      if (cs.consecutiveFailures >= (settings.alertAfterFailures || 10) && cs.alerted) {
        alerts.send(`✅ Timelapse "${job.name}": camera ${camName} is capturing again.`);
      }
      cs.consecutiveFailures = 0;
      cs.alerted = false;
      store.appendCaptureLog(job.id, { type: 'capture', cam: camId, slot: stamp, ok: true, ms: r.ms, bytes: r.bytes });
    } else {
      cs.consecutiveFailures = (cs.consecutiveFailures || 0) + 1;
      cs.lastError = r.error;
      store.appendCaptureLog(job.id, { type: 'capture', cam: camId, slot: stamp, ok: false, ms: r.ms, error: r.error });
      log.warn(`capture failed job=${job.id} cam=${camId}: ${r.error}`);
      const threshold = settings.alertAfterFailures || 10;
      if (cs.consecutiveFailures === threshold && !cs.alerted) {
        cs.alerted = true;
        alerts.send(`⚠️ Timelapse "${job.name}": camera ${camName} has failed ${threshold} captures in a row. Last error: ${r.error}`);
      }
    }
  } catch (e) {
    cs.lastCaptureAt = new Date().toISOString();
    cs.lastOk = false;
    cs.lastError = e.message;
    cs.consecutiveFailures = (cs.consecutiveFailures || 0) + 1;
    store.appendCaptureLog(job.id, { type: 'capture', cam: camId, slot: stamp, ok: false, error: e.message });
    log.error(`capture crashed job=${job.id} cam=${camId}:`, e.message);
  } finally {
    inFlight.delete(k);
    store.saveJob(job);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const settings = config.get();
    const stalled = lastTickMs && now - lastTickMs > STALL_MS ? now - lastTickMs : 0;
    lastTickMs = now;
    await disk.refreshIfStale();
    const d = disk.current();
    const lowDisk = d.freeBytes != null && d.freeBytes < (settings.minFreeGB || 0) * 1e9;

    for (const job of store.activeJobs()) {
      const startMs = schedule.startMs(job), endMs = schedule.endMs(job);
      if (stalled && job.status === 'capturing') {
        store.appendCaptureLog(job.id, { type: 'gap', reason: 'process stalled / sleep', ms: stalled });
      }
      if (job.status === 'scheduled' && now >= startMs) transition(job, 'capturing');
      if (job.status === 'capturing' && now > endMs) {
        transition(job, 'finishing');
        render.enqueueFinal(job);
        continue;
      }
      if (job.status !== 'capturing') continue;

      if (lowDisk) {
        if (!job.pausedReason) {
          job.pausedReason = 'disk';
          store.saveJob(job, { now: true });
          log.warn(`job ${job.id} paused: low disk (${Math.round(d.freeBytes / 1e9)} GB free)`);
          alerts.send(`⚠️ Timelapse paused: only ${Math.round(d.freeBytes / 1e9)} GB free on the MacBook. Free some space to resume "${job.name}".`, { dedupeKey: 'disk', dedupeMs: 6 * 3600 * 1000 });
        }
        continue;
      } else if (job.pausedReason) {
        job.pausedReason = null;
        store.saveJob(job, { now: true });
        log.info(`job ${job.id} resumed`);
      }

      for (const camId of job.cameraIds) {
        const cs = job.cameras[camId];
        if (!cs || cs.removed || inFlight.has(key(job, camId))) continue;
        const slot = schedule.slotFor(job, now);
        if (cs.lastSlotMs != null && slot <= cs.lastSlotMs) continue;
        if (!schedule.inWindow(job, slot, settings)) continue;
        if (inFlight.size >= (settings.maxConcurrentCaptures || 2)) break;
        const missed = schedule.missedSlots(job, cs.lastSlotMs, slot, settings);
        if (missed > 0) logGap(job, camId, cs.lastSlotMs, slot, missed, stalled ? 'process stalled / sleep' : 'scheduler busy or restarted');
        cs.lastSlotMs = slot;
        runCapture(job, camId, slot); // not awaited
      }
    }
    power.setActive(store.activeJobs().some((j) => j.status === 'capturing' || j.status === 'finishing'));
  } catch (e) {
    log.error('scheduler tick failed:', e);
  } finally {
    ticking = false;
  }
}

function onFinalsSettled(job, { anyFailed }) {
  const j = store.getJob(job.id);
  if (!j || j.status !== 'finishing') return;
  if (anyFailed) transition(j, 'errored', { error: 'Final render failed. Use Retry final render.' });
  else transition(j, 'completed', { error: null });
}

// Boot: reconcile counts, make sure finishing jobs have their final renders queued.
function boot() {
  for (const job of store.allJobs()) {
    store.recountFrames(job);
    if (job.status === 'finishing') {
      const st = render.finalsState(job.id);
      if (st.pending === 0) {
        if (st.done > 0 && st.failed === 0) transition(job, 'completed');
        else render.enqueueFinal(job);
      }
    }
    store.saveJob(job, { now: true });
  }
  render.events.on('finalsSettled', onFinalsSettled);
}

function start() {
  boot();
  timer = setInterval(tick, TICK_MS);
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  power.stop();
}

// ---- actions ----
function cancel(job) {
  if (!['scheduled', 'capturing', 'finishing'].includes(job.status)) throw new Error(`Cannot cancel a ${job.status} job`);
  transition(job, 'cancelled');
}

function endNow(job) {
  if (!['scheduled', 'capturing'].includes(job.status)) throw new Error(`Cannot end a ${job.status} job`);
  const now = Date.now();
  if (schedule.startMs(job) > now) job.start = time.isoWithOffset(now - 1000);
  job.end = time.isoWithOffset(now);
  transition(job, 'finishing');
  render.enqueueFinal(job);
}

function retryFinal(job) {
  if (!['errored', 'completed', 'cancelled'].includes(job.status)) throw new Error(`Cannot retry final render for a ${job.status} job`);
  transition(job, 'finishing', { error: null });
  render.enqueueFinal(job);
}

function state() {
  return {
    lastTick: lastTickMs ? new Date(lastTickMs).toISOString() : null,
    inFlight: [...inFlight.keys()],
  };
}

module.exports = { start, stop, tick, cancel, endNow, retryFinal, state, transition };
