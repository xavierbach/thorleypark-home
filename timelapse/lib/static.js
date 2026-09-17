'use strict';
// Static file serving + sendFile with HTTP Range support (needed for <video> seeking in Safari).
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendFile(req, res, absPath, opts = {}) {
  let st;
  try {
    st = fs.statSync(absPath);
    if (!st.isFile()) throw new Error('not a file');
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const headers = {
    'Content-Type': opts.mime || mimeFor(absPath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cacheControl || 'no-cache',
  };
  if (opts.download) {
    const name = (opts.filename || path.basename(absPath)).replace(/["\r\n]/g, '');
    headers['Content-Disposition'] = `attachment; filename="${name}"`;
  }
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1; }
      else { const suffix = parseInt(m[2], 10); start = Math.max(0, st.size - suffix); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(absPath, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Serve a file from publicDir for the given URL path, with a directory traversal guard.
function serveStatic(req, res, publicDir, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(publicDir, rel.split('?')[0]);
  if (!abs.startsWith(publicDir + path.sep) && abs !== publicDir) {
    res.writeHead(403); return res.end('Forbidden');
  }
  const ext = path.extname(abs);
  sendFile(req, res, abs, { cacheControl: ext === '.html' ? 'no-cache' : 'public, max-age=300' });
}

module.exports = { MIME, mimeFor, sendFile, serveStatic };
