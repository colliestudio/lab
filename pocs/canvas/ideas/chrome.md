# Chrome: dock, main menu, and what plugins register

The screen has four small regions and one toast. Core draws them (`src/core/chromeView.ts`); core, the app shell and plugins fill them through registration calls on `App`. Nothing game-specific is written in `main.ts`.

```
[☰ breadcrumb]                                   [people · chat · Share]
                         table
              [ ↖  ✋ | + ]  (dock)                       [− 100% + ⛶ ?]
```

- **Main menu** (top-left, ☰): File ▸ (New table, Open…, Save, Save as…), Edit ▸ (Undo, Redo, Reset table…), Room ▸ (your name and color, copy invite link, leave; only in a room), Add ▸ (one row per kit), then submenus plugins name (Game ▸: New hand, Play prototype), then Bridge… and Help. The top level stays small: plugins always go in a named submenu.
- **Dock** (bottom-center): icon buttons with tooltips (name and shortcut): Select (V), Hand (H, hold Space), + (opens the kit list above the button). No Undo/Redo buttons: the Edit menu and ⌘Z / ⇧⌘Z.
- **Top-right**: players and connection status, Chat (⇧C, unread badge), Share (copies the table into a new room; in a room it copies the invite link).
- **Bottom-right**: zoom out, percent (click = 100%), zoom in, fit, and ? (the controls sheet).
- **Toast** (above the dock): messages from `app.notify` (saved, opened, link copied…).
- **Context actions** (right-click) are unchanged: `registerMenu` / `registerMenuItem`.
- At 640 px and narrower the connection text collapses to a dot, other players' names hide (dots stay) and zoom keeps only the percent and ?.

## Registering

```ts
// a dock button; `active` makes it a modal tool (aria-pressed)
const off = app.registerDockItem({
  id: 'diagram.box', label: 'Box', icon: 'square', shortcut: 'R', section: 'create',
  active: (a) => a.view.tool === 'box', run: (a) => a.view.setTool('box'),
});

// a main-menu row; `group` names the submenu (File, Edit, Room, Add are core's; any other name is a new one)
app.registerMainMenuItem({
  id: 'cards.newHand', group: 'Game',
  entry: (a) => a.presence ? { label: 'New hand for', items: () => newHandEntries(a) } : { label: 'New hand', run: () => newHandFor(a, a.me()) },
});

// a context action (right-click)
app.registerMenu((a, selected) => ({ entries: [{ label: 'Play prototype', run: play }] }));
```

Each returns a disposer. Registering an id again replaces the earlier item in place. `when(app)` hides an item (the dock re-checks it when the tool, the table or the registry changes; the menu is built on open). `shortcut` is display only: bind the key with `registerKey`. `registerKit` refreshes the dock (the + shows once a kit exists). Small hooks keep the shell game-free: `registerStarter` (what New table puts on the empty table), `registerRenameHook` (cards relabel your hand when you rename), `onTableReplaced(fn)` (run after New / Open / dropping a file replaced the table: drop per-table state) and `registerNewKind({ id, label, start, param? })` (adds File ▸ New <label>, confirmed by the shell, `start(app)` fills the cleared table; `?<param>` starts an empty browser on it).

Icons: `icon` takes a name from `ICONS` (`src/core/icons.ts`, Lucide paths; license text in `LICENSES/lucide.txt`) or inline SVG markup. An unknown name logs a warning and shows a square. Add a name with `ICONS.name = '<path …/>'`.

## Adding drawing tools later

A tool registry (`registerTool`) only needs to also call `registerDockItem` with `section: 'create'` and `active: (a) => a.view.tool === tool.id`; no toolbar code in `main.ts`. Icons available for shapes: `square`, `circle`, `diamond`, `type`, `sticky-note`, `arrow-up-right`.

A plugin with its own mode (a diagram's paper) needs no `main.ts` code either:

```ts
app.onTableReplaced((a) => leavePaper(a));                       // New table / Open
app.registerNewKind({ id: 'diagram', label: 'diagram', param: 'diagram', start: (a) => enterPaper(a) });
```
