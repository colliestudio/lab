import './battleline.css';
import './render';
import { loadPlayer, type App, type Command, type DocView, type MenuEntry, type Plugin, type Store } from '../../core';
import { handLabelOf } from '../cards';
import { FIELD as CARDS } from '../cards/deck';
import { commands, flags, handOf, troopsDeck, type Seat } from './commands';
import { repairImport, shapeExport } from './io';
import { SIDE_NAME, flag, isFlag, isPart, type Side } from './model';
import { flagHtml } from './render';

/** The data side of the plugin (commands, reset, import/export). No DOM; used by tests too. */
export function registerBattleLineLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`battleline.${name}`, cmd as Command);
  store.resets.push(commands.resetAll as Command);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
}

/** Who sits where: the local player first, then everyone else in the room. */
function seats(app: App): Seat[] {
  const me = app.presence?.me ?? loadPlayer();
  const all = [me, ...(app.presence?.peers() ?? [])];
  return all.map((p) => ({ id: p.id, label: handLabelOf(p.name), color: p.color }));
}

/** A side's player name and color, from its hand ("Alice's hand" → Alice); else "Player A". */
function sideInfo(doc: DocView, side: Side) {
  const h = handOf(doc, side);
  return { name: h?.label?.replace(/['’]s hand$/, '') ?? `Player ${SIDE_NAME[side]}`, color: (h?.[CARDS] as { color?: string } | undefined)?.color };
}

const dealEntry = (app: App): MenuEntry => ({
  label: 'Deal Battle Line (7 troops each)',
  disabled: troopsDeck(app.doc) ? false : 'No Battle Line on the table (Add… › Battle Line)',
  run: () => app.dispatch('battleline.deal', { players: seats(app) }),
});

function claimMenu(app: App, ids: () => string[], current?: Side): MenuEntry {
  const to = (side: Side | null) => () => app.dispatch('battleline.claim', { ids: ids(), side });
  return {
    label: 'Claim for',
    items: () => [
      { label: `${sideInfo(app.doc, 'a').name} (bottom)`, checked: current === 'a', run: to('a') },
      { label: `${sideInfo(app.doc, 'b').name} (top)`, checked: current === 'b', run: to('b') },
      { label: 'Unclaimed (back on the line)', checked: current === undefined, separator: true, run: to(null) },
    ],
  };
}

export const battleLinePlugin: Plugin = {
  id: 'battleline',
  setup(app) {
    registerBattleLineLogic(app.store);
    app.registerKit({
      id: 'battleline',
      label: 'Battle Line',
      create: (a, at) => {
        if (troopsDeck(a.doc)) return a.notify('There is already a Battle Line on the table (Reset puts it back to the start)');
        a.dispatch('battleline.setup', at);
        a.view.fit();
      },
    });

    app.registerType({
      id: 'battleline-flag',
      match: isFlag,
      render(node, el, { doc }) {
        const f = flag(node);
        const info = f.claim ? sideInfo(doc, f.claim) : undefined;
        el.innerHTML = flagHtml(f, info?.color, info?.name);
      },
      renderKey(node, { doc }) {
        const f = flag(node);
        const info = f.claim ? sideInfo(doc, f.claim) : undefined;
        return `${f.n}:${f.claim ?? ''}:${info?.name ?? ''}:${info?.color ?? ''}`;
      },
      onDragEnd: (dragged, a, _t, via) => {
        if (via === 'drag') a.dispatch('battleline.placeFlags', { ids: dragged.map((n) => n.id) });
      },
    });

    app.registerMenu((a, sel) => {
      if (!sel.length) return troopsDeck(a.doc) ? { title: 'Table', entries: [dealEntry(a)] } : undefined;
      const fs = sel.filter(isFlag);
      if (fs.length === sel.length) {
        const ids = () => a.selected().filter(isFlag).map((n) => n.id);
        const cur = fs.length === 1 ? flag(fs[0]).claim : undefined;
        return {
          title: fs.length === 1 ? `Flag ${flag(fs[0]).n}` : `${fs.length} flags`,
          entries: [claimMenu(a, ids, cur), { ...dealEntry(a), separator: true }],
        };
      }
      if (sel.length === 1 && (isPart(sel[0], 'troops') || isPart(sel[0], 'hand'))) return { entries: [dealEntry(a)] };
    });
  },
};

export { commands, flags };
