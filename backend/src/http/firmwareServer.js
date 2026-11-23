import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

function safePath(root, relative) {
  const resolvedRoot = path.resolve(root); const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return target;
}

export function createFirmwareMiddleware(firmwareDir) {
  return async (req, res, next) => {
    if (!req.path.startsWith('/firmware/')) return next();
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); res.writeHead(405); return res.end(); }
      const decoded = decodeURIComponent(new URL(req.url, 'https://localhost').pathname);
      const match = /^\/firmware\/(esp32|stm32)\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)\/(manifest\.json|firmware\.bin)$/.exec(decoded);
      if (!match) { res.writeHead(404); return res.end(); }
      const file = safePath(firmwareDir, path.join(match[1], match[2], match[3]));
      if (!file) { res.writeHead(400); return res.end(); }
      const root = await realpath(firmwareDir); const actual = await realpath(file);
      if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) { res.writeHead(404); return res.end(); }
      const info = await stat(file); if (!info.isFile()) { res.writeHead(404); return res.end(); }
      const isManifest = match[3] === 'manifest.json'; const range = !isManifest ? req.headers.range : null;
      let start = 0; let end = info.size - 1; let partial = false;
      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!parsed) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
        if (parsed[1] === '') { const suffix = Number(parsed[2]); if (!suffix) { res.writeHead(416); return res.end(); } start = Math.max(0, info.size - suffix); }
        else { start = Number(parsed[1]); if (parsed[2]) end = Number(parsed[2]); }
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
        end = Math.min(end, info.size - 1); partial = true;
      }
      const headers = { 'Content-Type': isManifest ? 'application/json' : 'application/octet-stream', 'Accept-Ranges': isManifest ? 'none' : 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      res.writeHead(partial ? 206 : 200, headers);
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(file, { start, end }), res);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  };
}
