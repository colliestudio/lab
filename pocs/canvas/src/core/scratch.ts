import { applyChanges, type CanvasDoc, type Change, type DocView } from './doc';
import type { EventSpec } from './log';
import type { CommandCtx, CommandResult, Store } from './store';

/**
 * Run several commands in a row inside one command: each call sees the doc as the calls before it
 * left it (a plain copy, nothing is applied to the live doc). Collect the changes and return them as
 * one result: one transaction, one undo step, one sync update. Lets a command (an automation button,
 * later a script on the host) compose existing commands without the store knowing.
 */
export class Scratch {
  private plain: CanvasDoc;
  private cached: DocView | null;
  /** Everything the calls changed, in order (undoable). */
  readonly changes: Change[] = [];
  /** Changes that stay when the step is undone (a game clock). */
  readonly untracked: Change[] = [];
  /** Events the calls reported (computed against the doc right after each call). */
  readonly events: EventSpec[] = [];
  /** Calls that failed (unknown command or a throw), for the caller to report. */
  readonly failures: string[] = [];

  constructor(
    private store: Store,
    doc: DocView,
    readonly ctx: CommandCtx,
  ) {
    this.plain = { nodes: doc.nodes, edges: doc.edges, extra: doc.extra };
    this.cached = doc;
  }

  /** The doc as the calls so far left it. */
  get doc(): DocView {
    return (this.cached ??= this.store.viewOf(this.plain));
  }

  /**
   * Run command `name` against the current scratch doc. `untracked`: its changes stay on undo.
   * Unknown command or a throw → `{ ok: false }`, nothing changes.
   */
  call(name: string, args: unknown, opts: { untracked?: boolean } = {}): { ok: boolean; error?: string; result?: CommandResult } {
    const cmd = this.store.command(name);
    if (!cmd) return this.fail(`unknown command: ${name}`);
    let res: CommandResult;
    try {
      const r = cmd(this.doc, args, this.ctx);
      res = Array.isArray(r) ? { changes: r } : r;
    } catch (e) {
      return this.fail(`${name}: ${(e as Error).message}`);
    }
    const all = [...(res.untracked ?? []), ...res.changes];
    if (all.length) {
      this.plain = applyChanges(this.plain, all);
      this.cached = null;
    }
    if (opts.untracked) this.untracked.push(...all);
    else {
      this.untracked.push(...(res.untracked ?? []));
      this.changes.push(...res.changes);
    }
    if (res.events) {
      try {
        this.events.push(...(typeof res.events === 'function' ? res.events(this.doc) : res.events));
      } catch {
        /* an event text that can't be computed is just not told */
      }
    }
    return { ok: true, result: res };
  }

  private fail(error: string) {
    this.failures.push(error);
    return { ok: false, error };
  }

  /** Apply changes of the caller's own (not from a command). */
  push(changes: Change[], opts: { untracked?: boolean } = {}) {
    if (!changes.length) return;
    this.plain = applyChanges(this.plain, changes);
    this.cached = null;
    (opts.untracked ? this.untracked : this.changes).push(...changes);
  }
}
