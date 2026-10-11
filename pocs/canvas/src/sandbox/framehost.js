// The sandbox origin: a tiny frame-host page served with real HTTP headers from an origin that is
// not the app's. Untrusted code (third-party plugins, agent-made HTML pages) runs there, one frame
// per plugin/page, each on its own subdomain (`<label>.<sandbox host>`), so every frame is its own
// origin: no shared storage, no reaching into a sibling frame.
//
//   /worker  plugin frames. The page itself runs only the boot script below (allowed by hash); the
//            app sends worker code, the boot starts it as a dedicated Worker and relays messages.
//            Plugin code never runs in a window: no `location` to navigate, no RTCPeerConnection.
//            `?connect=<origin>,<origin>` = the plugin's declared network origins (connect-src).
//   /page    HTML pages (prototype). The boot installs a navigation guard, then writes the app's
//            HTML into the document (inline scripts/styles allowed; nothing from the network).
//
// Both: CSP header with frame-ancestors = the app's origins, `sandbox allow-scripts
// allow-same-origin` (no popups, forms, top navigation, modals, downloads; the origin is real and
// unique, which the Navigation API guard needs), Permissions-Policy that denies device features.
//
// Plain JS (no imports but sha256.js) so the Node dev server (sandbox/server.mjs), the Cloudflare
// Worker (signaling/src/index.ts) and the tests load the same code.

import { sha256Base64 } from './sha256.js';

/** Who may embed sandbox frames in dev: any port on localhost / 127.0.0.1 / mini.internal (+ subdomains). */
export const DEV_APP_ORIGINS = ['http://localhost:*', 'http://*.localhost:*', 'http://127.0.0.1:*', 'http://mini.internal:*', 'http://*.mini.internal:*'];

export const PERMISSIONS_POLICY = [
  'accelerometer',
  'autoplay',
  'bluetooth',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'picture-in-picture',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'web-share',
  'xr-spatial-tracking',
]
  .map((f) => `${f}=()`)
  .join(', ');

const ORIGIN_PATTERN = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|\d{1,5}))?$/;
const CONNECT_ORIGIN = /^(https|wss|http|ws):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

/** A CSP-style origin pattern (`http://*.localhost:*`) as a regex source matching an exact origin. */
export function originRegex(pattern) {
  const m = ORIGIN_PATTERN.exec(pattern);
  if (!m) throw new Error(`bad app origin pattern: ${pattern}`);
  const [, scheme, sub, host, port] = m;
  const esc = (s) => s.replace(/[.]/g, '\\.');
  const portRe = port === '*' ? '(?::\\d{1,5})?' : port ? `:${port}` : '';
  return `^${scheme}://${sub ? '(?:[a-z0-9-]+\\.)+' : ''}${esc(host)}${portRe}$`;
}

/** Network origins a plugin frame may connect to, from `?connect=` (anything malformed: error). */
export function parseConnect(value) {
  if (!value) return [];
  const list = value.split(',').filter(Boolean);
  if (list.length > 8) throw new Error('too many connect origins');
  for (const o of list) if (!CONNECT_ORIGIN.test(o)) throw new Error(`bad connect origin: ${o}`);
  return list;
}

// ---------------------------------------------------------------- boot scripts (run in the frame)

// Shared prelude. Captures what the guard needs before any untrusted code can replace it, then
// cancels every navigation of this frame (location.href = …, meta refresh, link clicks,
// navigation.navigate, reload). CSP has no navigate-to, so this is the only way to stop a frame
// from leaking data in a URL; it needs the Navigation API and a real (not opaque) origin.
const PRELUDE = (appRes) => `const P = parent;
const APPS = ${JSON.stringify(appRes)}.map((s) => new RegExp(s));
const okOrigin = (o) => APPS.some((r) => r.test(o));
const NAV = typeof navigation === 'object' && !!navigation && typeof NavigateEvent === 'function';
const apply = Reflect.apply, pd = Event.prototype.preventDefault;
const dest = NAV && Object.getOwnPropertyDescriptor(NavigateEvent.prototype, 'destination').get;
const urlOf = NAV && Object.getOwnPropertyDescriptor(NavigationDestination.prototype, 'url').get;
let app = null; // the embedding app's origin, once it spoke
const tell = (m) => app && P.postMessage(m, app);
if (NAV) {
  navigation.addEventListener('navigate', (e) => {
    apply(pd, e, []);
    tell({ t: 'blocked', what: 'navigation', url: String(apply(urlOf, apply(dest, e, []), [])).slice(0, 300) });
  });
} else P.postMessage({ t: 'unguarded' }, '*');
addEventListener('securitypolicyviolation', (e) => tell({ t: 'violation', text: e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') }));`;

const WORKER_BOOT = (appRes) => `(() => {
${PRELUDE(appRes)}
let w = null;
addEventListener('message', (e) => {
  if (e.source !== P || !okOrigin(e.origin)) return;
  const m = e.data;
  if (!w) {
    if (!m || m.t !== 'start' || typeof m.code !== 'string') return;
    app = e.origin;
    w = new Worker(URL.createObjectURL(new Blob([m.code], { type: 'text/javascript' })));
    w.onmessage = (ev) => P.postMessage(ev.data, app);
    w.onerror = (ev) => { ev.preventDefault(); P.postMessage({ t: 'fail', error: String(ev.message || 'worker failed to start') }, app); };
    return;
  }
  w.postMessage(m);
});
// say hello after load, so the app's load count starts from a finished boot document
addEventListener('load', () => P.postMessage({ t: 'boot' }, '*'), { once: true });
})();`;

// Pages: best-effort removal of WebRTC (it ignores CSP). A page can get fresh constructors from a
// same-origin child frame (about:blank, window[0]), so this stops casual use, not a determined page.
const PAGE_BOOT = (appRes) => `(() => {
${PRELUDE(appRes)}
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver']) try { delete window[k]; } catch {}
const onMsg = (e) => {
  if (e.source !== P || !okOrigin(e.origin)) return;
  const m = e.data;
  if (!m || m.t !== 'render' || typeof m.html !== 'string') return;
  app = e.origin;
  removeEventListener('message', onMsg);
  document.open();
  // document.open() drops window listeners: report the page's own CSP violations again
  addEventListener('securitypolicyviolation', (ev) => tell({ t: 'violation', text: ev.violatedDirective + ' blocked ' + (ev.blockedURI || 'inline') }));
  document.write(m.html);
  document.close();
};
addEventListener('message', onMsg);
// say hello after load, so the app's load count starts from a finished boot document
addEventListener('load', () => P.postMessage({ t: 'boot' }, '*'), { once: true });
})();`;

const page = (script) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>${script}</script>`;

/**
 * The frame host for a set of app origins. Returns `serve(pathname, search)` → `{status, headers,
 * body}`: plain data, so any server (Node, a Worker) can send it.
 */
export function frameHost(opts = {}) {
  const apps = opts.appOrigins && opts.appOrigins.length ? opts.appOrigins : DEV_APP_ORIGINS;
  const appRes = apps.map(originRegex);
  const ancestors = apps.join(' ');
  const workerBoot = WORKER_BOOT(appRes);
  const pageBoot = PAGE_BOOT(appRes);
  const workerHash = `'sha256-${sha256Base64(workerBoot)}'`;
  const pageHash = `'sha256-${sha256Base64(pageBoot)}'`;
  const common = `base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}; sandbox allow-scripts allow-same-origin`;
  const csp = {
    worker: (connect) =>
      `default-src 'none'; script-src ${workerHash} blob:; worker-src blob:; connect-src ${connect.length ? connect.join(' ') : "'none'"}; ${common}`,
    // pages run their own inline scripts; the boot runs first (it is the first thing in the document).
    // `webrtc 'block'` is CSP3 but Chrome ignores it (console: unrecognized directive); kept for
    // browsers that honour it. WebRTC in pages is otherwise only removed best-effort (see PAGE_BOOT).
    page: () =>
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'none'; worker-src 'none'; webrtc 'block'; ${common}`,
  };
  const headers = (policy) => ({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': policy,
    'permissions-policy': PERMISSIONS_POLICY,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  const text = (status, body) => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' }, body });

  function serve(pathname, search = '') {
    const q = new URLSearchParams(search);
    if (pathname === '/worker') {
      let connect;
      try {
        connect = parseConnect(q.get('connect'));
      } catch (e) {
        return text(400, String(e.message || e));
      }
      return { status: 200, headers: headers(csp.worker(connect)), body: page(workerBoot) };
    }
    if (pathname === '/page') return { status: 200, headers: headers(csp.page()), body: page(pageBoot) };
    if (pathname === '/') return text(200, 'canvas sandbox origin: frames for plugins (/worker) and pages (/page)\n');
    return text(404, 'not found\n');
  }
  return { serve, appOrigins: apps, workerBoot, pageBoot };
}
