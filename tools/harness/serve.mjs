#!/usr/bin/env node
/**
 * serve.mjs — tiny dependency-free static file server for the NOCTURNE repo root.
 *
 *   node tools/harness/serve.mjs [port]            (default port 8787)
 *   node tools/harness/serve.mjs --root <dir> [port]
 *
 * or programmatically:
 *
 *   import { startServer } from './serve.mjs';
 *   const srv = await startServer(repoRoot, 0);   // port 0 = pick a free port
 *   console.log(srv.url); ... await srv.close();
 *
 * Behaviour: GET/HEAD only, correct MIME types for everything the app ships,
 * `Cache-Control: no-store` on every response, directories redirect to a
 * trailing slash and serve their index.html, single-range requests are honoured
 * (so <audio>/<video> seeking works), path traversal is rejected.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function send(res, status, headers, body) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function createHandler(root, { log } = {}) {
  const absRoot = path.resolve(root);
  return function handle(req, res) {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'Method Not Allowed');
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request');
    }
    if (pathname.includes('\0')) return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request');

    const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(absRoot, rel);
    if (filePath !== absRoot && !filePath.startsWith(absRoot + path.sep)) {
      return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
    }

    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isDirectory()) {
        if (!pathname.endsWith('/')) {
          return send(res, 301, { Location: url.pathname + '/' + url.search, 'Content-Type': 'text/plain' }, 'Moved');
        }
        filePath = path.join(filePath, 'index.html');
        return fs.stat(filePath, (err2, stat2) => {
          if (err2 || !stat2.isFile()) return notFound();
          serveFile(filePath, stat2);
        });
      }
      if (err || !stat.isFile()) return notFound();
      serveFile(filePath, stat);
    });

    function notFound() {
      if (pathname === '/favicon.ico') {
        // browsers fetch this implicitly; an absent favicon is noise, not an app bug
        if (log) log(`204 ${method} ${pathname}`);
        return send(res, 204, {}, '');
      }
      if (log) log(`404 ${method} ${pathname}`);
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, `Not found: ${pathname}`);
    }

    function serveFile(fp, stat) {
      const headers = {
        'Content-Type': mimeFor(fp),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Last-Modified': stat.mtime.toUTCString(),
      };
      const size = stat.size;
      const range = req.headers.range;
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m && (m[1] !== '' || m[2] !== '')) {
          if (m[1] === '') {
            const suffix = Math.min(size, parseInt(m[2], 10));
            start = size - suffix;
          } else {
            start = parseInt(m[1], 10);
            if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
          }
          if (start > end || start >= size) {
            return send(res, 416, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'text/plain' }, 'Range Not Satisfiable');
          }
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
      }
      headers['Content-Length'] = String(end - start + 1);
      if (log) log(`${status} ${method} ${pathname}`);
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      if (method === 'HEAD' || size === 0) return res.end();
      const stream = fs.createReadStream(fp, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      stream.pipe(res);
    }
  };
}

/**
 * Start the static server.
 * @param {string} root directory to serve
 * @param {number} [port=0] TCP port (0 = free port)
 * @param {{host?: string, log?: (line: string) => void}} [opts]
 * @returns {Promise<{server: import('node:http').Server, port: number, host: string, url: string, root: string, close: () => Promise<void>}>}
 */
export function startServer(root, port = 0, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const server = http.createServer(createHandler(root, { log: opts.log }));
  server.keepAliveTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        host,
        url: `http://${host}:${actualPort}`,
        root: path.resolve(root),
        close: () =>
          new Promise((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let port = 8787;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--port') port = parseInt(argv[++i], 10);
    else if (/^\d+$/.test(argv[i])) port = parseInt(argv[i], 10);
  }
  startServer(root, port, { log: (line) => process.stderr.write(line + '\n') })
    .then((srv) => {
      process.stderr.write(`NOCTURNE static server: ${srv.url}/  (root ${srv.root})\n`);
      const stop = () => srv.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      process.stderr.write(`serve.mjs: ${err.message}\n`);
      process.exit(1);
    });
}
