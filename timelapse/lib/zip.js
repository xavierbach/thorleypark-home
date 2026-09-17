'use strict';
// Stream a directory of frames as a zip (stored, no compression: JPEG does not compress) using
// the system `zip` binary, so nothing is buffered on disk.
const { spawn } = require('child_process');
const log = require('./log');

function streamDirAsZip(req, res, dir, filename) {
  const safeName = filename.replace(/["\r\n]/g, '');
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'no-store',
  });
  const child = spawn('zip', ['-0', '-q', '-r', '-', '.'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (e) => { log.error('zip spawn failed:', e.message); try { res.destroy(); } catch (x) { /* ignore */ } });
  child.on('close', (code) => { if (code !== 0) log.error(`zip exited ${code}: ${stderr.trim()}`); });
  res.on('close', () => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } });
  child.stdout.pipe(res);
}

module.exports = { streamDirAsZip };
