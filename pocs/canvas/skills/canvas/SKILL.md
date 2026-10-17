---
name: canvas
description: Join a Canvas board from this session, get woken when someone @-mentions you in its chat, and leave. Use for "/canvas", "/canvas join <board>", "/canvas leave", or when asked to join or work on a canvas board with other people or agents.
---

# Canvas

Seats this session at a board served by `canvas serve`, so people and other agents see you there. Tools: the `canvas` MCP server (`canvas_boards`, `canvas_join`, `chat_send`, `chat_read`, `canvas_leave`, the rest via `canvas_help`). Wake-up: a Monitor running `canvas-wait.mjs` in this skill's folder (`<base>` below = the "Base directory for this skill" shown when it loads).

## Setup (once, per machine; the user runs these)

```
claude mcp add --scope user --transport http canvas http://localhost:5310/mcp
ln -s ~/code/canvas-serve/current/skills/canvas ~/.claude/skills/canvas
```

`canvas serve` must be running (the always-on one on 5310; a dev `pnpm serve` listens on 5231 and needs its own `claude mcp add`). The Monitor script must talk to the same serve as the MCP, so `join` reads the MCP's origin and passes it explicitly.

## /canvas

Call `canvas_boards`. Say which boards this session has joined (from your notes of this conversation) and whether a Monitor runs for each.

## /canvas join <board>

1. Serve origin: run `claude mcp get canvas` and take the origin (scheme, host, port) of its URL, e.g. `http://localhost:5310` from `http://localhost:5310/mcp`. If that gives no URL, use `$CANVAS_SERVE`. If neither is set, the serve origin is unknown: skip step 5 (no Monitor), tell the user, and either ask them for the URL or wait in-turn with `chat_wait` as below. Never guess a default port.
2. Seat name: run `node <base>/canvas-wait.mjs name` (e.g. `Claude · task-3.38`; from the cwd's git branch `task-N-…`, else the repo or dir name). If it gives a generic dir name (e.g. a workspace root) and this session works on a known task, use `Claude · <task-id>` instead (max 30 chars). If `canvas_join` says the name is taken by another agent, retry with ` 2`, ` 3`.
3. `canvas_join {board, name}`. Don't pass `create` unless the user asked for a new board.
4. `chat_send` one short hello: who you are and what you're working on.
5. Start the wake-up Monitor:
   - `command`: `node <base>/canvas-wait.mjs follow <board> --as "<seat name>" --serve <origin>` (the name `canvas_join` accepted, with any ` 2` suffix; always pass `--serve`)
   - `description`: `canvas chat: <board>`
   - `timeout_ms`: `1800000` (the maximum; a Monitor is killed at its timeout, and the script ends itself at 29 minutes, just before).
6. Note the board, seat name, origin and Monitor task id for later, and a count of quiet re-arms (0).

A Monitor only wakes a session that is still running. In a one-shot run (`claude -p`, where the session ends when the turn does) or with no Monitor tool, skip step 5 and wait in-turn instead: loop `chat_wait` (it returns when someone else writes; call it again on timeout) until you have answered what you were asked to wait for.

## When the Monitor prints

Each line is a new chat message from someone else, already read (don't `chat_read` it again). A leading `@you` means it @-mentions you or everyone.

- `@you`, or clearly addressed to you: do what it asks (pass `canvas: "<board>"` to canvas tools when joined to 2+ boards), then answer with `chat_send`. Keep replies short.
- Anything else: stay quiet.
- Monitor ended with a timeout notice or exit 0 (it runs at most 29 minutes): start it again with the same command and add 1 to the quiet re-arm count. Any line it printed resets the count to 0. After 4 quiet re-arms in a row (about 2 hours with no messages) don't start it again: `canvas_leave {board}` and tell the user you left the idle board and they can `/canvas join <board>` again.
- Monitor exited with an error (exit 1: the serve is gone, the board vanished, or "seat … is not on board" = the origin isn't the serve the MCP joined on): tell the user; don't restart or retry with another guessed origin.
- A tool says `join a board first` or `not joined to`: `canvas_join` again with the same seat name; restart the Monitor if it exited.

## Seeing the board

`canvas_screenshot` returns the board as an image, the way your seat sees it (a hand that isn't yours shows its backs). Use it to check what text can't tell: layout, overlaps, how a drawing, a page or a game board looks. `canvas_look` is cheaper and exact for facts and ids. The loop: `canvas_look`, `canvas_do`, `canvas_screenshot`, fix. Pass `node` (id or title) to fill the picture with one node or frame, `region` for a box in board coordinates, and `labels: true` to tag every node with its id (the reply also lists the ids in view with their boxes in the picture). It needs a browser on the serve's machine; without one it says so and the other tools still work.

## Working on the board

- The board's background color is shared by everyone and shows in screenshots: `core.background {color}` (a #hex or a preset such as `slate`, `night`, `mint`; `null` goes back to the default), read with `canvas_look {view: "core.board"}`. Light text and arrows are drawn on dark colors for you.
- Your cursor and selection stay on the last node you changed. If the board has a node titled `Agent lounge`, end each burst of edits by nudging it 1px by id (find the id once with `canvas_look {text: "Agent lounge"}`; the title alone can match notes that mention the lounge): `core.move {ids: [<id>], dx: 1}`, then `dx: -1` the next time, so your cursor waits there, off the content. Only a real change moves the cursor. Don't put content near the lounge.
- Moving a frame moves every node whose center is inside it, other people's too. Before moving a frame, check what's in it (`canvas_look {view: "frames.outline"}`); to move only your own nodes, move them by id.

## /canvas leave [board]

For the board (or every joined board): stop its Monitor with `TaskStop` first, then `canvas_leave {board}`. A Monitor you stopped (or one for a board you left) reports that it ended: that is expected, don't restart it. Leave before the session ends: otherwise the seat lingers about 30 minutes.
