import './diagram.css';
import { inlineEdit, type App, type CanvasNode, type InlineEdit, type Plugin } from '../../core';
import { mountHandles } from './handles';
import { registerDiagramLogic } from './logic';
import { DEFAULT_TEXT_SIZE, isShape, shapeOf, textBox, type ShapeKind } from './model';
import { mountPanel } from './panel';
import { renderShape, styleKey } from './render';

export { registerDiagramLogic } from './logic';
export * from './model';

// Diagram: boxes, ellipses, diamonds, text and sticky notes joined by arrows, for sketching and
// thinking things through. Shapes are JSON Canvas text nodes with an `x-shape` look; arrows are plain
// core edges. Everything goes through commands (logic.ts), so an agent can do what a person can.

/** Tools: key (when nothing is selected), toolbar glyph. */
export const SHAPE_TOOLS: { kind: ShapeKind; key: string; glyph: string; label: string }[] = [
  { kind: 'rect', key: 'r', glyph: '▭', label: 'Rectangle' },
  { kind: 'ellipse', key: 'o', glyph: '◯', label: 'Ellipse' },
  { kind: 'diamond', key: 'd', glyph: '◇', label: 'Diamond' },
  { kind: 'text', key: 't', glyph: 'T', label: 'Text' },
  { kind: 'sticky', key: 's', glyph: '◧', label: 'Sticky note' },
];

/** Set once a diagram has been started in this tab: the table turns to paper even while it is empty. */
let paperOn = false;
const hasShapes = (app: App) => app.doc.nodes.some(isShape);
export const isPaper = (app: App) => paperOn || hasShapes(app);
export function enterPaper(app: App) {
  paperOn = true;
  app.view.root.classList.add('cv-paper');
}
/** Another kind of table replaced the diagram: paper (and the shape tool keys) only if it holds shapes. */
export function leavePaper(app: App) {
  paperOn = false;
  app.view.root.classList.toggle('cv-paper', hasShapes(app));
}

export const diagramPlugin: Plugin = {
  id: 'diagram',
  setup(app) {
    registerDiagramLogic(app.store);

    const root = app.view.root;
    const syncPaper = () => root.classList.toggle('cv-paper', isPaper(app));
    app.store.subscribe(syncPaper);
    syncPaper();

    // ------------------------------------------------------------ editing a shape's words, where it sits
    let editing: { id: string; fresh: boolean } | null = null;
    let session: InlineEdit | undefined;

    const finish = (text: string) => {
      const e = editing;
      editing = null;
      session = undefined;
      const n = e && app.node(e.id);
      if (e && n) {
        // an empty new text: take the creation back, leaving no step behind
        if (e.fresh && shapeOf(n)?.kind === 'text' && !text.trim()) app.store.undo();
        else if (text !== (n.text ?? '')) app.dispatch('diagram.update', { id: e.id, text }, { merge: e.fresh });
      }
      app.view.render();
      root.focus({ preventScroll: true });
    };

    const startEdit = (id: string, opts: { seed?: string; fresh?: boolean } = {}) => {
      session?.close(true);
      if (!app.node(id)) return;
      editing = { id, fresh: !!opts.fresh };
      app.store.select([id]);
      app.view.render();
      const el = app.view.boxOf(id)?.querySelector<HTMLElement>('.dg-text');
      if (!el) {
        editing = null;
        return;
      }
      session = inlineEdit(el, { seed: opts.seed, onCommit: finish });
    };

    app.registerType({
      id: 'diagram.shape',
      match: isShape,
      // while its words are typed, a redraw (someone else's change) must not replace the editor
      renderKey: (n) => (editing?.id === n.id ? 'editing' : `${styleKey(n)}\n${n.text ?? ''}`),
      render: (n, el) => renderShape(n, el),
      onDoubleClick: (n) => {
        app.store.newUndoStep();
        startEdit(n.id);
      },
      edit: (n, _a, seed) => startEdit(n.id, { seed }),
      altDragDuplicates: true,
    });

    // ------------------------------------------------------------ making shapes
    /** Put a shape where the tool was used (a click = default size around the point; a drag = that box), then type into it. */
    const create = (kind: ShapeKind, box: { x: number; y: number; width: number; height: number }) => {
      const dragged = box.width >= 12 && box.height >= 12;
      const args: Record<string, unknown> = { kind };
      if (dragged) Object.assign(args, { x: box.x, y: box.y, width: box.width, height: box.height });
      else if (kind === 'text') Object.assign(args, { x: box.x, y: Math.round(box.y - textBox('', DEFAULT_TEXT_SIZE).h / 2) });
      else Object.assign(args, { cx: box.x, cy: box.y });
      const id = app.dispatch('diagram.add', args).select?.[0];
      if (id) startEdit(id, { fresh: true });
    };
    for (const t of SHAPE_TOOLS) {
      app.registerTool({
        id: `diagram.${t.kind}`,
        label: t.glyph,
        title: `${t.label} (${t.key.toUpperCase()}): click or drag on the table`,
        key: t.key,
        when: isPaper,
        create: (_a, box) => create(t.kind, box),
      });
    }
    // double-click on empty paper: a line of text right there
    app.registerEmptyDoubleClick((at) => {
      if (!isPaper(app)) return false;
      create('text', { x: at.x, y: at.y, width: 0, height: 0 });
      return true;
    });

    // ------------------------------------------------------------ arrows pulled from a shape's dots
    mountHandles(app, {
      connect(from, side, drop) {
        if (drop.to) {
          app.dispatch('core.connect', { from, to: drop.to, fromSide: side, toSide: drop.toSide });
          return;
        }
        const id = app.dispatch('diagram.addConnected', { from, side, at: drop.at }).select?.[0];
        if (id) startEdit(id, { fresh: true });
      },
    });
    mountPanel(app, () => isPaper(app));

    // new shapes land a little way from the middle when made from a menu: the Add menu
    for (const t of SHAPE_TOOLS) {
      app.registerKit({
        id: `diagram.${t.kind}`,
        label: t.label,
        create: (a, at) => {
          const id = a.dispatch('diagram.add', { kind: t.kind, cx: at.x, cy: at.y }).select?.[0];
          if (id) startEdit(id, { fresh: true });
        },
      });
    }
  },
};

export type { CanvasNode };
