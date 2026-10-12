# json-view

**Idea.** See, search and edit the board as its `.canvas` JSON in a code-editor panel next to the canvas. The text is the same canonical file the bridge writes to disk; it follows the live board; an edit goes back through the same 3-way field merge the bridge uses for file edits, so what others changed meanwhile survives. Selecting a node on the canvas shows its block, putting the caret in a block selects the node. It never shows what the viewer can't see (other players' cards).

Branch `idea/json-view` (from `idea/agent-player`), worktree `~/code/canvas-wt/json-view`.

## How it works

```
 board (Y.Doc) ──exportDoc──▶ redact per viewer ──stableSerialize──▶ text ──▶ CodeMirror panel
      ▲                                                                           │ ⌘S / Apply / Auto
      └── store.dispatch('core.patch') ◀── mergeFile(base, live, parse(edited)) ◀──┘
              one undo step, logged "Alex edited the JSON: 2 changed"
```

- **One text, three users.** `src/core/canonical.ts` (moved from `bridge/`) holds `stableSerialize`, `diffFile`, `mergeFile`. The bridge's file watcher and the browser panel call the same functions; nothing is copied.
- **The panel works in the browser's store**, so it behaves the same in P2P rooms, solo, and bridge mode (the change is a normal doc change that syncs; the bridge writes the file as always). No new bridge code.
- **Base = the text you started from.** The session remembers the text it last showed (parsed). Applying computes `diff(base → edited)` and applies only that to the live doc. Someone moved the node you edited the text of? Both survive. Same field edited by both: your edit wins (same rule as a file edit).
- **Live follow.** Every render (doc change or selection) the panel recomputes the text (throttled, 120 ms). No unapplied edits → the editor is updated with a minimal diff (caret, scroll and folds stay). Unapplied edits → the text is left alone and the status says "the board changed meanwhile: Apply merges, Reload discards".
- **Apply** = ⌘S in the editor, the Apply button, or Auto (applies 0.9 s after you stop typing when the JSON is valid; off by default, remembered). Invalid JSON, a broken node (no id/type/x/y/width/height, duplicate id), or a changed top-level field: red status line + squiggle, nothing applied. An edge whose node you deleted is dropped (as deleting the node does).
- **Undo + log.** Applying dispatches `core.patch {changes, text}`: one undo step on the person's own store (⌘Z on the canvas undoes it, the log says "undid: edited the JSON…"), one log entry with counts only (never node text, so nothing hidden leaks).
- **Hidden info.** A new plugin hook `registerRedactor(node, {doc, viewer}) → node | null` (null = leave out). Cards: a card whose face this viewer can't see (in another player's hand, or face down anywhere) shows `"face": "▒ hidden ▒"` and the same for `text` (which holds the face label); cards in a hand that hides its count don't appear at all, and links to omitted nodes go too. It uses the exact rule the renderer uses (`hiddenFrom`, `concealedFrom`), including "view as others" (hold `\`: the panel masks your own hand too). Masked values are never written back: a changed `set` equal to the mask is dropped; an added node's masked field is stripped; unchanged masked text is no change (base is masked too), so applying never touches a secret.
- **Selection both ways.** `blocks(text)` finds the `{…}` range of each node/edge entry by scanning (also works on half-typed text). Canvas → editor: selected nodes' lines get a tint, the first scrolls into view. Editor → canvas: a caret move (not typing) into a block selects that node and pans the canvas if it's off screen. Hidden/concealed nodes are never selected.
- **Editor choice: CodeMirror 6**, not Monaco. Loaded on the first click (dynamic import): 423 KB / 137 KB gzip lazy chunk, 0 on the main bundle. Monaco is a few MB plus web workers and needs bundler config; here we need one JSON document with highlight, folding, search, line numbers, bracket matching and a lint squiggle, which `basicSetup` + `lang-json` + `lint` give. Monaco's extras (JSON schema validation, minimap, diff editor) aren't needed yet; a JSON-schema for `.canvas` could be added to CM too.

## What's built

- `src/core/canonical.ts` — moved from `bridge/canonical.ts`, plus `mergeFile` and `withZ` (moved from `bridge/host.ts`). Bridge imports them from core.
- `src/core/jsonView.ts` (DOM-free) — `redactedDoc`, `viewText`, `JsonSession` (`current/refresh/plan/apply`), `blocks`, `nodeAt`, `MASK`.
- `src/core/jsonPanel.ts` + `.css` — the CodeMirror side panel: status line, Apply, Reload, Auto, drag-to-resize edge, docks (canvas, toolbar and zoom control move out of its way), open/width/auto remembered.
- Core additions: `core.patch` command (changes as data → one undo step + log line), `App.registerRedactor` / `App.redactors`, `View.onRender(fn)`. Cards plugin registers a redactor. Toolbar button `{ }` in `main.ts`.
- Bridge: `--host` flag (`pnpm bridge file --host 127.0.0.1`); default unchanged (all interfaces).
- Tests: +16 (279 total): session edit/merge/undo/log, concurrent edit on the same node, add/remove/link, invalid input, redaction (omit, mask, never written back), `blocks`/`nodeAt` (strings with braces, broken text), cards privacy (other viewer, owner, hidden-count hand, view-as-others, edit next to masked cards).
- Headless Chrome (Playwright, `channel: 'chrome'`) runs, all as expected: bridge mode (panel text == file on disk byte for byte; edit in the panel → file on disk; edit the file → panel follows; concurrent move + JSON edit merge; invalid JSON rejected; undo; Auto; Delete/Backspace in the editor doesn't touch canvas nodes), solo cards table (52 cards: 39 face-down masked, the 13 face-up ones shown; own hand visible; view-as-others masks it), and a two-browser P2P room (A applies a JSON edit while B moves the same node: both survive on both sides, B's log reads "Player 73: edited the JSON: 1 changed").

## Demo

Nothing is left running (stopped when done). From the worktree `~/code/canvas-wt/json-view`, all detached, localhost only:

```
mkdir -p /tmp/canvas-demos/json-view && git init -q /tmp/canvas-demos/json-view
nohup pnpm exec vite --port 5283 --strictPort --host 127.0.0.1 > /tmp/canvas-demos/json-view-app.log 2>&1 &
nohup pnpm bridge /tmp/canvas-demos/json-view/board.canvas --port 5286 --host 127.0.0.1 > /tmp/canvas-demos/json-view-bridge.log 2>&1 &
export CANVAS_BRIDGE=http://localhost:5286
pnpm canvas add-node "Order placed"
pnpm canvas add-node "Payment taken" --near "Order placed" --color 4
pnpm canvas connect "Order" "Payment" --label then
pnpm canvas add-node "Shipped" --near "Payment"
```

1. **Bridge mode.** Open `http://mini.internal:5283/?bridge=ws://mini.internal:5286`, click `{ }` in the toolbar. The panel shows the file's text exactly (checked byte for byte against `/tmp/canvas-demos/json-view/board.canvas`). Fold a node with the gutter arrows, ⌘F to search.
2. **Selection.** Click "Payment taken" on the canvas: its block is tinted and scrolled to. Click inside another block in the panel: that note is selected on the canvas.
3. **Edit and apply.** Change `"text"` of the first node, add `"color": "2"`: status says "1 change not applied", Apply lights up. Press ⌘S: status "Applied: edited the JSON: 1 changed", the canvas updates, the log (bottom left) says "You edited the JSON: 1 changed", `git -C /tmp/canvas-demos/json-view diff` shows the one-line change. ⌘Z on the canvas undoes it.
4. **Concurrent edit (the point of the merge).** Edit a node's text in the panel without applying. In a shell: `pnpm canvas move "Order" --dy 300` (or drag it in a second tab). Status turns amber: "the board changed meanwhile: Apply merges, Reload discards". ⌘S: the text change and the move both stay.
5. **Invalid.** Delete a `}` or a `"width"`: red status with the reason, a squiggle, Apply disabled, ⌘S does nothing. Fix it: back to normal.
6. **File edits.** Edit `board.canvas` in any editor or `git checkout` it: the panel follows (if you have no unapplied edits).
7. **Auto.** Tick Auto, change a value, stop typing: applied after about a second.
8. **P2P and hidden cards.** Open `http://mini.internal:5283/` (starter deck; signaling needs the main checkout's `pnpm dev` running for rooms). `{ }`: 13 face-up cards show their faces, 39 face-down show `▒ hidden ▒`. New hand → drag cards in: your own cards show their faces; open the hand's menu → "View as others" (or hold `\`): they're masked. In a room (Share, second browser) the other player's hand cards are masked, a hand with "Hide card count" doesn't list its cards at all. Edit JSON in one window while the other moves things: both survive.
9. Stop: `kill $(lsof -tiTCP:5283 -sTCP:LISTEN -a -c node) $(lsof -tiTCP:5286 -sTCP:LISTEN -a -c node)`; clean the demo with `/bin/rm -rf /tmp/canvas-demos/json-view*`.

## What it says about the core / plugin API

- **Text view = a third kind of "what may this viewer see".** The API now has `registerHider` (presence), `ObjectType.concealed` (render) and `registerRedactor` (text). They answer overlapping questions and the cards plugin implements each from the same two functions. One hook returning `visible | masked(fields) | absent` per node and viewer would replace all three, and also serve the bridge's agent views (`chess.state`/"my hand") and host-side filtering at stage 3. Worth promoting once a fourth consumer appears.
- **Redaction composes with 3-way merge for free** because the base is the masked text: a masked field is equal in base and edit, so it's never a change. The only extra rule needed is "never write the mask". This only works while the panel is display-only privacy: every peer still holds the full doc, so a modified client can read it anyway (same caveat as the rest; host/dealer fixes it).
- **`core.patch`: "field changes as data" belongs in core.** Editors, the bridge's file path and import all produce `Change[]` from outside the command set. Today the bridge's file apply is a special non-undoable path (`Host.applyFile`); the panel's is an ordinary undoable command. They could be one command with an `undoable` flag, which would also let the bridge log and attribute file edits through the same route.
- **Top-level fields (`extra`/meta) have no `Change` op**, so the panel can't edit them (read-only with an error). The cross-cutting "doc-level `meta` op" from the exploration rounds shows up again.
- **`View.onRender` is the missing "something visible changed" signal** (doc, selection, or a plugin's view-only toggle like "view as others"). Without it the panel would have to guess when the viewer's text changed.
- **The exported shape ≠ the live model for cards.** `exportDoc` turns decks into groups and lists cards in them; the panel shows that file form (good: it's what the bridge writes and git sees), but an edit is applied as field changes on the live nodes. Editing a pile card's x/y in the text changes a field the pile layout ignores. Plugin export filters are lossy in the way the panel makes visible; if the panel becomes a primary editor, import filters need to run on applied text too.
- **Same-field conflicts silently go to the person typing** (as for file edits). Fine for a prototype; a "your edit overwrote Bob's change to `x`" note in the log is cheap (the diff knows both sides).
- Small: the `Store.dispatch` path already gave undo grouping, actor attribution and log for free; the panel needed no new core concept besides the redactor.

## VS Code integration: what this implies (not built)

- **The panel's contract is the custom-editor contract.** Four messages cover it: `text(viewerText)` host → editor (canonical text, per viewer), `apply(text)` editor → host with `{ok, line | error}` back, `select(ids)` both ways, `pending/stale` status. `JsonSession` is already that contract as a DOM-free class (`current/refresh/plan/apply`), and `blocks/nodeAt` is the id ↔ range mapping a VS Code extension needs for reveal and "select the node under the cursor" (`vscode.Range`, `TextEditorSelectionChangeEvent`).
- **Two integrations, both thin:**
  1. *Text editor on the real file.* VS Code opens `board.canvas` as JSON already; the bridge's file watcher turns every save into the same 3-way merge (the panel's apply is the browser-side twin). What's missing is only the canvas next to it: a webview showing the app in bridge mode (`?bridge=ws://localhost:<port>`), with `select` messages for the shared selection. The extension starts/attaches a bridge for the workspace file. Almost no new logic.
  2. *Custom editor for `*.canvas`* (`CustomTextEditorProvider`): the webview is the canvas app; the `TextDocument` is the model. Webview → extension: apply as `WorkspaceEdit` (ranges from `blocks`, or whole-text replace; VS Code's own undo then owns undo, so `core.patch`'s undo step wouldn't be used there). Extension → webview: on `onDidChangeTextDocument` post the new text; the webview parses and merges with `mergeFile(base=lastText, cur, next)`, which is exactly the panel's `plan`. The same merge function serves both directions.
- **Privacy differs:** a file in the editor is the whole truth (no viewer). The redactor path is for in-app views; in VS Code the file view is the host's view, so it's only right for single-user or after host-side secrecy exists. Say so in the extension.
- **Canonical text matters more there:** a stable serializer is why a VS Code save, a git diff and the panel all agree. Keep `stableSerialize` as the only writer; for custom editors, format-on-save via the same function.
- **Open in the app, not in VS Code?** The panel is the in-app answer to "I want to see the JSON" and would stay even with the extension (no editor install, works for guests in a room).

## Open questions

- Should Auto be the default? Each pause is an undo step and a log line ("Alex edited the JSON: 1 changed" ×N); coalescing into one step for a typing burst would make it viable.
- Same-field conflicts: silently mine, or log/notify ("replaced Bob's change")?
- Should the panel show the viewer's own selection only, or others' (colored blocks per player, like cursors)? Presence has the data.
- Show the event log (`x-log`) or presence in the JSON? Today neither (the file has none; git has history). A second tab "Log" would be easy.
- JSON Schema for `.canvas` (+ plugin `x-*` schemas) for completions and validation in the editor: from plugin manifests, the same "command/field schemas" gap as agent-bridge.
- Edit scope: node fields only. Top-level fields need a meta op in core.
- Editing text in a hand's masked field: today a real edit (writes the typed text) because masked-vs-typed can't be told from a legit change. Probably fine (you can type anything into a note), but for card faces a plugin should reject (a `validate` hook on patches, which the same redactor could provide).

## Known gaps

- Privacy is display-only: the doc, the bridge's file on disk and its `/doc` endpoint contain every face. The panel is as honest as the rest of the table until stage 3.
- Auto-apply makes one undo step per pause. The panel's own text undo (⌘Z inside the editor) is CodeMirror's history, separate from the board's undo; after Apply the editor text is replaced by the merged text (one history entry).
- Remote edits to the same lines while you have unapplied edits aren't text-merged: your whole edit is measured from your base and applied as field changes (usually what you want; a *reformat* of the whole file is a no-op).
- Not measured on big boards: `plan` runs on every keystroke and the follow on every render (throttled). 2000 plain notes: about 1.8 ms to serialize and 11 ms to plan in Node; the editor itself on a 2000-node (~30k line) doc untested.
- Left-out (concealed) nodes are skipped in the text, so if you delete everything visible you delete only what you see.
- Pasting a node whose id already exists is refused (duplicate id); there's no "fix ids" helper.
- Keyboard: ⌘S applies only while the editor has focus (elsewhere it still saves the file as before).
- Mobile/touch: not considered. Window narrower than the panel + toolbar: the toolbar wraps.

## Effort to make it real

- Default-on polish (coalesce Auto into one step, conflict notes, others' selection colors, a Log/Schema tab): ~3 days.
- One visibility hook (`visible | masked | absent`) replacing hider/concealed/redactor, used by agent views too: ~3 days (with the bridge views work).
- VS Code: webview-in-bridge-mode extension with shared selection: ~2-3 days; full custom editor with WorkspaceEdit round trip and undo ownership: ~1 week.
- Meta op + `core.patch` as the single path for file edits and panel edits (so the bridge logs and attributes file edits uniformly): ~1-2 days.
