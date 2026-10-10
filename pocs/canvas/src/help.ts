import type { App, Change, Command } from './core';

const GROUPS: [string, [string, string][]][] = [
  [
    'Table',
    [
      ['V / H', 'Select tool / hand tool (toolbar buttons too)'],
      ['Drag empty table', 'Box select: touching objects (⇧ adds, ⌥ only fully inside)'],
      ['Wheel / two-finger scroll', 'Pan (⇧wheel sideways)'],
      ['Space+drag, middle-drag, hand tool', 'Pan'],
      ['⌘wheel, pinch', 'Zoom at the pointer'],
      ['⌘+ / ⌘−', 'Zoom in / out'],
      ['⇧0 or ⌘0', 'Zoom to 100%'],
      ['⇧1 or 0', 'Zoom to fit everything'],
      ['⇧2', 'Zoom to selection'],
      ['⌘Z / ⇧⌘Z', 'Undo / redo'],
      ['Right-click', 'Actions for what is under the pointer'],
      ['?', 'This help'],
    ],
  ],
  [
    'Selection',
    [
      ['Click', 'Select'],
      ['⇧click', 'Add / remove from selection'],
      ['⌘A', 'Select everything on the table'],
      ['Esc', 'Clear selection'],
      ['Delete / Backspace', 'Delete selection'],
      ['Arrows (⇧ arrows)', 'Nudge 1px (10px)'],
    ],
  ],
  [
    'Cards',
    [
      ['Drag', 'Move'],
      ['Double-click, F', 'Flip'],
      ['⇧G over any card', 'Gather all cards back into their home deck (each keeps its facing)'],
    ],
  ],
  [
    'Decks, groups, hands',
    [
      ['', 'Three kinds of card collection. Deck: stacked, top card shows (the home deck from New table is one). Group: spread out (fan, row or grid), everyone sees it. Hand: a group that’s yours: others see its cards face down.'],
      ['Drop a card right on top of a card', 'Makes a deck (the target shows “Stack”)'],
      ['Drop it partly over a card', 'Makes a group (the target shows “Fan”)'],
      ['G', 'Group the selection (into a selected deck or group, if there is one)'],
      ['L', 'Deck ⇄ group (under the mouse, else selected; the home deck too)'],
      ['Click the ⠿ tab, right-click', 'Menu: Turn into ▸ Deck / Group / Hand, Layout ▸, Facing ▸, Put cards on table…'],
      ['Turn into ▸ Hand', 'Makes it your hand; Group or Deck makes it public again'],
      ['Put cards on table', 'Lays the cards in a row where it was, facing kept (the home deck’s slot stays)'],
      ['Right-click the table', 'Put all hands on table: showdown, every hand laid out face up'],
      ['Drag a card in a group', 'Take it out; drop it back to put it at that spot'],
      ['Drag the ⠿ tab', 'Move the whole thing'],
      ['New hand (toolbar)', 'A new empty hand in free space near the bottom of the view'],
      ['', 'A group of one card is just a card'],
    ],
  ],
  [
    'Decks',
    [
      ['Drag a deck', 'Take its top card'],
      ['⌥drag a deck', 'Move the whole deck'],
      ['S / E', 'Shuffle / spread on the table, overlapping'],
      ['D (⇧D)', 'Draw one as it lies (⇧: turned over)'],
      ['1–9 (⌥1–9)', 'Deal N as they lie (⌥: turned over); Deal ▸ N… for more'],
      ['', 'Deck keys act on the deck under the mouse, else the selected one'],
    ],
  ],
  [
    'Menus',
    [
      ['Hover or click “… ▸”', 'Open a submenu'],
      ['↑ ↓ / → ← / Enter / Esc', 'Move / open, close a submenu / run / close all'],
      ['', 'Shortcuts are shown on the right of each item'],
    ],
  ],
  [
    'Playing together',
    [
      ['Share', 'Copy this table into a new room and copy its link'],
      ['Open the link', 'Join the room (your name is asked once)'],
      ['', 'You see the others’ cursors and selections in their color'],
      ['', 'A card someone is dragging can’t be grabbed until they let go'],
      ['Undo', 'Only undoes your own moves'],
      ['Leave', 'Back to your own table; the room stays on this device'],
    ],
  ],
  [
    'Files',
    [
      ['⌘S / ⇧⌘S', 'Save / save as .canvas (JSON Canvas, opens in Obsidian)'],
      ['⌘O, drop a file', 'Open a .canvas file'],
      ['', 'The table also saves itself in this browser'],
    ],
  ],
];


/** Help overlay: `?` button / key; Esc or a click outside closes it. */
export function mountHelp(app: App, button: HTMLElement) {
  const overlay = document.createElement('div');
  overlay.className = 'help-overlay';
  overlay.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'help-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Controls');
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  panel.innerHTML =
    `<h2>Controls</h2>` +
    GROUPS.map(
      ([title, rows]) =>
        `<section><h3>${title}</h3><dl>` + rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + `</dl></section>`,
    ).join('');
  overlay.append(panel);
  document.body.append(overlay);

  const open = () => {
    overlay.hidden = false;
  };
  const close = () => {
    overlay.hidden = true;
  };
  const toggle = () => (overlay.hidden ? open() : close());
  button.addEventListener('click', toggle);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!overlay.hidden && e.key === 'Escape') {
        e.stopImmediatePropagation();
        close();
      }
    },
    { capture: true },
  );
  app.registerKey({ key: '?', label: 'Help', run: toggle });
  app.registerKey({ key: 'shift+?', label: 'Help', run: toggle });
  return { open, close, toggle };
}

/** The old on-table help note (stage 1 to ux-tidy) is gone: remove it from loaded docs. */
export const removeHelpNote: Command = (doc) =>
  doc.nodes
    .filter((n) => n.type === 'text' && !Object.keys(n).some((k) => k.startsWith('x-')) && typeof n.text === 'string' && n.text.startsWith('Card table') && n.text.includes('Drag cards'))
    .map((n): Change => ({ op: 'del', id: n.id }));
