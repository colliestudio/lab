import type { PageFrameOpts } from '../../sandbox/page';

/** What a page frame is given: state only while the page is being interacted with (idle thumbnails get none). */
export const frameProps = (live: boolean, state: Record<string, string>): PageFrameOpts => (live ? { live: true, state } : {});

/** The bits of a page's canvas box that interact mode touches. */
export interface Box {
  classList: { toggle(c: string, on: boolean): unknown };
  querySelector(sel: string): { replaceWith(n: any): void; title?: string } | null;
}

/**
 * Interact mode (local to this screen): which pages take clicks. Entering or leaving builds a fresh
 * frame, so the state a page was given while interacting is not in the frame that goes idle.
 * `build` makes a frame for a page; the box holds an iframe or, after removal, a `.pg-gone` placeholder.
 */
export class Interact<B extends Box = Box> {
  readonly live = new Set<string>();
  constructor(
    private box: (id: string) => B | undefined,
    private build: (id: string) => unknown,
  ) {}

  /** Only a page being interacted with may act on the canvas. */
  accepts(id: string | undefined) {
    return !!id && this.live.has(id);
  }

  set(id: string, on: boolean) {
    const changed = this.live.has(id) !== on;
    if (on) this.live.add(id);
    else this.live.delete(id);
    const box = this.box(id);
    box?.classList.toggle('pg-live', on);
    const b = box?.querySelector('[data-action="live"]');
    if (b) b.title = on ? 'Interacting: clicks go to the page (I to stop)' : 'Interact with the page (I)';
    if (changed) this.reload(id);
  }

  /** The page from its start again (a placeholder from a removed frame is replaced too). */
  reload(id: string) {
    const old = this.box(id)?.querySelector('iframe, .pg-gone');
    const next = this.build(id);
    if (old && next) old.replaceWith(next);
  }
}
