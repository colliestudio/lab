# Kanban: a live board of a Backlog.md folder

A kanban node on a board of a canvas serve shows a Backlog.md project as columns and cards, and writes
board edits back to the task files the way `backlog task edit` does. The files stay the truth: the CLI,
git and hand edits keep working and the node follows within a second. Direction (and what comes after):
"Collie Kanban" in the workspace notes. This is step 1.

## What it is

- **One node, real cards.** Columns are the statuses of `backlog.config.yml`. A card shows id, title,
  priority, AC progress and assignee (with a dot while that assignee is seated on the board). Done shows
  its tasks of the last 14 days as one-line rows and the rest behind "+N older". Filters (labels, parent)
  are saved on the node.
- **Edits.** Drag a card (status, plus an ordinal for the slot), quick add (`+` on a column, Enter; a paste of
  several lines makes several tasks), the card panel (title, status, labels, assignee, priority,
  description, acceptance criteria, plan, notes, comments). Undo works per viewer for moves and field
  edits; creating a task and commenting are not undoable (a file exists by then).
- **Outside edits** show on every viewer within about two seconds. The same field changed on both sides:
  the file wins and a notice says so.
- **Agents** use `kanban.move/create/edit/comment/filter/addBoard` through `canvas_do` and read the node as
  text with the view `kanban.board` (`canvas_look`); both describe themselves like other plugins.
  `canvas kanban move TASK-12 "In Progress"` and `canvas kanban` are the CLI spellings.

## How it runs

```
browser A ─┐  y-websocket   ┌──────────── canvas serve ─────────────────────┐
browser B ─┼───────────────►│ Board (Y.Doc)                                  │
agent MCP ─┘ canvas_do/look │   kanban task nodes = mirror of the folder     │
                            │   KanbanSync per kanban node ──► BacklogMdSource ──► Backlog.md folder
                            │     pull: file watch + 1 s poll → doc (file wins)   │◄── CLI, git, editors
                            │     push: doc fields ≠ base → one patch per task    │
                            └────────────────────────────────────────────────┘
```

- **Host = the serve** (single writer). Viewers and agents only change the doc; nobody but the serve
  touches files. A page that is not a serve board (a local board, a bridge) shows the node read-only,
  "not live here".
- **Folders are configured on the serve**: `--kanban name=path` (repeatable) or
  `$CANVAS_KANBAN="a=path,b=path"`. A path is a Backlog.md project root (`backlog.config.yml`) or a backlog
  folder (`config.yml` + `tasks/`). A node stores only the name; `GET /api/info` lists names, never paths.
  No path or folder comes from a board, a client or an agent: a hand-edited `.canvas` carrying one is
  ignored, and agent commands reject path-like arguments.
- **Every task of the folder is a node in the doc** (contained in the board; layout places the ones that
  show). The `.canvas` file keeps only the card face and the filter; sections, comments, sync hashes and the
  sync state are not exported and are refilled from the folder.
- **Sync is field-level.** `base[f]` = hash of what the file held at the last sync. A doc field whose hash
  differs from base is a board edit to push; a file field whose hash differs is an outside edit to pull.
  Both sides changed = conflict: the file's value stays and everyone gets a notice. After a write, base is
  taken from the card read back, and a value the file stored differently replaces the board's, so nothing
  loops.
- **Writes** go through one queue per folder, atomically (temp file in the same folder + rename), patching
  only the lines of the changed field or the inside of the changed section. A read-only file fails with a
  notice and the card goes back to the file's state. A file that stops parsing keeps its last good card.
- **New tasks** get a provisional id at once (past every id in tasks, archive and completed); if two
  viewers pick the same, the serve gives the loser a fresh id and says so.

## Adapter

`src/plugins/kanban/source.ts` is the whole surface the sync, commands and panel know: `list`, `read`,
`write(id, patch)`, `create`, `watch`, `nextId`, with `caps` for what a tracker can't do. Backlog.md is the
only adapter (`node/backlogMd.ts`). Trello (lists, `pos`, checklists, webhooks), Linear (states,
`sortOrder`, description only), GitHub Projects (Status field, `after` ordering) and ClickUp (statuses,
`orderindex`) fit without a change; tokens and webhook receivers would live in an adapter's constructor
and `watch`. `MemSource` and the shared contract suite (`source.contract.ts`) are what a new adapter
passes first.

## Where things are

| | |
|---|---|
| `src/plugins/kanban/markdown.ts` | task file reader and patcher, CLI-compatible (tested against `backlog` itself) |
| `model.ts`, `commands.ts`, `layout.ts`, `logic.ts`, `agent.ts` | node model, commands, layout, agent surface (no DOM) |
| `sync.ts` | `KanbanSync` and the pure pull step |
| `index.ts`, `render.ts`, `panel.ts`, `kanban.css` | the browser side |
| `node/` | Node-only: `BacklogMdSource`, folder registry, per-board attach, `serve.ts` (what `canvas serve` loads through `src/plugins/serve.ts`) |
| `server/core` | generic hooks: `serveExtra.ts` types, `Host.applySystem`, `Board.addCloser`, `BoardDirectory` `attach`/`info` |
| `scripts/kanban-e2e.mjs` | headless Chromium against a scratch serve (needs `pnpm build`) |

## Not in v1

Pulling a card out onto the canvas as a live copy, card to thing arrows, `@mention` waking an agent,
sticky-to-task on drop, swimlanes by parent, any tracker but Backlog.md, a rule about who may drag to Done.
