'use strict';
// Time helpers. All scheduling maths is done in epoch ms; strings are for storage and display.
// Local time means the timezone of the machine running the server (the Mac), never the phone's.

const crypto = require('crypto');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

// Date -> "2026-09-10T07:00:00+10:00" in the server's local zone
function isoWithOffset(d) {
  d = new Date(d);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Accepts "YYYY-MM-DDTHH:MM[:SS]" (interpreted as server-local wall clock) or any ISO string with an offset.
// Returns epoch ms or NaN.
function parseDateTime(s) {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  return new Date(s).getTime();
}

// epoch ms -> "YYYY-MM-DDTHH:MM" for <input type="datetime-local">
function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Frame filename stamp, UTC, sortable: 20260910T070000Z
function fmtStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function parseStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(String(s));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Local compact stamp for render filenames: 20260912-1430
function fmtLocalCompact(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// "06:30" -> 390 (minutes), null if invalid
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Local calendar date parts of an instant
function localDate(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function localDateKey(ms) {
  const { y, m, d } = localDate(ms);
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Local date parts + minutes past midnight -> epoch ms (DST-aware via the Date constructor)
function localDateAtMinutes({ y, m, d }, minutes) {
  return new Date(y, m - 1, d, 0, minutes, 0, 0).getTime();
}

function addLocalDays({ y, m, d }, n) {
  const dt = new Date(y, m - 1, d + n, 12, 0, 0);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}

function randomId(prefix, n = 6) {
  return `${prefix}_${crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, n).toLowerCase()}`;
}

function timezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'unknown'; }
}

module.exports = {
  pad, isoWithOffset, parseDateTime, toLocalInput, fmtStamp, parseStamp, fmtLocalCompact,
  parseHHMM, localDate, localDateKey, localDateAtMinutes, addLocalDays, slug, randomId, timezone,
};
