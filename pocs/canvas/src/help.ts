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
      ['Add…', 'Put a deck of cards, a chess set or a game clock in the view (or open the chess piece palette)'],
      ['Reset', 'Everything back to its starting state, keeping what is on the table (one undo): decks get all their cards back face down and shuffled, boards their 32 pieces, clocks their time'],
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
      ['Delete / Backspace, right-click › Delete', 'Delete selection (a board takes its pieces with it)'],
      ['⌘D', 'Duplicate selection (not cards)'],
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
    'Chess',
    [
      ['Add… › Chess set', 'A board with 32 pieces in the starting position (free play: no rules)'],
      ['Drag a piece', 'It snaps to the square under its center; the move is tinted on the board'],
      ['Drop on a piece', 'Capture: the piece there goes beside the board on its owner’s side'],
      ['Drop beside the board', 'Stays with the board; further away it lies free on the table'],
      ['Drag the board’s ⠿ tab', 'Move the board with its pieces (the surface is locked: dragging it box-selects)'],
      ['Click the tab, right-click', 'Set up pieces, flip board (view from black), clear, lock/unlock'],
      ['Pieces… (tab, right-click, Add…)', 'Piece palette: drag a piece onto a square or the table; click one to put it beside the selected board'],
      ['⌘D', 'Duplicate the selected pieces (copies lie offset until you drop them on a square)'],
      ['', 'Set up keeps extra pieces beside the board'],
    ],
  ],
  [
    'Game clock',
    [
      ['Add… › Game clock', 'A two-sided clock for any game (starts at 5+0)'],
      ['Tap your side', 'Ends your turn: your time stops (+ increment), the other side’s runs'],
      ['Space over the clock', 'Tap for the side that is running (or start / resume)'],
      ['▶ / ❚❚', 'Start (left side first) / pause / resume'],
      ['Click its ⠿ tab', 'Time control (1+0 … 15+10, custom), pause, reset, side names'],
      ['', 'Red = out of time (the clock stops). Taps can’t be undone; Reset table resets clocks'],
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
