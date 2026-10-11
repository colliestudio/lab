import './components.css';
import type { App, CanvasNode, MenuEntry, Plugin } from '../../core';
import { refEdges } from './export';
import { registerComponentsLogic } from './logic';
import { CARD_W, ctypeOf, isInstance, library, typeOf } from './model';
import { cardKey, renderCard } from './render';
import { openTable } from './table';
import { addInstance, editing, setEditing } from './editing';

export { registerComponentsLogic } from './logic';
export { mountComponentsPanel } from './panel';
export { exportJson, exportMarkdown } from './export';
export { addInstance } from './editing';

/** Reference lines, drawn under the cards (an SVG layer in the world). */
function mountEdges(app: App) {
  const NS_SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS_SVG, 'svg');
  svg.classList.add('cmp-edges');
  svg.innerHTML = `<defs><marker id="cmp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="rgba(255,255,255,0.75)"/></marker></defs>`;
  const g = document.createElementNS(NS_SVG, 'g');
  svg.append(g);
  app.view.world.prepend(svg);
  const clip = (n: CanvasNode, tx: number, ty: number) => {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const s = Math.min(Math.abs(n.width / 2 / (dx || 1e-9)), Math.abs(n.height / 2 / (dy || 1e-9)));
    return [cx + dx * Math.min(1, s), cy + dy * Math.min(1, s)];
  };
  let last = '';
  const draw = () => {
    const doc = app.store.doc;
    const edges = refEdges(doc).filter((e) => doc.isVisible(e.from) && doc.isVisible(e.to));
    const parts: string[] = [];
    for (const e of edges) {
      const a = doc.get(e.from)!;
      const b = doc.get(e.to)!;
      const [x1, y1] = clip(a, b.x + b.width / 2, b.y + b.height / 2);
      const [x2, y2] = clip(b, a.x + a.width / 2, a.y + a.height / 2);
      parts.push(`${e.from}|${e.field}|${x1.toFixed(0)},${y1.toFixed(0)},${x2.toFixed(0)},${y2.toFixed(0)}|${e.label}`);
    }
    const key = parts.join('\n');
    if (key === last) return;
    last = key;
    g.replaceChildren();
    for (const p of parts) {
      const [, , coords, label] = p.split('|');
      const [x1, y1, x2, y2] = coords.split(',').map(Number);
      const line = document.createElementNS(NS_SVG, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute('marker-end', 'url(#cmp-arrow)');
      const text = document.createElementNS(NS_SVG, 'text');
      text.setAttribute('x', String((x1 + x2) / 2));
      text.setAttribute('y', String((y1 + y2) / 2 - 6));
      text.textContent = label;
      g.append(line, text);
    }
  };
  app.store.subscribe(draw);
  draw();
}

/** Detail by zoom: far = title only (big), mid = summary fields, near = everything. */
function mountDetailLevels(app: App) {
  const root = app.view.root;
  const apply = () => {
    const z = app.viewport.zoom;
    root.classList.toggle('cmp-lod-far', z < 0.45);
    root.classList.toggle('cmp-lod-mid', z >= 0.45 && z < 0.8);
  };
  app.viewport.onChange(apply);
  apply();
}

export const componentsPlugin: Plugin = {
  id: 'components',
  setup(app) {
    registerComponentsLogic(app.store);
    const commit = (id: string) => (field: string, value: unknown) => app.dispatch('components.set', { id, field, value });

    app.registerType({
      id: 'component',
      match: isInstance,
      render(node, el, ctx) {
        renderCard(ctx.doc, node, el, { editing: editing.has(node.id), commit: commit(node.id) });
      },
      // while editing, keep the form (and its focus): changes still commit field by field
      renderKey: (node, ctx) => (editing.has(node.id) ? `editing` : cardKey(ctx.doc, node, typeOf(ctx.doc, ctypeOf(node)))),
      onDoubleClick(node) {
        setEditing(app, node.id, true);
      },
      onAction(node, action) {
        if (action === 'done') setEditing(app, node.id, false);
      },
    });

    // leaving a card (click elsewhere, Esc) ends its edit
    app.store.subscribe(() => {
      for (const id of editing) if (!app.store.selection.has(id) || !app.node(id)) setEditing(app, id, false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !editing.size) return;
      const t = e.target as Element | null;
      if (!t?.closest?.('.cmp-card')) return;
      for (const id of [...editing]) setEditing(app, id, false);
      app.view.root.focus();
    });

    mountEdges(app);
    mountDetailLevels(app);

    app.registerKit({ id: 'components.starter', label: 'Product discovery starter (Persona, Story, Decision, Metric)', create: (a, at) => a.dispatch('components.starter', at) });

    const newEntries = (at: () => { x: number; y: number }): MenuEntry[] =>
      Object.values(library(app.doc)).map((t) => ({ label: `${t.icon ?? '▣'} ${t.name}`, color: t.color, run: () => addInstance(app, t.id, at()) }));
    app.registerMenu((a, sel) => {
      const at = () => a.view.menuPoint ?? a.viewCenter();
      if (!sel.length) {
        const items = newEntries(at);
        return { entries: items.length ? [{ label: 'New component', items }] : [{ label: 'Component starter kit', run: () => a.dispatch('components.starter', at()) }] };
      }
      if (sel.length !== 1 || !isInstance(sel[0])) return;
      const n = sel[0];
      const t = typeOf(a.doc, ctypeOf(n));
      return {
        title: t?.name ?? 'Component',
        entries: [
          { label: 'Edit fields', hint: 'double-click', run: () => setEditing(a, n.id, true) },
          ...(t
            ? [
                { label: `All ${t.name} cards as a table`, run: () => openTable(a, t.id) },
                { label: `Edit type ${t.name}…`, run: () => document.dispatchEvent(new CustomEvent('cmp:edit-type', { detail: t.id })) },
                { label: `New ${t.name}`, run: () => addInstance(a, t.id, { x: n.x + n.width + 40 + CARD_W / 2, y: n.y + 60 }) },
              ]
            : []),
        ],
      };
    });
  },
};
