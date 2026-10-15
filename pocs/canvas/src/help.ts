import type { App, Change, Command } from './core';

export const GROUPS: [string, [string, string][]][] = [
  [
    'Screen',
    [
      ['Menu (top left)', 'File, Edit, Room, Add, game submenus (New hand, Play prototype), Bridge…, Help'],
      ['Dock (bottom)', 'Select, hand and + (put something on the table); tooltips name each button and its shortcut'],
      ['People, Chat, Share (top right)', 'Who is here and the connection, the chat, and the invite link'],
      ['Zoom and ? (bottom right)', 'Zoom out / % / in / fit, and this help. Messages (saved, opened, link copied) appear above the dock'],
    ],
  ],
  [
    'Table',
    [
      ['V / H', 'Select tool / hand tool (the dock has both)'],
      ['Drag empty table', 'Box select: touching objects (⇧ adds, ⌥ only fully inside)'],
      ['Wheel / two-finger scroll', 'Pan (⇧wheel sideways)'],
      ['Space+drag, middle-drag, hand tool', 'Pan'],
      ['⌘wheel, pinch', 'Zoom at the pointer'],
      ['⌘+ / ⌘−', 'Zoom in / out'],
      ['⇧0 or ⌘0', 'Zoom to 100%'],
      ['⇧1 or 0', 'Zoom to fit everything'],
      ['⇧2', 'Zoom to selection'],
      ['⌘Z / ⇧⌘Z', 'Undo / redo (also Menu ▸ Edit)'],
      ['Right-click', 'Actions for what is under the pointer'],
      ['+ (dock), menu ▸ Add', 'Put a deck of cards (face up, sorted, spread out; L stacks it), a chess set, a game clock, a Battle Line table or a mat (empty, poker table, player mat, solitaire) in the view (or open the chess piece palette)'],
      ['Menu ▸ Edit ▸ Reset table', 'Everything back to its starting state, keeping what is on the table (one undo): decks get all their cards back face down and shuffled, boards their 32 pieces, clocks their time'],
      ['⇧L, Log (bottom left)', 'Event log: who shuffled, drew, dealt, played, showed, gave, claimed, moved a chess piece, started or paused the clock, and when. Click an entry to go to its object; while the log is closed a badge counts the others’ new entries'],
      ['?', 'This help'],
    ],
  ],
  [
    'Prototype pages',
    [
      ['+ › Prototype: example signup flow', 'Five linked HTML pages (a signup/checkout flow) with sticky notes. + › blank page / sticky note for your own'],
      ['I, or ✋ on the page', 'Interact: clicks go into the page; its links follow the arrows and the view glides to the next page (Esc in the page stops)'],
      ['↵, double-click', 'Edit the page: title, device, HTML with a live preview (⌘↵ saves)'],
      ['Menu ▸ Game ▸ Play prototype, ⇧↵, ▶ on a page, right-click the table', 'Play full screen from the selected / start page: Back (←), breadcrumb, link chips, notes (N), restart (R), Esc exits. In a room others get “Follow”'],
      ['Right-click a page', 'Link to another page (the arrow’s label = the action), links from here, start page, device, size, add note, auto-link'],
      ['Right-click the table', 'Arrange pages as a flow (left → right by step), auto-link every data-goto link, new page'],
      ['In page HTML', 'data-goto="Page title or action" follows a link, data-back goes back, data-store="key" keeps a field, data-show="key" shows it, canvas.goto()/canvas.state for scripts. Pages run sandboxed: no network, no storage, no access to the canvas'],
    ],
  ],
  [
    'Event log',
    [
      ['', 'What players do that matters shows twice: a short note near the object in the player’s color (“Alex shuffled the deck”, the deck wiggles) and a line in the log. Moving things around isn’t logged'],
      ['', 'Never a card you can’t see: a face-down draw is “drew a card”, a card going into a hand is named only if everyone saw it on the table, a card played from a hand face down is “a card” (its owner sees the name). A hand that hides its count never gets counted'],
      ['', 'Undo keeps the log and adds “undid: …”. New table and Open start a new log; the log is part of the shared table (latest 500 entries)'],
    ],
  ],
  [
    'Selection',
    [
      ['Click', 'Select'],
      ['⇧click, ⌘click', 'Add / remove from selection (in a hand or group ⇧click selects the run from the last clicked card)'],
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
      ['', 'Three kinds of card collection. Deck: stacked, top card shows (the home deck of a Deck of cards from Add is one). Group: spread out (fan, row or grid), everyone sees it. Hand: a group that’s yours: others see its private cards face down.'],
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
      ['Menu ▸ Game ▸ New hand, right-click the table ▸ New hand for', 'A new empty hand for you or another player, in free space'],
      ['Sort ▸ (groups, hands)', 'By suit then rank, by rank then suit, by rank only (keeps the order within a rank), Tiến Lên (3 lowest … A, 2 highest; ♠ ♣ ♦ ♥), or reverse; Ace high (default) or low. “Sort again” repeats the last one for that group or hand'],
      ['', 'A group of one card is just a card'],
    ],
  ],
  [
    'Your hand',
    [
      ['', 'Only you see the cards in your hand; others see backs. Only you can sort it, change its layout, put its cards on the table or return them to the deck (anyone can once you left)'],
      ['Drag a card within your hand', 'Rearrange: it moves only on your screen until you drop it, and nobody sees it travel; a yellow line shows where it goes. Over the frame the hand lights up “Add to hand”'],
      ['Click, ⇧click a run, ⌘click more', 'Select several cards of your hand (the card under the pointer lifts a little)'],
      ['← / → (⇧← / ⇧→)', 'Move the selected cards one place within the hand (to the start / end)'],
      ['Drag selected cards out of your hand', 'Play them together, in hand order: onto a zone or pile (it lights up “Play to …”), or onto the table, overlapping (they flash). Played cards land face up; hold ⌥ while dropping to play face down. A zone’s Facing on entry wins'],
      ['P (⇧P), right-click ▸ Play to ▸', 'Play the selected cards to the zone under the pointer, else the zone you last played to (⇧: face down). One log line names what everyone can see'],
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
      ['', 'Others never see which of your private cards you select or touch: over your row your pointer shows at the hand’s tab. When you show a card they get a short note (“Alex showed K♠ to the table”) and a log line'],
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
      ['Deal ▸ To players ▸', '1–13 each, all evenly, or N each, round-robin from the top into each player’s hand (a new one below the deck where they have none), private. Players ▸ ticks who gets cards (in a room: everyone here; solo: you and a second seat). The rest stays in the deck; one undo, one log line'],
      ['', 'Deck keys act on the deck under the mouse, else the selected one'],
    ],
  ],
  [
    'Chess',
    [
      ['+ › Chess set', 'A board with 32 pieces in the starting position (free play: no rules)'],
      ['Drag a piece', 'It snaps to the square under its center; the move is tinted on the board'],
      ['Drop on a piece', 'Capture: the piece there goes beside the board on the capturer’s side'],
      ['Drop beside the board', 'Stays with the board; further away it lies free on the table'],
      ['Drag the board’s ⠿ tab', 'Move the board with its pieces (the surface is locked: dragging it box-selects)'],
      ['Click the tab, right-click', 'Set up pieces, flip board (view from black), clear, lock/unlock'],
      ['Pieces… (tab, right-click, +)', 'Piece palette: drag a piece onto a square or the table; click one to put it beside the selected board'],
      ['⌘D', 'Duplicate the selected pieces (copies lie offset until you drop them on a square); with the board: a second set'],
      ['', 'Clear, Set up extras and clicked pieces are set aside on their owner’s side'],
    ],
  ],
  [
    'Mats',
    [
      ['', 'A mat is a surface for a game: whatever lies on it moves with it, and its zones are the places cards go (each zone is a deck, group or hand with its own layout).'],
      ['+ › Mat: …', 'Empty (add your own zones), Poker table (deck, community row of 5, muck, pot, six seats: yours is private), Player mat (deck, in play, discard, your private hand row), Solitaire (stock, waste, 4 foundations, 7 columns; mat tab ▸ Deal Klondike)'],
      ['', 'A preset with a deck takes the table’s deck (all 52, shuffled face down; Gather all and Reset bring them back there)'],
      ['Drop a card on a zone', 'It goes in with the zone’s layout, turned face up / down if the zone says so (from a hand: face up unless the zone says down or you hold ⌥); a full zone refuses more. The pointer over the zone is enough'],
      ['Drag the mat’s ⠿ tab', 'Move the mat with everything on it (the surface is locked: dragging it box-selects). Corner: resize'],
      ['Click the tab, right-click', 'Edit zones, Add zone ▸, Rename…, Color ▸, Locked, Remove mat (keeps what’s on it)'],
      ['Z (pointer on a mat), Edit zones', 'Edit mode: drag a zone to move it, its corner to resize, ⚙ or double-click for its settings; Z or Done to finish. Outside edit mode zones stay put'],
      ['Zone settings ▸', 'Rename, Layout ▸ (pile, fan, row, grid, column), Max cards ▸, Facing on entry ▸ (keep, face up, face down), Delete zone (its cards stay)'],
      ['Right-click a zone › Visibility ▸', 'Public, or Private to ▸ a player: a seat, their hand (others see backs; every hand option works)'],
      ['', 'Saved files: a mat is a group holding its zones (groups) holding their cards'],
    ],
  ],
  [
    'Battle Line',
    [
      ['+ › Battle Line', 'Reiner Knizia’s two-player card game on a mat, for free play (hints, never enforced): 9 flags, a formation per flag and side, the troop and tactics decks, a discard pile, a played tactics row per side, a tactics tally'],
      ['Right-click the table or a flag, or the Troops deck › Deal Battle Line', 'A new game: every card back and shuffled, flags unclaimed, 7 troops face down to each side’s hand. One hand per player: a hand you already have (New hand) becomes your side’s (solo: an ownerless hand for side B; Give to ▸ hands it over)'],
      ['Drop a troop, Leader or Morale on a formation', 'Next free slot, face up. On a flag: your formation there'],
      ['Drop Fog or Mud on a flag or its formations', 'Onto the flag (sideways, up to 2), face up, counted for the side that played it. Fog: the flag shows “total only”. Mud: both formations there get a 4th slot (4 cards stay if the Mud leaves, outlined)'],
      ['Drop a Guile tactic on the line', 'Into your played tactics row, face up; do its effect by hand. Scout: draw 3 (drag the decks), then drag 2 hand cards onto a deck (face down, nobody sees which). Redeploy / Deserter: drag the card to a formation or the Discard (face up). Traitor: drag their troop into your formation'],
      ['Tactics tally (by the decks)', 'Tactics each side played (formations, flags, played rows); red = ahead, so by the rules no tactic now'],
      ['', 'Hints (a note, still allowed): a tactic while ahead, a second Leader, cards at a claimed flag. The drop label shows where a card will land'],
      ['Drag a flag toward a side', 'Claims it for that side (it snaps there); drag it back to the line to unclaim'],
      ['Right-click a flag › Claim for ▸', 'Claim for the bottom (A) or top (B) player, or unclaim'],
      ['Reset table', 'Flags back on the line, every card back in its deck, shuffled (hands stay, empty)'],
    ],
  ],
  [
    'Game clock',
    [
      ['+ › Game clock', 'A two-sided clock for any game (starts at 5+0)'],
      ['Tap your side', 'Ends your turn: your time stops (+ increment), the other side’s runs'],
      ['Space with the pointer on the clock', 'Tap for the side that is running (or start / resume); elsewhere Space pans'],
      ['▶ / ❚❚', 'Start (left side first) / pause / resume'],
      ['Click its ⠿ tab', 'Time control (1+0 … 15+10, custom, per side for a handicap), pause, reset, side names, rotate'],
      ['R over the clock', 'Rotate 90° (tall: the halves stack, text stays upright; menu › Top half upside down to face a player across a real table)'],
      ['', 'Red = out of time (the clock stops). Taps can’t be undone; Reset table resets clocks'],
    ],
  ],
  [
    'Event storm',
    [
      ['+ › Event storm board', 'A board with a phase switch, sticky palette, votes left, a timebox and a Markdown export'],
      ['E (pointer on the board)', 'New domain event where the pointer is; type, Enter to finish, Tab for the next event to its right, Esc to drop it'],
      ['Q / C / A / P / R / X / G', 'Hotspot / command / actor / policy / read model / external system / aggregate (offered by phase). With an event selected it attaches to that event'],
      ['Phase buttons', 'Chaotic exploration (events anywhere) → Enforce the timeline (events snap into one sequence) → Commands & policies → Aggregates'],
      ['Drag an event', 'Reorder: drop it between two others; what is attached comes along. Drop a sticky in an event’s column to attach it'],
      ['. / ,', 'Vote for / take a vote back from the sticky under the pointer (budget per person, right-click the board tab to change)'],
      ['Double-click, Enter', 'Edit a sticky’s words'],
      ['⇩ Markdown', 'The flow as an ordered list of events with their commands, policies…; also window.storm.markdown()'],
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
      ['Share (top right)', 'Copy this table into a new room and copy its link (in a room: copy the invite link)'],
      ['Open the link', 'Join the room (your name is asked once)'],
      ['', 'You see the others’ cursors and selections in their color'],
      ['', 'A card someone is dragging can’t be grabbed until they let go'],
      ['Undo', 'Only undoes your own moves (the log says “undid: …”)'],
      ['', 'Everyone sees what the others do as notes near the objects and in the log (⇧L)'],
      ['Menu ▸ Room ▸ Leave room', 'Back to your own table; the room stays on this device'],
      ['Your name (top right), Menu ▸ Room', 'Change your name and color'],
    ],
  ],
  [
    'Files',
    [
      ['⌘S / ⇧⌘S', 'Save / save as .canvas (JSON Canvas, opens in Obsidian)'],
      ['⌘O, drop a file, Menu ▸ File', 'Open a .canvas file (File also has New board, Save, Save as)'],
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
