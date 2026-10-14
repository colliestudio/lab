# agent-bridge

**Idea.** A `.canvas` file on disk is the durable, git-trackable record; a small Node bridge hosts it live, so browsers, agents (CLI, MCP) and existing tools all edit the same board at once. Agents and tools sit at the table as players: cursor, selection, log name, their own undo.

## How it works

```
 .canvas file ⇄ bridge (Node, :5222) ⇄ WebSocket (y-websocket protocol) ⇄ browsers (?bridge=ws://…:5222)
                  ↑ HTTP API (/cmd /undo /query /doc /log /status)
          canvas CLI · MCP server · sync-backlog (any script)
```

- **Bridge = host.** One `Y.Doc`. Browsers sync over plain WebSocket (simplest local transport; no WebRTC in Node). `bridge/server.ts`.
- **Agents never touch Yjs.** They send named commands (`board.add`, `board.connect`, …) with plain args over HTTP; the bridge runs them. The commands are the same plugin commands the browser's Add menu runs.
- **A Store per actor on the shared doc** (`bridge/host.ts`). Each seated actor (agent "Claude", tool "Backlog.md") gets its own `Store` → its own `UndoManager` and log name, and its own `Awareness` (own client id) → its own cursor and selection outline in browsers. Idle 3 min = leaves the table (and its undo history goes with it).
- **doc → file**: after every change (300 ms debounce) the bridge writes canonical text (`bridge/canonical.ts`): fixed key order, tabs, nodes in z order, edges by id. Editing one field (text, color, y) = a one-line git diff; a move changes the x and y lines.
- **file → doc**: `fs.watch` on the directory (editors and `git checkout` replace the file). An edit becomes a **3-way field merge**: diff(file as the bridge last saw it → new file) applied to the live doc as per-field `Change`s. A field a person changed in the browser meanwhile, and the file didn't touch, survives. Logged as actor **File**. A pending doc → file write first merges any file change the watcher hasn't applied yet, so a save never gets overwritten; an invalid file is left alone (doc changes wait) until it parses.
- **Restarts**: `<dir>/.canvas-bridge/<name>.ystate` keeps Yjs history, so a restarted bridge and still-open tabs agree on identity; file edits made while it was down merge in at start. Delete it any time; the file wins.
- **Integration (existing system)**: `canvas sync-backlog` runs `backlog task list --plain` (read only) in `~/workspaces/cs`, parses it (`bridge/backlog.ts`) and dispatches one `board.sync`: statuses → columns, tasks → notes (ids `backlog:TASK-35`, `x-sync` metadata, color by priority). Re-runnable: unchanged input = no change; changed text updates; status change moves the note to the new column; notes a person rearranged within their column stay; deleted tasks go. Runs as actor "Backlog.md" (kind tool).

## What's built (branch `idea/agent-bridge`)

- `src/plugins/board/` — new plugin. `logic.ts` (DOM-free): `board.add/update/remove/connect/disconnect/sync`, rider rule (a note rides the column its center is in). `index.ts`: note/column renderers (JSON Canvas colors 1–6, light markdown), Add ▸ Note / Column kits, right-click Edit / Link these two / Unlink / Color / Delete, double-click edit.
- `bridge/server.ts` — WebSocket Yjs host + HTTP API + file watcher + state sidecar.
- `bridge/host.ts` — doc, per-actor seats, file apply/merge. `bridge/canonical.ts` — stable serialize, diff. `bridge/query.ts` — summaries, filters, resolve node by id or title.
- `bridge/cli.ts` — `canvas status|list|query|show|add-node|add-column|update|move|connect|disconnect|rm|undo|redo|log|cmd|sync-backlog`. Nodes by id or title (unique prefix/substring).
- `bridge/mcp.ts` — MCP stdio server: `canvas_list, canvas_add_node, canvas_update_node, canvas_connect, canvas_remove, canvas_undo, canvas_log`.
- App: `?bridge=ws://host:5222` joins the bridge (no IndexedDB, no starter deck; toolbar shows players incl. agents).
- Tests: +15 (edges, board commands, sync, canonical/diff/merge, host undo-per-actor, Yjs round trip, backlog parser). 244 total on the original branch; the merge branch adds the undo-step test, the guard and argument parser tests.
- `bridge/guard.ts` + `bridge/args.ts`: request guard and argument parsing (a flag before the file is not the file; unknown flags are an error).

## Who may talk to the bridge

The bridge binds `127.0.0.1` (`--host` to change) and answers only requests a local tool or the allowed app would send (`bridge/guard.ts`; the same idea as `localOnly` in the desktop-electron branch):

- **Host** must be `localhost`, `127.0.0.1` or `[::1]` (or the host of an `--allow-origin`): a DNS name rebound to 127.0.0.1 is refused.
- **Origin**, when the request has one (browsers always send it, also on WebSocket), must be the bridge's own origin or one given with `--allow-origin URL` (repeatable, or `$CANVAS_ALLOW_ORIGIN`, comma separated). Anything else gets `403` on every route, reads included (the document and the chat are private). CLI, MCP and curl send no Origin and pass.
- **No Origin, but from a browser**: an `<img>` or `<script>` GET from another site sends no Origin; browsers mark it `Sec-Fetch-Site: cross-site` (or `same-site` from another local port), and it is refused (reads seat the actor and mark its chat as read). A URL typed into the address bar (`none`) still works.
- **POST** needs `content-type: application/json`, which a cross-site form or a no-cors `fetch` cannot send.
- No CORS headers at all: the browser app only uses the WebSocket.
- Refusals are logged with the origin, so a missing `--allow-origin` shows in the bridge log.
- `--as NAME` stays unauthenticated: any local process can act under any name (tokens per agent are the later step; Open questions).

The app is served by vite on another port than the bridge, so its origin must be allowed: `pnpm bridge board.canvas --port 5285 --allow-origin http://localhost:5284` for an app on 5284. Alex opens `http://mini.internal:5284/?bridge=ws://mini.internal:5285`: the dev proxy on the Mini rewrites `mini.internal` to `localhost` in Host and Origin before they reach vite and the bridge, so the bridge sees `localhost:5284` and the flag above is the right one. Without that proxy (a direct URL), allow the origin exactly as the address bar shows it; a refused WebSocket says which origin in the bridge log.

Reaching a bridge from the deployed app, a bridge joining an existing room, one-command sharing and the pairing token: [bridge-ux.md](bridge-ux.md).

## Demo

From the worktree `~/code/canvas-wt/agent-bridge` (ports are examples; `$APP` and `$BRIDGE` = the vite and bridge ports):

1. `git init /tmp/demo` with `.canvas-bridge/` in its `.gitignore`, then `pnpm bridge /tmp/demo/board.canvas --port $BRIDGE --allow-origin http://localhost:$APP` (creates the file; add `--host 0.0.0.0` only to open it to the LAN, and then `--allow-origin` the LAN origin too).
2. `pnpm exec vite --port $APP --strictPort`; open `http://mini.internal:$APP/?bridge=ws://mini.internal:$BRIDGE` (on the Mini itself `localhost` for both). `export CANVAS_BRIDGE=http://127.0.0.1:$BRIDGE` for the shell. Two tabs to see two people (tabs in one browser share a name and color: rename one from the toolbar).
3. Agent from the shell, watch the browser:
   - `pnpm canvas add-node "Order placed"`
   - `pnpm canvas add-node "Payment taken" --near "Order placed" --color 4`
   - `pnpm canvas connect "Order" "Payment" --label then`
   - Claude's cursor jumps to each note, the log (bottom left) says "Claude added note …".
4. `pnpm canvas sync-backlog` → three columns of cs's Backlog tasks appear (as "Backlog.md"). Run again: "board already up to date". Move a task in Backlog (`backlog task edit …`) and re-run: it moves column.
5. Edit in the browser (double-click a note) → `git -C /tmp/demo diff` shows one line. Edit the file in an editor → browser updates, log says "File edited the file: 1 changed". `git checkout board.canvas` → the board reverts live.
6. `pnpm canvas undo` → undoes Claude's last step only (people's and other agents' steps stay). `pnpm canvas undo --as Someone` → "nothing to undo". If another actor overwrote Claude's last step, `undo` says so and does nothing; the next `undo` goes to the step before.
7. A web page cannot act: from a page on another origin, a `fetch` POST of `/chat/say` or `/cmd`, a read of `/chat/read`, and a `new WebSocket(...)` are all refused (bridge log: `refused POST /cmd: Origin … is not allowed`).
8. MCP: `claude mcp add canvas -e CANVAS_AS=Claude -- ~/code/canvas-wt/agent-bridge/node_modules/.bin/tsx ~/code/canvas-wt/agent-bridge/bridge/mcp.ts` (via `pnpm --dir … canvas-mcp` fails where mise has no global pnpm, e.g. from `/tmp`), then ask Claude to "map the checkout flow on the canvas". It shows up as a second player "Claude" (use `CANVAS_AS` to name each agent).
9. Ctrl-C the bridge: it writes the file and state; restart picks up where it was.

## What it says about the core / plugin API

Fit well:
- **Commands as plain data** made "agent API" free: HTTP/MCP is just `dispatch(name, args)` remotely. Any plugin's commands are reachable via `canvas cmd <name> <json>` once the bridge registers that plugin's logic.
- **`registerXLogic(store)` without DOM** (existing pattern) let the bridge run plugin logic in Node unchanged.
- **Event log with actor + `targets`** gave attribution and "cursor goes to what it touched" for nothing.
- **Presence on Awareness** worked with a second provider (y-websocket) unchanged.
- **JSON Canvas + namespaced `x-` fields + per-field `set` changes** made the file↔doc merge clean.

Had to change (small, listed):
1. `Change` gets `{op:'edge'}` / `{op:'unedge'}` (doc.ts, store.ts). Commands couldn't create edges before.
2. View draws edges (SVG layer, arrows, labels; view.ts + core.css). There was no edge rendering.
3. `Store` origin per instance instead of a module constant (store.ts): several Stores on one Y.Doc, each with its own undo = per-agent undo.
4. `sync.ts`: `joinBridge()`; `Room.provider` loosened to `{destroy()}`, optional `label` (share.ts adjusted).
5. `main.ts`: `?bridge=` mode; registers the board plugin.

Gaps the API showed:
- Bridge registers only core + board logic. Plugins' import/export filters (cards' `shapeExport`) and repairs don't run there, so a card table written by the bridge may differ from the browser's Save. Fix: plugin manifests that declare a DOM-free logic entry the host loads (fits the marketplace model).
- No way for a plugin to declare a command's **arg schema**: MCP tool schemas are hand-written. A `describe` on commands (zod/JSON Schema + one-line doc) would let the bridge auto-expose every plugin command as a tool.
- Rider rule by geometry is O(notes × columns) per view build; fine to hundreds.

## Fit with the big vision

- **Agent native**: agents are players, not side channels. Same commands, same log, own undo, visible presence. "Agent as a player" means: per-agent undo (undo scope = the actor; see Known gaps for where that leaks), per-agent identity in the log (`agent:claude`, `tool:backlog-md`, `file`), and later per-agent permissions.
- **Local first**: the file is the source of truth, plain JSON Canvas (Obsidian opens it), in git. No server needed; the bridge is a local process. Browser in bridge mode stores nothing.
- **Hosting**: the bridge *is* a host. The same process with auth = "Collie Server" for a team; a `.canvas` in a repo + bridge = the git-tracked option. Both providers (WebRTC P2P, WS host) share one Y.Doc, so a room could have both.
- **Host / secret model**: a host that runs commands is where secrecy can live: it could hold hidden state (deck order) and filter per player, and refuse commands an actor may not run. Today every peer still holds the whole doc (WS relays everything), so this is the place to add it, not done.
- **Permissions / marketplace security**: the HTTP API is where to enforce "agent X may only run `board.*` on nodes it created / in column Y". Today: no auth, any local process can act as anyone (`--as`). Plugins running in the host is a code-execution trust boundary: marketplace plugins would need the DOM-free logic sandboxed (worker/isolate) on the host.

## Open questions

- Who wins on conflict between the file and the live doc when both changed the same field: currently the file (applied last). OK?
- Should the event log live in the file (`x-log`) for git history, or stay ephemeral? Git already has history; keeping it out keeps diffs clean.
- One bridge per file, or a bridge serving a folder (vault) with one doc per file?
- Agent identity: trust `--as`, or issue tokens per agent (and show "unverified")?
- Agent leaving after idle drops its undo history; keep it longer?
- Large syncs (57 Backlog notes) make a tall Done column; let sources choose layout (grid, collapsed) or filter (`-- --status "To Do,In Progress"`).

## Known gaps

- No auth: any local process can act as any `--as` name and read/write the board. The bridge binds 127.0.0.1 and refuses foreign Origins/Hosts (see above), but `--host 0.0.0.0` opens it to every process on the network (the Origin check only constrains browsers).
- Clicking a note raises it, and the file stores nodes in z order, so a browser edit also moves that note's block to the end of the file in `git diff`.
- No plugin logic other than board in the bridge (see above); cards/chess still work in the browser over the bridge, but their export filters don't shape the file.
- Browser in bridge mode doesn't persist offline edits if the bridge is down when the tab closes.
- File edits with invalid JSON are skipped (logged) until fixed; meanwhile doc changes aren't written (the file isn't overwritten). Skipped malformed nodes in a valid file are dropped from the doc.
- Per-agent undo: fixed in core `Store.step` (undo takes exactly the top step; one that someone else overwrote is dropped and reported as nothing to undo, instead of undoing the step before it). Not fixed: undoing an older step can still restore a value over a later File/person edit of the same field when the agent edited that field again in between (Yjs only protects what it can tell was overwritten).
- Calling `undo --as X` (or any call) seats X: it shows in the toolbar as a player for 3 min.
- `pnpm canvas` prints pnpm's command echo on stderr; stdout is clean for scripts.

## Effort to make it real

- Bridge hardening (auth tokens per actor, permissions per command, folder of files): ~1 week. (Localhost bind and the Origin/Host/content-type guard are done.)
- Plugin manifest with DOM-free logic entry + command schemas → auto MCP tools for every plugin: ~3–4 days.
- Host-side secrecy (per-player filtering over WS): ~1–2 weeks; overlaps the dealer task (TASK-35.5).
- More integrations (GitHub issues, Linear) on `board.sync`: ~1 day each.
