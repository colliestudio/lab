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
      ['Drop squarely on a card or deck', 'Stack it (the target lights up); every card keeps its facing'],
      ['G', 'Stack the selection into a pile'],
      ['⇧G over any card', 'Gather all cards back into their home deck (each keeps its facing)'],
    ],
  ],
  [
    'Groups',
    [
      ['Drop a card right on top of a card', 'Stack: a subdeck (the target shows “Stack”)'],
      ['Drop it partly over a card', 'Fan: a group with every card shown (the target shows “Fan”)'],
      ['L', 'Turn a subdeck into a fan group and back (also in the ⠿ menu)'],
      ['G', 'Group the selection (into a selected deck or group, if there is one)'],
      ['Drag a card in a group', 'Take it out; drop it back to put it at that spot'],
      ['Drag the group’s ⠿ tab', 'Move the whole group'],
      ['Click the ⠿ tab', 'Stack / fan / row / grid, make mine / public, face up/down, sort, ungroup'],
      ['', 'A subdeck acts like a deck: dragging it takes the top card'],
      ['', 'A group of one card is just a card'],
    ],
  ],
  [
    'Hands',
    [
      ['Hand (toolbar)', 'A new hand in free space near the bottom of the view (as many as you like)'],
      ['', 'A hand is a group that’s yours: others see its cards face down (and you theirs)'],
      ['Make mine / Make public', 'Turn any group into a hand, or back (⠿ menu)'],
      ['Drop cards on it', 'Hold them; drag within to reorder; Sort in its ⠿ menu'],
    ],
  ],
  [
    'Decks',
    [
      ['Drag a deck', 'Take its top card'],
      ['Drag its ⠿ tab, ⌥drag', 'Move the whole deck'],
      ['Click its ⠿ tab', 'Deck menu: gather all, shuffle, deal, flip, all face up/down, spread'],
      ['S / E', 'Shuffle / spread'],
      ['D (⇧D)', 'Draw one as it lies (⇧: turned over)'],
      ['1–9 (⌥1–9)', 'Deal N as they lie (⌥: turned over)'],
      ['', 'Deck keys act on the deck under the mouse, else the selected one'],
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
