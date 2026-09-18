'use strict';
// Grab one full-resolution frame from a camera into a JPEG, plus a small thumbnail.
// Kinds: ip (snapshot URL via curl, else RTSP via ffmpeg), lavfi (synthetic test source), file.
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const config = require('./config');
const log = require('./log');

const MIN_BYTES = 5000;

// "rtsp://user:pass@host/x" -> { clean: "rtsp://host/x", user, pass }
function splitCreds(url) {
  const m = /^(\w+:\/\/)(?:([^:@\/]*)(?::([^@\/]*))?@)?(.*)$/s.exec(String(url || ''));
  if (!m) return { clean: url, user: null, pass: null };
  return {
    clean: m[1] + m[4],
    user: m[2] != null ? decodeURIComponent(m[2]) : null,
    pass: m[3] != null ? decodeURIComponent(m[3]) : null,
  };
}

function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function validJpeg(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MIN_BYTES) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0xff && buf[1] === 0xd8;
  } catch (e) {
    return false;
  }
}

function rmSilent(file) {
  try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
}

function baseArgs() {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
}

function inputArgsFor(camera) {
  switch (camera.kind) {
    case 'ip':
      return ['-rtsp_transport', 'tcp', '-i', camera.rtspUrl];
    case 'lavfi': {
      // Small offset so successive test frames differ (testsrc2 draws a running clock).
      const ss = String(Math.floor((Date.now() / 1000) % 30));
      return ['-f', 'lavfi', '-ss', ss, '-i', camera.lavfiSpec || 'testsrc2=size=1280x720:rate=1'];
    }
    case 'file':
      return ['-i', camera.filePath];
    default:
      throw new Error(`Unknown camera kind: ${camera.kind}`);
  }
}

function thumbArgs(thumbPath, width) {
  return ['-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', '-f', 'image2', thumbPath];
}

// Make a thumbnail from an existing JPEG. Returns true on success.
async function makeThumb(src, dst, width) {
  const info = ffmpeg.locate();
  if (!info.ok) return false;
  ensureDirFor(dst);
  const r = await ffmpeg.run(info.ffmpeg, [...baseArgs(), '-i', src, ...thumbArgs(dst, width)], { timeoutMs: 20000 });
  return r.code === 0 && fs.existsSync(dst);
}

function errorMessage(r, what) {
  if (r.timedOut) return `${what} timed out after ${Math.round(r.ms / 1000)}s`;
  const lines = (r.stderrTail || '').trim().split('\n');
  const lastLine = lines[lines.length - 1] || '';
  return `${what} exited ${r.code}${lastLine ? ': ' + lastLine.slice(0, 200) : ''}`;
}

// Returns { ok, ms, bytes, width, height, error, stderrTail }.
async function grabFrame(camera, { outPath, thumbPath = null, timeoutMs = 20000, wantDims = false } = {}) {
  const settings = config.get();
  const started = Date.now();
  const part = outPath + '.part';
  ensureDirFor(outPath);
  if (thumbPath) ensureDirFor(thumbPath);
  const thumbWidth = settings.thumbWidth || 320;
  const result = { ok: false, ms: 0, bytes: 0, width: null, height: null, error: null, stderrTail: null };

  try {
    let r;
    const useSnapshot = camera.kind === 'ip' && camera.snapshotUrl;
    if (useSnapshot) {
      const { clean, user, pass } = splitCreds(camera.snapshotUrl);
      const args = ['-sS', '--fail', '-L', '--max-time', String(Math.max(2, Math.ceil(timeoutMs / 1000))), '-o', part];
      if (user != null) args.push('--anyauth', '-u', `${user}:${pass || ''}`);
      args.push(clean);
      r = await ffmpeg.run('curl', args, { timeoutMs: timeoutMs + 3000 });
      if (r.code !== 0 || !validJpeg(part)) {
        result.error = r.code === 0 ? 'snapshot response is not a JPEG' : errorMessage(r, 'curl');
        result.stderrTail = r.stderrTail;
        rmSilent(part);
        return result;
      }
      fs.renameSync(part, outPath);
      if (thumbPath) await makeThumb(outPath, thumbPath, thumbWidth);
    } else {
      const info = ffmpeg.locate();
      if (!info.ok) { result.error = info.error; return result; }
      const args = [...baseArgs(), ...inputArgsFor(camera), '-frames:v', '1', '-q:v', '2', '-f', 'image2', part];
      if (thumbPath) args.push(...thumbArgs(thumbPath, thumbWidth));
      r = await ffmpeg.run(info.ffmpeg, args, { timeoutMs });
      if (r.code !== 0 || !validJpeg(part)) {
        result.error = r.code === 0 ? 'ffmpeg produced no usable frame' : errorMessage(r, 'ffmpeg');
        result.stderrTail = r.stderrTail;
        rmSilent(part);
        if (thumbPath) rmSilent(thumbPath);
        return result;
      }
      fs.renameSync(part, outPath);
    }
    result.ok = true;
    result.bytes = fs.statSync(outPath).size;
    if (wantDims) {
      const d = await ffmpeg.probeDimensions(outPath);
      if (d) { result.width = d.width; result.height = d.height; }
    }
    return result;
  } catch (e) {
    rmSilent(part);
    result.error = e.message;
    log.error('grabFrame error', camera.id || camera.name, e.message);
    return result;
  } finally {
    result.ms = Date.now() - started;
  }
}

module.exports = { grabFrame, makeThumb, splitCreds, validJpeg };
