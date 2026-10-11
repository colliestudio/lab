import type { CanvasNode, DocView } from '../../core';
import { coerce, ctypeOf, data, display, instancesOf, titleField, titleOf, typeOf, type ComponentType, type FieldDef } from './model';

// DOM for cards and form controls. Everything user-authored goes in via textContent / value / a
// checked image URL: a type is data and can't inject markup or script.

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A form control for one field; `commit` gets the raw value (the command validates it). */
export function fieldControl(doc: DocView, f: FieldDef, v: unknown, commit: (value: unknown) => void, selfId?: string): HTMLElement {
  let c: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  switch (f.kind) {
    case 'longtext':
    case 'list': {
      const t = h('textarea');
      t.rows = f.kind === 'list' ? Math.max(2, (Array.isArray(v) ? v.length : 0) + 1) : 3;
      t.value = f.kind === 'list' ? (Array.isArray(v) ? v.join('\n') : '') : typeof v === 'string' ? v : '';
      if (f.kind === 'list') t.placeholder = 'one per line';
      c = t;
      break;
    }
    case 'enum':
    case 'ref': {
      const s = h('select');
      s.append(new Option('—', ''));
      if (f.kind === 'enum') for (const o of f.options ?? []) s.append(new Option(o, o));
      else
        for (const n of f.to ? instancesOf(doc, f.to) : doc.nodes.filter((n) => ctypeOf(n)))
          if (n.id !== selfId) s.append(new Option(titleOf(doc, n), n.id));
      s.value = typeof v === 'string' ? v : '';
      c = s;
      break;
    }
    default: {
      const i = h('input');
      i.type = f.kind === 'number' ? 'number' : f.kind === 'image' ? 'url' : 'text';
      if (f.kind === 'image') i.placeholder = 'https://…';
      i.value = v === undefined ? '' : String(v);
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') i.blur();
      });
      c = i;
    }
  }
  c.className = 'cmp-input';
  c.dataset.action = 'edit';
  c.dataset.field = f.id;
  c.addEventListener('change', () => commit(c.value));
  return c;
}

function valueEl(doc: DocView, f: FieldDef, v: unknown): HTMLElement {
  if (f.kind === 'image') {
    if (typeof v !== 'string' || coerce(f, v) === null) return h('div', 'cmp-value cmp-empty', '—');
    const img = h('img', 'cmp-img');
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.draggable = false;
    img.src = v;
    return img;
  }
  if (f.kind === 'list' && Array.isArray(v) && v.length) {
    const ul = h('ul', 'cmp-value cmp-list');
    for (const x of v) ul.append(h('li', undefined, String(x)));
    return ul;
  }
  const text = display(doc, f, v);
  const d = h('div', `cmp-value cmp-${f.kind}${text ? '' : ' cmp-empty'}`, text || '—');
  if (f.kind === 'enum' && text) d.dataset.value = text;
  if (f.kind === 'ref' && text) d.textContent = '→ ' + text;
  return d;
}

export interface CardOpts {
  editing: boolean;
  commit(field: string, value: unknown): void;
}

/** The card: header (icon, title, type name), then fields. Classes drive zoom detail levels. */
export function renderCard(doc: DocView, n: CanvasNode, el: HTMLElement, opts: CardOpts) {
  const t = typeOf(doc, ctypeOf(n));
  const card = h('div', 'cmp-card' + (opts.editing ? ' cmp-editing' : ''));
  card.style.setProperty('--c', t?.color ?? '#666');
  const head = h('div', 'cmp-head');
  head.append(h('span', 'cmp-icon', t?.icon ?? '▣'));
  const title = t && titleField(t);
  if (opts.editing && title) head.append(fieldControl(doc, title, data(n)[title.id], (v) => opts.commit(title.id, v), n.id));
  else head.append(h('span', 'cmp-title', titleOf(doc, n)));
  const tag = h('span', 'cmp-type', t?.name ?? `unknown type “${ctypeOf(n)}”`);
  head.append(tag);
  if (opts.editing) {
    const done = h('button', 'cmp-done', 'Done');
    done.dataset.action = 'done';
    head.append(done);
  }
  card.append(head);
  const body = h('div', 'cmp-body');
  for (const f of t?.fields ?? []) {
    if (f === title) continue;
    const row = h('div', 'cmp-field');
    if (f.card) row.dataset.card = '';
    row.append(h('div', 'cmp-label', f.label));
    const v = data(n)[f.id];
    row.append(opts.editing ? fieldControl(doc, f, v, (x) => opts.commit(f.id, x), n.id) : valueEl(doc, f, v));
    body.append(row);
  }
  card.append(body);
  el.append(card);
}

/** Re-render key: the type, the values, and the titles of referenced cards. */
export function cardKey(doc: DocView, n: CanvasNode, t: ComponentType | undefined): string {
  const refs = (t?.fields ?? []).filter((f) => f.kind === 'ref').map((f) => display(doc, f, data(n)[f.id]));
  return JSON.stringify([t, n[`x-components`], refs, n.width, n.height]);
}
