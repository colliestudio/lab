import { parse } from '../src/core/io';
import type { CanvasDoc } from '../src/core/doc';
import { resolveNode, type NodeSummary } from './query';

// Thin client for the bridge's HTTP API (used by the CLI and the MCP server). Agents never touch
// Yjs: they send named commands; the bridge runs them as a seated player.

export interface Client {
  doc(): Promise<CanvasDoc>;
  query(q: Record<string, string | undefined>): Promise<NodeSummary[]>;
  cmd(name: string, args: unknown): Promise<{ ok: boolean; error?: string; touched?: string[]; select?: string[]; changed?: number }>;
  undo(redo?: boolean): Promise<{ ok: boolean; error?: string }>;
  log(limit?: number): Promise<{ time: string; actor: string | null; text: string }[]>;
  status(): Promise<unknown>;
  /** Node id for an id or a title (see resolveNode). */
  resolve(ref: string): Promise<string>;
}

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
    resolve: async (ref) => resolveNode(await (async () => parse(await req('/doc')))(), ref).id,
  };
}
