# agent-player

**Idea.** An agent joins a game on the table as a seat: it reads the game (not raw nodes), plays moves through the plugin's own commands, and waits for its turn, while people watch its cursor go to the piece and the log say "Claude played Black Nf6". Chess first: a rules mode for the chess board, a built-in bot that proves the loop without an LLM, and MCP tools so a real Claude agent can play.

Branch `idea/agent-player` (from `idea/agent-bridge`), worktree `~/code/canvas-wt/agent-player`.

## How it works

```
 browser (drag a piece) ─┐                          ┌─ canvas bot chess --as Bot   (search, no LLM)
                         ├─ chess.move / chess.place ┤
 bridge (Node, :5230) ───┘   same commands, same log └─ MCP chess_* tools ← Claude ("play black")
       GET /view/chess.state   GET /wait/chess.turn (long-poll until it's your move)
```

- **Rules mode lives in the chess plugin** (`src/plugins/chess/rules.ts`, `game.ts`, DOM-free). The table stays a table of pieces: a position = pieces standing on the board's squares + game fields on the board node (`x-chess.rules/turn/castling/ep/half/full/moves/result/end/white/black`). Free play (the old behavior) is the default; "Play by the rules" in the board menu (or `chess.newgame`) turns it on.
- **One move, two entrances.** `chess.move {id, move: "e2e4" | "Nf3" | "O-O"}` for agents; for people, dropping a piece (`chess.place`, wrapped in rules mode) on a legal square plays the same move; an illegal or out-of-turn drop bounces back to its square. Both produce the same changes (capture to the side, castling rook, en passant, promotion to a queen node) and the same log line with SAN, check and mate.
- **Seats.** `chess.sit {id, color}` seats the acting player. Core change: `CommandCtx.actor` (the store's actor, passed by `dispatch`), so the plugin enforces "only the white seat moves white". An open seat is hot-seat (anyone). `leave` stands up; `leave + force` frees someone else's seat (an agent that went away). The tab shows "♔ Alex – ♚ Bot · White to move" / "0-1 checkmate".
- **Views and waiting (bridge).** `bridge/views.ts`: a view is a pure function `(doc, args, actor) → value`. `chess.state` = the game as an agent needs it (FEN, picture, turn, seats, your color, your turn?, legal moves in SAN, history). `chess.turn` = same but `undefined` until it's your move or the game is over; `GET /wait/chess.turn` long-polls on it (re-checked after every doc change, max 290 s per call; waiting keeps the agent seated).
- **The bot** (`bridge/chess.ts runBot`) is a plain bridge client: sit → wait → `botMove` (negamax/alpha-beta on material, depth 2 by default, random among equals) → `chess.move` → repeat. Same path an LLM agent takes; it stands up when stopped or done.
- **Presence**: a command can now name what it acted on (`select`), and the bridge points the agent's cursor there: the moved piece, not "everything touched".

## What's built

- `src/plugins/chess/rules.ts`: legal move generation (castling through check, en passant, promotion, pins), SAN in/out with disambiguation, UCI, FEN, mate/stalemate/50-move/insufficient material, bot search. Perft-tested (start d3, kiwipete d2, positions 3 and 4).
- `src/plugins/chess/game.ts`: `chess.move/newgame/rules/sit/resign`, rules-aware `chess.place` and `chess.setup`, reset hook, `gameView`, `findBoard`. `logic.ts` = the DOM-free registration (bridge + tests); index.ts adds the board menu (New game, Play white/black, Free a seat, Resign, Free play) and the tab status.
- Core: `CommandCtx.actor` (store.ts); chess imports core values from `core/commands`/`core/doc` instead of the index (the index pulls in the DOM app and CSS, which Node can't load).
- Bridge: chess logic registered in the host; `GET /view/<name>`, `GET /wait/<name>?timeout=S`; client `view()/wait()`; CLI `canvas chess state|new|sit|move|wait|resign`, `canvas bot chess`; MCP `chess_state, chess_sit, chess_new_game, chess_move, chess_wait_for_turn, chess_resign`.
- Tests: +19 (rules 5, rules mode 11, bridge 3). 263 total. Headless Chromium run: person drags e2→e5 (bounced), e2→e4, Ng1→f3 vs the bot as black; tab, cursors and log as expected. MCP checked with an SDK client over stdio (no LLM): list tools, new game, sit, refused out-of-turn move with the reason, wait timeout.

## Takeback (and no undo in a rules game)

- `chess.takeback {id}` (CLI `canvas chess takeback`, MCP `chess_takeback`, board menu "Take back my last move"): seated, it goes back to just before your last move (your move and the reply); not seated at an open board, the last move. It replays the SAN record (`moves`, from the standard start, or from `start` when rules were turned on mid-game) and puts the pieces, captured pieces, promoted pieces (back to pawns), castling rights, en passant, counters, last-move highlight and result as they were, as one step. If the pieces no longer match the record (moved by hand), it refuses and says so. Not seated while both seats are taken: refused.
- Undo of any step that touched a rules board or its pieces is refused with "use takeback", in the browser (the toolbar says why), the CLI and MCP. This is a core hook (`Store.undoGuards`), so other games can guard their own state. Free-play boards undo as before.

## Demo

Start the bridge with the app's origin allowed (`--allow-origin http://localhost:<app port>`, see agent-bridge.md § Who may talk to the bridge). The ports below are the ones from the original run (app 5220, bridge 5230 on `/tmp/canvas-demos/agent-player/game.canvas`, a git repo), with a bot seated as black (`--keep`: plays every new game).

1. Open `http://mini.internal:5220/?bridge=ws://mini.internal:5230`. Board tab menu (click "Chess") → **Play white**. Drag e2→e4: Bot's cursor goes to its reply after ~0.6 s; the log (bottom left) says "Bot played Black …". Try an illegal drop: the piece goes back.
2. Shell, from the worktree, `export CANVAS_BRIDGE=http://localhost:5230`:
   - `pnpm canvas chess state` (the agent's view), `pnpm canvas chess move Nf3 --as Alex` (refused if Alex isn't the white seat holder and someone is), `pnpm canvas chess wait`.
   - Two bots: free both seats in the menu, then `pnpm canvas bot chess --as "Bot W" --color white --depth 1` and `pnpm canvas bot chess --as "Bot B" --color black` in two shells: a full game in seconds, every move in the log.
3. A real Claude as black (one LLM session, nothing else costs):
   - free the black seat from the menu ("Free the black seat (Bot)"; the bot stops when it notices, within a minute)
   - `claude mcp add canvas -e CANVAS_AS=Claude -e CANVAS_BRIDGE=http://localhost:5230 -- ~/code/canvas-wt/agent-player/node_modules/.bin/tsx ~/code/canvas-wt/agent-player/bridge/mcp.ts`
   - prompt: "Sit at the chessboard as black with chess_sit, then loop: chess_wait_for_turn, pick a move from the legal list, chess_move, until the game is over."
   - Play white in the browser. Claude's cursor and log name show up like the bot's.
4. With the bot's reply on the board, `pnpm canvas undo --as Alex` is refused ("use takeback"); `pnpm canvas chess takeback --as Alex` puts the board back to before your move, white to move again, and the bot keeps playing.
5. `git -C /tmp/canvas-demos/agent-player diff`: a move is a handful of lines (piece square/x/y, board turn/from/to/moves).

Restart (all detached): `cd ~/code/canvas-wt/agent-player && nohup pnpm exec vite --port 5220 --strictPort > /tmp/canvas-demos/agent-player-app.log 2>&1 &`, `nohup pnpm bridge /tmp/canvas-demos/agent-player/game.canvas --port 5230 > /tmp/canvas-demos/agent-player-bridge.log 2>&1 &`, `CANVAS_BRIDGE=http://localhost:5230 nohup pnpm canvas bot chess --as Bot --color black --keep > /tmp/canvas-demos/agent-player-bot.log 2>&1 &`.

## What it says about the core / plugin API

- **Legal-move knowledge belongs in the plugin, not the agent.** The agent gets the legal list and is refused with a reason; the person's drag is checked by the same function. An agent that knew the rules itself would drift from what the board enforces, and a person would have no check at all. Rules stay opt-in per board: free play (the table's spirit) is untouched.
- **Per-seat identity needs the actor in the command.** One field (`CommandCtx.actor`) was enough to enforce seats in the plugin, for people and agents alike. It is only as honest as the actor: in the browser it's the device's player id; on the bridge it's `--as` (unauthenticated). Real permissions need the host to authenticate actors; the check itself stays where it is.
- **Agents need views, not nodes.** `chess.state` is a pure `(doc, args, actor) → value`; the same shape covers "my hand" for cards. Proposal: plugins register views (`registerView(name, fn, {describe})`) next to commands, and the bridge exposes both as MCP tools automatically (pairs with agent-bridge's "command schemas" gap). The bridge's hand-written `views.ts` and `chess_*` tools are what that would generate.
- **Turn loops = "wait until a view is ready".** A view returning `undefined` for "not yet" + long-poll covers chess turns, card turns, "wait until someone plays on my column". Generic, no per-game protocol.
- **Commands should say what they acted on.** `select` doubles as "point the cursor here" for agents; worth a dedicated field (`focus`) so it doesn't change the agent store's selection semantics.
- **Node-safe plugin logic.** Importing values from `core/index` drags in the DOM app; plugin logic entries must import from DOM-free modules (or core should split `core/data` from `core/app`). Same need as agent-bridge's "DOM-free logic entry".
- Rough edges found: rules mode is a wrapper around free-play commands (setup, place) rather than a hook; a plugin "mode" with command overrides per node would be cleaner. Multi-piece drags on a rules board bounce back.

## Fit with the vision

- **Agent native**: the agent is a player with a seat, not a remote control. Same move command as a person, same log, own cursor; refusals say why.
- **Play**: proves "the table knows the game when you ask it to" without forcing rules on free play; a lone person can play a bot, and two agents can play each other on a shared board people watch.
- **Host model**: the bot is a client today; it could run inside the host (no HTTP, no seat to fake), the same way the host would hold hidden state. Rules checks in a host are authoritative; on today's P2P table every peer runs them for its own drops, so a modified client could still write an illegal position (the doc accepts any change).
- **Local first**: game state is in the `.canvas` file (`x-chess` fields), so a game is resumable from the file and diffable in git.

## Tiến Lên (not built; the shape)

- Views: `cards.my_hand` (the actor's hand: ids + faces, sorted Tiến Lên order), `cards.table` (the last play on the pile, who passed, card counts per seat, whose turn). Commands: `tienlen.play {cards}` (checks combo type and beats the pile), `tienlen.pass`. Wait: `tienlen.turn`.
- Privacy: hands are owned groups (`owner` = player id) and privacy is display-only today: every peer, and the bridge, holds all faces. The view must filter (only the asker's hand), which is honest only when the host serves views and peers don't hold the doc (host model / dealer task). On the bridge today, an agent could read the raw file.
- Needs a turn order (seats around the table) that cards don't have yet; the chess seat fields would generalize to `x-seats` on a mat or table zone.

## Open questions

- Takebacks: decided and built (`chess.takeback`, below). Per-actor undo of a move after the opponent replied left the game fields inconsistent with a half-restored position (the undone move stayed in the history and the undoer moved again; a recaptured piece didn't come back), so rules mode now refuses undo. Open: should the other player have to agree to a takeback?
- Should seats be core (a table-level "who plays what" for any game: chess colors, card seats, battleline sides), with permissions on commands keyed to them?
- A clock (the clock plugin exists): tie it to the turn (`turn` change → press the clock), and time out a waiting agent?
- Draw offers, threefold repetition (needs position history), PGN export.

## Known gaps

- Rules enforcement is per peer; nothing stops a raw doc edit (file edit, modified client) from making an illegal position. The next move is judged from whatever the position is. Same for two people moving an open (hot) seat's color at the same moment: each peer accepts its own drop, both merge.
- Multi-piece drags on a rules board bounce back; promotion by drag is always a queen.
- Takeback asks nobody (a bot cannot object, a person is not asked), and the board must still match its record: a rules game whose pieces were rearranged by hand (free play in between, then rules on) restarts the record, so earlier moves cannot be taken back.
- Undo is refused for every step touching a rules board, including a bounced illegal drag or a drag of a captured piece: there is no per-gesture undo in a game, only takeback.
- `--as` is unauthenticated: any local process can claim a seat holder's name.
- A seated agent that dies keeps its seat until someone frees it (menu) — bots stand up on Ctrl-C/kill of the node process only (killing the `pnpm` wrapper may not forward the signal).
- Long waits are long-polls of ≤290 s; MCP clients may time out a tool call sooner; `chess_wait_for_turn` defaults to 240 s and says "call again".

## Effort to make it real

- Rules mode polish (takeback, clock link, repetition, PGN, promotion picker, highlight legal squares while dragging): ~3 days.
- `registerView` + command/view schemas → auto MCP tools for every plugin: ~3–4 days (shared with agent-bridge's schema work).
- Seats in core + per-command permissions keyed to seats: ~1 week; real only with authenticated actors (host).
- Tiến Lên agent seat: ~3–4 days for rules + views; honest privacy depends on the host/dealer work (TASK-35.5).
