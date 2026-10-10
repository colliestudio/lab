import './mats.css';
import type { App, CanvasNode, MenuEntry, ObjectType, Plugin } from '../../core';
import { canGive, handLabelOf, seats } from '../cards';
import { cardsIn, isHand, isStacked, layoutOf, type Layout } from '../cards/deck';
import { zonesOf } from './commands';
import { registerMatsLogic } from './logic';
import { MAT_COLORS, ZONE_KINDS, ZONE_KIND_NAMES, deckField, isFreeZone, isMat, isZone, mat, zone, zoneName } from './model';
import { PRESETS, presetOf, type PresetId } from './presets';
import { areaHtml, matHtml, zoneEditHtml } from './render';
import { askText } from './textDialog';

const onGrip = (down: PointerEvent) => !!(down.target as Element | null)?.closest?.('[data-grip]');
const EDIT_FIRST = 'Turn on Edit zones (Z) first';
const LAYOUT_NAMES: Record<Layout, string> = { stack: 'Pile', fan: 'Fan', row: 'Row', grid: 'Grid', column: 'Column', 'column-up': 'Column (upward)' };

/** Players at the table (me first) for presets: seats and hands become theirs. */
const players = (app: App) =>
  seats(app)
    .filter((p) => !p.away)
    .map((p) => ({ id: p.id, label: handLabelOf(p.name), color: p.color }));

export const matsPlugin: Plugin = {
  id: 'mats',
  setup(app) {
    registerMatsLogic(app.store);

    // ---------------------------------------------------------------- edit mode (local to this screen)
    const editing = new Set<string>();
    const matOf = (n: CanvasNode | undefined): string | undefined => {
      if (!n) return;
      if (isMat(n)) return n.id;
      if (isZone(n)) return zone(n).zone;
      const c = app.doc.carrierOf(n.id) ?? app.doc.carrierOf(app.doc.parentOf(n.id) ?? '');
      return c && isMat(app.node(c)) ? c : undefined;
    };
    const isEditing = (n: CanvasNode) => {
      const m = matOf(n);
      return !!m && editing.has(m);
    };
    const setEditing = (id: string, on: boolean) => {
      if (on) editing.add(id);
      else editing.delete(id);
      if (!on) app.store.select([...app.store.selection].filter((s) => !isZone(app.node(s))));
      app.view.render();
      app.notify(on ? 'Editing zones: drag to move, corner to resize, ⚙ for settings (Z or Done to finish)' : 'Zones fixed');
    };
    const toggleEditing = (id: string) => setEditing(id, !editing.has(id));

    // ---------------------------------------------------------------- resizing (one undo step per drag)
    const resizeFrom = (id: string, e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const n0 = app.node(id);
      if (!n0) return;
      const z = isZone(n0) && !isFreeZone(n0) ? (deckField(n0)!.area ?? { w: n0.width, h: n0.height }) : { w: n0.width, h: n0.height };
      const [x0, y0] = [e.clientX, e.clientY];
      const zoom = app.viewport.zoom;
      app.store.newUndoStep();
      const move = (ev: PointerEvent) => app.dispatch('mats.resize', { id, w: z.w + (ev.clientX - x0) / zoom, h: z.h + (ev.clientY - y0) / zoom }, { merge: true });
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    const hookResize = (el: HTMLElement, id: string) =>
      el.querySelectorAll<HTMLElement>(':scope > * > .mt-resize').forEach((h) => h.addEventListener('pointerdown', (e) => resizeFrom(id, e)));

    // ---------------------------------------------------------------- menus
    const rename = async (n: CanvasNode) => {
      const v = await askText(isMat(n) ? 'Rename the mat' : 'Rename the zone', isMat(n) ? (n.label ?? 'Mat') : zoneName(n));
      if (v) app.dispatch(isMat(n) ? 'mats.setMat' : 'mats.configZone', isMat(n) ? { id: n.id, label: v } : { id: n.id, name: v });
    };

    function zoneSettings(z: CanvasNode): MenuEntry[] {
      const id = z.id;
      const cfg = (a: Record<string, unknown>) => () => app.dispatch('mats.configZone', { id, ...a });
      const out: MenuEntry[] = [{ label: 'Rename…', run: () => void rename(z) }];
      if (!isFreeZone(z)) {
        const f = deckField(z)!;
        const priv = isHand(z);
        const cur = layoutOf(z);
        const n = cardsIn(app.doc, id).length;
        out.push(
          {
            label: 'Layout',
            items: () =>
              (['stack', 'fan', 'row', 'grid', 'column', 'column-up'] as Layout[]).map((l) => ({
                label: LAYOUT_NAMES[l],
                checked: cur === l,
                disabled: priv && l === 'stack' ? 'A private zone can’t be a pile (its top card would show)' : priv && l !== 'fan' && l !== 'row' ? 'A private zone lays its cards in a fan or a row' : false,
                run: cfg({ layout: l }),
              })),
          },
          {
            label: 'Max cards',
            items: () => [
              { label: 'No limit', checked: f.max === undefined, run: cfg({ max: null }) },
              ...[1, 2, 3, 4, 5, 7, 10, 13].map((k): MenuEntry => ({ label: String(k), checked: f.max === k, run: cfg({ max: k }), disabled: k < n ? `It holds ${n} now` : false })),
              { label: 'Max', separator: true, number: { value: f.max ?? Math.max(1, n), min: 1, max: 60, action: 'Set', run: (k) => cfg({ max: k })() } },
            ],
          },
          {
            label: 'Facing on entry',
            disabled: priv ? 'A private zone keeps its cards private (hand rules)' : false,
            items: () => [
              { label: 'Keep as they are', checked: f.enter === undefined, run: cfg({ enter: 'keep' }) },
              { label: 'Face up', checked: f.enter === 'up', run: cfg({ enter: 'up' }) },
              { label: 'Face down', checked: f.enter === 'down', run: cfg({ enter: 'down' }) },
            ],
          },
        );
      }
      out.push({ label: isFreeZone(z) ? 'Delete area' : 'Delete zone (its cards stay)', separator: true, run: () => app.dispatch('mats.deleteZone', { ids: [id] }) });
      return out;
    }

    function visibilityMenu(z: CanvasNode): MenuEntry {
      const allowed = canGive(app, z);
      return {
        label: 'Visibility',
        disabled: allowed ? false : `Only ${z.label?.replace(/['’]s hand$/, '') ?? 'its owner'} can change it`,
        items: () => [
          { label: 'Public (everyone sees the cards)', checked: !z.owner, run: () => app.dispatch('mats.visibility', { id: z.id, owner: null }) },
          {
            label: 'Private to',
            separator: true,
            items: () =>
              seats(app).map((p) => ({
                label: `${p.name}${p.id === app.viewer ? ' (you)' : ''}${p.away ? ' (left)' : ''}`,
                color: p.color,
                muted: p.away,
                checked: z.owner === p.id,
                run: () => app.dispatch('mats.visibility', { id: z.id, owner: p.id, label: handLabelOf(p.name), color: p.color }),
              })),
          },
        ],
      };
    }

    function zoneMenu(z: CanvasNode): MenuEntry[] {
      const m = zone(z).zone;
      const ed = editing.has(m);
      const out: MenuEntry[] = [];
      if (!isFreeZone(z)) out.push(visibilityMenu(z));
      out.push(
        { label: 'Zone settings', disabled: ed ? false : EDIT_FIRST, items: () => zoneSettings(z) },
        { label: 'Edit zones', hint: 'Z', checked: ed, run: () => toggleEditing(m) },
      );
      return out;
    }

    function matMenu(m: CanvasNode): MenuEntry[] {
      const id = m.id;
      const ed = editing.has(id);
      const locked = !mat(m).unlocked;
      const at = app.view.menuPoint;
      const inside = at && at.x >= m.x && at.x < m.x + m.width && at.y >= m.y && at.y < m.y + m.height ? at : undefined;
      const out: MenuEntry[] = [
        { label: 'Edit zones', hint: 'Z', checked: ed, run: () => toggleEditing(id) },
        {
          label: 'Add zone',
          disabled: ed ? false : EDIT_FIRST,
          items: () => ZONE_KINDS.map((k): MenuEntry => ({ label: ZONE_KIND_NAMES[k], separator: k === 'free', run: () => app.dispatch('mats.addZone', { mat: id, kind: k, ...inside }) })),
        },
      ];
      if (presetOf(m) === 'solitaire') {
        const cols = zonesOf(app.doc, id, 'tableau');
        const stock = zonesOf(app.doc, id, 'stock')[0];
        const why = !stock || cols.length !== 7 ? 'Needs the stock and 7 tableau columns' : cols.some((c) => cardsIn(app.doc, c.id).length) ? 'The tableau isn’t empty (Reset gathers the cards)' : cardsIn(app.doc, stock.id).length < 28 ? 'The stock needs 28 cards' : false;
        out.push({ label: 'Deal Klondike', separator: true, disabled: why, run: () => app.dispatch('mats.dealKlondike', { id }) });
      }
      out.push(
        { label: 'Rename…', separator: true, run: () => void rename(m) },
        { label: 'Color', items: () => MAT_COLORS.map((c) => ({ label: c.name, color: c.hex, checked: m.color === c.hex, run: () => app.dispatch('mats.setMat', { id, color: c.hex }) })) },
        { label: 'Locked (move by the tab)', checked: locked, run: () => app.dispatch('mats.lock', { id, locked: !locked }) },
        { label: 'Remove mat (keep what’s on it)', separator: true, run: () => app.dispatch('mats.removeMat', { id }) },
      );
      return out;
    }

    // ---------------------------------------------------------------- kits
    const put = (create: (at: { x: number; y: number }) => void) => (a: App, at: { x: number; y: number }) => {
      create(at);
      const m = a.doc.nodes.filter(isMat).at(-1);
      if (m) a.view.fit(80, [m]);
    };
    app.registerKit({ id: 'mats.mat', label: 'Mat (empty: add your own zones)', create: put((at) => {
      const id = app.dispatch('mats.create', at).select?.[0];
      if (id) setEditing(id, true);
    }) });
    for (const [pid, p] of Object.entries(PRESETS))
      app.registerKit({ id: `mats.${pid}`, label: `Mat: ${p.label}`, create: put((at) => app.dispatch('mats.preset', { preset: pid as PresetId, ...at, players: players(app) })) });

    // ---------------------------------------------------------------- the mat
    app.registerType({
      id: 'mat',
      match: isMat,
      render(node, el) {
        el.innerHTML = matHtml({ label: node.label ?? 'Mat', color: node.color ?? '#2f6b45', locked: !mat(node).unlocked, editing: editing.has(node.id) });
        hookResize(el, node.id);
      },
      renderKey: (node) => `${node.label}:${node.color}:${!!mat(node).unlocked}:${editing.has(node.id)}:${node.width}x${node.height}`,
      // a locked mat moves only by its tab; its surface acts like the table (box select)
      grabbable: (node, down) => onGrip(down) || !!mat(node).unlocked,
      boxSelectable: (node) => !!mat(node).unlocked,
      onClick(node, down, a) {
        if (!onGrip(down)) return false;
        a.view.openMenu(matMenu(node), (down.target as Element).closest('[data-grip]')!, node.label ?? 'Mat');
        return true;
      },
      onAction(node, action) {
        if (action === 'done') setEditing(node.id, false);
      },
    });

    // ---------------------------------------------------------------- zones: a cards container (or a free area) plus edit mode
    // Registered ahead of the cards plugin's container type: outside edit mode a zone acts like that
    // container (drops, draws, its tab menu), only it stays put; in edit mode it moves and resizes.
    const deck = app.types.find((t) => t.id === 'deck');
    if (!deck) throw new Error('mats: the cards plugin must be set up first');
    const zoneType: ObjectType = {
      id: 'mat-zone',
      match: isZone,
      render(node, el, ctx) {
        const ed = isEditing(node);
        if (isFreeZone(node)) el.innerHTML = areaHtml(zoneName(node));
        else deck.render(node, el, ctx);
        el.toggleAttribute('data-editing', ed);
        if (ed) {
          el.insertAdjacentHTML('beforeend', zoneEditHtml(zoneName(node)));
          hookResize(el, node.id);
        }
      },
      renderKey: (node, ctx) => `${isFreeZone(node) ? `free:${node.label}:${node.width}x${node.height}` : (deck.renderKey?.(node, ctx) ?? '')}:${isEditing(node)}:${zoneName(node)}:${node.width}x${node.height}`,
      grabbable(node, down, a) {
        if (isEditing(node)) return true;
        if (isFreeZone(node)) return false;
        // the tab (menu); a pile's cards (drag = draw); else the press falls through to the mat / table
        return onGrip(down) || (isStacked(node) && !down.altKey && cardsIn(a.doc, node.id).length > 0);
      },
      movable: (node) => isEditing(node),
      boxSelectable: (node) => isEditing(node),
      onClick(node, down, a) {
        if (isEditing(node)) {
          if (!onGrip(down)) return false;
          a.view.openMenu(zoneSettings(node), (down.target as Element).closest('[data-grip]')!, zoneName(node));
          return true;
        }
        return deck.onClick?.(node, down, a) ?? false;
      },
      onDoubleClick(node, a) {
        if (isEditing(node)) return void rename(node);
        if (!isFreeZone(node)) deck.onDoubleClick?.(node, a);
      },
      onAction(node, action, a) {
        if (action !== 'zone-menu') return;
        const chip = a.view.boxOf(node.id)?.querySelector('[data-action="zone-menu"]');
        if (chip) a.view.openMenu(zoneSettings(node), chip, zoneName(node));
      },
      onDragStart: (node, down, a) => (isEditing(node) || isFreeZone(node) ? undefined : deck.onDragStart?.(node, down, a)),
      onDragEnd(dragged, a, _t, via) {
        const ids = dragged.filter((n) => isEditing(n)).map((n) => n.id);
        if (ids.length && via === 'drag') a.dispatch('mats.placeZones', { ids });
      },
      canDrop: (target, dropped, a, ov) => (isEditing(target) || isFreeZone(target) ? false : (deck.canDrop?.(target, dropped, a, ov) ?? false)),
      onDrop: (target, ids, a, at, mode) => deck.onDrop?.(target, ids, a, at, mode),
    };
    app.types.unshift(zoneType);

    // ---------------------------------------------------------------- keys and menus
    const targetMat = (a: App) => {
      const h = a.view.hovered ? a.node(a.view.hovered) : undefined;
      const fromSel = a.selected().map(matOf).filter(Boolean).at(-1);
      const only = a.doc.nodes.filter(isMat);
      return matOf(h) ?? fromSel ?? (only.length === 1 ? only[0].id : undefined);
    };
    app.registerKey({
      key: 'z',
      label: 'Edit zones of the mat',
      run: (a) => {
        const m = targetMat(a);
        if (m) toggleEditing(m);
        else a.notify(a.doc.nodes.some(isMat) ? 'Point at a mat, then Z' : 'No mat on the table (Add… › Mat)');
      },
    });
    app.registerMenu((_a, sel) => {
      if (sel.length !== 1) return;
      const n = sel[0];
      if (isMat(n)) return { title: n.label ?? 'Mat', entries: matMenu(n) };
      if (isZone(n)) return { title: isFreeZone(n) ? zoneName(n) : undefined, entries: zoneMenu(n) };
    });
  },
};

