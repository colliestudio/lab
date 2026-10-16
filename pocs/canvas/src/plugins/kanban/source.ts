// The tracker behind a kanban board, as the board sees it. The sync, the commands and the panel know
// only this interface; the serve supplies the adapter (server/kanban/backlogMd.ts for Backlog.md).
// A Trello, Linear, GitHub Projects or ClickUp adapter would implement the same six calls: tokens and
// webhook receivers stay inside the adapter's constructor and `watch`; what a tracker can't do is off
// in `caps`. Types and an in-memory adapter for tests: Node- and browser-safe, no I/O.

import { ID_RE, type AcItem, type CommentItem, type SectionKey } from './markdown';

export type { SectionKey } from './markdown';

export interface SourceInfo {
  /** The project's name. */
  name: string;
  /** Columns in board order: Backlog.md statuses, Trello lists, Linear states, GitHub Status options. */
  columns: string[];
  defaultColumn: string;
  /** The column that collapses to its recent cards (the last status). */
  doneColumn?: string;
  labels: string[];
  priorities?: string[];
  caps: {
    sections: SectionKey[];
    checklist: boolean;
    comments: boolean;
    /** How order is expressed: a number (ordinal, pos, sortOrder), "after" another card, or not at all. */
    order: 'number' | 'after' | 'none';
    /** `nextId` works: new cards get their id before they are written. */
    nextId: boolean;
  };
}

export interface Card {
  id: string;
  title: string;
  column: string;
  order?: number;
  labels: string[];
  assignee: string[];
  priority?: string;
  parent?: string;
  created?: string;
  updated?: string;
  url?: string;
  sections: Partial<Record<SectionKey, string>>;
  /** Backlog.md acceptance criteria; a Trello checklist; a GitHub task list. */
  checklist: AcItem[];
  comments: CommentItem[];
}

export interface CardPatch {
  title?: string;
  column?: string;
  /** A number for ordinal / pos / sortOrder (null = none); `after` for position-relative APIs. */
  order?: number | null;
  after?: string | null;
  labels?: string[];
  assignee?: string[];
  priority?: string | null;
  sections?: Partial<Record<SectionKey, string>>;
  /** The full list; the adapter writes the minimal change. */
  checklist?: AcItem[];
  /** Appended. */
  comment?: { author?: string; text: string };
}

export interface NewCard extends Omit<CardPatch, 'comment' | 'after' | 'column' | 'priority' | 'order'> {
  title: string;
  column: string;
  order?: number;
  priority?: string;
  parent?: string;
  /** The id the board already showed for it; used when still free, else the adapter picks another. */
  preferId?: string;
}

export interface WriteOpts {
  now: Date;
}

export type SourceErrorCode = 'not-found' | 'invalid' | 'io';

/** What an adapter throws: the board shows `message`, never a path or a token. */
export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface TrackerSource {
  /** 'backlog-md', 'memory'. */
  readonly kind: string;
  list(): Promise<{ info: SourceInfo; cards: Card[] }>;
  /** null: no such card, or an id that is not one (nothing is looked up for it). */
  read(id: string): Promise<Card | null>;
  /** Apply a patch and return the card as stored now. Rejects with SourceError. */
  write(id: string, patch: CardPatch, o: WriteOpts): Promise<Card>;
  create(card: NewCard, o: WriteOpts): Promise<Card>;
  /** `onChange` runs (debounced) after the tracker changed by any means, our own writes included. Returns the stop function. */
  watch(onChange: () => void): () => void;
  /** caps.nextId: the id a new card gets next (per parent for subcards). */
  nextId?(parent?: string): Promise<string>;
}

// ------------------------------------------------------------ in-memory adapter (tests, contract suite)

const clone = <T>(v: T): T => structuredClone(v);

export class MemSource implements TrackerSource {
  readonly kind = 'memory';
  private cards = new Map<string, Card>();
  private watchers = new Set<() => void>();
  writes = 0;
  /** Set to make the next write fail (a read-only file, a folder gone). */
  failNext: string | undefined;

  constructor(
    readonly info: SourceInfo,
    cards: Card[] = [],
  ) {
    for (const c of cards) this.cards.set(c.id, clone(c));
  }

  static info(columns = ['To Do', 'In Progress', 'Done'], over: Partial<SourceInfo> = {}): SourceInfo {
    return { name: 'mem', columns, defaultColumn: columns[0], doneColumn: columns.at(-1), labels: [], caps: { sections: ['description', 'plan', 'notes'], checklist: true, comments: true, order: 'number', nextId: true }, ...over };
  }

  static card(id: string, over: Partial<Card> = {}): Card {
    return { id, title: id, column: 'To Do', labels: [], assignee: [], sections: {}, checklist: [], comments: [], ...over };
  }

  async list() {
    return { info: clone(this.info), cards: [...this.cards.values()].map(clone) };
  }

  async read(id: string) {
    const c = ID_RE.test(id) ? this.cards.get(id.toUpperCase()) : undefined;
    return c ? clone(c) : null;
  }

  private checkFail() {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = undefined;
      throw new SourceError('io', m);
    }
  }

  async write(id: string, p: CardPatch, o: WriteOpts) {
    this.checkFail();
    const c = ID_RE.test(id) ? this.cards.get(id.toUpperCase()) : undefined;
    if (!c) throw new SourceError('not-found', `no card ${id}`);
    this.apply(c, p, o.now);
    this.writes++;
    this.fire();
    return clone(c);
  }

  private apply(c: Card, p: CardPatch, now: Date) {
    let bump = false;
    if (p.title !== undefined && p.title !== c.title) ((c.title = p.title), (bump = true));
    if (p.column !== undefined && p.column !== c.column) {
      if (!this.info.columns.includes(p.column)) throw new SourceError('invalid', `no column "${p.column}" (columns: ${this.info.columns.join(', ')})`);
      c.column = p.column;
      bump = true;
    }
    if (p.order !== undefined) c.order = p.order ?? undefined;
    if (p.labels) ((c.labels = [...p.labels]), (bump = true));
    if (p.assignee) ((c.assignee = [...p.assignee]), (bump = true));
    if (p.priority !== undefined) ((c.priority = p.priority ?? undefined), (bump = true));
    for (const [k, v] of Object.entries(p.sections ?? {}) as [SectionKey, string][]) {
      if (v) c.sections[k] = v;
      else delete c.sections[k];
      bump = true;
    }
    if (p.checklist) ((c.checklist = clone(p.checklist)), (bump = true));
    if (p.comment) {
      c.comments.push({ author: p.comment.author, created: now.toISOString().slice(0, 16).replace('T', ' '), text: p.comment.text });
      bump = true;
    }
    if (bump) c.updated = now.toISOString().slice(0, 16).replace('T', ' ');
  }

  async nextId(parent?: string) {
    let max = 0;
    const base = parent?.toUpperCase();
    for (const id of this.cards.keys()) {
      if (base) {
        if (id.startsWith(`${base}.`)) max = Math.max(max, Number(id.slice(base.length + 1).split('.')[0]));
      } else max = Math.max(max, Number(/-(\d+)/.exec(id)?.[1] ?? 0));
    }
    return base ? `${base}.${max + 1}` : `TASK-${max + 1}`;
  }

  async create(n: NewCard, o: WriteOpts) {
    this.checkFail();
    if (!this.info.columns.includes(n.column)) throw new SourceError('invalid', `no column "${n.column}" (columns: ${this.info.columns.join(', ')})`);
    const pref = n.preferId && ID_RE.test(n.preferId) ? n.preferId.toUpperCase() : undefined;
    const id = pref && !this.cards.has(pref) ? pref : await this.nextId(n.parent);
    const stamp = o.now.toISOString().slice(0, 16).replace('T', ' ');
    const c = MemSource.card(id, { title: n.title, column: n.column, order: n.order, labels: n.labels ?? [], assignee: n.assignee ?? [], priority: n.priority, parent: n.parent, created: stamp, sections: n.sections ?? {}, checklist: n.checklist ?? [] });
    this.cards.set(id, c);
    this.writes++;
    this.fire();
    return clone(c);
  }

  watch(onChange: () => void) {
    this.watchers.add(onChange);
    return () => void this.watchers.delete(onChange);
  }

  get watching() {
    return this.watchers.size;
  }

  private fire() {
    for (const w of [...this.watchers]) w();
  }

  // --- the tracker changing without us (an outside edit)
  outside(id: string, p: CardPatch, now = new Date()) {
    const c = this.cards.get(id);
    if (!c) throw new Error(`no card ${id}`);
    this.apply(c, p, now);
    this.fire();
  }
  outsideRemove(id: string) {
    this.cards.delete(id);
    this.fire();
  }
  outsideAdd(c: Card) {
    this.cards.set(c.id, clone(c));
    this.fire();
  }
}
