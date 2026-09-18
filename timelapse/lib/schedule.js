'use strict';
// Pure scheduling maths. Everything is epoch ms. No I/O, no state.
//
// A job's capture "slots" sit on a grid anchored at the job start: start + n * interval.
// A slot is captured only if it falls inside the job's daily window (none / daily / sun).
// Windows are half-open [a, b) intervals in the server's local time.
const time = require('./time');
const sun = require('./sun');

function startMs(job) { return time.parseDateTime(job.start); }
function endMs(job) { return time.parseDateTime(job.end); }
function intervalMs(job) { return Math.max(1, Math.round(job.intervalSec)) * 1000; }

// Latest slot at or before now (never earlier than start).
function slotFor(job, nowMs) {
  const s = startMs(job), iv = intervalMs(job);
  if (nowMs <= s) return s;
  return s + Math.floor((nowMs - s) / iv) * iv;
}

// Capture windows intersected with [fromMs, toMs).
function windows(job, fromMs, toMs, settings) {
  if (!(toMs > fromMs)) return [];
  const w = job.window || { mode: 'none' };
  if (!w.mode || w.mode === 'none') return [[fromMs, toMs]];
  const out = [];
  let day = time.addLocalDays(time.localDate(fromMs), -1);
  const last = time.localDate(toMs);
  for (let guard = 0; guard < 20000; guard++) {
    let a = 0, b = 0;
    if (w.mode === 'daily') {
      const s = time.parseHHMM(w.dailyStart), e = time.parseHHMM(w.dailyEnd);
      if (s == null || e == null) return [[fromMs, toMs]];
      a = time.localDateAtMinutes(day, s);
      b = e > s ? time.localDateAtMinutes(day, e) : time.localDateAtMinutes(time.addLocalDays(day, 1), e);
    } else if (w.mode === 'sun') {
      const t = sun.times(day, settings.lat, settings.lon);
      if (t.polar === 'day') {
        a = time.localDateAtMinutes(day, 0);
        b = time.localDateAtMinutes(time.addLocalDays(day, 1), 0);
      } else if (t.polar === 'night') {
        a = b = 0;
      } else {
        a = t.sunrise - (Number(w.sunBeforeMin) || 0) * 60000;
        b = t.sunset + (Number(w.sunAfterMin) || 0) * 60000;
      }
    } else {
      return [[fromMs, toMs]];
    }
    if (b > a) {
      const ca = Math.max(a, fromMs), cb = Math.min(b, toMs);
      if (cb > ca) out.push([ca, cb]);
    }
    if (day.y === last.y && day.m === last.m && day.d === last.d) break;
    day = time.addLocalDays(day, 1);
  }
  return out;
}

function inWindow(job, tMs, settings) {
  return windows(job, tMs, tMs + 1, settings).length > 0;
}

// Number of grid slots inside [a, b).
function countSlots(job, a, b) {
  const s = startMs(job), iv = intervalMs(job);
  const first = s + Math.ceil((a - s) / iv) * iv;
  if (first >= b) return 0;
  return Math.floor((b - 1 - first) / iv) + 1;
}

function firstSlotAtOrAfter(job, a) {
  const s = startMs(job), iv = intervalMs(job);
  return s + Math.ceil((a - s) / iv) * iv;
}

// Next slot the scheduler will capture for a camera, or null if none remain.
function nextCaptureAt(job, camState, nowMs, settings) {
  const s = startMs(job), e = endMs(job), iv = intervalMs(job);
  const last = camState && camState.lastSlotMs != null ? camState.lastSlotMs : -Infinity;
  const from = Math.max(s, last + iv, slotFor(job, nowMs));
  for (const [a, b] of windows(job, from, e + 1, settings)) {
    const first = firstSlotAtOrAfter(job, a);
    if (first < b && first <= e) return first;
  }
  return null;
}

// In-window slots strictly between lastSlot and slot (missed captures).
function missedSlots(job, lastSlotMs, slotMs, settings) {
  if (lastSlotMs == null || !(slotMs > lastSlotMs)) return 0;
  const iv = intervalMs(job);
  let n = 0;
  for (const [a, b] of windows(job, lastSlotMs + iv, slotMs, settings)) n += countSlots(job, a, b);
  return n;
}

// Total in-window slots between start and end (frames per camera if nothing is missed).
function estimateFrames(job, settings) {
  const s = startMs(job), e = endMs(job);
  let n = 0;
  for (const [a, b] of windows(job, s, e + 1, settings)) n += countSlots(job, a, b);
  const days = Math.max(1 / 24, (e - s) / 86400000);
  return { frames: n, perDay: n / days, days };
}

module.exports = {
  startMs, endMs, intervalMs, slotFor, windows, inWindow, countSlots, nextCaptureAt, missedSlots, estimateFrames,
};
