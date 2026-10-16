import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Base64, sha256Hex } from './sha256.js';
import { DEV_APP_ORIGINS, frameHost, originRegex, parseConnect } from './framehost.js';
import { frameOrigin, pageMode, sandboxTemplate } from './client';
import { IDLE_THUMBNAIL_SCRIPTS, PAGE_CSP, TAG, frameAttrs, loadWatch, pageRuntime, rateCap, runtimeMessage, srcdocDocument } from './srcdoc';
import { readMessage } from '../plugins/prototype/bridge';
import { PAGE_ESCAPE, PAGE_GONE, fromFrame, pageFrame } from './page';

const subtle = globalThis.crypto.subtle;
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const webHex = async (s: string) => hex(await subtle.digest('SHA-256', new TextEncoder().encode(s)));

describe('sha256 (plain JS)', () => {
  it('matches the standard vectors and WebCrypto on many lengths and UTF-8', async () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (let n = 0; n < 200; n++) {
      const s = 'x'.repeat(n) + (n % 3 ? 'é漢🎲' : '');
      expect(sha256Hex(s)).toBe(await webHex(s));
    }
    const big = 'export default {};\n'.repeat(5000);
    expect(sha256Hex(big)).toBe(await webHex(big));
    expect(sha256Base64('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

describe('frame host', () => {
  const host = frameHost();
  const csp = (path: string, q = '') => host.serve(path, q).headers['content-security-policy'];

  it('worker frame: boot allowed by hash only, no network, framed only by the app, sandboxed', () => {
    const r = host.serve('/worker');
    expect(r.status).toBe(200);
    const p = csp('/worker');
    expect(p).toContain(`script-src 'sha256-${sha256Base64(host.workerBoot)}' blob:`);
    expect(p).not.toContain('unsafe-inline');
    expect(p).not.toContain('unsafe-eval');
    expect(p).toContain("connect-src 'none'");
    expect(p).toContain("default-src 'none'");
    expect(p).toContain("form-action 'none'");
    expect(p).toContain(`frame-ancestors ${DEV_APP_ORIGINS.join(' ')}`);
    expect(p).toContain('sandbox allow-scripts allow-same-origin');
    expect(r.body).toContain(host.workerBoot);
    expect(r.headers['permissions-policy']).toContain('camera=()');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
  it('worker frame: declared network origins become connect-src; anything else is refused', () => {
    expect(csp('/worker', '?connect=https://api.example.com,wss://ws.example.com:8443')).toContain('connect-src https://api.example.com wss://ws.example.com:8443;');
    for (const bad of ["'unsafe-inline'", '*', 'https://a.com/path', 'https://a.com;script-src *', 'javascript:alert(1)', 'https://A.com', 'data:']) {
      expect(host.serve('/worker', '?connect=' + encodeURIComponent(bad)).status, bad).toBe(400);
    }
    expect(() => parseConnect(Array(9).fill('https://a.com').join(','))).toThrow();
  });
  it('page frame: inline page scripts allowed, nothing from the network, no nested frames or workers', () => {
    const p = csp('/page');
    expect(p).toContain("script-src 'unsafe-inline'");
    expect(p).toContain("frame-src 'none'");
    expect(p).toContain("worker-src 'none'");
    expect(p).not.toMatch(/connect-src (?!'none')/);
    expect(p).toContain('sandbox allow-scripts allow-same-origin');
    expect(host.pageBoot).toContain("navigation.addEventListener('navigate'");
  });
  it('page frame: Escape is reported only for a real key press, with the key the app sent', () => {
    expect(host.pageBoot).toContain("ev.isTrusted && ev.key === 'Escape'");
    expect(host.pageBoot).toContain("typeof m.key === 'string'");
    // page scripts run inside the render handler: they must not find the key on window.event.data
    expect(host.pageBoot).toContain('delete m.key');
  });
  it('dev: sandbox frames are not allowed to embed frames (no wildcard subdomains)', () => {
    expect(DEV_APP_ORIGINS.some((o) => o.includes('*.'))).toBe(false);
    const re = DEV_APP_ORIGINS.map((o) => new RegExp(originRegex(o)));
    expect(re.some((r) => r.test('http://p-abc.mini.internal:5292'))).toBe(false);
    expect(re.some((r) => r.test('http://p-abc.localhost:5292'))).toBe(false);
    expect(re.some((r) => r.test('http://mini.internal:5291'))).toBe(true);
  });
  it('unknown paths 404; app origins configurable', () => {
    expect(host.serve('/nope').status).toBe(404);
    const prod = frameHost({ appOrigins: ['https://canvas.lab.collie.studio'] });
    expect(prod.serve('/page').headers['content-security-policy']).toContain('frame-ancestors https://canvas.lab.collie.studio;');
    expect(() => frameHost({ appOrigins: ['https://evil.com/path'] })).toThrow();
  });
  it('origin patterns match exact origins only', () => {
    const t = (p: string, o: string) => new RegExp(originRegex(p)).test(o);
    expect(t('http://localhost:*', 'http://localhost:5217')).toBe(true);
    expect(t('http://localhost:*', 'http://localhost')).toBe(true);
    expect(t('http://localhost:*', 'http://localhost.evil.com:5217')).toBe(false);
    expect(t('http://localhost:*', 'https://localhost:5217')).toBe(false);
    expect(t('http://*.mini.internal:*', 'http://a.mini.internal:5217')).toBe(true);
    expect(t('http://*.mini.internal:*', 'http://mini.internal:5217')).toBe(false);
    expect(t('http://*.mini.internal:*', 'http://evilmini.internal:5217')).toBe(false);
    expect(t('https://canvas.lab.collie.studio', 'https://canvas.lab.collie.studio')).toBe(true);
    expect(t('https://canvas.lab.collie.studio', 'https://canvas.lab.collie.studio:444')).toBe(false);
  });
});

describe('client config', () => {
  it('dev: same host name, port 5227, one subdomain per frame; IPs fall back to localhost', () => {
    expect(sandboxTemplate({ protocol: 'http:', hostname: 'mini.internal' }, '')).toBe('http://{label}.mini.internal:5227');
    expect(sandboxTemplate({ protocol: 'http:', hostname: '127.0.0.1' }, '')).toBe('http://{label}.localhost:5227');
    expect(sandboxTemplate({ protocol: 'http:', hostname: 'localhost' }, 'https://{label}.frames.example/')).toBe('https://{label}.frames.example');
    expect(frameOrigin('p-dice-ab12', 'http://{label}.localhost:5227')).toBe('http://p-dice-ab12.localhost:5227');
  });
});

describe('page mode', () => {
  it('srcdoc unless a sandbox host is configured', () => {
    expect(pageMode({})).toBe('srcdoc');
    expect(pageMode({ VITE_SANDBOX_URL: '', VITE_SANDBOX_PORT: '' })).toBe('srcdoc');
    expect(pageMode({ VITE_SANDBOX_URL: '   ' })).toBe('srcdoc');
    expect(pageMode({ VITE_SANDBOX_URL: 'https://frames.example' })).toBe('srcdoc'); // no {label}
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(pageMode({ VITE_SANDBOX_URL: 'not a url {label}' })).toBe('srcdoc');
    expect(pageMode({ VITE_SANDBOX_URL: 'https://{label}.frames.example' })).toBe('origin');
    expect(pageMode({ VITE_SANDBOX_URL: ' https://{label}.frames.example/ ' })).toBe('origin');
    expect(pageMode({ VITE_SANDBOX_PORT: '5227' })).toBe('origin');
    vi.restoreAllMocks();
  });
});

describe('srcdoc page frames', () => {
  const key = 'k'.repeat(32);
  const doc = (html: string, o: { scripts?: boolean; state?: Record<string, string> } = {}) => srcdocDocument(html, { scripts: true, key, ...o });

  it('the CSP meta comes first and allows no network', () => {
    const d = doc('<h1>Hi</h1>');
    expect(d.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`)).toBe(true);
    for (const want of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:', 'media-src data: blob:', "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'"]) expect(PAGE_CSP).toContain(want);
    expect(PAGE_CSP).not.toMatch(/(?:https?:|\*)/);
    expect(d.endsWith('<h1>Hi</h1>')).toBe(true);
  });
  it('page html and state cannot break out of the CSP meta or the runtime', () => {
    const evil = '</head><meta http-equiv="refresh" content="0;url=http://x"><meta http-equiv="Content-Security-Policy" content="default-src *"></script><script>alert(1)</script>';
    const d = doc(evil, { state: { name: evil } });
    const at = d.indexOf(evil);
    expect(d.indexOf('Content-Security-Policy')).toBe('<!doctype html><meta http-equiv="'.length);
    expect(d.slice(0, at).match(/<meta/g)!.length).toBe(3); // CSP, charset, viewport
    // the only </script> before the page's html is the runtime's own
    expect(d.slice(0, at).match(/<\/script>/g)!.length).toBe(1);
    expect(d.slice(0, at)).not.toContain('</head>');
    expect(d.slice(0, at)).not.toContain('<meta http-equiv="refresh"');
  });
  it('state: idle frames carry none; Play / interact frames get it escaped', () => {
    expect(doc('<p>', { state: {} })).toContain('const state = {};');
    expect(doc('<p>', { state: { name: 'Ada' } })).toContain('const state = {"name":"Ada"};');
    expect(doc('<p>', { scripts: false, state: { name: 'Ada' } })).not.toContain('Ada');
    expect(doc('<p>', { scripts: false })).not.toContain('<script');
  });
  it('frame attributes: allow-scripts only, no same-origin; scripts off is the empty sandbox', () => {
    expect(frameAttrs(true)).toEqual({ sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', allow: '' });
    expect(frameAttrs(false).sandbox).toBe('');
    expect(typeof IDLE_THUMBNAIL_SCRIPTS).toBe('boolean');
  });
  it('runtime: key held in the closure, Escape only from a trusted key, getters captured, no Object.assign', () => {
    const rt = pageRuntime(key, {});
    expect(rt).toContain('ev.isTrusted');
    expect(rt).toContain("apply(keyOf, ev, []) === 'Escape'");
    expect(rt).toContain('Reflect.apply');
    expect(rt).toContain('document.currentScript.remove()');
    // in-page anchors scroll instead of navigating the frame (a navigation would remove it)
    expect(rt).toContain("closest('a[href^=\"#\"]')");
    expect(rt).toContain('scrollIntoView()');
    expect(rt).toContain('scrollTo(0, 0)');
    // a navigation that commits no document (204, download, stop) still fires a trusted beforeunload first
    expect(rt).toMatch(/addEventListener\('beforeunload', \(ev\) => \{ if \(ev\.isTrusted\) up\.postMessage\(\{[^}]*kind: 'leaving'/);
    expect(rt.indexOf('beforeunload')).toBeLessThan(rt.indexOf('window.canvas = '));
    // a page can dispatch a fake `load` to look vouched for: only a real one counts
    expect(rt).toMatch(/addEventListener\('load', \(ev\) => \{ if \(ev\.isTrusted\)/);
    expect(rt).not.toContain('Object.assign');
    expect(rt.indexOf('Reflect.apply')).toBeLessThan(rt.indexOf('window.canvas'));
    // every message to the parent has the key
    // the state key is a different field from the frame key (a clash once dropped every `set`)
    expect(rt).toContain("kind: 'set', key: String(k), value: String(v)");
    expect(readMessage({ tag: TAG, auth: 'a'.repeat(32), kind: 'set', key: 'name', value: 'Ada' })).toEqual({ kind: 'set', key: 'name', value: 'Ada' });
    for (const m of rt.match(/postMessage\(\{[^}]*\}/g)!) expect(m).toContain('auth: KEY');
  });
  it('runtime messages need the frame key', () => {
    expect(runtimeMessage({ tag: TAG, auth: key, kind: 'loaded' }, key)).toBe('loaded');
    expect(runtimeMessage({ tag: TAG, auth: key, kind: 'escape' }, key)).toBe('escape');
    expect(runtimeMessage({ tag: TAG, auth: key, kind: 'leaving' }, key)).toBe('leaving');
    expect(runtimeMessage({ tag: TAG, kind: 'leaving' }, key)).toBeUndefined();
    expect(runtimeMessage({ tag: TAG, kind: 'escape' }, key)).toBeUndefined();
    expect(runtimeMessage({ tag: TAG, auth: 'guess', kind: 'escape' }, key)).toBeUndefined();
    expect(runtimeMessage({ tag: TAG, auth: key, kind: 'goto' }, key)).toBeUndefined();
    expect(runtimeMessage('escape', key)).toBeUndefined();
  });
});

describe('message rate cap', () => {
  it('trips above the limit within the window, not for a steady trickle', () => {
    let t = 0;
    const hit = rateCap(200, 1000, () => t);
    for (let i = 0; i < 200; i++) expect(hit()).toBe(false);
    expect(hit()).toBe(true);
    t = 5000;
    const slow = rateCap(200, 1000, () => t);
    for (let i = 0; i < 2000; i++) {
      t += 10; // 100 / s: typing fast
      expect(slow()).toBe(false);
    }
  });
});

describe('load watch', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  it('one load vouched for by the runtime is fine; a second load is foreign', () => {
    const foreign = vi.fn();
    const w = loadWatch(true, foreign);
    w.onLoaded();
    w.onLoad();
    vi.advanceTimersByTime(5000);
    expect(foreign).not.toHaveBeenCalled();
    w.onLoad();
    w.onLoad();
    expect(foreign).toHaveBeenCalledTimes(1);
  });
  it('a first load with no runtime message in time is foreign (the page navigated while parsing)', () => {
    const foreign = vi.fn();
    loadWatch(true, foreign).onLoad();
    vi.advanceTimersByTime(1999);
    expect(foreign).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(foreign).toHaveBeenCalledTimes(1);
  });
  it('the runtime message arriving after the load still counts', () => {
    const foreign = vi.fn();
    const w = loadWatch(true, foreign);
    w.onLoad();
    w.onLoaded();
    vi.advanceTimersByTime(5000);
    expect(foreign).not.toHaveBeenCalled();
  });
  it('scripts off: no runtime to wait for, only a second load is foreign', () => {
    const foreign = vi.fn();
    const w = loadWatch(false, foreign);
    w.onLoad();
    vi.advanceTimersByTime(5000);
    expect(foreign).not.toHaveBeenCalled();
    w.onLoad();
    expect(foreign).toHaveBeenCalledTimes(1);
  });
});

describe('srcdoc frame in the page', () => {
  // just enough DOM for pageFrame in a node test
  class FakeEl extends EventTarget {
    attrs: Record<string, string> = {};
    style: Record<string, string> = { cssText: '' };
    srcdoc = '';
    className = '';
    textContent = '';
    isConnected = true;
    contentWindow = {};
    replacedBy: FakeEl | null = null;
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    replaceWith(o: FakeEl) {
      this.replacedBy = o;
      this.isConnected = false;
    }
  }
  const listeners: Array<(e: MessageEvent) => void> = [];
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('window', { addEventListener: (_: string, f: any) => listeners.push(f), removeEventListener: () => {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    listeners.length = 0;
  });
  const keyOf = (f: FakeEl) => /const TAG = "[^"]*", KEY = "([0-9a-f]+)"/.exec(f.srcdoc)![1];
  const msg = (source: unknown, origin: string, data: unknown) => ({ source, origin, data }) as unknown as MessageEvent;
  const make = (opts = {}) => pageFrame('<p>x</p>', 390, 800, 0.5, opts) as unknown as FakeEl;

  it('idle: no state; live and Play: allow-scripts with state; none has a src or same-origin', () => {
    const idle = make();
    expect(idle.attrs.sandbox).toBe(IDLE_THUMBNAIL_SCRIPTS ? 'allow-scripts' : '');
    expect(idle.srcdoc).not.toContain('Ada');
    const play = make({ state: { name: 'Ada' } });
    expect(play.attrs.sandbox).toBe('allow-scripts');
    expect(play.srcdoc).toContain('{"name":"Ada"}');
    const preview = make({ live: true });
    expect(preview.attrs.sandbox).toBe('allow-scripts');
    expect(preview.srcdoc).toContain('const state = {};');
    for (const f of [idle, play, preview]) expect(JSON.stringify(f.attrs)).not.toContain('same-origin');
    expect((idle as any).src).toBeUndefined();
  });
  it('trusts the frame only with its window, origin null and its key', () => {
    const f = make({ live: true });
    const k = keyOf(f);
    const frame = f as unknown as HTMLIFrameElement;
    expect(fromFrame(frame, msg(f.contentWindow, 'null', { tag: TAG, auth: k, kind: 'goto' }))).toBe(true);
    expect(fromFrame(frame, msg(f.contentWindow, 'null', { tag: TAG, kind: 'goto' }))).toBe(false); // no key: a navigated-to document
    expect(fromFrame(frame, msg(f.contentWindow, 'null', { tag: TAG, auth: 'guess', kind: 'goto' }))).toBe(false);
    expect(fromFrame(frame, msg({}, 'null', { tag: TAG, auth: k }))).toBe(false);
    expect(fromFrame(frame, msg(f.contentWindow, 'https://evil.example', { tag: TAG, auth: k }))).toBe(false);
  });
  it('Escape reaches the plugin only with the key', () => {
    const f = make({ live: true });
    const k = keyOf(f);
    const heard = vi.fn();
    f.addEventListener(PAGE_ESCAPE, heard);
    const send = (data: unknown) => listeners.forEach((l) => l(msg(f.contentWindow, 'null', data)));
    send({ tag: TAG, kind: 'escape' });
    send({ tag: TAG, auth: 'guess', kind: 'escape' });
    expect(heard).not.toHaveBeenCalled();
    send({ tag: TAG, auth: k, kind: 'escape' });
    expect(heard).toHaveBeenCalledTimes(1);
  });
  it('a frame announcing it is leaving is replaced at once, with no load at all', () => {
    const f = make({ live: true });
    const send = (data: unknown) => listeners.forEach((l) => l(msg(f.contentWindow, 'null', data)));
    send({ tag: TAG, kind: 'leaving' });
    expect(f.replacedBy).toBeNull();
    send({ tag: TAG, auth: keyOf(f), kind: 'leaving' });
    expect(f.replacedBy?.className).toBe('pg-gone');
  });
  it('a frame flooding the app with messages is replaced', () => {
    const f = make({ live: true });
    const send = (data: unknown) => listeners.forEach((l) => l(msg(f.contentWindow, 'null', data)));
    for (let i = 0; i < 200; i++) send({ tag: TAG, auth: keyOf(f), kind: 'set', key: 'a', value: String(i) });
    expect(f.replacedBy).toBeNull();
    send({ tag: TAG, kind: 'noise' });
    expect(f.replacedBy?.className).toBe('pg-gone');
  });
  it('a frame that loads a second document is replaced by a placeholder', () => {
    const f = make({ live: true });
    const gone = vi.fn();
    f.addEventListener(PAGE_GONE, gone);
    listeners.forEach((l) => l(msg(f.contentWindow, 'null', { tag: TAG, auth: keyOf(f), kind: 'loaded' })));
    f.dispatchEvent(new Event('load'));
    expect(f.replacedBy).toBeNull();
    f.dispatchEvent(new Event('load'));
    expect(f.replacedBy?.className).toBe('pg-gone');
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
