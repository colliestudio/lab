import runtimeSrc from './runtime.js?raw';
import { networkOrigins, type Manifest } from './manifest';
import type { Approvals, FromSandbox, MakeTransport, ToSandbox } from './host';

// The browser sandbox: one hidden iframe per plugin, `sandbox="allow-scripts"` (opaque origin: no
// access to the app's DOM, cookies, localStorage or IndexedDB) plus a CSP that blocks all network
// unless the manifest names origins. The plugin's code arrives by postMessage and is imported from
// a blob: URL inside the iframe; the runtime (runtime.js) adapts it to the message protocol.

const RUNTIME = runtimeSrc.replace(/^export \{ createRuntime \};?\s*$/m, '');

function bootScript() {
  return `${RUNTIME}
let rt;
const P = parent; // captured before plugin code runs (window.parent is replaceable)
const post = (m) => P.postMessage(m, '*');
// leaving this document (the plugin navigated its frame): tell the host before anything else loads
addEventListener('pagehide', () => post({ t: 'fail', error: 'left the sandbox page (navigation): stopped' }));
addEventListener('securitypolicyviolation', (e) => post({ t: 'violation', text: e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') }));
addEventListener('message', async (e) => {
  if (e.source !== P) return;
  const m = e.data;
  if (m && m.t === 'load') {
    try {
      const url = URL.createObjectURL(new Blob([m.source], { type: 'text/javascript' }));
      const mod = await import(url);
      rt = createRuntime(mod.default, post);
    } catch (err) {
      post({ t: 'fail', error: String((err && err.message) || err) });
    }
    return;
  }
  if (rt) rt.handle(m);
});
post({ t: 'boot' });`;
}

export function csp(m: Manifest) {
  const net = networkOrigins(m);
  return `default-src 'none'; script-src 'unsafe-inline' blob:; connect-src ${net.length ? net.join(' ') : "'none'"}; img-src 'none'; style-src 'none'; form-action 'none'`;
}

export const iframeTransport: MakeTransport = (manifest, source) => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.plugin = manifest.id;
  frame.style.display = 'none';
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp(manifest).replace(/"/g, '&quot;')}"><script type="module">${bootScript().replace(/<\/script/gi, '<\\/script')}</script>`;
  frame.srcdoc = html;
  let fn: (m: FromSandbox) => void = () => {};
  const queue: ToSandbox[] = [];
  let booted = false;
  // The frame may navigate itself (sandbox can't forbid that, CSP has no navigate-to): the new page
  // would have no CSP and the same contentWindow. Stop the plugin on the first sign of it.
  let dead = false;
  const kill = (why: string) => {
    if (dead) return;
    dead = true;
    window.removeEventListener('message', onMsg);
    frame.remove();
    fn({ t: 'fail', error: why });
  };
  let loads = 0;
  frame.addEventListener('load', () => ++loads > 1 && kill('sandbox frame navigated away: stopped'));
  const onMsg = (e: MessageEvent) => {
    if (dead || e.source !== frame.contentWindow) return;
    if ((e.data as { t?: string })?.t === 'fail' && booted) return kill(String((e.data as { error?: string }).error));
    const m = e.data as FromSandbox | { t: 'boot' };
    if (m?.t === 'boot') {
      if (booted) return;
      booted = true;
      frame.contentWindow!.postMessage({ t: 'load', source }, '*');
      for (const q of queue.splice(0)) frame.contentWindow!.postMessage(q, '*');
      return;
    }
    fn(m as FromSandbox);
  };
  window.addEventListener('message', onMsg);
  document.body.append(frame);
  return {
    send: (m) => {
      if (dead) return;
      if (booted) frame.contentWindow!.postMessage(m, '*');
      else queue.push(m);
    },
    onMessage: (f) => (fn = f),
    destroy: () => {
      dead = true;
      window.removeEventListener('message', onMsg);
      frame.remove();
    },
  };
};

/** Hashes this device agreed to run (localStorage). */
export function localApprovals(key = 'canvas-poc:plugin-approvals'): Approvals {
  const read = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  };
  const write = (v: string[]) => localStorage.setItem(key, JSON.stringify([...new Set(v)]));
  return { has: (h) => read().includes(h), add: (h) => write([...read(), h]), remove: (h) => write(read().filter((x) => x !== h)) };
}
