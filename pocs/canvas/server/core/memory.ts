import type { BoardInfo, BoardStorage } from './storage';

/** BoardStorage in Maps: for tests (no fs), and as the reference for what a driver must do. */
export class MemoryStorage implements BoardStorage {
  mutable = true;
  readonly files = new Map<string, string>();
  readonly states = new Map<string, Uint8Array>();
  readonly trash = new Map<string, string>();
  private mtimes = new Map<string, number>();
  private watchers = new Map<string, Set<() => void>>();
  /** How many times each board was read (the lazy-load tests count these). */
  readonly reads = new Map<string, number>();
  watching = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(files)) this.put(k, v);
  }

  private put(name: string, text: string) {
    this.files.set(name, text);
    this.mtimes.set(name, Date.now());
  }

  async list(): Promise<BoardInfo[]> {
    return [...this.files].map(([name, t]) => ({ name, modified: this.mtimes.get(name), size: t.length }));
  }
  async read(name: string) {
    this.reads.set(name, (this.reads.get(name) ?? 0) + 1);
    return this.files.get(name);
  }
  async write(name: string, text: string, expect?: { from: string | undefined }) {
    if (expect && this.files.get(name) !== expect.from) return false;
    this.put(name, text);
    return true;
  }
  async create(name: string, text: string) {
    if (this.files.has(name)) return false;
    this.put(name, text);
    return true;
  }
  async rename(from: string, to: string) {
    if (this.files.has(to)) throw new Error(`${to} exists`);
    this.put(to, this.files.get(from)!);
    this.files.delete(from);
    const st = this.states.get(from);
    if (st) this.states.set(to, st);
    this.states.delete(from);
  }
  async remove(name: string) {
    this.trash.set(name, this.files.get(name) ?? '');
    this.files.delete(name);
    this.states.delete(name);
  }
  async readState(name: string) {
    return this.states.get(name);
  }
  async writeState(name: string, data: Uint8Array) {
    this.states.set(name, data);
  }
  watch(name: string, onChange: () => void) {
    const set = this.watchers.get(name) ?? new Set();
    this.watchers.set(name, set);
    set.add(onChange);
    this.watching++;
    return () => {
      if (set.delete(onChange)) this.watching--;
    };
  }
  location(name: string) {
    return `memory:${name}`;
  }

  /** An edit from outside (an editor): replaces the text and fires the board's watcher. */
  externalWrite(name: string, text: string) {
    this.put(name, text);
    for (const fn of this.watchers.get(name) ?? []) fn();
  }
}
