import { describe, expect, it } from 'vitest';
import { sha256Base64, sha256Hex } from './sha256.js';
import { DEV_APP_ORIGINS, frameHost, originRegex, parseConnect } from './framehost.js';
import { frameOrigin, sandboxTemplate } from './client';

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
