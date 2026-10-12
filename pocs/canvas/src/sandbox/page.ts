import { openFrame } from './client';

// HTML pages (the prototype idea's agent-made pages) on the sandbox origin. Same call shape as the
// prototype plugin's former srcdoc `pageFrame(html, vw, vh, scale, state)`. A page is re-rendered by
// replacing its frame, not by reassigning `srcdoc`. The bridge script below is what the srcdoc
// frames ran: clicks on `[data-goto]` / `[data-back]`, `data-store` fields, `window.canvas`. The
// CSP now comes from the frame host's response header instead of a meta tag, plus the navigation
// guard.

export const TAG = 'canvas-page/1';
/** Fired on a page's frame element when the user pressed Escape inside it (the frame host reports it; the page can't fake it). */
export const PAGE_ESCAPE = 'page-escape';

const BRIDGE = (tag: string, state: Record<string, string>) => `
(() => {
  const TAG = ${JSON.stringify(tag)};
  const state = ${JSON.stringify(state).replace(/</g, '\\u003c')};
  const send = (m) => parent.postMessage(Object.assign({ tag: TAG }, m), '*');
  window.canvas = {
    state,
    goto: (target) => send({ kind: 'goto', target: String(target || '') }),
    back: () => send({ kind: 'back' }),
    set: (key, value) => { state[key] = String(value); send({ kind: 'set', key: String(key), value: String(value) }); },
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-goto], [data-back]');
    if (!el) return;
    e.preventDefault();
    if (el.hasAttribute('data-back')) return canvas.back();
    const form = el.tagName === 'BUTTON' || el.type === 'submit' ? el.closest('form') : null;
    if (form && !form.reportValidity()) return;
    canvas.goto(el.getAttribute('data-goto'));
  }, true);
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  const sync = (el) => { if (el.dataset && el.dataset.store) canvas.set(el.dataset.store, el.type === 'checkbox' ? (el.checked ? 'yes' : '') : el.value); };
  document.addEventListener('input', (e) => sync(e.target), true);
  document.addEventListener('change', (e) => sync(e.target), true);
  addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll('[data-store]')) {
      const v = state[el.dataset.store];
      if (v === undefined) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
    for (const el of document.querySelectorAll('[data-show]')) {
      const v = state[el.dataset.show];
      if (v) el.textContent = v;
    }
  });
})();`;

/** The document written into the frame: bridge first, then the page's own HTML (no CSP meta: the header has it). */
export function pageDocument(html: string, state: Record<string, string> = {}, bridge = true): string {
  const b = bridge ? `<script>${BRIDGE(TAG, state).replace(/<\/script/gi, '<\\/script')}</script>` : '';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">${b}${html}`;
}

/** What the frame host reports about a page (besides the page's own bridge messages). */
export type HostNote = { t: 'blocked'; what: string; url: string } | { t: 'violation'; text: string } | { t: 'unguarded' } | { t: 'navigated' };

export interface SandboxPage {
  frame: HTMLIFrameElement;
  origin: string;
  /** Messages the page's bridge (or its own script) posted. */
  onPageMessage(fn: (data: unknown) => void): void;
  onHostNote(fn: (n: HostNote) => void): void;
  destroy(): void;
}

/** A page frame on the sandbox origin. Attach `frame` yourself; the page renders once the host boots. */
export function sandboxPage(html: string, opts: { state?: Record<string, string>; bridge?: boolean; hint?: string; template?: string } = {}): SandboxPage {
  const sf = openFrame('page', { hint: opts.hint ?? 'page', template: opts.template });
  const doc = pageDocument(html, opts.state, opts.bridge !== false);
  let onPage: (d: unknown) => void = () => {};
  let onNote: (n: HostNote) => void = () => {};
  let booted = false;
  sf.onNavigated(() => {
    onNote({ t: 'navigated' });
    sf.destroy(); // a page that got away is not ours any more
  });
  const escapeKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  sf.onMessage((d) => {
    const m = d as { t?: string; key?: unknown } | null;
    if (m && typeof m === 'object' && typeof m.t === 'string') {
      if (m.t === 'escape') {
        if (m.key === escapeKey) sf.frame.dispatchEvent(new Event(PAGE_ESCAPE));
        return;
      }
      if (m.t === 'boot' && !booted) {
        booted = true;
        // document.open() + close() in the frame fires load once more: expected, once
        sf.allowLoad();
        sf.send({ t: 'render', html: doc, key: escapeKey });
      }
      else if (m.t === 'blocked' || m.t === 'violation' || m.t === 'unguarded') onNote(m as HostNote);
      return;
    }
    onPage(d);
  });
  return { frame: sf.frame, origin: sf.origin, onPageMessage: (f) => (onPage = f), onHostNote: (f) => (onNote = f), destroy: sf.destroy };
}

/** A frame for a page laid out at `vw` x `vh` and scaled by `scale`, with the prototype's frame styling. */
export function pageFrame(html: string, vw: number, vh: number, scale: number, state?: Record<string, string>): HTMLIFrameElement {
  const p = sandboxPage(html, { state });
  const f = p.frame;
  f.className = 'pg-frame';
  f.style.width = `${vw}px`;
  f.style.height = `${vh}px`;
  f.style.transform = `scale(${scale})`;
  return f;
}

/**
 * Is this message from `frame` itself? The window must be the frame's and the origin must still be
 * the sandbox origin the frame was opened on, so a frame that ended up somewhere else (a browser
 * without the navigation guard) can't keep talking.
 */
export function fromFrame(frame: HTMLIFrameElement, e: MessageEvent): boolean {
  if (e.source !== frame.contentWindow) return false;
  try {
    return e.origin === new URL(frame.src).origin;
  } catch {
    return false;
  }
}
