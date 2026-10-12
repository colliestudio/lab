import { describeDiff, diffFile, mergeFile, stableSerialize, withZ, type FileDiff } from './canonical';
import type { CanvasDoc, CanvasEdge, CanvasNode, Change, DocView } from './doc';
import { parse } from './io';
import type { Store } from './store';

// The board as text, and the way back (DOM-free; the editor is jsonPanel.ts). The text is the
// canonical .canvas JSON (the same serializer the bridge writes to disk), as one viewer may see it:
// plugins' redactors mask secret fields and leave out nodes that viewer must not know exist.
// An edit goes back through the bridge's 3-way field merge: only what the person changed relative to
// the text they started from is applied, so what others changed meanwhile survives.

/** What a masked field shows instead of its value (a card's face). Read-only: never written back. */
export const MASK = '▒ hidden ▒';

export type Redactor = (node: CanvasNode, ctx: { doc: DocView; viewer: string }) => CanvasNode | null;

/** The saved form of the live doc, as `viewer` may see it: redacted nodes, no edges to omitted ones. */
export function redactedDoc(store: Store, redactors: readonly Redactor[], viewer: string): CanvasDoc {
  return redact(store, redactors, viewer).doc;
}

function redact(store: Store, redactors: readonly Redactor[], viewer: string): { doc: CanvasDoc; gone: Set<string> } {
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
  return { doc: { ...out, nodes, edges }, gone };
}

/** Canonical text of what `viewer` may see. */
export const viewText = (store: Store, redactors: readonly Redactor[], viewer: string) => stableSerialize(redactedDoc(store, redactors, viewer));

const hasMask = (v: unknown): boolean => v === MASK || (!!v && typeof v === 'object' && Object.values(v).some(hasMask));

/** What may change on a node that holds secrets (or holds nodes that do): where it is and how it looks. */
const OPEN_KEYS = new Set(['x', 'y', 'width', 'height', 'z', 'color']);

/**
 * Why `c` may not be applied, if it touches a value this viewer can't see. Masked values are
 * read-only: writing over one would change a secret blind (another player's card face), and a copy
 * of one would write the mask itself.
 */
function maskError(c: Change, base: Map<string, CanvasNode>): string | undefined {
  if (c.op === 'add') return hasMask(c.node) ? `${c.node.id}: a hidden value (${MASK}) can't be copied` : undefined;
  if (c.op !== 'set') return;
  const dot = c.key.indexOf('.');
  const was = base.get(c.id) as Record<string, unknown> | undefined;
  const top = was?.[dot < 0 ? c.key : c.key.slice(0, dot)];
  const before = dot < 0 ? top : (top as Record<string, unknown> | undefined)?.[c.key.slice(dot + 1)];
  if (hasMask(before)) return `${c.id}: hidden values (${MASK}) can't be edited`;
  if (hasMask(c.value)) return `${c.id}: a hidden value (${MASK}) can't be copied`;
}

export type Plan = { ok: true; changes: Change[]; summary: FileDiff['summary']; text: string } | { ok: false; error: string };

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
  private base!: CanvasDoc;
  private shown!: string;
  /** Nodes the base text masks or leaves out. */
  private secret = new Set<string>();

  constructor(
    private store: Store,
    private redactors: readonly Redactor[],
    private viewer: () => string,
  ) {
    this.refresh();
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
    const r = redact(this.store, this.redactors, this.viewer());
    this.shown = stableSerialize(r.doc);
    this.base = withZ(parse(this.shown));
    this.secret = new Set([...r.gone, ...this.base.nodes.filter(hasMask).map((n) => n.id)]);
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
    const baseById = new Map(this.base.nodes.map((n) => [n.id, n]));
    // a secret's container decides who sees it (a hand's owner, what it shows): as locked as the secret
    const holders = new Set([...this.secret].flatMap((id) => live.parentOf(id) ?? []));
    for (const c of d.changes) {
      const masked = maskError(c, baseById);
      if (masked) return { ok: false, error: masked };
      if (c.op === 'set' && !OPEN_KEYS.has(c.key) && (this.secret.has(c.id) || holders.has(c.id)))
        return { ok: false, error: `${c.id}: holds something hidden from you; only its position, size and color can be changed here (${c.key})` };
      // a new node's id may belong to one this viewer can't see (or one added meanwhile): adding would replace it
      if (c.op === 'add' && live.get(c.node.id)) return { ok: false, error: `${c.node.id}: that id is already used on the board` };
    }
    return { ok: true, changes: d.changes, summary: d.summary, text: `edited the JSON: ${describeDiff(d.summary)}` };
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
      const r = this.store.dispatch('core.patch', { changes: p.changes });
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
