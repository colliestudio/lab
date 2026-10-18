// Pages as self-contained srcdoc iframes: the default when no sandbox host is configured.
//
// A page is untrusted (an agent or another player wrote it). The frame is `sandbox="allow-scripts"`
// without allow-same-origin (opaque origin: no access to the canvas, its storage or cookies; no
// forms, popups or top navigation), with a CSP meta tag first in the document (no network at all;
// a later script can't lift it). The page talks to the canvas through postMessage only.
//
// What the CSP cannot stop: an opaque-origin frame can navigate itself (`location = …`, meta
// refresh, a clicked link), and there is no navigation guard here as there is on a sandbox origin.
// So the page is only ever given the cross-page state while the user is in Play or interacting
// with it, and a frame that tries to navigate is removed: the runtime reports every attempt
// (`beforeunload`, which also fires for navigations that never load a document), with the
// iframe's `load` count and a handshake timeout as backstops. That is best effort: removal runs on
// the app's main thread, so a page in Play or interact can still leak what was typed, possibly in
// several requests. Idle pages carry no state. Real isolation is strict mode (sandbox origin).

export const TAG = 'canvas-page/1';

/**
 * THE switch for idle thumbnails (no Play, no interact).
 * true:  scripts run (`sandbox="allow-scripts"`), but get no state (`canvas.state` is `{}`). Pages that
 *        build their DOM in JS look right. A page can still send one request (which carries no state)
 *        before its frame is removed.
 * false: scripts off (`sandbox=""`): no JS, so no self-navigation, meta refresh or `a.click()` either,
 *        0 requests. Pages that need JS to draw look empty until Interact / Play.
 * Flip this one line; page-leak.mjs and the tests follow.
 */
export const IDLE_THUMBNAIL_SCRIPTS = true;

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Runs inside the page, first in the document: clicks on `[data-goto]` / `[data-back]`, `data-store`
 * fields, `data-show`, `window.canvas`, Escape, and the `loaded` / `leaving` handshake. Every message
 * carries the per-frame key (field `auth`; `key` is taken by `set`), which lives only in this
 * closure. The page can't read this script (it removes its own element), can't patch what it uses
 * (the globals are captured first, messages are object literals) and can't forge a trusted event
 * (`isTrusted`: key presses, `load`, `beforeunload`).
 */
export function pageRuntime(key: string, state: Record<string, string>): string {
  return `(() => {
  const TAG = ${json(TAG)}, KEY = ${json(key)};
  const apply = Reflect.apply, keyOf = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, 'key').get, up = parent;
  const state = ${json(state)};
  // a navigation of this frame (even one that never commits a document: 204, download, window.stop()) announces itself
  addEventListener('beforeunload', (ev) => { if (ev.isTrusted) up.postMessage({ tag: TAG, auth: KEY, kind: 'leaving' }, '*'); });
  const goto = (target) => up.postMessage({ tag: TAG, auth: KEY, kind: 'goto', target: String(target || '') }, '*');
  const back = () => up.postMessage({ tag: TAG, auth: KEY, kind: 'back' }, '*');
  const set = (k, v) => { state[k] = String(v); up.postMessage({ tag: TAG, auth: KEY, kind: 'set', key: String(k), value: String(v) }, '*'); };
  window.canvas = { state, goto, back, set };
  addEventListener('load', (ev) => { if (ev.isTrusted) up.postMessage({ tag: TAG, auth: KEY, kind: 'loaded' }, '*'); });
  addEventListener('keydown', (ev) => { if (ev.isTrusted && apply(keyOf, ev, []) === 'Escape') up.postMessage({ tag: TAG, auth: KEY, kind: 'escape' }, '*'); }, true);
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-goto], [data-back]');
    if (!el) return;
    e.preventDefault();
    if (el.hasAttribute('data-back')) return back();
    // a button in a form submits it: check the form first (a plain link in the form, like "Change plan", doesn't)
    const form = el.tagName === 'BUTTON' || el.type === 'submit' ? el.closest('form') : null;
    if (form && !form.reportValidity()) return;
    goto(el.getAttribute('data-goto'));
  }, true);
  // A link to a place in this document would navigate the frame (and count as leaving): set the hash from script
  // instead (hashchange and :target work, the frame stays). Bubble phase on window, so a page's own click
  // handler that called preventDefault wins.
  addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const link = e.target.closest && e.target.closest('a[href], area[href]');
    const href = link ? String(link.getAttribute('href')).trim() : '';
    if (href[0] === '#') {
      e.preventDefault();
      location.hash = href;
    }
  });
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  const sync = (el) => { if (el.dataset && el.dataset.store) set(el.dataset.store, el.type === 'checkbox' ? (el.checked ? 'yes' : '') : el.value); };
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
  document.currentScript.remove();
})();`;
}

/** The srcdoc: CSP meta first, then (when scripts run) the runtime, then the page's own HTML. */
export function srcdocDocument(html: string, o: { scripts: boolean; state?: Record<string, string>; key: string }): string {
  const rt = o.scripts ? `<script>${pageRuntime(o.key, o.state ?? {}).replace(/<\/script/gi, '<\\/script')}</script>` : '';
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width">${rt}${html}`;
}

/** iframe attributes of a srcdoc page frame. Never allow-same-origin. */
export function frameAttrs(scripts: boolean): Record<string, string> {
  return { sandbox: scripts ? 'allow-scripts' : '', referrerpolicy: 'no-referrer', allow: '' };
}

/** A fresh per-frame secret. */
export const frameKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A message from the runtime that is for the frame host, not the canvas (anything else: undefined). */
export function runtimeMessage(data: unknown, key: string): 'loaded' | 'escape' | 'leaving' | undefined {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  if (d.tag !== TAG || d.auth !== key) return;
  return d.kind === 'loaded' || d.kind === 'escape' || d.kind === 'leaving' ? d.kind : undefined;
}

/** Does this message carry the frame's key? (the key makes a navigated-away document in the same window untrusted) */
export const hasKey = (data: unknown, key: string) => !!data && typeof data === 'object' && (data as Record<string, unknown>).auth === key;

/**
 * Second-load detection. The frame's first document loads once, and (with scripts) its runtime says so.
 * Any later `load`, or a first `load` that no runtime vouches for within `ms`, means the frame left
 * the srcdoc document: `foreign` fires (once).
 */
export type ForeignReason = 'second-load' | 'no-handshake' | 'leaving';

export function loadWatch(scripts: boolean, foreign: (why: ForeignReason) => void, ms = 2000) {
  let loads = 0;
  let vouched = !scripts;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (why: ForeignReason) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    foreign(why);
  };
  return {
    onLoad() {
      if (++loads > 1) return fire('second-load');
      if (!vouched) timer = setTimeout(() => !vouched && fire('no-handshake'), ms);
    },
    onLoaded() {
      vouched = true;
      clearTimeout(timer);
    },
    /** The runtime saw its frame navigate: foreign right away (a navigation may never load a document). */
    onLeaving: () => fire('leaving'),
    dispose() {
      done = true;
      clearTimeout(timer);
    },
  };
}
