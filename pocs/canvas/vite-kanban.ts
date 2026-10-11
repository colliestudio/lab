import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const LOOPBACK = new Set([undefined, false, 'localhost', '127.0.0.1', '::1']);

/** Does Vite's `server.host` bind to loopback only? (`--host` sets `true` = all interfaces.) */
export const bindsLoopback = (host: string | boolean | undefined) => LOOPBACK.has(host);

/** Is a request's Host header a local name? localhost, 127.0.0.1, [::1], *.localhost (the Mini dev proxy
 * rewrites Host to `<app>.localhost`, so mini.internal still counts). Port ignored. */
export function localHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')).toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name.endsWith('.localhost');
}

// Dev only: the kanban plugin's "dev folder". KANBAN_ROOT=/some/backlog-project serves that folder to
// the page at /__kanban (list / read / write .md and .yml files inside it), for browsers without the
// File System Access API and for headless checks. Nothing outside the root, nothing but text files.
// `/__kanban/info` also says whether the /backlog-api proxy is on (BACKLOG_URL set; see vite.config.ts).
// When the server binds beyond loopback (`vite --host`), /__kanban and /backlog-api answer only requests
// whose Host is local, so other machines on the network can't read or write through them.
export function kanbanDevFolder(root = process.env.KANBAN_ROOT, backlogUrl = process.env.BACKLOG_URL): Plugin {
  return {
    name: 'kanban-dev-folder',
    configureServer(server) {
      // registered here (before Vite's own middlewares), so it runs ahead of the /backlog-api proxy
      server.middlewares.use((req, res, next) => {
        const u = req.url ?? '';
        if (!(u.startsWith('/__kanban') || u.startsWith('/backlog-api'))) return next();
        const deny = (code: number, error: string) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error }));
        };
        if (!bindsLoopback(server.config.server.host) && !localHostHeader(req.headers.host)) return deny(403, 'kanban dev endpoints answer only localhost / *.localhost hosts');
        // no proxy registered: answer here rather than fall through to the SPA's index.html
        if (u.startsWith('/backlog-api') && !backlogUrl) return deny(404, 'no Backlog.md server: start vite with BACKLOG_URL=…');
        next();
      });
      const base = root ? realpathSync(root) : undefined;
      const within = (p: string) => !!base && (p === base || p.startsWith(base + path.sep));
      const inside = (rel: string) => {
        if (!base) return undefined;
        const p = path.resolve(base, rel || '.');
        if (!within(p)) return undefined;
        // a symlink inside the root may point outside it: check the real path of the deepest existing part
        let real = p;
        for (;;) {
          try {
            real = path.join(realpathSync(real), path.relative(real, p));
            break;
          } catch {
            const up = path.dirname(real);
            if (up === real) return undefined;
            real = up;
          }
        }
        return within(real) ? p : undefined;
      };
      server.middlewares.use('/__kanban', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const send = (code: number, body: unknown, type = 'application/json') => {
          res.statusCode = code;
          res.setHeader('content-type', type);
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (url.pathname === '/info') return send(200, { enabled: !!base, name: base ? path.basename(base) : null, service: !!backlogUrl });
        const p = inside(url.searchParams.get('path') ?? '');
        if (!p) return send(403, { error: 'outside the root (or KANBAN_ROOT unset)' });
        try {
          if (url.pathname === '/list' && req.method === 'GET') {
            // a missing folder is an answer (null), not an error
            const ents = await fs.readdir(p, { withFileTypes: true }).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
            if (!ents) return send(200, 'null');
            const out = await Promise.all(
              ents
                .filter((e) => !e.name.startsWith('.'))
                .map(async (e) => {
                  if (e.isDirectory()) return { name: e.name, kind: 'dir', stamp: '' };
                  const st = await fs.stat(path.join(p, e.name));
                  return { name: e.name, kind: 'file', stamp: `${st.mtimeMs}:${st.size}` };
                }),
            );
            return send(200, out);
          }
          if (url.pathname === '/read' && req.method === 'GET') return send(200, await fs.readFile(p, 'utf8'), 'text/plain; charset=utf-8');
          if (url.pathname === '/write' && req.method === 'PUT') {
            if (!/\.(md|ya?ml)$/.test(p)) return send(403, { error: 'only .md / .yml' });
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.writeFile(p, Buffer.concat(chunks).toString('utf8'));
            return send(200, { ok: true });
          }
          return send(404, { error: 'unknown' });
        } catch (e) {
          return send((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, { error: (e as Error).message });
        }
      });
    },
  };
}
