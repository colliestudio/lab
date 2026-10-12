import { describeDiff, diffFile, mergeFile, stableSerialize, withZ, type FileDiff } from './canonical';
import type { CanvasDoc, CanvasEdge, CanvasNode, Change, DocView } from './doc';
import { parse } from './io';
import type { Store } from './store';

// The board as text, and the way back (DOM-free; the editor is jsonPanel.ts). The text is the
// canonical .canvas JSON (the same serializer the bridge writes to disk), as one viewer may see it:
// plugins' redactors mask secret fields and leave out nodes that viewer must not know exist.
// An edit goes back through the bridge's 3-way field merge: only what the person changed relative to
// the text they started from is applied, so what others changed meanwhile survives.

/** What a masked field shows instead of its value (a card's face). Never written back. */
export const MASK = '▒ hidden ▒';

export type Redactor = (node: CanvasNode, ctx: { doc: DocView; viewer: string }) => CanvasNode | null;

/** The saved form of the live doc, as `viewer` may see it: redacted nodes, no edges to omitted ones. */
export function redactedDoc(store: Store, redactors: readonly Redactor[], viewer: string): CanvasDoc {
  const doc = store.doc;
  const out = store.exportDoc();
  const gone = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const n of out.nodes) {
    let r: CanvasNode | null = n;
    for (const f of redactors) {
      r = f(r, { doc, viewer });
      if (!r) break;
    }
    if (r) nodes.push(r);
    else gone.add(n.id);
  }
  const edges = out.edges.filter((e: CanvasEdge) => !gone.has(e.fromNode) && !gone.has(e.toNode));
  return { ...out, nodes, edges };
}

/** Canonical text of what `viewer` may see. */
export const viewText = (store: Store, redactors: readonly Redactor[], viewer: string) => stableSerialize(redactedDoc(store, redactors, viewer));

/** A masked value must never reach the doc: drop any field (or plugin sub-field) that still says MASK. */
function unmask(c: Change): Change | null {
  if (c.op === 'set') return c.value === MASK ? null : c;
  if (c.op !== 'add') return c;
  const clean = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v === MASK ? [] : [[k, v && typeof v === 'object' && !Array.isArray(v) ? clean(v as Record<string, unknown>) : v]])));
  return { op: 'add', node: clean(c.node as unknown as Record<string, unknown>) as unknown as CanvasNode };
}

export type Plan = { ok: true; changes: Change[]; summary: FileDiff['summary']; text: string; touched: string[] } | { ok: false; error: string };

/** "line 3 column 5" from a JSON.parse error, if it says where. */
function jsonError(e: unknown, text: string): string {
  const msg = (e as Error).message;
  const pos = /position (\d+)/.exec(msg);
  if (pos && !/line \d+/.test(msg)) {
    const before = text.slice(0, Number(pos[1]));
    const line = before.split('\n').length;
    return `${msg} (line ${line})`;
  }
  return msg;
}

export class JsonSession {
  /** The text as last shown / applied, parsed with z: what the next edit is measured from. */
  private base: CanvasDoc;
  private shown: string;

  constructor(
    private store: Store,
    private redactors: readonly Redactor[],
    private viewer: () => string,
  ) {
    this.shown = this.current();
    this.base = withZ(parse(this.shown));
  }

  /** The canonical text of the live doc for this viewer. */
  current(): string {
    return viewText(this.store, this.redactors, this.viewer());
  }

  /** The text last handed out by `refresh`. */
  get text() {
    return this.shown;
  }

  /** Take the live doc as the new starting point (the editor now shows it). */
  refresh(): string {
    this.shown = this.current();
    this.base = withZ(parse(this.shown));
    return this.shown;
  }

  /** What applying `text` would do, or why it can't. Changes are measured from the text last shown. */
  plan(text: string): Plan {
    try {
      JSON.parse(text);
    } catch (e) {
      return { ok: false, error: jsonError(e, text) };
    }
    let next: CanvasDoc & { skipped?: string[] };
    try {
      next = parse(text);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    // an edge whose node is gone is dropped (as deleting the node does); a broken node is an error
    const bad = (next.skipped ?? []).filter((x) => x.startsWith('node'));
    if (bad.length) return { ok: false, error: `not valid .canvas: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''} (a node needs a unique id, a type, x, y, width and height)` };
    const live = this.store.doc;
    const cur: CanvasDoc = { nodes: live.nodes, edges: live.edges, extra: live.extra };
    const nextDoc = { nodes: next.nodes, edges: next.edges, extra: next.extra };
    if (diffFile(this.base, nextDoc).extra) return { ok: false, error: 'top-level fields other than nodes and edges are read-only here' };
    const d = mergeFile(this.base, cur, nextDoc);
    const changes = d.changes.flatMap((c) => {
      const u = unmask(c);
      return u ? [u] : [];
    });
    const touched = [...d.summary.added, ...d.summary.changed];
    return { ok: true, changes, summary: d.summary, text: `edited the JSON: ${describeDiff(d.summary)}`, touched };
  }

  /**
   * Apply `text` as the person: one undo step, one log line with counts only. On success the session
   * moves on to the new live text (`refresh`), which the caller shows.
   */
  apply(text: string): { ok: true; line: string | null; shown: string } | { ok: false; error: string } {
    const p = this.plan(text);
    if (!p.ok) return p;
    let line: string | null = null;
    if (p.changes.length) {
      const r = this.store.dispatch('core.patch', { changes: p.changes, text: p.text, targets: p.touched });
      if (!r.ok) return { ok: false, error: r.error ?? 'could not apply' };
      line = p.text;
    }
    return { ok: true, line, shown: this.refresh() };
  }
}

// --------------------------------------------------------------------------- where a node is in the text

export interface Block {
  kind: 'nodes' | 'edges';
  id: string;
  from: number;
  to: number;
}

/**
 * The `{…}` ranges of the entries of the top-level `nodes` and `edges` arrays, with their ids. Works
 * on text that is only partly valid (stops at what it can't read), so the panel keeps following the
 * caret while someone types.
 */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const stack: { t: '{' | '['; key?: string; start?: number }[] = [];
  let lastKey: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const str = text.slice(i + 1, j);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === ':' && stack.at(-1)?.t === '{') {
        try {
          lastKey = JSON.parse(`"${str}"`);
        } catch {
          lastKey = str;
        }
      }
      i = j;
    } else if (ch === '{' || ch === '[') {
      const parent = stack.at(-1);
      const entry = ch === '{' && parent?.t === '[' && stack.length === 2 && (parent.key === 'nodes' || parent.key === 'edges');
      stack.push({ t: ch, key: lastKey, start: entry ? i : undefined });
      lastKey = undefined;
    } else if (ch === '}' || ch === ']') {
      const top = stack.pop();
      if (top?.start !== undefined) {
        const parent = stack.at(-1)!;
        try {
          const id = JSON.parse(text.slice(top.start, i + 1)).id;
          if (typeof id === 'string') out.push({ kind: parent.key as 'nodes' | 'edges', id, from: top.start, to: i + 1 });
        } catch {
          // an entry that isn't valid yet has no id to follow
        }
      }
    }
  }
  return out;
}

/** The node entry the caret `pos` is inside (or on), if any. */
export function nodeAt(text: string, pos: number): string | undefined {
  return blocks(text).find((b) => b.kind === 'nodes' && pos >= b.from && pos <= b.to)?.id;
}
