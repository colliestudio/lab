import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { Guard } from './guard';

// The built web app, served next to the API by `canvas serve`:
//  /            home.html (the board list)
//  /b/<name>    index.html (the board app; it reads the name from the path)
//  elsewhere    a file under the app folder, or 404
// /api, /ws and /mcp are never ours. The files are the same public code as the hosted app, so they skip the
// Origin and Sec-Fetch-Site rules (a link from another site must open the page); the Host rule stays
// (DNS rebinding), and board data only moves through the guarded /api and /ws.

export interface StaticApp {
  /** Answers the request and returns true, or returns false when it isn't a static request. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

const RESERVED = /^\/(api|ws|mcp)(\/|$)/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticApp(root: string, guard: Guard): StaticApp {
  const base = resolve(root);

  function notFound(res: ServerResponse) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}\n');
  }

  function text(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
    res.end(body);
  }

  /** The regular file at `file` if it lies inside the app folder (symlinks out don't count), else undefined. */
  async function inside(file: string): Promise<string | undefined> {
    try {
      const real = await realpath(file);
      const realBase = await realpath(base);
      if (!real.startsWith(realBase + sep)) return undefined;
      return (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async handle(req, res) {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://service');
      } catch {
        // `//%` and the like: not a URL, so not ours to guess at; never let it escape as an exception
        text(res, 400, 'bad request target');
        return true;
      }
      if (RESERVED.test(url.pathname)) return false;
      if (!guard.hostAllowed(req.headers)) {
        text(res, 403, `Host ${req.headers.host ?? '(none)'} is not allowed`);
        return true;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        text(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return true;
      }
      const path = url.pathname;
      let rel: string;
      if (path === '/') rel = 'home.html';
      else if (path === '/b' || path === '/b/') {
        res.writeHead(302, { location: '/' });
        res.end();
        return true;
      } else if (path.startsWith('/b/')) rel = 'index.html';
      else {
        let p: string;
        try {
          p = decodeURIComponent(path);
        } catch {
          text(res, 400, 'bad URL encoding');
          return true;
        }
        const segments = p.slice(1).split('/');
        if (/[\0\\]/.test(p) || segments.some((s) => s === '..' || s.startsWith('.'))) {
          notFound(res);
          return true;
        }
        rel = p.slice(1);
      }
      const html = rel === 'home.html' || rel === 'index.html';
      const file = resolve(base, rel);
      if (!file.startsWith(base + sep)) {
        notFound(res);
        return true;
      }
      const real = await inside(file);
      if (!real) {
        if (html) text(res, 503, `canvas serve: no web app build in ${base}; run \`pnpm build\` (the API at /api still works)`);
        else notFound(res);
        return true;
      }
      let body: Buffer;
      try {
        body = await readFile(real);
      } catch {
        notFound(res);
        return true;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'x-content-type-options': 'nosniff',
        // the pages load outside the guard's cross-site rule, so no other site may frame them (clickjacking)
        ...(html ? { 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' } : {}),
        'cache-control': html ? 'no-cache' : path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    },
  };
}
