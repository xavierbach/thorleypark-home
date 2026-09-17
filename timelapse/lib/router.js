'use strict';
// Minimal method + pattern router for the JSON API. Patterns like /api/jobs/:id/renders/:rid.
// Handlers receive { req, res, params, query, body } and either return a value (sent as JSON 200)
// or write the response themselves and return undefined.
const log = require('./log');

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const routes = [];
const MAX_BODY = 1024 * 1024;

function add(method, pattern, handler) {
  const keys = [];
  const src = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  routes.push({ method, re: new RegExp('^' + src + '$'), keys, handler });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, detail) {
  sendJson(res, status, { error: message, detail: detail === undefined ? undefined : String(detail) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Returns true if a route matched (response written), false otherwise.
async function dispatch(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const query = Object.fromEntries(url.searchParams.entries());
    try {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
      const out = await r.handler({ req, res, params, query, body });
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
      else if (out === undefined && !res.headersSent) res.end();
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) sendError(res, e.status, e.message, e.detail);
      } else {
        log.error(`${req.method} ${pathname} failed:`, e);
        if (!res.headersSent) sendError(res, 500, 'Internal error', e.message);
      }
    }
    return true;
  }
  if (pathMatched) { sendError(res, 405, 'Method not allowed'); return true; }
  return false;
}

module.exports = { add, dispatch, sendJson, sendError, HttpError };
