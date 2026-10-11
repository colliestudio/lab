import { openFrame } from './client';

// HTML pages (the prototype idea's agent-made pages) on the sandbox origin. Same call shape as the
// prototype branch's `pageFrame(html, vw, vh, scale, state)` in src/plugins/prototype/bridge.ts, so
// that plugin can switch by changing one import (and replace a frame instead of setting `srcdoc`
// to re-render). The bridge script below is the prototype's, unchanged in behavior: clicks on
// `[data-goto]` / `[data-back]`, `data-store` fields, `window.canvas`. The CSP now comes from the
// frame host's response header instead of a meta tag, plus the navigation guard.

export const TAG = 'canvas-page/1';

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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') send({ kind: 'escape' }); }, true);
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
  sf.onMessage((d) => {
    const m = d as { t?: string } | null;
    if (m && typeof m === 'object' && typeof m.t === 'string') {
      if (m.t === 'boot' && !booted) {
        booted = true;
        // document.open() + close() in the frame fires load once more: expected, once
        sf.allowLoad();
        sf.send({ t: 'render', html: doc });
      }
      else if (m.t === 'blocked' || m.t === 'violation' || m.t === 'unguarded') onNote(m as HostNote);
      return;
    }
    onPage(d);
  });
  return { frame: sf.frame, origin: sf.origin, onPageMessage: (f) => (onPage = f), onHostNote: (f) => (onNote = f), destroy: sf.destroy };
}

/** Drop-in for the prototype's `pageFrame` (same arguments and frame styling). */
export function pageFrame(html: string, vw: number, vh: number, scale: number, state?: Record<string, string>): HTMLIFrameElement {
  const p = sandboxPage(html, { state });
  const f = p.frame;
  f.className = 'pg-frame';
  f.style.width = `${vw}px`;
  f.style.height = `${vh}px`;
  f.style.transform = `scale(${scale})`;
  return f;
}
