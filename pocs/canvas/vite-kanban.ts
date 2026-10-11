import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

// Dev only: the kanban plugin's "dev folder". KANBAN_ROOT=/some/backlog-project serves that folder to
// the page at /__kanban (list / read / write .md and .yml files inside it), for browsers without the
// File System Access API and for headless checks. Nothing outside the root, nothing but text files.
export function kanbanDevFolder(root = process.env.KANBAN_ROOT): Plugin {
  return {
    name: 'kanban-dev-folder',
    configureServer(server) {
      const base = root ? realpathSync(root) : undefined;
      const inside = (rel: string) => {
        if (!base) return undefined;
        const p = path.resolve(base, rel || '.');
        return p === base || p.startsWith(base + path.sep) ? p : undefined;
      };
      server.middlewares.use('/__kanban', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const send = (code: number, body: unknown, type = 'application/json') => {
          res.statusCode = code;
          res.setHeader('content-type', type);
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (url.pathname === '/info') return send(200, { enabled: !!base, name: base ? path.basename(base) : null });
        const p = inside(url.searchParams.get('path') ?? '');
        if (!p) return send(403, { error: 'outside the root (or KANBAN_ROOT unset)' });
        try {
          if (url.pathname === '/list' && req.method === 'GET') {
            const ents = await fs.readdir(p, { withFileTypes: true });
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
