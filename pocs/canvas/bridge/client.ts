import { parse } from '../src/core/io';
import type { CanvasDoc } from '../src/core/doc';
import type { ChatMessage } from '../src/core/chat';
import { resolveNode, type NodeSummary } from '../src/core/query';

// Thin client for the bridge's HTTP API (used by the CLI and the MCP server). Agents never touch
// Yjs: they send named commands; the bridge runs them as a seated player.

export interface Client {
  doc(): Promise<CanvasDoc>;
  query(q: Record<string, string | undefined>): Promise<NodeSummary[]>;
  cmd(name: string, args: unknown): Promise<{ ok: boolean; error?: string; touched?: string[]; select?: string[]; changed?: number }>;
  undo(redo?: boolean): Promise<{ ok: boolean; error?: string }>;
  log(limit?: number): Promise<{ time: string; actor: string | null; text: string }[]>;
  status(): Promise<unknown>;
  /** A plugin view as this actor (e.g. chess.state); throws its error. */
  view<T = any>(name: string, args?: Record<string, string | undefined>): Promise<T>;
  /** Long-poll a view until it's ready (e.g. chess.turn); `{waiting: true}` after `timeoutS`. */
  wait<T = any>(name: string, args?: Record<string, string | undefined>, timeoutS?: number): Promise<T | { waiting: true }>;
  /** Say something in the table chat; `node` = id of a node it is about. */
  say(text: string, node?: string): Promise<ChatMessage>;
  /** Last `limit` messages, or only those since you last looked (`onlyNew`). Either marks everything as seen. */
  chatRead(opts?: { limit?: number; onlyNew?: boolean }): Promise<ChatMessage[]>;
  /** Long-poll for new messages from others; `[]` after `timeoutS` with none. */
  chatWait(timeoutS?: number): Promise<ChatMessage[]>;
  /** Node id for an id or a title (see resolveNode). */
  resolve(ref: string): Promise<string>;
}

const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined));

export function client(opts: { url?: string; as?: string; kind?: 'agent' | 'tool' } = {}): Client {
  const base = (opts.url ?? process.env.CANVAS_BRIDGE ?? 'http://localhost:5222').replace(/\/+$/, '');
  const as = opts.as ?? process.env.CANVAS_AS ?? 'Claude';
  const kind = opts.kind ?? 'agent';
  const req = async (path: string, init?: { body: unknown }) => {
    let res: Response;
    try {
      res = await fetch(base + path, init ? { method: 'POST', body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : undefined);
    } catch {
      throw new Error(`can't reach the canvas bridge at ${base} (start it: pnpm bridge <file.canvas>)`);
    }
    const text = await res.text();
    return text;
  };
  const json = async (path: string, init?: { body: unknown }) => JSON.parse(await req(path, init));
  return {
    doc: async () => parse(await req('/doc')),
    query: (q) => json(`/query?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]))}`),
    cmd: (name, args) => json('/cmd', { body: { as, kind, name, args } }),
    undo: (redo = false) => json(redo ? '/redo' : '/undo', { body: { as, kind } }),
    log: (limit = 20) => json(`/log?limit=${limit}`),
    status: () => json('/status'),
    view: async (name, args = {}) => {
      const r = await json(`/view/${name}?${qs({ ...args, as, kind })}`);
      if (r?.error) throw new Error(r.error);
      return r;
    },
    wait: async (name, args = {}, timeoutS = 50) => {
      const r = await json(`/wait/${name}?${qs({ ...args, as, kind, timeout: String(timeoutS) })}`);
      if (r?.error && !r.waiting) throw new Error(r.error);
      return r;
    },
    say: async (text, node) => {
      const r = await json('/chat/say', { body: { as, kind, text, node } });
      if (!r.ok) throw new Error(r.error ?? 'failed');
      return r.message;
    },
    chatRead: async (o = {}) => {
      const r = await json(`/chat/read?${qs({ as, kind, limit: o.limit ? String(o.limit) : undefined, new: o.onlyNew ? '1' : undefined })}`);
      if (!Array.isArray(r)) throw new Error(r?.error ?? 'unexpected reply');
      return r;
    },
    chatWait: async (timeoutS = 50) => {
      const r = await json(`/chat/wait?${qs({ as, kind, timeout: String(timeoutS) })}`);
      if (Array.isArray(r)) return r;
      if (r?.waiting) return [];
      throw new Error(r?.error ?? 'unexpected reply');
    },
    resolve: async (ref) => resolveNode(await (async () => parse(await req('/doc')))(), ref).id,
  };
}
