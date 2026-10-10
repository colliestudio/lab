import { applyChanges, emptyDoc, type CanvasDoc, type Change } from './doc';

/** Everything non-deterministic a command may use; injectable for tests / replay. */
export interface CommandCtx {
  newId(): string;
  random(): number;
}

export interface CommandResult {
  changes: Change[];
  /** New selection, if the command wants to set one. */
  select?: string[];
}

/** A command reads the doc and returns changes. It never mutates. */
export type Command<A = any> = (doc: CanvasDoc, args: A, ctx: CommandCtx) => CommandResult | Change[];

export function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export const defaultCtx: CommandCtx = { newId, random: Math.random };

export function runCommand<A>(cmd: Command<A>, doc: CanvasDoc, args: A, ctx: CommandCtx = defaultCtx): CommandResult {
  const r = cmd(doc, args, ctx);
  return Array.isArray(r) ? { changes: r } : r;
}

export class Store {
  doc: CanvasDoc = emptyDoc();
  selection: ReadonlySet<string> = new Set();
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();

  constructor(public ctx: CommandCtx = defaultCtx) {}

  register(name: string, cmd: Command) {
    if (this.commands.has(name)) throw new Error(`command already registered: ${name}`);
    this.commands.set(name, cmd);
  }

  has(name: string) {
    return this.commands.has(name);
  }

  dispatch<A>(name: string, args: A): CommandResult {
    const cmd = this.commands.get(name);
    if (!cmd) throw new Error(`unknown command: ${name}`);
    const res = runCommand(cmd, this.doc, args, this.ctx);
    if (res.changes.length) this.doc = applyChanges(this.doc, res.changes);
    if (res.select) this.selection = new Set(res.select);
    else if (res.changes.some((c) => c.op === 'del')) {
      const alive = new Set(this.doc.nodes.map((n) => n.id));
      this.selection = new Set([...this.selection].filter((id) => alive.has(id)));
    }
    if (res.changes.length || res.select) this.emit();
    return res;
  }

  setDoc(doc: CanvasDoc) {
    this.doc = doc;
    this.selection = new Set();
    this.emit();
  }

  select(ids: Iterable<string>) {
    this.selection = new Set(ids);
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
