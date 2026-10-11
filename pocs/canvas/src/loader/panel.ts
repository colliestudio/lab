import { capText, parseManifest } from './manifest';
import type { PluginHost } from './host';

// The Plugins panel: what this table (room) uses, install from a URL / local files / the bundled
// examples, approve a plugin another player added, remove one, and what the sandbox refused.

const EXAMPLES = [
  { label: 'Dice', url: '/examples/plugins/dice/manifest.json' },
  { label: 'Sticky votes', url: '/examples/plugins/votes/manifest.json' },
];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Ask before running new code: the capabilities in plain words. */
function consent(manifestJson: unknown, from: string): boolean {
  const m = parseManifest(manifestJson);
  const caps = m.capabilities.map((c) => `  • ${capText(c)}`).join('\n');
  return confirm(`Add the plugin "${m.name}" ${m.version} to this table?\nFrom: ${from}\n\nIt asks to:\n${caps}\n\nEveryone at the table will be asked to allow it too.`);
}

async function fetchText(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

export async function installFromUrl(host: PluginHost, url: string) {
  const abs = new URL(url, location.href);
  const manifest = JSON.parse(await fetchText(abs.href));
  const m = parseManifest(manifest);
  if (!consent(manifest, abs.href)) return;
  const source = await fetchText(new URL(m.main, abs).href);
  await host.install(manifest, source, abs.href);
}

async function installFromFiles(host: PluginHost, files: FileList) {
  const list = [...files];
  const mf = list.find((f) => f.name.endsWith('.json'));
  if (!mf) throw new Error('pick the manifest.json and the plugin .js together');
  const manifest = JSON.parse(await mf.text());
  const m = parseManifest(manifest);
  const main = list.find((f) => f.name === m.main.split('/').pop());
  if (!main) throw new Error(`pick ${m.main} too`);
  if (!consent(manifest, `local files (${mf.name}, ${main.name})`)) return;
  await host.install(manifest, await main.text(), `file: ${main.name}`);
}

export function mountPluginPanel(host: PluginHost, bar: HTMLElement) {
  const btn = h('button', 'plugins-btn', 'Plugins');
  btn.title = 'Plugins this table uses: install, allow, remove';
  bar.insertBefore(btn, bar.querySelector('.help-btn'));
  const panel = h('div', 'plugins-panel');
  panel.hidden = true;
  document.body.append(panel);
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    draw();
  });
  const fail = (e: unknown) => host.app.notify(`Plugin install failed: ${(e as Error).message}`);

  function draw() {
    const room = host.roomPlugins();
    const waiting = room.filter((p) => host.status(p.manifest.id) === 'awaiting approval').length;
    btn.textContent = waiting ? `Plugins (${waiting} to allow)` : room.length ? `Plugins (${room.length})` : 'Plugins';
    btn.classList.toggle('attention', waiting > 0);
    if (panel.hidden) return;
    panel.replaceChildren();
    const head = h('div', 'pp-head');
    head.append(h('b', '', 'Plugins at this table'));
    const close = h('button', 'pp-close', '×');
    close.addEventListener('click', () => ((panel.hidden = true), draw()));
    head.append(close);
    panel.append(head, h('p', 'pp-note', 'The table records which plugins it uses, so everyone loads the same code (pinned by hash). Each device allows a plugin before it runs there. Plugins run sandboxed and can only do what they list.'));

    if (!room.length) panel.append(h('p', 'pp-empty', 'None yet.'));
    for (const p of room) {
      const m = p.manifest;
      const st = host.status(m.id);
      const row = h('div', 'pp-plugin');
      const title = h('div', 'pp-title');
      title.append(h('b', '', m.name), h('span', 'pp-ver', ` ${m.version} · ${m.id}`), h('span', `pp-status pp-${st.replace(/ /g, '-')}`, st));
      row.append(title);
      if (m.description) row.append(h('div', 'pp-desc', m.description));
      const caps = h('div', 'pp-caps');
      for (const c of m.capabilities) {
        const chip = h('span', 'pp-cap', c);
        chip.title = capText(c);
        caps.append(chip);
      }
      row.append(caps);
      row.append(h('div', 'pp-meta', `${p.hash.slice(0, 19)}… · added by ${p.addedBy ?? '?'}${p.from ? ` · ${p.from}` : ''}`));
      const err = host.loaded.get(m.id)?.error;
      if (err) row.append(h('div', 'pp-err', err));
      const actions = h('div', 'pp-actions');
      if (st === 'awaiting approval') {
        const allow = h('button', 'pp-allow', 'Allow on this device');
        allow.addEventListener('click', () => {
          const caps = m.capabilities.map((c) => `  • ${capText(c)}`).join('\n');
          if (confirm(`Run "${m.name}" (added by ${p.addedBy ?? 'someone'}) on this device?\n\nIt asks to:\n${caps}`)) void host.approve(p.hash);
        });
        actions.append(allow);
      }
      const rm = h('button', '', 'Remove from table');
      rm.addEventListener('click', () => confirm(`Remove "${m.name}" from this table for everyone? Its objects stay as plain text.`) && host.uninstall(m.id));
      actions.append(rm);
      row.append(actions);
      panel.append(row);
    }

    const add = h('div', 'pp-add');
    add.append(h('b', '', 'Add a plugin'));
    const ex = h('div', 'pp-row');
    ex.append(h('span', '', 'Examples:'));
    for (const e of EXAMPLES) {
      const b = h('button', '', e.label);
      b.addEventListener('click', () => installFromUrl(host, e.url).catch(fail));
      ex.append(b);
    }
    const urlRow = h('div', 'pp-row');
    const input = h('input');
    input.placeholder = 'https://…/manifest.json';
    const go = h('button', '', 'Install from URL');
    go.addEventListener('click', () => input.value.trim() && installFromUrl(host, input.value.trim()).catch(fail));
    urlRow.append(input, go);
    const fileRow = h('div', 'pp-row');
    const file = h('input');
    file.type = 'file';
    file.multiple = true;
    file.accept = '.json,.js,.mjs';
    file.hidden = true;
    file.addEventListener('change', () => file.files && installFromFiles(host, file.files).catch(fail).finally(() => (file.value = '')));
    const pick = h('button', '', 'From files… (manifest.json + .js)');
    pick.addEventListener('click', () => file.click());
    fileRow.append(pick, file);
    add.append(ex, urlRow, fileRow);
    panel.append(add);

    const notes = host.notices.slice(-12).reverse();
    if (notes.length) {
      const log = h('div', 'pp-log');
      log.append(h('b', '', 'Sandbox log'));
      for (const n of notes) log.append(h('div', `pp-n pp-n-${n.kind}`, `${new Date(n.time).toLocaleTimeString()} ${n.plugin}: ${n.kind === 'denied' ? 'DENIED ' : ''}${n.text}`));
      panel.append(log);
    }
  }
  host.subscribe(draw);
  host.app.store.meta.observe(() => draw());
  draw();
  return { open: () => ((panel.hidden = false), draw()) };
}
