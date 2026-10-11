# kanban: a board node backed by Backlog.md

Branch `idea/kanban`, port 5216.

## Idea

A kanban node on the canvas that is a view of a Backlog.md project: columns = statuses, cards = task files. Same data as files and as a board; agents and the CLI edit the files, the board follows, and board edits land back in the files as small git diffs.

## How it works

- **Nodes** (`x-kanban` namespace):
  - board: a JSON Canvas `group`
  - task: a `file` node pointing at its `.md`, contained in the board
  - ref: a linked copy of a task anywhere on the canvas
  - web: an iframe of the Backlog.md UI
- **Layout**: tasks sit in columns via a core layout rule (derived, never stored). The board grows to fit; columns show 8 cards with "+N more".
- **Fields sync per field through Yjs**: title, status, labels, assignee, ordinal, body. Each task also keeps `base` = hashes of what the source held at the last sync.
- **Host**: the tab that connected the board (`ownerTab`) is the only one that talks to the source. Each cycle it pulls, then pushes:
  - pull: a source field ≠ base means an outside edit, so the source wins for that field.
  - push: a doc field ≠ base means a local edit from any peer, so it writes that field.
  - Poll every 1.5 s; after a change, a cycle (pull, then push) 250 ms later.
- **Source adapter** (`sources.ts`), two implementations:
  - **files**: a folder of `backlog/tasks/*.md` + `backlog.config.yml`, picked via the File System Access API (Chromium, secure origin) or the dev server's `KANBAN_ROOT` folder (`/__kanban` list/read/write, any browser). Writes patch only the changed frontmatter lines plus `updated_date`, like the CLI. New tasks get the next id past `archive/` and `completed/`.
  - **service**: a running `backlog browser` through the Vite proxy `/backlog-api` (it sends no CORS headers). Read: `GET /api/tasks?crossBranch=false`, `/api/config`. Write: `PUT /api/tasks/:id` (title/status/labels/assignee/description), `POST /api/tasks/reorder` (taskId, targetStatus, orderedTaskIds), `POST /api/tasks` (create). Found in the 1.53 binary's route table.
- **Drags**:
  - card to another column: status change (+ ordinal only if needed)
  - card onto empty canvas: a linked ref (the card stays on the board)
  - ref onto its board: the task moves and the ref goes away
- **Opening a task**: double-click or Enter opens a side panel with title, status, labels, assignee and body. Edits go to the doc, the host writes them, and outside edits show live.

## What's built

- `src/plugins/kanban/`:
  - `markdown.ts`: frontmatter reader (lists, `>-` folded, quotes) and line-preserving patcher
  - `model.ts`, `layout.ts`, `commands.ts`: create, connect, pull, pushed, move, edit, newTask, ref, expand, web
  - `host.ts`: sync loop
  - `sources.ts`: Files/Service sources; FSA/Dev/Mem folders
  - `connect.ts`: which tab hosts; resume after reload; FSA handle in IndexedDB
  - `render.ts`, `panel.ts`, `index.ts`, `kanban.css`
- `vite-kanban.ts`: dev folder endpoint. `vite.config.ts`: plugin + `/backlog-api` proxy (`BACKLOG_URL`, default 6421).
- Tests: `kanban.test.ts` (12) covers:
  - parse/patch/quoting
  - minimal diffs
  - ordinal placement
  - 3-way merge
  - new ids past the archive
  - refs
  - layout limits
  - peer edit → host write
  - service-style source that renumbers (no write loop)
- Totals: 241 tests pass; typecheck clean.
- `scripts/kanban-e2e.mjs`: headless Chrome run of everything below. All 13 checks pass.

## Demo

Setup (copies only; the real cs board is never written):

```
for d in /tmp/kanban-demo /tmp/kanban-svc; do mkdir -p $d; cp -R ~/workspaces/cs/backlog ~/workspaces/cs/backlog.config.yml $d/; git -C $d init -q; git -C $d add -A; git -C $d commit -qm copy; done
(cd /tmp/kanban-svc && backlog browser --port 5226 --no-open &)
KANBAN_ROOT=/tmp/kanban-demo BACKLOG_URL=http://127.0.0.1:5226 pnpm exec vite --port 5216 --strictPort
```

1. Open http://localhost:5216. Add… → Kanban board (Backlog.md) → "Dev folder: kanban-demo". 57 tasks appear.
2. Drag a To Do card to Done, then `git -C /tmp/kanban-demo diff`: `status`, `updated_date`, maybe `ordinal`.
3. Edit a file by hand or with `backlog task edit` in `/tmp/kanban-demo`. The card changes within 2 s.
4. Drag a card onto empty canvas to get a linked ref. Double-click it and edit the title/body; the board card and the file follow.
5. "+" on a column → new task → a new `task-N - Title.md`.
6. Share → open the room link in a second tab. It shows "host: you, in another tab". Drag there; the first tab writes the file.
7. Add another board → "Backlog server": same board via the API of the instance on 5226. Moves land in `/tmp/kanban-svc`.
8. Add… → Backlog.md web UI (iframe), URL `http://localhost:5226`. Double-click to use it; Done / Esc / click outside to stop.
9. Chromium on localhost: "Open folder…" picks any Backlog.md folder (FSA). After a reload it needs one "Reconnect folder" click.

## Native board vs iframe of `backlog browser`

| | native node (files or service) | iframe of the Backlog.md UI |
|---|---|---|
| multiplayer | board state in Yjs; everyone sees the same thing; peers' edits go through the host | per viewer: each person has their own session; only the data is shared, and only if they can reach the server |
| reach | peers need only the room; the host needs the folder/service | every viewer needs network access to the server (localhost = only the host machine) |
| canvas | cards are nodes: drag out as refs, connect with edges, export to JSON Canvas (`file` nodes) | a rectangle; no refs, no export (blank in SVG), not readable by a canvas agent |
| interaction | same gestures as the rest of the canvas | needs an edit-mode gate (double-click), and pan/zoom stop inside it |
| features | what we build: today title/status/labels/assignee/body/order/new | everything Backlog.md has (milestones, AC, DoD, search, drafts, docs) for free |
| cost | parser + writer + sync per source | ~40 lines |

The iframe is fine as a quick personal view. The native node is the one that fits the vision.

## What it says about core / plugin API

- These worked unchanged: the layout rule (columns), parent rule (tasks in board), local drags + `dropProxy` + `onDrop(at)` (column/slot), `onLocalDrop` (refs), `dragOver` (insert marker), duplicate rules, export filters, not-undoable dispatch for sync.
- No core changes. The only shared-file changes are `main.ts` (register), `vite.config.ts` (plugin, proxy) and the new `vite-kanban.ts`.
- Gaps found:
  - **Host/side-effect hook.** Plugins need "run this loop in one tab only" (a service per doc). Today ownership is an `ownerTab` field plus module state; core could offer `app.registerService(boardId, …)` with election and handoff.
  - **Plugin-local render state.** Connection status isn't in the doc, so `renderKey` reads module state and the plugin calls `app.view.render()`. A `app.invalidate(id)` would be cleaner.
  - **Text input inside nodes.** Pointer capture + `root.focus()` steal focus, so I used dialogs and a side panel. Core needs an "interactive region" rule (no capture, no focus steal) for inline editing.
  - **Shared dialogs.** I reused `askText` from mats; it belongs in core.
  - Small items:
    - nested `x-` maps are only one level deep, so `base` and lists are whole values (fine here)
    - `body` is a plain string (last writer wins), where Y.Text would merge typing
    - the synthetic-pointer pinch bug: a stale pointer id left in `View.pointers` turns the next press into a pinch
- **Containment boards that grow**: a layout may set the container's own size. That's a neat trick, but it's implicit, so document it in `LayoutRule`.

## Fit with the vision

- **Multiplayer**: board state is Yjs; one writer per source avoids file conflicts. A field-level 3-way merge with source wins on conflict.
- **Agent native**: agents edit the markdown or run the `backlog` CLI, both already supported. The canvas shows it live. The board writes Backlog.md format, so agents see canvas edits too.
- **Local first**: files on disk, git diffs as small as the CLI's; the doc persists offline. A reopened `.canvas` has no `base`, so the host pulls before writing (files win).
- **Hosting**:
  - git-tracked files: the files source.
  - Collie Server: runs `BoardHost` server-side against the repo/folder or the service. The browser-tab host is a stand-in for that and has the same shape.
- **Host model**: only the host can reach the folder/service; it shares a snapshot via Yjs and applies peers' moves. Exactly what the iframe can't do.
- **Plugin security**: the plugin gets a folder handle (user-picked, readwrite) or a proxy URL. A real plugin system should hand out a scoped capability, e.g. "this folder" or "this origin", rather than the plugin doing `fetch`/FSA itself. The dev endpoint is confined to its root and to `.md/.yml` writes.

## Open questions

- Who hosts when the owner tab closes? Today it's a manual "Take over as host" from the menu, with no presence-based election.
- Body is a whole string; concurrent typing in two panels loses one. Use Y.Text for the body? Map it to file sections (Description, Plan, Notes)?
- Service mode edits only the Description section via the API; files mode edits the raw body. Should they converge on sections?
- Timestamps: Backlog's server writes `updated_date` in UTC; the files writer uses local time like the CLI does on this Mac. Check which the CLI really uses.
- Renaming a task doesn't rename the file (Backlog's CLI does). Fine for git, but drifts from the CLI's layout.
- Big boards: Done grows forever. Collapse Done by default, or a date filter?
- Other markdown boards (Obsidian Kanban plugin, todo.txt, GitHub issues) as more adapters. The source interface is small enough.

## Effort to make real

- Hardening (1 week):
  - task files: subtasks, dependencies, AC/DoD (read-only)
  - drafts, milestones
  - Y.Text body
  - host election via presence
  - inline title editing once core has interactive regions
  - error and conflict UI
- Core pieces (1 week): service/host API, invalidate, interactive regions, shared dialogs.
- Server host (with Collie Server): run `BoardHost` in the room server against a git checkout, commit/push policy.
- Total about 2 to 3 weeks for a solid Backlog.md board. Each extra source adapter is about 2 to 3 days.
