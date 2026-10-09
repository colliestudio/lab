# recap-lab spec (format `collie-doc/0`)

Visual reviews and plans. One doc model, two kinds: **`.plan`** (before the work) and **`.review`** (after). Core principle: **big picture first, zoom in on demand** (Shneiderman: overview → zoom/filter → details on demand).

Names are placeholders: CLI `recap`, format `collie-doc/0`.

## 1. Zoom ladder

Every doc renders at four named levels, numbered 1–4 everywhere (UI badge, keys `1`–`4`, URL `#/L1`…`#/L4`, `level=` attrs). The viewer has a zoom control (`+`/`-` step); each level shows itself plus everything above it.

| level | name | review shows | plan shows |
|---|---|---|---|
| 1 | **Headline** | title, tl;dr (one sentence), risk + why, the ask ("approve", "check X"), stats | title, goal, the decisions needed from the reader |
| 2 | **Map** | change map: areas/components as nodes, change status coloured (added / changed / removed), edges = calls / data flow; each node = one section; mechanical areas greyed and collapsed | same map; nodes `planned` (new) or `changed`, existing context nodes `unchanged`, work left for later `deferred` |
| 3 | **Areas** | per-area section: narrative, flow diagrams, demo clips, before/after, data model, API | per-area approach, steps, open questions, sketches |
| 4 | **Code** | file list, annotated diffs | code sketches, file list of where things land |

- Clicking a map node **focuses** that area: only its section, breadcrumb back to the map, neighbours listed as context (Ilograph-style).
- Sections are ordered by dependency ("what must I understand first"), not alphabetically. Mechanical sections (renames, formatting, generated, lockfiles) go last, collapsed.
- A review may link the plan it implements (`plan:` in frontmatter). The viewer then marks the map: **planned and done**, **planned, not done**, **deferred** (deferred in the plan or the review; never counted as not done), **unplanned**. Plan work the review's map doesn't draw (deferred or not done) appears as dashed **ghost** nodes, with the plan's edges to drawn nodes (`planLink.ghosts`).

## 2. Bundle

A doc is a bundle: a directory `name.review/` (or `name.plan/`), or the same contents zipped into a single file `name.review` (portable; like `.replay`). Every tool accepts both.

```
name.review/
  doc.md            required: the source (§3)
  changes.patch     optional: unified diff written by `recap collect`; `diff` blocks can reference it
  assets/           optional: images (png/jpg/svg/webp)
  demos/*.replay    optional: Collie Demo recordings (replay/0 zip), embedded by `demo` blocks
  comments.json     optional: reader comments (§6)
```

## 3. Source: `doc.md`

Markdown + YAML frontmatter + **typed fenced blocks**. Degrades readably on GitHub. The parser turns it into the JSON model in `src/model.ts` (the contract between parser, viewer and server).

### Frontmatter (level 1)

```yaml
---
kind: review            # review | plan
title: Retry failed webhook deliveries
tldr: Failed deliveries now retry with capped exponential backoff; operators can see and replay them.
goal: Stop losing deliveries when a destination is briefly down.   # optional (plans); kept as doc.goal
status: ready           # review: draft | ready ; plan: proposed | accepted | done
risk: medium            # low | medium | high
risk_why: Changes the delivery worker's ack path; a bug here drops or duplicates events.
ask: Approve the backoff caps; check the migration is reversible.
repo: acme/relay
base: main              # or (empty): the whole tree at head (`recap collect --root`)
head: feat/retries
pr: https://github.com/acme/relay/pull/1093
plan: ../retries.plan    # optional link to the plan this implements (path or URL)
author: dev agent
date: 2026-10-05
---
```

`stats` (files / additions / deletions) are computed from `changes.patch` when present. `tldr` is required; when it is missing, `goal` stands in for it (plans often say only the goal). Unrecognized frontmatter keys are a warning.

### Map (level 2)

Exactly one ` ```map ` block, YAML body, before the first section:

````
```map
groups:
  - { id: worker, label: Delivery worker }
nodes:
  - { id: queue, label: Delivery queue, kind: queue, change: unchanged }
  - { id: retry, label: Retry scheduler, kind: module, change: added, group: worker, section: retry }
  - { id: ui, label: Failed deliveries page, kind: ui, change: added, section: ui }
  - { id: lock, label: Lockfile, kind: config, change: changed, mechanical: true, section: mechanical }
edges:
  - { from: queue, to: retry, label: nack, change: added }
  - { from: retry, to: queue, label: re-enqueue after backoff, change: added }
```
````

- `kind`: `service | module | ui | db | api | queue | job | external | config | doc` (icon only).
- `change`: `added | changed | removed | unchanged | planned | deferred`. `unchanged` = context; `deferred` = work the plan leaves for later (give it a section, e.g. "Later", so the reader sees what and why).
- `section`: the section id this node opens. Every non-context node should have one.
- `files`: optional globs; the viewer uses them to attach file-level diffs to the node.
- Allowed keys: groups `id, label`; nodes `id, label, kind, change, group, section, mechanical, note, files`; edges `from, to, label, change`. Any other key is a `check` **error**: it almost always comes from an unquoted `, ` or `: ` inside `{ }` / `[ ]` (`{ label: Player (a, b) }` parses as `label: "Player (a"` plus a key `b)`). Quote such values.

### Sections (level 3)

Each `## ` heading starts a section. Id from `{#id}` or slugified title. Attributes in the braces: `.mechanical`.

```md
## Retry scheduler {#retry}

First paragraph = the section summary (shown on map hover and at the top of the section). Keep it to 1–2 sentences.

More markdown...
```

Everything between the map and the first `##` is the **overview**, shown under the map: a short level-2 narrative plus any blocks that describe the whole change (`flow`, `callout`, `questions`, `checklist`, …). Overview markdown is level 2; typed blocks keep their default level (level-4 blocks there get a warning: they belong in a section). Model: `doc.overviewBlocks` (all of it, in source order, ids `overview-<type>-<n>`) and `doc.overview` (the markdown joined, for previews and `recap md`).

### Blocks

Fence info string: ` ```<type> key=value key="quoted value" `. Body: YAML for structured blocks, raw for `diff` / `flow` / `code`. Markdown between fences becomes `markdown` blocks. Every block takes `id=` and `level=N` (1-4; anything else, including the old `level=0`, is a `check` error); other attributes are per type (below), unknown ones are a warning. YAML keys are checked per object like the map's (keys listed in the table); an unknown key, or a mapping where a string was expected (a `checklist` item or `options` entry with an unquoted `: `), is a `check` error. Default level per type:

| type | level | body | renders |
|---|---|---|---|
| (markdown) | 3 | markdown | prose |
| `callout` | 3 | markdown; attr `tone=info\|warn\|risk\|decision` | highlighted note |
| `flow` | 3 | Mermaid source (sequence, flowchart, state, ER) | diagram |
| `demo` | 3 | YAML: `src: demos/x.replay`, `steps: [2,3]` (1-based step numbers as in the recording; omit = all), `caption:` | embedded Collie Demo player, step list, seek to step |
| `before-after` | 3 | YAML: `before: {src\|demo+step, caption}`, `after: {...}`, `caption`; `step` is 1-based | side-by-side images (or replay frames) |
| `data-model` | 3 | YAML: `entities: [{name, change, note, fields: [{name, type, change, note}]}]` | entity cards with change flags |
| `api` | 3 | YAML: `endpoints: [{method, path, change, summary, request, response}]` | endpoint cards |
| `steps` | 3 | YAML: `[{title, detail, status: todo\|doing\|done, area}]` | plan steps |
| `questions` | 1 | YAML: `[{q, options: [...], recommend, why}]` | decisions needed (shown at level 1 = "the ask") |
| `checklist` | 3 | YAML list of strings | how to verify |
| `files` | 4 | optional YAML `{path: note}` (or `{notes, paths}`); paths may be globs (`src/server/**`, `*.ts`) or directories, expanded against `changes.patch` (a file's own note wins over a glob's) | file tree with change flags, notes, +/− counts |
| `diff` | 4 | a raw unified diff, or empty with `file=path` (from `changes.patch`); attrs `hunks=`, `lines=`; `@<line>: note` lines | split/unified diff with inline notes |
| `code` | 4 | raw; attrs `lang`, `file`, `start`, `lines`; `@<line>: note` lines | highlighted code with line numbers and notes |

**`questions`** may sit in any section or in the overview; every one is collected into `doc.questions` (the level-1 ask). The overview is the natural place: the reader meets the decisions before the details.

**`diff`** picks:
- `hunks=1,3`: hunk numbers **per file, 1-based**, in patch order.
- `lines=163-199` (also `lines=18,163-199`): keeps only the part of the (picked) hunks whose **new-side** line numbers fall in the ranges; works alone or after `hunks=`. A removed line goes with the new-side line that follows it, so a replacement stays whole. Sliced hunks keep their real line numbers (header rebuilt). This is how a long new file fits the 150-line budget.
- Notes: body lines `@<n>: note` (`n` = new-side line number) anywhere in the body, with or without an inline diff (convention: after it). Each must fall on a shown line.

**`code`**: `start=N` numbers the first line `N` (default 1). Body lines `@<n>: note` annotate line `n` (in the same numbering) and are not part of the code; write `\@<n>:` for a code line that really starts with `@<n>:`. With `file=` naming a file in `changes.patch` and an otherwise empty body, the code is filled from the patch's new side (`lines=a-b` to pick, else all of it; `start` then comes from the patch); this works for whole new files and for changed regions, and stops with a warning at the first line the patch doesn't contain. With a body, `lines=a-b` just sets `start` to `a`. `lang` defaults from the file extension.

## 4. Viewing modes (same viewer everywhere)

The viewer is one static web app. It receives a **Doc model** (JSON) + a way to fetch bundle files. Three ways to deliver it:

| mode | command | how |
|---|---|---|
| local | `recap serve x.review` | Node server on 127.0.0.1: viewer + `GET /api/doc`, `GET /api/files/<path>`, `GET/POST /api/comments` (writes `comments.json` in the bundle). Live reload on `doc.md` change. |
| single file | `recap build x.review -o x.html` | one self-contained HTML: viewer + model + files inlined (base64). Opens from disk, offline, attachable. Comments are read-only. |
| hosted / self-hosted | `recap server --data ./data` + `recap publish x.review --to <url>` | same API under `/d/<id>/…`; upload = zip; unlisted random ids; comments stored server-side. Hosted = the same server run by us. |

Plus `recap md x.review` → a GitHub comment fallback: headline, risk, ask, the map as Mermaid, link.

Viewer contract (`window.__RECAP__`): `{ doc: Doc, files?: Record<path, base64>, api?: string /* base URL of the API, e.g. "/api" or "/d/abc/api" */ }`. If `files` is present use it, else fetch `${api}/files/<path>`. API under `${api}`: `GET doc`, `GET files/<path>`, `GET|POST comments`. See `src/model.ts` `ViewerBoot`.

## 5. CLI

| command | does |
|---|---|
| `recap collect --base main [--head HEAD] [--repo .] [--exclude <pathspec>]... -o x.review` (or `--root` instead of `--base`: everything at head vs the empty tree, frontmatter `base: (empty)`) | creates/updates the bundle: `changes.patch`, a `doc.md` scaffold (frontmatter, a map with one node per top-level area, a `files` block, mechanical files flagged) for the agent to rewrite. `--exclude` (repeatable) is a git pathspec with glob magic (`samples/*.review/**`, a bare dir excludes its tree; `:(…)`/`:!` specs pass through). Mechanical: lockfiles, generated/vendored/minified, nested bundles (`*.review/**`, `*.plan/**`), `.replay`, images and `screenshots/`, JSON under `fixtures/`/`testdata/`/`__snapshots__/`, pure renames, whitespace-only |
| `recap check x.review` | parse + lint: map present, nodes ↔ sections linked, diff refs resolve, demo files exist, unknown YAML keys (errors), size budgets (map ≤ 12 nodes, ≤ 8 sections, diff and code blocks ≤ 150 lines), tl;dr one sentence |
| `recap pack x.review/` / `recap unpack x.review` | dir ↔ zip |
| `recap model x.review` | print the parsed JSON model |
| `recap serve`, `build`, `md`, `server`, `publish` | §4 |

## 6. Comments

`comments.json`: `[{id, anchor: {section?, block?, file?, line?}, author, body, created, resolved?}]`. Anchors are section / block ids (stable: from `{#id}` or `id=` attr, else derived). The authoring agent reads them with `recap comments x.review` and resolves after editing.
