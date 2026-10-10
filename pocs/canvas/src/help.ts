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
      ['Double-click, F', 'Flip (never reveals a card in a hand)'],
      ['⇧G over any card', 'Gather all cards back into their home deck (each keeps its facing)'],
    ],
  ],
  [
    'Decks, groups, hands',
    [
      ['', 'Three kinds of card collection. Deck: stacked, top card shows (the home deck from New table is one). Group: spread out (fan, row or grid), everyone sees it. Hand: a group that’s yours: others see its private cards face down.'],
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
      ['New hand (toolbar), right-click the table ▸ New hand for', 'A new empty hand for you or another player, in free space'],
      ['Sort ▸ (groups, hands)', 'By suit then rank, by rank then suit, by rank only (keeps the order within a rank), or reverse; Ace high (default) or low. “Sort again” repeats the last one for that group or hand'],
      ['', 'A group of one card is just a card'],
    ],
  ],
  [
    'Your hand',
    [
      ['', 'Only you see the cards in your hand; others see backs. Only you can sort it, change its layout, put its cards on the table or return them to the deck (anyone can once you left)'],
      ['Drag a card within your hand', 'Rearrange: it moves only on your screen until you drop it, and nobody sees it travel. Dropped just outside the frame it lands on the table (it flashes so you notice); over the frame the hand lights up “Add to hand”'],
      ['Tab ▸ Visibility ▸', 'The hand’s privacy options (below)'],
      ['Visibility ▸ Fixed frame size', 'The frame keeps its size whatever your count (cards squeeze together to fit); drag its right edge to resize. Off (default): it grows with your cards'],
      ['Visibility ▸ Allow showing cards to table', 'Adds a “Shown to table” strip above the row (off by default). Turning it off hides shown cards again'],
      ['Drag a card above the line / back down', 'Show it to the table / hide it again (the line and the drop label appear while you drag)'],
      ['Right-click ▸ Show to table / Hide from table', 'Same, for every selected card (with the count); the tab menu has Show all / Hide all'],
      ['Double-click, F', 'Never show a card to the table'],
      ['Visibility ▸ See my cards', 'On (default): you see all your private cards. Off: F or double-click turns a private card face up or down for you only'],
      ['Visibility ▸ Hide card count', 'Others see a plain pile instead of your private cards: no count, no order, no movement (keeps the frame fixed)'],
      ['Tab ▸ Give to ▸', 'Hand it to another player (or no one: a public group); you then see it as the others do. A hand whose player left shows greyed “(left)” and anyone can give it on'],
      ['Hold \\, or tab ▸ View as others', 'See your hand as the others do'],
      ['', 'Others never see which of your private cards you select or touch: over your row your pointer shows at the hand’s tab. When you show a card they get a short note (“Alex showed K♠”)'],
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
    'Chess',
    [
      ['Add… › Chess set', 'A board with 32 pieces in the starting position (free play: no rules)'],
      ['Drag a piece', 'It snaps to the square under its center; the move is tinted on the board'],
      ['Drop on a piece', 'Capture: the piece there goes beside the board on the capturer’s side'],
      ['Drop beside the board', 'Stays with the board; further away it lies free on the table'],
      ['Drag the board’s ⠿ tab', 'Move the board with its pieces (the surface is locked: dragging it box-selects)'],
      ['Click the tab, right-click', 'Set up pieces, flip board (view from black), clear, lock/unlock'],
      ['Pieces… (tab, right-click, Add…)', 'Piece palette: drag a piece onto a square or the table; click one to put it beside the selected board'],
      ['⌘D', 'Duplicate the selected pieces (copies lie offset until you drop them on a square)'],
      ['', 'Clear, Set up extras and clicked pieces are set aside on their owner’s side'],
    ],
  ],
  [
    'Game clock',
    [
      ['Add… › Game clock', 'A two-sided clock for any game (starts at 5+0)'],
      ['Tap your side', 'Ends your turn: your time stops (+ increment), the other side’s runs'],
      ['Space with the pointer on the clock', 'Tap for the side that is running (or start / resume); elsewhere Space pans'],
      ['▶ / ❚❚', 'Start (left side first) / pause / resume'],
      ['Click its ⠿ tab', 'Time control (1+0 … 15+10, custom, per side for a handicap), pause, reset, side names, rotate'],
      ['R over the clock', 'Rotate 90° (tall: each half faces its player at the end)'],
      ['', 'Red = out of time (the clock stops). Taps can’t be undone; Reset table resets clocks'],
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
