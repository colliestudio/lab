# bridge-ux

**Idea.** On the deployed app (canvas.lab.collie.studio) people start in a normal room and invite others; later, without anyone switching links, a bridge joins that room and brings agents in. Or the other way round: the agent starts a bridge and sends one link. Either way the person says "bring a bridge in" and the agent runs one command.

Builds on [agent-bridge.md](agent-bridge.md) (the bridge) and [chat.md](chat.md) (chat as part of the doc).

## Three ways in

| | who runs what | what the others do |
|---|---|---|
| **Room first, agents later** | agent: `pnpm bridge join <room link> <file>` | nothing; the bridge appears in the room, agents show up as players |
| **Bridge first** | agent: `pnpm bridge share <file>` (quick tunnel, token) | open the printed link |
| **Connect from the app** | person: Menu ▸ **Bridge…**, paste an address or link | the tab opens that bridge's board |

`?bridge=` links keep working unchanged.

## Joining a room: the bridge as a peer

```
 browsers ⇄ WebRTC mesh ⇄ browsers                      (unchanged; Worker only signals)
 browsers ─ WebSocket /r/<room>?relay=peer ─┐
                                             ├─ Durable Object: forwards binary frames, holds no doc
 bridge   ─ WebSocket /r/<room>?relay=bridge ┘
```

Node has no WebRTC (y-webrtc would need a native `wrtc`/`node-datachannel`), so the bridge reaches the room over a WebSocket path in the same Worker that already does signaling. Chosen over the alternatives:

- **node-datachannel as a real WebRTC peer**: no Worker change, but a native dependency, and a bridge behind a NAT without TURN may not connect. A relay always works (outbound WebSocket).
- **The Durable Object holds the doc (y-websocket server)**: the "tomorrow" plan in `core/sync.ts`; persistence and a dealer fit there, but it is a bigger change (storage, limits, secrets) and not needed to get a bridge into a room. The relay does not stand in its way: the DO could later become the one `bridge` peer.

How it works:

- **Worker** (`signaling/src/index.ts`, `hub.ts`): `?relay=bridge|peer` sockets (tagged) get binary frames forwarded: a bridge's frames go to everyone, a browser's only to bridges (browsers sync with each other over WebRTC; no double traffic). The DO tells the signaling sockets `{type:'bridge', online}` when a bridge arrives or leaves (and on every subscribe), and sends bridges a "query awareness" frame when a browser connects. Stateless; no new storage, no migration.
- **Browser** (`core/sync.ts`, `core/relay.ts`): on `bridge online` it opens the relay on the same Y.Doc and Awareness, closes it when the bridge leaves. Rooms without a bridge open nothing extra. It is a small own client, not y-websocket's provider, because that one wipes everyone else's awareness on every disconnect (here: the players seen over WebRTC).
- **Bridge** (`bridge/relay.ts`, `server.ts`): dials out and runs the socket through the same code as a browser connection (`attach`), reconnecting with backoff. Heartbeats keep both ends sure the path is alive. Nothing inbound: no port to expose, no tunnel, no token.
- **Agents are unchanged**: the HTTP API on `127.0.0.1` of the machine the bridge runs on (`pnpm canvas --as Claude …`), so each agent has its cursor, log name, chat and its own undo, and everyone in the room sees them.

### The board file

`pnpm bridge join <room> [file]` saves the room to `file` (default `room-<id>.canvas` in the current directory; give a path, agents should use a scratch or repo path, not a real board unless they mean to). While joined it is the same bridge as ever: the doc is written to the file (canonical text, clean git diffs), edits to the file flow back into the room, `.canvas-bridge/<name>.ystate` keeps history across restarts. Pointing it at an existing file merges that file into the room (like opening a file), so use a new name to only record.

### Host model

Nothing new is authoritative: the room stays a CRDT mesh, the bridge is one more full replica that also writes a file. Consequences:

- The bridge sees everything in the doc, including hidden hands (hiding is UI-only in the mesh anyway). A bridge in a room is a machine of someone in the room.
- If the bridge leaves, the room carries on; the file stops updating until a bridge rejoins (it catches up on what it missed).
- This is not the host of the host model (secrets, dealer, file of record). It could become that later (the DO as the one peer that holds secrets), but nothing here assumes it.
- The room link is the credential, as for any room. Whoever holds it can also announce itself as a bridge on the relay; that gives it what a peer already has.

## Security

- **App origin**: `share` allows `https://canvas.lab.collie.studio`, the workers.dev name and the dev servers (`:5190` on localhost, 127.0.0.1, mini.internal), plus `--app`. Foreign origins are still refused (guard.ts).
- **Pairing token** (`share`, or `--token`): a quick tunnel URL is public. Anything that is not a direct local request needs the token: the guard treats a request as local only when the peer address is loopback and none of the proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`, `CF-Ray`, `Forwarded`, …) are present; cloudflared and Caddy both add them. So the CLI and agents on the machine need nothing, while everything through a tunnel (HTTP API and WebSocket) needs `?token=` or `Authorization: Bearer`. Constant-time compare; the token is never logged. Verified through a real quick tunnel: no token 403, token 200, token with a foreign origin 403.
- The token rides in the printed link's `#fragment` (`…/?bridge=wss%3A…#token=…`), which no server sees; the app moves it into localStorage with the remembered address and takes it out of the address bar.
- **Joining a room exposes nothing**: the bridge listens on loopback only and talks to the room over an outbound socket. What a room peer can do is write the Yjs document. The bridge turns the document into the board file's text and runs plugin command logic on it (pure functions); it never uses document content as a path, a command or a URL. A peer cannot reach the HTTP API (loopback, guarded). What it can still do: write odd content into the board file (review the diff before committing it), or flood the room (the same as in any room).
- `--as NAME` stays unauthenticated for local processes, as before.

## For agents: bringing a bridge in

Run these on the machine where you work, in the canvas repo (`~/code/canvas`, or a worktree), with `pnpm install` done. Use scratch files (`/tmp/canvas-demos/<name>.canvas`) unless asked to save into a project. Keep the bridge running in the background (`nohup … > /tmp/canvas-demos/bridge.log 2>&1 &`) and read the log; Ctrl-C / SIGINT stops it cleanly (and the tunnel).

**1. People are already in a room** (they sent you the room link, or ask you to join "this room"):

```
pnpm bridge join 'https://canvas.lab.collie.studio/?room=abc123' /tmp/canvas-demos/room-abc123.canvas
```

- It prints `Joined room abc123` and the file path; the top-right status of everyone in the room shows `· bridge`, and the Bridge… dialog lists the agents.
- Add `--port N` if 5222 is taken. A bare room id works with `--signal wss://canvas.lab.collie.studio`.
- The room and the file merge both ways, so give a new file (or none: `room-<id>.canvas` in the current directory). A file that already holds another board is refused; `--merge` overrides that, only when asked to bring that board into the room.
- Act through the CLI (the `--as` name is yours on the board; one name per agent):
  ```
  export CANVAS_BRIDGE=http://localhost:5222
  pnpm canvas --as Claude add-node "Order placed"
  pnpm canvas --as Claude chat say "hi, I'm here"
  pnpm canvas --as Claude chat wait        # long-poll for what people say
  ```
  (or the MCP server, see agent-bridge.md). To leave: stop the process.

**2. Nobody is anywhere yet; give people a link to a board file:**

```
pnpm bridge share /tmp/canvas-demos/board.canvas
```

- It starts the bridge and a Cloudflare quick tunnel (`cloudflared` must be installed), then prints `Send this link …` and the URL: send exactly that line to the person (it contains the pairing token). Anyone with it can edit that board while the bridge runs, so say so.
- `--app http://mini.internal:5190` points the link at a dev app instead of canvas.lab (and allows it); `--no-tunnel` skips the tunnel (a link for a browser on the same machine); `--port N`, `--token T` as expected. Use the CLI as above (local requests need no token).
- Stop with Ctrl-C: the file is written, the tunnel closed.

**3. A person on a bridge page already** (they pasted nothing): they can use **Bridge…** → paste the bridge address or the printed link → Connect. The list remembers bridges (with the token) on that device.

Troubleshooting: the bridge log shows `refused …` with the reason (an origin that needs `--allow-origin`, a missing token). `pnpm canvas status` shows the room (`room: {id, online}`) and who is seated.

## What's built

- Worker: relay sockets, bridge announcements (`signaling/src/`). **Needs a deploy** to work with the deployed app; the rest of the app is backward compatible with the old Worker (a room just never sees a bridge).
- Bridge: `join`, `share`, tunnel, token (`bridge/args.ts`, `relay.ts`, `tunnel.ts`, `guard.ts`, `server.ts`), link and address parsing shared with the app (`src/core/bridgeAddress.ts`).
- App: Bridge… dialog (`src/bridgeDialog.ts`, `src/bridges.ts`), relay client (`src/core/relay.ts`), status shows `· bridge` in a room and online/offline for a bridge.
- Tests: unit (args, guard token, addresses, saved bridges, tunnel with `cloudflared` mocked, relay client, hub routing), `bridge/join.test.ts` (the real bridge process against a stand-in relay), and `scripts/bridge-e2e.mjs` (headless Chrome against `wrangler dev` and vite: two browsers in a room, a bridge joins, an agent adds a note and chats, both see it, the file saves, the bridge leaves and rejoins; a token-protected bridge behind a proxy, the dialog's connect / remember / disconnect).

## Gaps and open questions

- No health beyond "socket up": the app cannot call the bridge's HTTP `/status` (no CORS), so it shows connection state, who is here and the agents it sees.
- One bridge per room is the tested case. Two would both save the room to their own files and both answer; it works (a CRDT) but nobody has looked at it.
- Joining with a file that already holds a different board is refused unless `--merge` (the bridge remembers which room a file was saved from in `.canvas-bridge/<name>.room`).
- Relay frames are not size-limited by us (Cloudflare caps a message at 32 MiB); a room accepts at most 4 bridge and 64 browser relay sockets. A malformed frame is dropped (and logged) by the bridge. Rate limits belong with the "DO holds the doc" step.
- The pairing token is per bridge run, not per person or revocable apart from restarting. Per-agent tokens (`--as`) are still the later step in agent-bridge.md.
- Quick tunnels are a Cloudflare convenience with no SLA; a named tunnel would give a stable address.
- The room link is the credential for the relay too; a room password (needs `crypto.subtle`, so https) is not built.
