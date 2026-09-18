'use strict';
// Locate ffmpeg/ffprobe and run external binaries with a hard timeout.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('./config');
const log = require('./log');

let info = null; // { ffmpeg, ffprobe, version, ok, error }
let lastFailAt = 0;
const RETRY_MS = 30 * 1000; // a failed lookup is re-tried, never cached for good (slow first exec after a reboot)

const CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];

function tryVersion(bin) {
  try {
    const out = execFileSync(bin, ['-version'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /ffmpeg version (\S+)/.exec(out);
    return m ? m[1] : 'unknown';
  } catch (e) {
    return null;
  }
}

function locate(force = false) {
  if (info && !force && (info.ok || Date.now() - lastFailAt < RETRY_MS)) return info;
  const custom = (config.get().ffmpegPath || '').trim();
  const list = custom ? [custom] : CANDIDATES;
  for (const bin of list) {
    const version = tryVersion(bin);
    if (version) {
      let probe = 'ffprobe';
      if (bin.includes('/')) {
        const p = path.join(path.dirname(bin), 'ffprobe');
        probe = fs.existsSync(p) ? p : 'ffprobe';
      }
      info = { ffmpeg: bin, ffprobe: probe, version, ok: true, error: null };
      log.info(`ffmpeg ${version} at ${bin}`);
      return info;
    }
  }
  info = {
    ffmpeg: null, ffprobe: null, version: null, ok: false,
    error: custom ? `ffmpeg not found at ${custom}` : 'ffmpeg not found. Install with: brew install ffmpeg',
  };
  lastFailAt = Date.now();
  log.warn(info.error);
  return info;
}

function redactArgs(args) {
  return args.map((a) => log.redact(a)).join(' ');
}

// Spawn a process; resolve with { code, signal, timedOut, ms, stdout, stderrTail }.
// SIGKILL is used on timeout because ffmpeg can ignore SIGTERM while blocked in network I/O.
function run(bin, args, opts = {}) {
  const { timeoutMs = 30000, cwd, onStdoutLine, onSpawn, nice = 0, env } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    let cmd = bin, cmdArgs = args;
    if (nice > 0 && process.platform !== 'win32') { cmd = 'nice'; cmdArgs = ['-n', String(nice), bin, ...args]; }
    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, signal: null, timedOut: false, ms: 0, stdout: '', stderrTail: e.message });
    }
    if (onSpawn) onSpawn(child);
    let stdout = '';
    let stdoutBuf = '';
    const stderrLines = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (onStdoutLine) {
        stdoutBuf += s;
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          onStdoutLine(stdoutBuf.slice(0, idx));
          stdoutBuf = stdoutBuf.slice(idx + 1);
        }
      } else if (stdout.length < 64 * 1024) {
        stdout += s;
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (stderrLines.length > 40) stderrLines.shift();
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, timedOut, ms: Date.now() - started, stdout, stderrTail: e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ms: Date.now() - started, stdout, stderrTail: log.redact(stderrLines.join('\n')) });
    });
  });
}

// Image dimensions via ffprobe; returns { width, height } or null.
async function probeDimensions(file) {
  const i = locate();
  if (!i.ok) return null;
  const r = await run(i.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeoutMs: 15000 });
  const m = /(\d+),(\d+)/.exec(r.stdout || '');
  return m ? { width: +m[1], height: +m[2] } : null;
}

module.exports = { locate, run, redactArgs, probeDimensions };
