import type { App, CanvasNode } from '../../core';
import { card, handOf, isCard, label } from './deck';

// Hand UX that lives in the view only: "view as others" (hold \ or the tab menu toggle), and
// announcing reveals ("Alex showed K♠" + a pulse) when a card in a hand is shown or hidden.

export const VIEW_AS_KEY = '\\';

export interface HandUx {
  /** Render my hands as the others see them (private cards as backs). */
  asOthers(): boolean;
  /** The tab-menu toggle (the held key is separate). */
  sticky(): boolean;
  toggle(): void;
  /** Cards I'm dragging out of my own hand: card id → where it came from and whether I saw its face. */
  drag: Map<string, { hand: string; saw: boolean }>;
}

const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]');

export function mountHandUx(app: App): HandUx {
  let held = false;
  let sticky = false;
  const banner = document.createElement('div');
  banner.className = 'pc-viewas';
  banner.hidden = true;
  app.view.root.append(banner);
  banner.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (sticky) ux.toggle();
  });
  const update = () => {
    const on = held || sticky;
    banner.hidden = !on;
    banner.textContent = sticky ? 'Viewing as others · click to stop' : 'Viewing as others';
    app.view.render();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key !== VIEW_AS_KEY || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    e.preventDefault();
    if (!held) {
      held = true;
      update();
    }
  });
  const release = () => {
    if (!held) return;
    held = false;
    update();
  };
  window.addEventListener('keyup', (e) => e.key === VIEW_AS_KEY && release());
  window.addEventListener('blur', release);

  const ux: HandUx = {
    asOthers: () => held || sticky,
    sticky: () => sticky,
    toggle() {
      sticky = !sticky;
      update();
    },
    drag: new Map(),
  };
  mountAnnouncer(app);
  return ux;
}

/** "Alex" for a hand: the owner's name from presence, else from the hand's label. */
function ownerName(app: App, h: CanvasNode): string {
  const me = app.presence?.me;
  if (me && h.owner === me.id) return me.name;
  const p = app.presence?.peers().find((x) => x.id === h.owner);
  if (p) return p.name;
  return h.label?.replace(/’s hand$|'s hand$/, '') || 'Someone';
}

/** Toast + pulse text for one hand's changes. */
export function revealText(name: string, showed: string[], hid: number): string[] {
  const out: string[] = [];
  if (showed.length) out.push(`${name} showed ${showed.length > 3 ? `${showed.length} cards` : showed.join(', ')}`);
  if (hid) out.push(`${name} hid ${hid === 1 ? 'a card' : `${hid} cards`}`);
  return out;
}

/**
 * Watches hand cards: a card that was in hand H and is back in H with a different facing was shown or
 * hidden (also across a drag out and back in, which goes through the table). Others get a toast near
 * the hand; everyone sees the card pulse once.
 */
function mountAnnouncer(app: App) {
  const last = new Map<string, { hand: string; up: boolean }>();
  const scan = (announce: boolean) => {
    const doc = app.doc;
    const events = new Map<string, { hand: CanvasNode; showed: string[]; hid: number; ids: string[] }>();
    for (const n of doc.nodes) {
      if (!isCard(n)) continue;
      const h = handOf(doc, n);
      if (!h) {
        if (doc.parentOf(n.id)) last.delete(n.id); // into a deck or group: forget; loose (being moved): remember
        continue;
      }
      const up = card(n).faceUp;
      const prev = last.get(n.id);
      last.set(n.id, { hand: h.id, up });
      if (!announce || !prev || prev.hand !== h.id || prev.up === up) continue;
      let e = events.get(h.id);
      if (!e) events.set(h.id, (e = { hand: h, showed: [], hid: 0, ids: [] }));
      if (up) e.showed.push(label(card(n).face));
      else e.hid++;
      e.ids.push(n.id);
    }
    for (const e of events.values()) {
      for (const id of e.ids) pulse(app, id);
      if (e.hand.owner !== app.viewer) toast(app, e.hand, revealText(ownerName(app, e.hand), e.showed, e.hid).join(' · '));
    }
  };
  scan(false);
  app.store.subscribe(() => scan(true));
}

function pulse(app: App, id: string) {
  const box = app.view.boxOf(id);
  if (!box) return;
  box.classList.remove('pc-pulse');
  void box.offsetWidth; // restart the animation
  box.classList.add('pc-pulse');
  setTimeout(() => box.classList.remove('pc-pulse'), 1000);
}

function toast(app: App, hand: CanvasNode, text: string) {
  const el = document.createElement('div');
  el.className = 'pc-toast';
  el.textContent = text;
  el.style.left = `${hand.x}px`;
  el.style.top = `${hand.y - 32}px`;
  app.view.world.append(el);
  setTimeout(() => el.classList.add('pc-toast-out'), 2400);
  setTimeout(() => el.remove(), 2900);
}
