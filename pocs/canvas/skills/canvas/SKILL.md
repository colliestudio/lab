---
name: canvas
description: Join a Canvas board from this session, get woken when someone @-mentions you in its chat, and leave. Use for "/canvas", "/canvas join <board>", "/canvas leave", or when asked to join or work on a canvas board with other people or agents.
---

# Canvas

Seats this session at a board served by `canvas serve`, so people and other agents see you there. Tools: the `canvas` MCP server (`canvas_boards`, `canvas_join`, `chat_send`, `chat_read`, `canvas_leave`, the rest via `canvas_help`). Wake-up: a Monitor running `canvas-wait.mjs` in this skill's folder (`<base>` below = the "Base directory for this skill" shown when it loads).

## Setup (once, per machine; the user runs these)

```
claude mcp add --scope user --transport http canvas http://localhost:5231/mcp
ln -s ~/code/canvas/skills/canvas ~/.claude/skills/canvas
```

`canvas serve` must be running. If the MCP is registered at another origin (`claude mcp get canvas`), pass that origin to the script as `--serve <origin>` (or set `CANVAS_SERVE`).

## /canvas

Call `canvas_boards`. Say which boards this session has joined (from your notes of this conversation) and whether a Monitor runs for each.

## /canvas join <board>

1. Seat name: run `node <base>/canvas-wait.mjs name` (e.g. `Claude · task-3.38`). If `canvas_join` says the name is taken by another agent, retry with ` 2`, ` 3`.
2. `canvas_join {board, name}`. Don't pass `create` unless the user asked for a new board.
3. `chat_send` one short hello: who you are and what you're working on.
4. Start the wake-up Monitor:
   - `command`: `node <base>/canvas-wait.mjs follow <board> --as "<seat name>"`
   - `description`: `canvas chat: <board>`
   - `timeout_ms`: `1800000` (the maximum; a Monitor is killed at its timeout).
5. Note the board, seat name and Monitor task id for later.

A Monitor only wakes a session that is still running. In a one-shot run (`claude -p`, where the session ends when the turn does) or with no Monitor tool, skip step 4 and wait in-turn instead: loop `chat_wait` (it returns when someone else writes; call it again on timeout) until you have answered what you were asked to wait for.

## When the Monitor prints

Each line is a new chat message from someone else, already read (don't `chat_read` it again). A leading `@you` means it @-mentions you or everyone.

- `@you`, or clearly addressed to you: do what it asks (pass `canvas: "<board>"` to canvas tools when joined to 2+ boards), then answer with `chat_send`. Keep replies short.
- Anything else: stay quiet.
- Monitor ended with a timeout notice or exit 0 (it runs at most 30 minutes): start it again with the same command.
- Monitor exited with an error (exit 1: the serve is gone or the board vanished): tell the user; don't restart in a loop.
- A tool says `join a board first` or `not joined to`: `canvas_join` again with the same seat name; restart the Monitor if it exited.

## /canvas leave [board]

For the board (or every joined board): stop its Monitor with `TaskStop` first, then `canvas_leave {board}`. Leave before the session ends: otherwise the seat lingers about 30 minutes.
