'use strict';
// Console logging with an in-memory ring buffer (for /api/log) and credential redaction.

const RING_SIZE = 500;
const ring = [];

// Mask "scheme://user:pass@host" -> "scheme://user:***@host"
function redact(s) {
  return String(s).replace(/(\w+:\/\/[^\/\s:@]+:)[^@\/\s]+@/g, '$1***@');
}

function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }).join(' ');
}

function push(level, args) {
  const line = { t: new Date().toISOString(), level, msg: redact(fmt(args)) };
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
  const out = `${line.t} [${level}] ${line.msg}`;
  if (level === 'error') console.error(out);
  else console.log(out);
}

module.exports = {
  info: (...a) => push('info', a),
  warn: (...a) => push('warn', a),
  error: (...a) => push('error', a),
  recent: (limit = 200) => ring.slice(-limit),
  redact,
};
