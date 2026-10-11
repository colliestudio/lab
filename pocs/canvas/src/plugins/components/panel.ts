import type { App } from '../../core';
import { addInstance } from './editing';
import { exportJson, exportMarkdown } from './export';
import { KINDS, instancesOf, library, type ComponentType, type FieldDef } from './model';
import { h } from './render';
import { openTable } from './table';

// The component library panel: types in this canvas, a no-code type editor, the library as JSON
// (what an agent writes), and exports.

type Mode = { kind: 'list' } | { kind: 'type'; id: string } | { kind: 'json' };

export function mountComponentsPanel(app: App, bar: HTMLElement) {
  const panel = h('aside', 'cmp-panel');
  panel.hidden = true;
  document.body.append(panel);
  const btn = h('button', undefined, 'Components');
  btn.title = 'Component library: custom card types defined as data (C)';
  bar.append(btn);
  let mode: Mode = { kind: 'list' };
  const toggle = (show: boolean = !!panel.hidden) => {
    panel.hidden = !show;
    btn.classList.toggle('active', show);
    if (show) draw();
  };
  btn.onclick = () => toggle();
  app.registerKey({ key: 'c', label: 'Component library', run: () => toggle() });
  document.addEventListener('cmp:edit-type', (e) => {
    mode = { kind: 'type', id: (e as CustomEvent<string>).detail };
    toggle(true);
  });

  const go = (m: Mode) => {
    mode = m;
    draw();
  };
  const button = (label: string, run: () => void, cls?: string) => {
    const b = h('button', cls, label);
    b.onclick = run;
    return b;
  };

  function listView() {
    const lib = library(app.doc);
    const out = [h('h2', undefined, 'Component library'), h('p', 'cmp-muted', 'Card types stored in this canvas. They sync to everyone and save in the .canvas file.')];
    for (const t of Object.values(lib)) {
      const row = h('div', 'cmp-type-row');
      row.style.setProperty('--c', t.color ?? '#666');
      const n = instancesOf(app.doc, t.id).length;
      row.append(h('span', 'cmp-type-name', `${t.icon ?? '▣'} ${t.name}`), h('span', 'cmp-muted', `${t.fields.length} fields · ${n}`));
      const add = button('+', () => addInstance(app, t.id, app.viewCenter()));
      add.title = `New ${t.name} in the middle of the view`;
      row.append(add, button('Table', () => openTable(app, t.id)), button('Edit', () => go({ kind: 'type', id: t.id })));
      out.push(row);
    }
    if (!Object.keys(lib).length) out.push(h('p', 'cmp-muted', 'No types yet.'));
    const actions = h('div', 'cmp-actions');
    actions.append(
      button('+ New type', () => {
        const name = 'New type';
        const r = app.dispatch('components.defineType', { def: { name, icon: '▣', color: '#4a6fa5', fields: [{ label: 'Title', kind: 'text' }, { label: 'Notes', kind: 'longtext', card: true }] } });
        if (r.ok) go({ kind: 'type', id: Object.keys(library(app.doc)).find((id) => !lib[id])! });
      }),
      button('Starter kit', () => app.dispatch('components.starter', app.viewCenter())),
      button('Library JSON', () => go({ kind: 'json' })),
    );
    const ex = h('div', 'cmp-actions');
    ex.append(h('span', 'cmp-muted', 'Export all:'), button('JSON', () => showExport('JSON', JSON.stringify(exportJson(app.doc), null, 2), 'components.json')), button('Markdown', () => showExport('Markdown', exportMarkdown(app.doc), 'components.md')));
    out.push(actions, ex);
    return out;
  }

  function typeView(t: ComponentType) {
    const def = (patch: Partial<ComponentType>) => app.dispatch('components.defineType', { def: { ...t, ...patch } });
    const out: HTMLElement[] = [];
    const top = h('div', 'cmp-actions');
    top.append(button('← Library', () => go({ kind: 'list' })), button('Table', () => openTable(app, t.id)), button('+ Card', () => addInstance(app, t.id, app.viewCenter())));
    out.push(top);
    const meta = h('div', 'cmp-type-meta');
    const icon = h('input', 'cmp-icon-in');
    icon.value = t.icon ?? '';
    icon.maxLength = 4;
    icon.onchange = () => def({ icon: icon.value });
    const name = h('input');
    name.value = t.name;
    name.onchange = () => def({ name: name.value });
    const color = h('input');
    color.type = 'color';
    color.value = t.color ?? '#666666';
    color.onchange = () => def({ color: color.value });
    meta.append(icon, name, color);
    out.push(meta);
    const titleRow = h('label', 'cmp-inline', 'Card title: ');
    const title = h('select');
    for (const f of t.fields) title.append(new Option(f.label, f.id));
    title.value = t.title ?? t.fields[0]?.id ?? '';
    title.onchange = () => def({ title: title.value });
    titleRow.append(title);
    out.push(titleRow, h('h3', undefined, 'Fields'), h('p', 'cmp-muted', '☑ = shown on the card when zoomed out a bit'));
    t.fields.forEach((f, i) => out.push(fieldRow(t, f, i)));
    // add a field
    const add = h('form', 'cmp-field-row cmp-add');
    const label = h('input');
    label.placeholder = 'New field label';
    const kind = kindSelect('text');
    const extra = h('span');
    const syncExtra = () => extra.replaceChildren(...extraFor(kind.value as FieldDef['kind'], undefined, () => {}));
    kind.onchange = syncExtra;
    syncExtra();
    add.append(label, kind, extra, h('button', undefined, 'Add field'));
    add.onsubmit = (e) => {
      e.preventDefault();
      if (!label.value.trim()) return label.focus();
      const field: Record<string, unknown> = { label: label.value, kind: kind.value, card: true };
      const x = extra.querySelector<HTMLInputElement | HTMLSelectElement>('[name]');
      if (x?.name === 'options') field.options = x.value.split(',').map((s) => s.trim());
      if (x?.name === 'to') field.to = x.value || undefined;
      app.dispatch('components.addField', { type: t.id, field });
      requestAnimationFrame(() => panel.querySelector<HTMLInputElement>('.cmp-add input')?.focus());
    };
    out.push(add);
    const n = instancesOf(app.doc, t.id).length;
    const del = button('Delete type', () => {
      app.dispatch('components.deleteType', { type: t.id });
      go({ kind: 'list' });
    }, 'cmp-danger');
    del.disabled = n > 0;
    del.title = n ? `${n} cards use it: delete them first` : '';
    const json = h('details', 'cmp-json-peek');
    json.append(h('summary', undefined, 'As JSON'), h('pre', undefined, JSON.stringify(t, null, 2)));
    out.push(json, del);
    return out;
  }

  function kindSelect(v: string) {
    const s = h('select');
    for (const k of KINDS) s.append(new Option(k === 'ref' ? 'reference' : k, k));
    s.value = v;
    return s;
  }

  function extraFor(kind: FieldDef['kind'], f: FieldDef | undefined, commit: (patch: Partial<FieldDef>) => void): HTMLElement[] {
    if (kind === 'enum') {
      const o = h('input', 'cmp-opts');
      o.name = 'options';
      o.placeholder = 'a, b, c';
      o.value = f?.options?.join(', ') ?? '';
      o.onchange = () => commit({ options: o.value.split(',').map((s) => s.trim()) });
      return [o];
    }
    if (kind === 'ref') {
      const s = h('select');
      s.name = 'to';
      s.append(new Option('any card', ''));
      for (const t of Object.values(library(app.doc))) s.append(new Option(`→ ${t.name}`, t.id));
      s.value = f?.to ?? '';
      s.onchange = () => commit({ to: s.value || undefined });
      return [s];
    }
    return [];
  }

  function fieldRow(t: ComponentType, f: FieldDef, i: number) {
    const row = h('div', 'cmp-field-row');
    const upd = (patch: Partial<FieldDef>) => app.dispatch('components.updateField', { type: t.id, field: f.id, patch });
    const card = h('input');
    card.type = 'checkbox';
    card.checked = !!f.card;
    card.title = 'Show on the card when zoomed out a bit';
    card.onchange = () => upd({ card: card.checked });
    const label = h('input');
    label.value = f.label;
    label.onchange = () => upd({ label: label.value });
    const kind = kindSelect(f.kind);
    kind.onchange = () => upd({ kind: kind.value as FieldDef['kind'] });
    const up = button('↑', () => app.dispatch('components.moveField', { type: t.id, field: f.id, by: -1 }), 'cmp-mini');
    up.disabled = i === 0;
    const down = button('↓', () => app.dispatch('components.moveField', { type: t.id, field: f.id, by: 1 }), 'cmp-mini');
    down.disabled = i === t.fields.length - 1;
    const rm = button('✕', () => app.dispatch('components.removeField', { type: t.id, field: f.id }), 'cmp-mini');
    rm.title = 'Remove the field (and its values; Undo brings them back)';
    row.append(card, label, kind, ...extraFor(f.kind, f, upd), up, down, rm);
    return row;
  }

  function jsonView() {
    const ta = h('textarea', 'cmp-json');
    ta.value = JSON.stringify(Object.values(library(app.doc)), null, 2);
    ta.spellcheck = false;
    const msg = h('p', 'cmp-muted', 'The whole library as data: edit, paste an agent’s output, then Apply. Types are matched by id (new id = new type).');
    const actions = h('div', 'cmp-actions');
    actions.append(
      button('← Library', () => go({ kind: 'list' })),
      button('Apply', () => {
        let defs: unknown;
        try {
          defs = JSON.parse(ta.value);
        } catch (e) {
          msg.textContent = `Not JSON: ${(e as Error).message}`;
          return;
        }
        const list = Array.isArray(defs) ? defs : [defs];
        let ok = 0;
        app.store.newUndoStep();
        app.store.merged(() => {
          for (const def of list) if (app.dispatch('components.defineType', { def }).changes.length) ok++;
        });
        msg.textContent = `Applied ${ok} of ${list.length} type(s). Undo (⌘Z) reverts all.`;
      }),
    );
    return [h('h2', undefined, 'Library JSON'), msg, ta, actions];
  }

  function showExport(kind: string, text: string, file: string) {
    const overlay = h('div', 'cmp-overlay');
    const box = h('div', 'cmp-sheet cmp-export');
    const pre = h('textarea', 'cmp-json');
    pre.value = text;
    pre.readOnly = true;
    const actions = h('div', 'cmp-actions');
    const close = () => overlay.remove();
    actions.append(
      button('Copy', async () => {
        await navigator.clipboard?.writeText(text).catch(() => {});
        app.notify(`${kind} copied`);
      }),
      button('Download', () => {
        const a = h('a');
        a.href = URL.createObjectURL(new Blob([text], { type: kind === 'JSON' ? 'application/json' : 'text/markdown' }));
        a.download = file;
        a.click();
        URL.revokeObjectURL(a.href);
      }),
      button('Close', close),
    );
    box.append(h('h2', undefined, `Export: ${kind}`), pre, actions);
    overlay.append(box);
    overlay.addEventListener('pointerdown', (e) => e.target === overlay && close());
    document.body.append(overlay);
  }

  function draw() {
    if (panel.hidden || pressing) return;
    // never redraw under the user's typing (a commit lands when the field loses focus)
    const active = document.activeElement;
    if (active && panel.contains(active) && active.matches('input:not([type=checkbox]), textarea')) return;
    const t = mode.kind === 'type' ? library(app.doc)[mode.id] : undefined;
    if (mode.kind === 'type' && !t) mode = { kind: 'list' };
    const x = button('✕', () => toggle(false), 'cmp-close');
    panel.replaceChildren(x, ...(mode.kind === 'json' ? jsonView() : t ? typeView(t) : listView()));
  }
  // The JSON view is never redrawn from outside (it would drop unapplied edits and the Apply message).
  const refresh = () => {
    if (mode.kind !== 'json') draw();
  };
  // Never redraw between pointerdown and click: replacing the pressed button would swallow its click
  // (e.g. a focusout redraw when leaving a field to press "Add field" or "Apply").
  let pressing = false;
  panel.addEventListener('pointerdown', () => (pressing = true), true);
  const release = () => {
    if (!pressing) return;
    pressing = false;
    setTimeout(refresh);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  app.store.subscribe(refresh);
  panel.addEventListener('focusout', () => setTimeout(refresh));
}
