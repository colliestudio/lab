// The sandbox around a page's HTML. Pages are untrusted (an agent or another player wrote them):
// - iframe `sandbox="allow-scripts"` without allow-same-origin: an opaque origin, so no access to
//   the canvas, its storage or cookies; no forms, popups or top navigation.
// - a CSP meta tag first in <head> (a later script can't lift it): no network at all (fetch, images,
//   fonts, CSS from URLs); only inline scripts/styles and data: images.
// - the page talks to the canvas only through postMessage, with a tiny, validated vocabulary.

export const SANDBOX = 'allow-scripts';
export const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
/** Marks messages from the bridge script (other postMessages are ignored). */
export const TAG = 'canvas-page/1';

export type PageMessage =
  | { kind: 'goto'; target: string }
  | { kind: 'back' }
  /** Escape pressed inside the page (keys in a frame never reach the canvas): leave Play / Interact. */
  | { kind: 'escape' }
  | { kind: 'set'; key: string; value: string };

/** Validate a message from a page frame (anything else: undefined). */
export function readMessage(data: unknown): PageMessage | undefined {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  if (d.tag !== TAG) return;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
  if (d.kind === 'goto') {
    const target = str(d.target ?? '', 200);
    return target === undefined ? undefined : { kind: 'goto', target };
  }
  if (d.kind === 'back') return { kind: 'back' };
  if (d.kind === 'escape') return { kind: 'escape' };
  if (d.kind === 'set') {
    const key = str(d.key, 60);
    const value = str(d.value, 2000);
    return key && value !== undefined ? { kind: 'set', key, value } : undefined;
  }
}

/**
 * Runs inside the page. Clicks on `[data-goto]` (a link or a button: a button in a form checks the
 * form first) ask the canvas to follow that link; `[data-back]` goes back; fields with `data-store`
 * keep their value in the session state, `data-show` shows a stored value; `canvas.goto(name)` /
 * `canvas.state` for scripts.
 */
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
    // a button in a form submits it: check the form first (a plain link in the form, like "Change plan", doesn't)
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

/** The full srcdoc for a page: CSP + bridge first, then the page's own HTML. */
export function srcdoc(html: string, state: Record<string, string> = {}): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>${BRIDGE(TAG, state)}</script>${html}`;
}

/** A sandboxed frame for a page, laid out at `vw` x `vh` and scaled by `scale`. */
export function pageFrame(html: string, vw: number, vh: number, scale: number, state?: Record<string, string>): HTMLIFrameElement {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', SANDBOX);
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.className = 'pg-frame';
  f.style.width = `${vw}px`;
  f.style.height = `${vh}px`;
  f.style.transform = `scale(${scale})`;
  f.srcdoc = srcdoc(html, state);
  return f;
}
