// App side of the sandbox origin: where frames load from and a validated message channel to one.
// Page frames use it only in strict mode (`pageMode() === 'origin'`); otherwise pages are srcdoc
// frames (srcdoc.ts). Worker frames always need it.
//
// Every frame gets its own origin: `<label>.<sandbox host>`. In dev the sandbox host is the page's
// own host name on port 5227 (`x.localhost:5227`, `x.mini.internal:5227`); in production set
// VITE_SANDBOX_URL to a template such as `https://{label}.canvas-frames.example` (a wildcard host
// on a registrable domain of its own, see ideas/prototype.md).

export type FrameKind = 'worker' | 'page';

/** Dev port of `pnpm dev:sandbox`; `VITE_SANDBOX_PORT` moves it (a second dev server on another port). */
export const DEV_SANDBOX_PORT = Number(import.meta.env?.VITE_SANDBOX_PORT) || 5227;

/**
 * How page frames are made: `origin` when a sandbox host is configured (`VITE_SANDBOX_URL` with a
 * `{label}` placeholder, or `VITE_SANDBOX_PORT` for a dev sandbox server), else `srcdoc`.
 */
export function pageMode(env: { VITE_SANDBOX_URL?: string; VITE_SANDBOX_PORT?: string } = (import.meta.env ?? {}) as Record<string, string>): 'srcdoc' | 'origin' {
  const url = env.VITE_SANDBOX_URL?.trim();
  if (url) {
    try {
      if (url.includes('{label}')) {
        new URL(url.replace('{label}', 'x'));
        return 'origin';
      }
    } catch {}
    console.warn(`VITE_SANDBOX_URL "${url}" is not a URL template with {label}: pages use srcdoc frames`);
  } else if (env.VITE_SANDBOX_PORT?.trim()) return 'origin';
  return 'srcdoc';
}

/** `{label}` template for frame URLs (no path). */
export function sandboxTemplate(loc: { protocol: string; hostname: string } = location, env: string | undefined = import.meta.env?.VITE_SANDBOX_URL): string {
  if (env) return env.replace(/\/+$/, '');
  // an IP address can't take a subdomain: *.localhost reaches the same machine
  const host = /^[\d.]+$|^\[|:/.test(loc.hostname) ? 'localhost' : loc.hostname;
  return `${loc.protocol}//{label}.${host}:${DEV_SANDBOX_PORT}`;
}

/** A fresh DNS label: `<hint>-<random>` (lowercase, ≤ 63 chars). */
export function frameLabel(hint = 'f'): string {
  const clean = hint.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'f';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('');
  return `${clean}-${rand}`;
}

export function frameOrigin(label: string, template = sandboxTemplate()): string {
  return new URL(template.replace('{label}', label)).origin;
}

export interface SandboxFrame {
  frame: HTMLIFrameElement;
  origin: string;
  /** Post to the frame (only to its exact origin). */
  send(m: unknown): void;
  /** Messages from this frame only (source and origin checked). */
  onMessage(fn: (m: unknown) => void): void;
  /** Called if the frame loads another document (it navigated despite the guard). */
  onNavigated(fn: () => void): void;
  /** The next load is expected (a page frame's document.open re-fires load). */
  allowLoad(): void;
  destroy(): void;
}

/**
 * Create (not attach) a sandbox frame. Attributes: `sandbox="allow-scripts allow-same-origin"`
 * (safe: the frame's origin is never the app's), no referrer, no device features.
 */
export function openFrame(kind: FrameKind, opts: { hint?: string; query?: Record<string, string>; template?: string } = {}): SandboxFrame {
  const label = frameLabel(opts.hint);
  const tpl = opts.template ?? sandboxTemplate();
  const origin = frameOrigin(label, tpl);
  const url = new URL(`${origin}/${kind}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v) url.searchParams.set(k, v);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  frame.src = url.href;
  let fn: (m: unknown) => void = () => {};
  let nav: () => void = () => {};
  let loads = 0;
  let allowed = 1;
  let attached = false;
  frame.addEventListener('load', () => {
    attached = true;
    if (++loads > allowed) nav();
  });
  const onMsg = (e: MessageEvent) => {
    // the frame was removed (a re-render replaced it): stop listening
    if (attached && !frame.isConnected) return void window.removeEventListener('message', onMsg);
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    fn(e.data);
  };
  window.addEventListener('message', onMsg);
  return {
    frame,
    origin,
    send: (m) => frame.contentWindow?.postMessage(m, origin),
    onMessage: (f) => (fn = f),
    onNavigated: (f) => (nav = f),
    allowLoad: () => void allowed++,
    destroy: () => {
      window.removeEventListener('message', onMsg);
      frame.remove();
    },
  };
}
