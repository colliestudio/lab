import type { App, CanvasNode } from '../../core';
import { CARD_W, handOf, hiddenFrom, isCard, isHand, shownIn } from './deck';
import { rowTop } from './layout';

// Hand UX that lives in the view only: "view as others" (hold \ or the tab menu toggle), privacy of
// presence (no outlines on hidden cards, the pointer parked at the tab over a private row), and the
// quiet announcement of a shown card ("Alex showed K♠" + a short glow).

export const VIEW_AS_KEY = '\\';

export interface HandUx {
  /** Render my hands as the others see them (private cards as backs). */
  asOthers(): boolean;
  /** The tab-menu toggle (the held key is separate). */
  sticky(): boolean;
  toggle(): void;
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
  };
  mountAnnouncer(app);
  // presence privacy: a card hidden from a player is never outlined for them nor broadcast by its owner
  app.registerHider((n, viewer) => isCard(n) && hiddenFrom(app.doc, n, viewer));
  app.registerCursorRule((p, a) => parkedCursor(a, p));
  return ux;
}

/**
 * Over the private row of one of my hands, others see my pointer parked at the hand's tab: where I point
 * among my private cards is information. (The shown strip above the row is public.)
 */
export function parkedCursor(app: App, p: { x: number; y: number }): { x: number; y: number } | undefined {
  for (const h of app.doc.nodes) {
    if (!isHand(h) || h.owner !== app.viewer) continue;
    const top = h.y + rowTop(h) - 6;
    if (p.x >= h.x && p.x <= h.x + h.width && p.y >= top && p.y <= h.y + h.height) return { x: h.x + 48, y: h.y - 12 };
  }
}

/** `hidden`: its face was hidden from this viewer (a back, or nothing at all if the count is hidden). */
type Seen = { hand: string; shown: boolean; x: number; y: number; hidden: boolean };

/**
 * Watches hand cards. A card that is now shown in the hand it was private in was shown to the table:
 * everyone sees a short glow (the event log's bubble says who showed what). A card that left someone else's hand
 * for the table slides out from where it was if it was shown; a private one from the middle of the hand
 * (its slot in a sorted hand would hint at its rank).
 */
function mountAnnouncer(app: App) {
  const last = new Map<string, Seen>();
  const scan = (announce: boolean) => {
    const doc = app.doc;
    const events = new Map<string, string[]>();
    for (const n of doc.nodes) {
      if (!isCard(n)) continue;
      const h = handOf(doc, n);
      const prev = last.get(n.id);
      if (!h) {
        last.delete(n.id);
        const from = prev && doc.get(prev.hand);
        if (announce && from && from.owner !== app.viewer && !doc.parentOf(n.id)) slideOut(app, n, prev, from);
        continue;
      }
      const shown = shownIn(h, n);
      last.set(n.id, { hand: h.id, shown, x: n.x, y: n.y, hidden: hiddenFrom(doc, n, app.viewer) });
      if (!announce || !prev || prev.hand !== h.id || prev.shown || !shown) continue;
      events.set(h.id, [...(events.get(h.id) ?? []), n.id]);
    }
    for (const ids of events.values()) for (const id of ids) glow(app, id);
  };
  scan(false);
  app.store.subscribe(() => scan(true));
}

function glow(app: App, id: string) {
  const box = app.view.boxOf(id);
  if (!box) return;
  box.classList.remove('pc-glow');
  void box.offsetWidth; // restart the animation
  box.classList.add('pc-glow');
  setTimeout(() => box.classList.remove('pc-glow'), 400);
}

function slideOut(app: App, n: CanvasNode, prev: Seen, hand: CanvasNode) {
  const box = app.view.boxOf(n.id);
  if (!box) return;
  const from = prev.hidden ? { x: hand.x + hand.width / 2 - CARD_W / 2, y: hand.y + rowTop(hand) } : prev;
  const to = box.style.transform;
  box.style.transition = 'none';
  box.style.transform = `translate(${from.x}px, ${from.y}px)`;
  void box.offsetWidth;
  box.style.transition = 'transform 240ms ease-out';
  box.style.transform = to;
  setTimeout(() => (box.style.transition = ''), 300);
}
