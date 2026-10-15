import type { App, CanvasEdge, CanvasNode } from '../../core';
import { edgeStyle } from '../../core';
import { FILLS, INK, STROKES, TEXT_SIZES, DEFAULT_TEXT_SIZE, fillOf, shapeOf, sizeOf, strokeOf, type ShapeKind } from './model';

// The style panel: what can be changed on the selected shapes / arrows. Every button is one command
// (the same ones an agent calls), so undo and the bridge see the same thing.

const KIND_BUTTONS: { kind: ShapeKind; glyph: string; title: string }[] = [
  { kind: 'rect', glyph: '▭', title: 'Rectangle' },
  { kind: 'ellipse', glyph: '◯', title: 'Ellipse' },
  { kind: 'diamond', glyph: '◇', title: 'Diamond' },
  { kind: 'text', glyph: 'T', title: 'Text' },
  { kind: 'sticky', glyph: '◧', title: 'Sticky note' },
];

const ENDS: { label: string; title: string; from: 'none' | 'arrow'; to: 'none' | 'arrow' }[] = [
  { label: '—', title: 'No arrowheads', from: 'none', to: 'none' },
  { label: '→', title: 'Arrow at the end', from: 'none', to: 'arrow' },
  { label: '←', title: 'Arrow at the start', from: 'arrow', to: 'none' },
  { label: '↔', title: 'Arrows at both ends', from: 'arrow', to: 'arrow' },
];

export function mountPanel(app: App) {
  const panel = document.createElement('div');
  panel.className = 'dg-panel';
  panel.hidden = true;
  app.view.root.append(panel);
  // a press on the panel is not a press on the table
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation());
  let key = '';

  const shapesOf = () => app.selected().filter((n) => shapeOf(n));
  const edgesOf = () => [...app.store.selection].map((id) => app.doc.edge(id)).filter((e): e is CanvasEdge => !!e);

  const run = (fn: () => void) => {
    app.store.newUndoStep();
    app.store.merged(fn);
    app.view.root.focus({ preventScroll: true });
  };
  const shapeStyle = (patch: Record<string, unknown>) => run(() => app.dispatch('diagram.update', { ids: shapesOf().map((n) => n.id), ...patch }));
  const edgeStyleSet = (patch: Record<string, unknown>) => run(() => edgesOf().forEach((e) => app.dispatch('core.edge', { id: e.id, ...patch })));

  const btn = (parent: HTMLElement, label: string, title: string, on: boolean, click: () => void, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.className = (on ? 'on ' : '') + cls;
    b.addEventListener('click', click);
    parent.append(b);
    return b;
  };
  const section = (title: string) => {
    const wrap = document.createElement('div');
    const h = document.createElement('h4');
    h.textContent = title;
    const row = document.createElement('div');
    row.className = 'dg-row';
    wrap.append(h, row);
    panel.append(wrap);
    return row;
  };
  const swatch = (row: HTMLElement, color: string, on: boolean, click: () => void) => {
    const b = btn(row, '', color === 'none' ? 'No fill' : color, on, click, 'dg-sw' + (color === 'none' ? ' none' : ''));
    if (color !== 'none') b.style.background = color;
    if (color === '#ffffff' || color === 'none') b.style.borderColor = on ? '#4c8dff' : '#b8bec7';
    return b;
  };

  const build = () => {
    const shapes = shapesOf();
    const edges = edgesOf();
    panel.replaceChildren();
    if (shapes.length) {
      const styles = shapes.map((n) => shapeOf(n)!);
      const all = <T>(f: (s: (typeof styles)[number]) => T) => (styles.every((s) => f(s) === f(styles[0])) ? f(styles[0]) : undefined);
      const kinds = section('Shape');
      for (const k of KIND_BUTTONS) btn(kinds, k.glyph, k.title, all((s) => s.kind) === k.kind, () => shapeStyle({ kind: k.kind }));
      const stroke = section('Stroke');
      for (const c of STROKES) swatch(stroke, c, all(strokeOf) === c, () => shapeStyle({ stroke: c === INK ? null : c }));
      const fill = section('Fill');
      for (const c of FILLS) swatch(fill, c, all(fillOf) === c, () => shapeStyle({ fill: c }));
      const line = section('Line');
      btn(line, '━', 'Solid', !all((s) => !!s.dashed), () => shapeStyle({ dashed: false }));
      btn(line, '┅', 'Dashed', !!all((s) => !!s.dashed), () => shapeStyle({ dashed: true }));
      const text = section('Text size');
      for (const t of TEXT_SIZES) btn(text, t.label, `${t.px}px`, all(sizeOf) === t.px, () => shapeStyle({ size: t.px === DEFAULT_TEXT_SIZE ? null : t.px }));
    }
    if (edges.length) {
      const cur = edges.map((e) => ({ color: e.color ?? INK, dashed: !!edgeStyle(e).dashed, curve: !!edgeStyle(e).curve, from: e.fromEnd ?? 'none', to: e.toEnd ?? 'arrow' }));
      const all = <K extends keyof (typeof cur)[number]>(k: K) => (cur.every((c) => c[k] === cur[0][k]) ? cur[0][k] : undefined);
      const color = section('Arrow color');
      for (const c of STROKES) swatch(color, c, all('color') === c, () => edgeStyleSet({ color: c === INK ? null : c }));
      const line = section('Line');
      btn(line, '━', 'Solid', all('dashed') === false, () => edgeStyleSet({ dashed: false }));
      btn(line, '┅', 'Dashed', all('dashed') === true, () => edgeStyleSet({ dashed: true }));
      btn(line, '⎯', 'Straight', all('curve') === false, () => edgeStyleSet({ curve: false }));
      btn(line, '⌒', 'Curved', all('curve') === true, () => edgeStyleSet({ curve: true }));
      const ends = section('Arrowheads');
      for (const en of ENDS) btn(ends, en.label, en.title, all('from') === en.from && all('to') === en.to, () => edgeStyleSet({ fromEnd: en.from, toEnd: en.to }));
      if (edges.length === 1) {
        const lab = section('Label');
        btn(lab, 'Edit label', 'Edit the label (Enter)', false, () => app.view.editEdgeLabel(edges[0].id));
      }
    }
  };

  const update = () => {
    const shapes = shapesOf();
    const edges = edgesOf();
    const show = shapes.length > 0 || edges.length > 0;
    const k = show ? JSON.stringify([shapes.map((n: CanvasNode) => [n.id, n['x-shape']]), edges]) : '';
    panel.hidden = !show;
    if (k === key) return;
    key = k;
    if (show) build();
  };
  app.store.subscribe(update);
  update();
}
