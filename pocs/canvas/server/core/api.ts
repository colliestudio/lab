import { queryNodes } from '../../src/core/query';
import { FORMAT_VERSION, FormatError } from '../../src/core/format';
import { makeActor, type Actor } from './host';
import { BoardFileError, DirError } from './errors';
import type { Board } from './board';
import type { BoardDirectory } from './directory';

// The HTTP API of a board, as plain functions from a request to a reply: agents and tools
// (bridge/cli.ts, bridge/mcp.ts) call it, and a transport (server/node/http.ts) carries it.

export interface ApiRequest {
  method: string;
  /** Path below the board's root: "/doc", "/agent/run". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** The parsed JSON body ({} when empty). Rejects on invalid JSON. */
  body(): Promise<any>;
}

export interface ApiReply {
  status: number;
  json?: unknown;
  /** Sent as is, as application/json (/doc: the canonical file text). */
  raw?: string;
}

const ok = (json: unknown, status = 200): ApiReply => ({ status, json });
const fail = (status: number, error: string): ApiReply => ({ status, json: { error } });

function actorOf(b: { as?: string; kind?: string } | undefined, headers: ApiRequest['headers']): Actor {
  const name = b?.as ?? headers['x-canvas-as'] ?? 'Agent';
  return makeActor(String(name).slice(0, 32), b?.kind === 'tool' ? 'tool' : 'agent');
}

const waitMs = (q: Record<string, string | undefined>) => Math.min(Math.max(Number(q.timeout ?? 50), 1), 290) * 1000;

/** One board's API: /doc /query /log /status /view/* /wait/* /agent/* /chat/* /cmd /undo /redo. */
export async function boardApi(board: Board, req: ApiRequest): Promise<ApiReply> {
  const host = board.host;
  const { method, path, query } = req;
  const q = Object.fromEntries(query) as Record<string, string | undefined>;
  const log = board.log;
  try {
    if (method === 'GET' && path === '/doc') return { status: 200, raw: host.fileText() };
    if (method === 'GET' && path === '/query') return ok(queryNodes(host.store.doc, q, host.store.summaryExt));
    if (method === 'GET' && path === '/log') {
      const n = Number(query.get('limit')) || 20;
      return ok(host.store.log.toArray().slice(-n).map((e) => ({ time: new Date(e.time).toISOString(), actor: e.actor?.name ?? null, actorId: e.actor?.id ?? null, text: e.text, targets: e.targets })));
    }
    if (method === 'GET' && path === '/status') {
      const { name, ...rest } = board.status();
      return ok({ name, file: board.location(), ...rest });
    }
    const viewMatch = method === 'GET' && /^\/(view|wait)\/([\w.-]+)$/.exec(path);
    if (viewMatch) {
      const actor = actorOf({ as: q.as, kind: q.kind }, req.headers);
      try {
        // args as one JSON value (typed: numbers, lists), else the plain query parameters
        const args = q.args ? JSON.parse(q.args) : Object.fromEntries(Object.entries(q).filter(([k]) => !['as', 'kind', 'timeout', 'args'].includes(k)));
        if (viewMatch[1] === 'view') {
          const v = host.view(actor, viewMatch[2], args);
          return v === undefined ? fail(400, `${viewMatch[2]} has nothing yet (it only has something once it is ready: wait for it)`) : ok(v);
        }
        const ms = waitMs(q);
        const v = await host.wait(actor, viewMatch[2], args, ms);
        return ok(v === undefined ? { waiting: true, error: `still not ready after ${ms / 1000}s; wait again` } : v);
      } catch (e) {
        return fail(400, (e as Error).message);
      }
    }
    // what a plugin tells agents (guides, commands with their arguments and examples, views)
    if (method === 'GET' && path === '/agent/help') {
      try {
        const plugin = query.get('plugin') ?? undefined;
        const name = query.get('command') ?? undefined;
        return ok(query.has('text') ? { text: host.catalog.helpText(plugin, name) } : host.catalog.helpJson(plugin, name));
      } catch (e) {
        return fail(400, (e as Error).message);
      }
    }
    // a command as an agent: args checked against the plugin's description, node titles resolved
    if (method === 'POST' && path === '/agent/run') {
      const b = await req.body();
      const actor = actorOf(b, req.headers);
      const r = host.run(actor, String(b.name), b.args ?? {});
      if (!r.ok) return ok({ ok: false, error: r.error }, 400);
      if (r.changed) log(`${actor.name}: ${b.name} ${JSON.stringify(b.args ?? {}).slice(0, 120)}`);
      return ok({ ok: true, result: r.result, text: r.text, undescribed: r.undescribed, changed: r.changed });
    }
    // chat: say / read / wait as an actor (see ideas/chat.md); the messages live in the doc
    if (method === 'POST' && path === '/chat/say') {
      const b = await req.body();
      const actor = actorOf(b, req.headers);
      try {
        const m = host.say(actor, String(b.text ?? ''), b.node ? String(b.node) : undefined);
        log(`${actor.name}: said ${JSON.stringify(m.text.slice(0, 80))}`);
        return ok({ ok: true, message: m });
      } catch (e) {
        return ok({ ok: false, error: (e as Error).message }, 400);
      }
    }
    if (method === 'GET' && path === '/chat/read') {
      const actor = actorOf({ as: q.as, kind: q.kind }, req.headers);
      return ok(host.readChat(actor, { limit: Number(q.limit) || undefined, onlyNew: q.new === '1' || q.new === 'true' }));
    }
    if (method === 'GET' && path === '/chat/wait') {
      const actor = actorOf({ as: q.as, kind: q.kind }, req.headers);
      const ms = waitMs(q);
      const msgs = await host.waitChat(actor, ms);
      return ok(msgs ?? { waiting: true, error: `no new messages after ${ms / 1000}s; wait again` });
    }
    if (method === 'POST' && path === '/cmd') {
      const b = await req.body();
      const actor = actorOf(b, req.headers);
      const r = host.dispatch(actor, String(b.name), b.args ?? {});
      if (r.ok && r.changes.length) log(`${actor.name}: ${b.name} ${JSON.stringify(b.args ?? {}).slice(0, 120)}`);
      return ok({ ok: r.ok, error: r.error, changed: r.changes.length, touched: r.touched, select: r.select }, r.ok ? 200 : 400);
    }
    if (method === 'POST' && (path === '/undo' || path === '/redo')) {
      const b = await req.body();
      const actor = actorOf(b, req.headers);
      let done: boolean;
      try {
        done = host.undo(actor, path === '/redo');
      } catch (e) {
        return ok({ ok: false, error: (e as Error).message }, 400);
      }
      return ok({ ok: done, error: done ? undefined : `nothing to ${path.slice(1)} for ${actor.name} (each actor undoes only its own steps, while it stays seated)` });
    }
    return fail(404, 'GET /doc /query /log /status /agent/help?plugin=&command= /view/<name>?args=JSON /wait/<name>?timeout=S /chat/read?new=1&limit=N /chat/wait?timeout=S; POST /agent/run {as,name,args} /chat/say {as,text,node} /cmd {as,name,args} (raw) /undo {as} /redo {as}');
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}

// ------------------------------------------------------------ the service: many boards

const OPS = new Set(['rename', 'delete']);

/**
 * The directory's own routes: /api/info, /api/boards (list, create), /api/boards/<name>/rename and
 * /delete. undefined = not ours (a board's own route is `serviceApi`'s job).
 */
export async function directoryApi(dir: BoardDirectory, req: ApiRequest): Promise<ApiReply | undefined> {
  const { method, path } = req;
  try {
    if (method === 'GET' && path === '/api/info') return ok({ service: 'canvas-serve', format: FORMAT_VERSION, mutable: dir.mutable });
    if (path === '/api/boards') {
      if (method === 'GET') return ok(await dir.list());
      if (method === 'POST') return ok({ name: await dir.create(String((await req.body()).name ?? '')) }, 201);
      return undefined;
    }
    const m = /^\/api\/boards\/([^/]+)\/(rename|delete)$/.exec(path);
    if (m && method === 'POST' && OPS.has(m[2])) {
      const name = decodeName(m[1]);
      if (m[2] === 'rename') return ok({ name: await dir.rename(name, String((await req.body()).to ?? '')) });
      await dir.remove(name);
      return ok({ ok: true });
    }
    return undefined;
  } catch (e) {
    return errorReply(e);
  }
}

/** Everything under /api: the directory's routes, else a board's own (/api/boards/<name>/<route>, loaded on first use). undefined = not under /api. */
export async function serviceApi(dir: BoardDirectory, req: ApiRequest): Promise<ApiReply | undefined> {
  if (!req.path.startsWith('/api/')) return undefined;
  const own = await directoryApi(dir, req);
  if (own) return own;
  const m = /^\/api\/boards\/([^/]+)(\/.*)$/.exec(req.path);
  if (!m) return fail(404, 'GET /api/info /api/boards; POST /api/boards {name} /api/boards/<name>/rename {to} /api/boards/<name>/delete; a board: /api/boards/<name>/doc /status /agent/run …');
  try {
    return await dir.use(decodeName(m[1]), (b) => boardApi(b, { ...req, path: m[2] }));
  } catch (e) {
    return errorReply(e);
  }
}

function decodeName(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new DirError(400, 'the board name in the path is not valid URL encoding');
  }
}

/** DirError carries its HTTP status; a board in a newer or invalid format is a conflict, an unreadable file a 422 (both with a `kind`); anything else is a 500. */
export function errorReply(e: unknown): ApiReply {
  if (e instanceof DirError) return fail(e.status, e.message);
  if (e instanceof FormatError) return { status: 409, json: { error: e.message, kind: e.newer ? 'newer' : 'invalid' } };
  if (e instanceof BoardFileError) return { status: 422, json: { error: e.message, kind: 'invalid' } };
  return fail(500, (e as Error).message);
}
