'use strict';
// Sunrise / sunset for a local calendar date using the NOAA solar calculator equations.
// No dependencies. Accuracy is within a minute or two of published tables.
const time = require('./time');

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;

// Core NOAA computation for a Julian day. Returns minutes past UTC midnight of the JD's date.
function noaa(jd, lat, lon) {
  const T = (jd - 2451545) / 36525;
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T)
    + Math.sin(rad(3 * M)) * 0.000289;
  const Ltrue = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = Ltrue - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const delta = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eot = 4 * deg(
    y * Math.sin(2 * rad(L0))
    - 2 * e * Math.sin(rad(M))
    + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * y * y * Math.sin(4 * rad(L0))
    - 1.25 * e * e * Math.sin(2 * rad(M)),
  );
  const phi = rad(lat);
  const cosHA = Math.cos(rad(90.833)) / (Math.cos(phi) * Math.cos(delta)) - Math.tan(phi) * Math.tan(delta);
  const noon = 720 - 4 * lon - eot;
  if (cosHA > 1) return { noon, sunrise: null, sunset: null, polar: 'night' };
  if (cosHA < -1) return { noon, sunrise: null, sunset: null, polar: 'day' };
  const HA = deg(Math.acos(cosHA));
  return { noon, sunrise: noon - 4 * HA, sunset: noon + 4 * HA, polar: null };
}

const cache = new Map();

// { y, m, d } is a LOCAL calendar date (server timezone). Returns epoch ms values.
function times(date, lat, lon) {
  const key = `${date.y}-${date.m}-${date.d}|${lat}|${lon}`;
  if (cache.has(key)) return cache.get(key);
  if (cache.size > 2000) cache.clear();

  // Anchor on the UTC date that contains local noon, then express results as minutes past that UTC midnight.
  const localNoon = new Date(date.y, date.m - 1, date.d, 12, 0, 0).getTime();
  const n = new Date(localNoon);
  const utcMidnight = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  const jdMidnight = utcMidnight / 86400000 + 2440587.5;

  let r = noaa(jdMidnight + 0.5, lat, lon);
  let out;
  if (r.polar) {
    out = { sunrise: null, sunset: null, solarNoon: utcMidnight + r.noon * 60000, polar: r.polar };
  } else {
    // One refinement pass: recompute at the estimated sunrise/sunset instants for ~1 min accuracy.
    const rise = noaa(jdMidnight + r.sunrise / 1440, lat, lon);
    const set = noaa(jdMidnight + r.sunset / 1440, lat, lon);
    const sunrise = rise.polar ? r.sunrise : rise.sunrise;
    const sunset = set.polar ? r.sunset : set.sunset;
    out = {
      sunrise: utcMidnight + sunrise * 60000,
      sunset: utcMidnight + sunset * 60000,
      solarNoon: utcMidnight + r.noon * 60000,
      polar: null,
    };
  }
  cache.set(key, out);
  return out;
}

function timesForMs(ms, lat, lon) {
  return times(time.localDate(ms), lat, lon);
}

module.exports = { times, timesForMs };
