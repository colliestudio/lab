# chat

**Idea.** A text chat room on the board. Everyone at the table talks in one place: people in browsers and agents or tools seated through the bridge. Messages carry the sender's name and color, can @-mention a player, and can point at a node (click to jump there). An agent can read, wait for and answer messages the same way the chess bot waits for its turn.

Branch `idea/chat` (from `idea/agent-player`), worktree `~/code/canvas-wt/chat`.

## How it works

```
 browser panel ── sendChat() ──┐
                               ├─►  Y.Array 'chat' in the doc  ──►  every peer (WebRTC mesh or bridge WebSocket)
 bridge ◄─ POST /chat/say ─────┘         (capped at 300)           IndexedDB / bridge .ystate keep it
   ▲  GET /chat/read?new=1   GET /chat/wait   ◄── canvas chat say|read|wait · MCP chat_send|chat_read|chat_wait
```

- **Where messages live: a synced Y.Array in the doc, capped (300), like the event log.** Tried in the head, not in code: Awareness (ephemeral: late joiners and reloads lose everything, and a message must be visible long enough to be read, which means building a log on top of it) and a separate channel (a second transport and a second persistence for something the doc already gives us). The array works unchanged over both transports, late joiners get recent history, a reload keeps it (IndexedDB in a room, the bridge's `.ystate` sidecar behind a bridge). One cost: it is part of the doc everyone holds, so chat is as private as the table (every peer, and the bridge, can read it).
- **Not in the `.canvas` file.** The file is the board: JSON Canvas, in git, one-line diffs. Chat is conversation; it would churn every diff, and nothing else reads it. It does survive a bridge restart (sidecar) and is gone if the sidecar is deleted. The deliberate fork: if a conversation should be part of the record (design discussion on a board), add an opt-in "save chat" that appends to a `chat.md` next to the file, not to the canvas JSON.
- **Not a command.** Commands are board changes with undo and a log line. A chat message is neither: no undo step (you can't "undo" something others read), no event-log entry (it would double every message). So chat is a small core module (`src/core/chat.ts`, DOM-free) over the doc, not a plugin command. New table / file open leave chat alone.
- **Per-reader "seen" state.** Browser: last seen message id in `localStorage` per table (room id or bridge url); unread = messages after it, from others. Agents: the host keeps a cursor per actor id (outlives its seat, so an agent that idles out and comes back loses nothing; it lives in the bridge's memory, so a bridge restart resets every agent to "from now on"). `read` and `wait` move the cursor to the end; `say` does not (so a reply never skips what others said before it). First contact starts at the end of the chat ("new" means from now on).
- **Mentions** are plain text: `@Name` (case-insensitive, names may contain spaces, `@all` for everyone). Resolved by each reader against their own name at render time: no ids, nothing to keep in sync when someone renames. A mention highlights the message and turns the chat badge orange.
- **Node references**: a message may carry a node id. In the browser: select a node, click 📍, send. Agents: `--node "Order placed"` (id or title). The message shows the node's title as a button (click: center the view and pulse, reusing the log's jump). An agent's cursor goes to the node when it says it.
- **Agents are seated by speaking.** `say`, `read` and `wait` seat the actor (top-right player, cursor), like any bridge call; waiting keeps it seated.

## What's built

- `src/core/chat.ts`: `sendChat`, `after`/`unread`, `mentions`/`splitMentions`, `chatLine`, cap and text limit. DOM-free.
- `src/core/chatView.ts`: top-right Chat button with unread badge (⇧C), right-side panel (messages with color-coded names, "agent"/"tool" tag, times, mention highlight, node chips, click a name to @-mention, 📍 to point at the selection), a short status notice for new messages while the panel is closed, open state and last-read remembered.
- Wired in both modes in `main.ts`: room (P2P/Worker relay) and `?bridge=`. Hidden when playing solo (nobody to talk to).
- Bridge: `Host.say/readChat/waitChat`, HTTP `POST /chat/say`, `GET /chat/read?new=1&limit=N`, `GET /chat/wait?timeout=S` (long-poll, ≤290 s); client methods; CLI `canvas chat say|read|wait`; MCP `chat_send`, `chat_read`, `chat_wait`. The bridge binds `127.0.0.1` by default (`--host` to change). Localhost alone does not keep out web pages open in the same browser, so the bridge also refuses foreign `Origin`s (HTTP and WebSocket), non-localhost `Host`s and non-JSON POSTs, and sends no CORS headers (agent-bridge.md § Who may talk to the bridge); the app's origin is allowed with `--allow-origin`. Checked from a page on another origin in headless Chrome: its `fetch` POST to `/chat/say` and `/cmd`, its read of `/chat/read` and its WebSocket are all refused.
- Readers (browser, host, CLI/MCP) skip malformed entries (no sender, a time `Date` can't format, text over the limit), since any peer can write to the array. CLI/MCP print times in the reader's local time (`[15:58]`), like the panel.
- Tests: +14 (chat 7, host chat 7): 277 total (291 on the merge branch with the bridge guard, takeback and undo fixes). Checked in headless Chrome: two tabs on a bridge (badge, mention badge, send both ways, node chip jump, attach selection, reload keeps panel and read state), two tabs in a room (over BroadcastChannel; the reviewer also synced two isolated browser contexts over WebRTC with the local signaling), shell `say/read --new/wait` against live browsers, MCP tools over stdio with an SDK client, bridge restart keeps the history while `board.canvas` stays free of chat.

## Demo

Ran on the Mini during the build (localhost only): app 5281, bridge 5284 on `/tmp/canvas-demos/chat/board.canvas` (a git repo); not running now, start them with the restart commands below (the bridge needs `--allow-origin http://localhost:5281` for the browser to connect). Browser via `mini.internal`:

1. Open two tabs (a private window or a second browser for a second person; tabs in one browser share a name, rename from the top right or Menu ▸ Room): `http://mini.internal:5281/?bridge=ws://mini.internal:5284`.
2. Shell, from the worktree: `export CANVAS_BRIDGE=http://localhost:5284`
   - `pnpm canvas add-node "Order placed"`; `pnpm canvas add-node "Payment taken" --near "Order placed"`
   - `pnpm canvas chat say "hello table" --as Claude` → the Chat button gets a badge in both tabs.
   - `pnpm canvas chat say "@Player 4 look at this" --node "Payment taken" --as Claude` (use the name your tab shows) → orange badge; open the panel, click the "📍 Payment taken" chip: the view centers on it.
   - Type a reply in a tab (Enter sends; Shift+Enter newline). In the shell: `pnpm canvas chat read --new --as Claude`, or block for the next message: `pnpm canvas chat wait --as Claude`, then answer in a tab.
3. A room instead of a bridge: `pnpm exec vite --port 5281 --strictPort --host 127.0.0.1` plus the signaling on port 5192 (the main checkout's `pnpm dev` already serves it; otherwise `pnpm dev:signal`) and `http://mini.internal:5281/?room=lunch` in two browsers; same panel. (Exercised: tabs in one browser over BroadcastChannel, and two isolated browser contexts on one machine over WebRTC; not across devices.)
4. A real Claude in the room (one LLM session): `claude mcp add canvas -e CANVAS_AS=Claude -e CANVAS_BRIDGE=http://localhost:5284 -- ~/code/canvas-wt/chat/node_modules/.bin/tsx ~/code/canvas-wt/chat/bridge/mcp.ts`, then: "You are at the table. Loop: chat_wait, answer with chat_send (use @Name), until I say stop." Ask it something from a tab; it replies under its own name with the "agent" tag.
5. `git -C /tmp/canvas-demos/chat status`: chat is not in the file. Restart the bridge: history is still there (sidecar).

Restart (detached): `cd ~/code/canvas-wt/chat && nohup pnpm exec vite --port 5281 --strictPort --host 127.0.0.1 > /tmp/canvas-demos/chat-app.log 2>&1 &`, `nohup pnpm bridge /tmp/canvas-demos/chat/board.canvas --port 5284 --allow-origin http://localhost:5281 > /tmp/canvas-demos/chat-bridge.log 2>&1 &`.

## What it says about the core / plugin API

- **The doc is the right home for shared, ordered, persistent, small-volume data that isn't board content.** The log and chat are the same shape (capped Y.Array, append-only, transaction origin outside undo). That is a pattern worth naming in core: a `Stream` (name, cap, validator) with `append`, `observe`, `after(id)`. Today each is hand-rolled; plugins can't add one (a game's move list, comments, an audit trail).
- **Seen/unread is its own concern.** Both the log badge and chat badge do "last id I saw, per table, per device"; agents need the same, server-side per actor. A stream helper should own cursors (`stream.cursor(actor)`), so `wait` for a stream is generic: it is the same "wait until a view is ready" as chess turns, specialized to "new items after my cursor". Here it is a Host method; it could be a view returning `undefined` until the cursor has news, if views could carry per-actor state (they are pure today, and the cursor is state, which is why it wasn't a view).
- **Actor identity again.** Chat attribution is the sender's claim: the browser's player id, the bridge's unauthenticated `--as`. A person can be impersonated by any peer writing a message with their id. Fine at a table of friends; chat is where this shows first, because a forged line looks like speech. Real fix is the host authenticating actors and stamping `from` itself.
- **The host is the natural place for chat features that need authority**: moderation (delete, mute an agent), rate limits for chatty agents, redaction. Today every peer can write to the array.
- **Presence could carry "typing"/"thinking"**: an agent that is about to reply could set a status (`Claude is thinking…`) in awareness. Not built; it is a one-field presence extension.
- Core stayed untouched apart from a `jumpTo` extraction in `logView.ts` and exports. No plugin API change was needed, which says chat is a core feature, not a plugin (every plugin and every agent wants it, and it needs both transports).

## Fit with the vision

- **Agent native**: agents talk where people talk, same room, same names and colors, and can wait on the conversation like a game turn. "@Claude" is a request; a node chip is "this thing, there".
- **Multiplayer**: no new transport, nothing to host: the doc already syncs.
- **Local first**: the history lives with the doc (device IndexedDB, bridge sidecar); it stays out of the file on purpose.
- **Play**: table talk next to a game, with the bot or an LLM seated as a person ("good game", "your move @Alice").

## Open questions

- Should a conversation ever be part of the file (or of git)? Opt-in export to `chat.md` next to the file, or `x-chat` in the canvas meta capped small? Today: no.
- Threads / replies, reactions, edits and deletes? Messages are immutable and append-only; deleting needs an authority (host) or "delete my own message" (honor system).
- Per-node comments (a thread on a node) vs one room chat: the node reference covers pointing; a comment thread anchored to a node is a different feature (more like Figma comments) and wants the same stream primitive scoped to a node.
- Private messages (a whisper to one player): impossible to keep private while every peer holds the doc; same limit as hidden cards. Host work.
- Should agents be told when mentioned without polling? `chat_wait` is a long-poll; a push (MCP notification / channel) would let an agent sleep until `@Claude`. Filter option `wait --mentions-me`?
- Chatty agents: cap or batch by the host? Notification sounds / desktop notifications for mentions?

## Known gaps

- No autocomplete for @-names (click a name in the panel to insert one); mentions of renamed players stop matching old messages.
- Plain text only: no markdown, links aren't clickable, no images.
- Chat is open to anyone who can write to the doc, and `from` is not verified (see above); behind a bridge that means any local process (`--as` is unauthenticated). Web pages in the same browser are refused by the bridge's Origin check.
- Capped at 300 messages and 2000 chars each; history before the cap is gone for good. Two peers appending at once can land in either order (Yjs order, same on every peer).
- The "seen" marker for people is per device and table; the unread count assumes the cap didn't drop your marker (then everything counts as unread).
- A message sent while a peer was offline reaches them with their next sync (the badge counts it; no notice popup for messages older than 15 s).
- Not exercised: WebRTC between real devices (same-browser BroadcastChannel only), mobile layout, the panel over a very small window.

## Effort to make it real

- Polish (autocomplete, links/markdown, typing/thinking presence, notification sound, mobile layout): ~2 days.
- Core `Stream` primitive (log + chat + cursors + generic wait), migrating the log: ~3 days.
- Host-authenticated senders, moderation, rate limits: part of the host work (~1–2 weeks, shared).
- Anchored comment threads on nodes: ~1 week.
