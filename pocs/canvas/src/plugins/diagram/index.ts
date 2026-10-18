import './diagram.css';
import { inlineEdit, type CanvasNode, type InlineEdit, type Plugin } from '../../core';
import { mountHandles } from './handles';
import { useLogic } from '../logic';
import { logic } from './logic';
import { DEFAULT_TEXT_SIZE, isShape, shapeOf, textBox, type ShapeKind } from './model';
import { mountPanel } from './panel';
import { renderShape, styleKey } from './render';

export { registerDiagramLogic } from './logic';
export * from './model';

// Diagram: boxes, ellipses, diamonds, text and sticky notes joined by arrows, for sketching and
// thinking things through. Shapes are JSON Canvas text nodes with an `x-shape` look; arrows are plain
// core edges. Everything goes through commands (logic.ts), so an agent can do what a person can.

/** Tools: key (when nothing is selected), dock icon (a name in core ICONS). */
export const SHAPE_TOOLS: { kind: ShapeKind; key: string; icon: string; label: string }[] = [
  { kind: 'rect', key: 'r', icon: 'square', label: 'Rectangle' },
  { kind: 'ellipse', key: 'o', icon: 'circle', label: 'Ellipse' },
  { kind: 'diamond', key: 'd', icon: 'diamond', label: 'Diamond' },
  { kind: 'text', key: 't', icon: 'type', label: 'Text' },
  { kind: 'sticky', key: 's', icon: 'sticky-note', label: 'Sticky note' },
];

export const diagramPlugin: Plugin = {
  id: 'diagram',
  setup(app) {
    useLogic(app.store, logic);
    const root = app.view.root;

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
      session = inlineEdit(el, { seed: opts.seed, dragThrough: true, onCommit: finish });
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
    /** Text and sticky notes open the editor on creation; boxes just get selected (type, Enter or double-click to edit), so they can be moved right away. */
    const opensEditor = (kind: ShapeKind) => kind === 'text' || kind === 'sticky';

    /** Put a shape where the tool was used (a click = default size around the point; a drag = that box), then type into it. */
    const create = (kind: ShapeKind, box: { x: number; y: number; width: number; height: number }) => {
      const dragged = box.width >= 12 && box.height >= 12;
      const args: Record<string, unknown> = { kind };
      if (dragged) Object.assign(args, { x: box.x, y: box.y, width: box.width, height: box.height });
      else if (kind === 'text') Object.assign(args, { x: box.x, y: Math.round(box.y - textBox('', DEFAULT_TEXT_SIZE).h / 2) });
      else Object.assign(args, { cx: box.x, cy: box.y });
      const id = app.dispatch('diagram.add', args).select?.[0];
      if (id && opensEditor(kind)) startEdit(id, { fresh: true });
    };
    for (const t of SHAPE_TOOLS) {
      const id = `diagram.${t.kind}`;
      app.registerTool({
        id,
        label: t.label,
        title: `${t.label} (${t.key.toUpperCase()}): click or drag on the table`,
        key: t.key,
        owns: isShape,
        create: (_a, box) => create(t.kind, box),
      });
      app.registerDockItem({
        id,
        label: t.label,
        icon: t.icon,
        shortcut: t.key.toUpperCase(),
        section: 'create',
        active: (a) => a.view.tool === id,
        run: (a) => a.view.setTool(a.view.tool === id ? 'select' : id),
      });
    }
    // double-click on empty board: a line of text right there
    app.registerEmptyDoubleClick((at) => {
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
        const kind = id ? shapeOf(app.node(id))?.kind : undefined;
        if (id && kind && opensEditor(kind)) startEdit(id, { fresh: true });
      },
    });
    mountPanel(app);

    // new shapes land a little way from the middle when made from a menu: the Add menu
    for (const t of SHAPE_TOOLS) {
      app.registerKit({
        id: `diagram.${t.kind}`,
        label: t.label,
        create: (a, at) => {
          const id = a.dispatch('diagram.add', { kind: t.kind, cx: at.x, cy: at.y }).select?.[0];
          if (id && opensEditor(t.kind)) startEdit(id, { fresh: true });
        },
      });
    }
  },
};

export type { CanvasNode };
