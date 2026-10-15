import './battleline.css';
import { loadPlayer, type App, type CanvasNode, type DocView, type MenuEntry, type ObjectType, type Plugin } from '../../core';
import { useLogic } from '../logic';
import { logic } from './logic';
export { registerBattleLineLogic } from './logic';
import { handLabelOf, registerDealOverride, registerDropRouter, routeFor, type DropRoute } from '../cards';
import { incomingCount } from '../cards/commands';
import { FIELD as CARDS, card, cardsIn, handOf as cardHand, roomIn } from '../cards/deck';
import { isMat } from '../mats/model';
import { commands, envOn, environment, flags, formation, handOf, playedRow, tacticCounts, troopsDeck, type Seat } from './commands';
import { SIDES, SIDE_NAME, flag, isFlag, isPart, isTactic, kindOfCard, part, tactic, type Side } from './model';
import { flagHtml, tallyHtml } from './render';

/** Where on the line a drop target is: a formation, a flag (its environment spot too), a played row. */
function lineSpot(doc: DocView, target: CanvasNode): { flag?: number; side?: Side; role: string } | undefined {
  const box = isFlag(target) ? target : part(target) ? target : doc.get(doc.parentOf(target.id) ?? '');
  if (!box) return;
  if (isFlag(box)) return { flag: flag(box).n, role: 'flag' };
  const p = part(box);
  if (!p || !['formation', 'environment', 'played'].includes(p.role)) return;
  return { flag: p.flag, side: p.side, role: p.role };
}

/** The side dropping `c`: the hand it comes from, else the side of the spot it lands on, else mine, else A. */
function dropperSide(doc: DocView, c: CanvasNode, viewer: string, spot?: { side?: Side }): Side {
  const h = cardHand(doc, c);
  const fromHand = h && part(h)?.role === 'hand' ? part(h)!.side : undefined;
  return fromHand ?? spot?.side ?? SIDES.find((s) => handOf(doc, s)?.owner === viewer) ?? 'a';
}

/** Tactics `c` already counts for (it's in one of that side's counted spots), if any. */
function countedFor(doc: DocView, c: CanvasNode): Side | undefined {
  const box = doc.get(doc.parentOf(c.id) ?? '');
  const p = box && part(box);
  if (!p) return;
  if (p.role === 'formation' || p.role === 'played') return p.side;
  if (p.role === 'environment') return (c['x-battleline'] as { by?: Side } | undefined)?.by;
}

/**
 * Routing: a card dropped on the line goes where its kind is played. Troops, Leaders, Morale: the
 * formation (on a flag: the dropper's formation there). Fog, Mud: the flag's environment spot.
 * Guile: the dropper's played tactics row. Then soft rule hints (never blocking).
 */
export function route(target: CanvasNode, dropped: CanvasNode[], app: Pick<App, 'doc' | 'viewer' | 'notify' | 'dispatch'>): DropRoute | undefined {
  const doc = app.doc;
  const c = dropped[0];
  const kind = kindOfCard(c);
  const spot = kind && lineSpot(doc, target);
  if (!kind || !spot) return;
  const side = dropperSide(doc, c, app.viewer, spot);
  const name = (s: Side) => sideInfo(doc, s).name;
  let to: CanvasNode | undefined;
  let label: string | undefined;
  if (kind === 'Environment') {
    if (!spot.flag) return;
    to = environment(doc, spot.flag);
    label = `${tactic(card(c).face)?.name ?? 'Environment'} on flag ${spot.flag}`;
  } else if (kind === 'Guile') {
    to = playedRow(doc, side);
    label = `Played tactics · ${name(side)}`;
  } else if (spot.role === 'formation') to = target.id === doc.parentOf(c.id) ? undefined : doc.get(part(target) ? target.id : doc.parentOf(target.id)!);
  else if (spot.flag) {
    to = formation(doc, spot.flag, side);
    label = `Flag ${spot.flag} · ${name(side)}`;
  }
  if (!to) return;
  const dest = to;
  const before = tacticCounts(doc);
  const origin = doc.get(doc.parentOf(c.id) ?? '');
  const was = countedFor(doc, c);
  return {
    to: dest.id,
    label,
    after: () => {
      const d = app.doc;
      const notes: string[] = [];
      if (kind === 'Environment') app.dispatch('battleline.markPlayed', { ids: [c.id], side });
      const other: Side = side === 'a' ? 'b' : 'a';
      if (isTactic(c) && was !== side && before[side] > before[other])
        notes.push(`${name(side)} had played more tactics than ${name(other)} (${before[side]} to ${before[other]}): by the rules, no tactic now`);
      if (kind === 'Leader' && part(dest)?.role === 'formation') {
        const leaders = d.nodes.filter((n) => isPart(n, 'formation') && part(n)!.side === part(dest)!.side).flatMap((f) => cardsIn(d, f.id)).filter((x) => kindOfCard(x) === 'Leader');
        if (leaders.length > 1) notes.push(`${name(part(dest)!.side!)} now has two Leaders: only one per side`);
      }
      const claimedAt = [part(dest)?.flag, origin && part(origin)?.role === 'formation' ? part(origin)!.flag : undefined].find((n) => n && flags(d).find((f) => flag(f).n === n && flag(f).claim));
      if (claimedAt) notes.push(`Flag ${claimedAt} is claimed: its cards are settled`);
      if (notes.length) app.notify(notes.join(' • '));
    },
  };
}

/** Who sits where: the local player first, then everyone else in the room. */
function seats(app: App): Seat[] {
  const me = app.presence?.me ?? loadPlayer();
  const all = [me, ...(app.presence?.peers() ?? [])];
  return all.map((p) => ({ id: p.id, label: handLabelOf(p.name), color: p.color }));
}

/** A side's player name and color, from its owned hand ("Alice's hand" → Alice); else "Player A". */
function sideInfo(doc: DocView, side: Side) {
  const h = handOf(doc, side);
  const name = h?.owner && h.label ? h.label.replace(/['’]s hand$/, '') : `Player ${SIDE_NAME[side]}`;
  return { name, color: (h?.[CARDS] as { color?: string } | undefined)?.color };
}

const dealEntry = (app: App): MenuEntry => ({
  label: 'Deal Battle Line (new game: 7 troops each)',
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
    useLogic(app.store, logic);
    app.registerKit({
      id: 'battleline',
      label: 'Battle Line',
      create: (a, at) => {
        if (troopsDeck(a.doc)) return a.notify('There is already a Battle Line on the table (Reset puts it back to the start)');
        a.dispatch('battleline.setup', { ...at, mat: true });
        const m = a.doc.nodes.filter(isMat).at(-1);
        a.view.fit(80, m ? [m] : undefined);
      },
    });
    registerDropRouter(route);
    registerDealOverride((deck, a) =>
      isPart(deck, 'troops') ? { entry: dealEntry(a), keyHint: 'Battle Line troops: right-click › Deal Battle Line deals 7 to each hand; drag the deck to draw one' } : undefined,
    );

    // a flag's environment spot (Fog, Mud): nothing to see or press while empty (the flag stays free)
    const deck = app.types.find((t) => t.id === 'deck')!;
    const envType: ObjectType = {
      id: 'battleline-env',
      match: (n) => isPart(n, 'environment'),
      render(node, el) {
        el.innerHTML = `<div class="bl-env" title="${SIDE_NAME.a}/${SIDE_NAME.b}: environment tactics on flag ${part(node)?.flag}"></div>`;
      },
      renderKey: () => 'env',
      concealed: (node, { doc }) => cardsIn(doc, node.id).length === 0,
      grabbable: () => false,
      movable: () => false,
      boxSelectable: () => false,
      canDrop: (t, d, a, ov) => deck.canDrop?.(t, d, a, ov) ?? false,
      onDrop: (t, ids, a, at, mode) => deck.onDrop?.(t, ids, a, at, mode),
    };
    app.types.unshift(envType);

    app.registerType({
      id: 'battleline-tally',
      match: (n) => isPart(n, 'tally'),
      render(_node, el, { doc }) {
        const k = tacticCounts(doc);
        el.innerHTML = tallyHtml(k, { a: sideInfo(doc, 'a').name, b: sideInfo(doc, 'b').name });
      },
      renderKey(_node, { doc }) {
        const k = tacticCounts(doc);
        return `${k.a}:${k.b}:${sideInfo(doc, 'a').name}:${sideInfo(doc, 'b').name}`;
      },
    });

    app.registerType({
      id: 'battleline-flag',
      match: isFlag,
      render(node, el, { doc }) {
        const f = flag(node);
        const info = f.claim ? sideInfo(doc, f.claim) : undefined;
        el.innerHTML = flagHtml(f, info?.color, info?.name, envOn(doc, f.n));
      },
      renderKey(node, { doc }) {
        const f = flag(node);
        const info = f.claim ? sideInfo(doc, f.claim) : undefined;
        const env = envOn(doc, f.n);
        return `${f.n}:${f.claim ?? ''}:${info?.name ?? ''}:${info?.color ?? ''}:${env.fog}:${env.mud}`;
      },
      // a card dropped on a flag goes where its kind is played (routing above)
      canDrop(target, dropped, a, ov) {
        const r = ov >= 0.3 ? routeFor(target, dropped, a) : undefined;
        const box = r && a.node(r.to);
        if (!r || !box || incomingCount(a.doc, box, dropped) > roomIn(a.doc, box)) return false;
        return r.label ?? true;
      },
      onDrop(target, ids, a) {
        const r = routeFor(target, ids.map((id) => a.node(id)).filter((n): n is CanvasNode => !!n), a);
        if (!r) return;
        a.dispatch('cards.drop', { target: r.to, ids });
        r.after?.();
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
