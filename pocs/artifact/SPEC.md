# recap-lab spec (format `collie-doc/0`)

Visual reviews and plans. One doc model, two kinds: **`.plan`** (before the work) and **`.review`** (after). Core principle: **big picture first, zoom in on demand** (Shneiderman: overview → zoom/filter → details on demand).

Names are placeholders: CLI `recap`, format `collie-doc/0`.

## 1. Zoom ladder

Every doc renders at four named levels. The viewer has a zoom control (keys `1`–`4`, `+`/`-`); each level shows itself plus everything above it.

| level | name | review shows | plan shows |
|---|---|---|---|
| 0 | **Headline** | title, tl;dr (one sentence), risk + why, the ask ("approve", "check X"), stats | title, goal, the decisions needed from the reader |
| 1 | **Map** | change map: areas/components as nodes, change status coloured (added / changed / removed), edges = calls / data flow; each node = one section; mechanical areas greyed and collapsed | same map; nodes `planned` (new) or `changed`, and existing context nodes `unchanged` |
| 2 | **Areas** | per-area section: narrative, flow diagrams, demo clips, before/after, data model, API | per-area approach, steps, open questions, sketches |
| 3 | **Code** | file list, annotated diffs | code sketches, file list of where things land |

- Clicking a map node **focuses** that area: only its section, breadcrumb back to the map, neighbours listed as context (Ilograph-style).
- Sections are ordered by dependency ("what must I understand first"), not alphabetically. Mechanical sections (renames, formatting, generated, lockfiles) go last, collapsed.
- A review may link the plan it implements (`plan:` in frontmatter). The viewer then marks the map: **planned and done**, **planned, not done**, **unplanned**.

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

### Frontmatter (level 0)

```yaml
---
kind: review            # review | plan
title: Retry failed webhook deliveries
tldr: Failed deliveries now retry with capped exponential backoff; operators can see and replay them.
status: ready           # review: draft | ready ; plan: proposed | accepted | done
risk: medium            # low | medium | high
risk_why: Changes the delivery worker's ack path; a bug here drops or duplicates events.
ask: Approve the backoff caps; check the migration is reversible.
repo: acme/relay
base: main
head: feat/retries
pr: https://github.com/acme/relay/pull/1093
plan: ../retries.plan    # optional link to the plan this implements (path or URL)
author: dev agent
date: 2026-10-05
---
```

`stats` (files / additions / deletions) are computed from `changes.patch` when present.

### Map (level 1)

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
- `change`: `added | changed | removed | unchanged | planned`. `unchanged` = context.
- `section`: the section id this node opens. Every non-context node should have one.
- `files`: optional globs; the viewer uses them to attach file-level diffs to the node.

### Sections (level 2)

Each `## ` heading starts a section. Id from `{#id}` or slugified title. Attributes in the braces: `.mechanical`.

```md
## Retry scheduler {#retry}

First paragraph = the section summary (shown on map hover and at the top of the section). Keep it to 1–2 sentences.

More markdown...
```

Text before the first `##` (after the map) is the **overview** narrative: a short level-1 paragraph, shown under the map.

### Blocks

Fence info string: ` ```<type> key=value key="quoted value" `. Body: YAML for structured blocks, raw for `diff` / `flow` / `code`. Markdown between fences becomes `markdown` blocks. Default level per type (override with `level=N`):

| type | level | body | renders |
|---|---|---|---|
| (markdown) | 2 | markdown | prose |
| `callout` | 2 | markdown; attr `tone=info\|warn\|risk\|decision` | highlighted note |
| `flow` | 2 | Mermaid source (sequence, flowchart, state, ER) | diagram |
| `demo` | 2 | YAML: `src: demos/x.replay`, `steps: [2,3]` (or omit = all), `caption:` | embedded Collie Demo player, step list, seek to step |
| `before-after` | 2 | YAML: `before: {src\|demo+step, caption}`, `after: {...}` | side-by-side images (or replay frames) |
| `data-model` | 2 | YAML: `entities: [{name, change, fields: [{name, type, change, note}]}]` | entity cards with change flags |
| `api` | 2 | YAML: `endpoints: [{method, path, change, summary, request, response}]` | endpoint cards |
| `steps` | 2 | YAML: `[{title, detail, status: todo\|doing\|done, area}]` | plan steps |
| `questions` | 0 | YAML: `[{q, options: [...], recommend, why}]` | decisions needed (shown at level 0 = "the ask") |
| `checklist` | 2 | YAML list of strings | how to verify |
| `files` | 3 | optional YAML `{path: note}`; files come from `changes.patch` | file tree with change flags, notes, +/− counts |
| `diff` | 3 | either a raw unified diff, or empty with `file=path` (taken from `changes.patch`; `hunks=1,3` to pick) + annotation lines `@<newLineNo>: note` | split/unified diff with inline notes |
| `code` | 3 | raw; attrs `lang`, `file` | highlighted code |

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
| `recap collect --base main [--head HEAD] [--repo .] -o x.review` | creates/updates the bundle: `changes.patch`, a `doc.md` scaffold (frontmatter, a map with one node per top-level area, a `files` block, mechanical files flagged) for the agent to rewrite |
| `recap check x.review` | parse + lint: map present, nodes ↔ sections linked, diff refs resolve, demo files exist, size budgets (map ≤ 12 nodes, ≤ 8 sections, diff blocks ≤ 150 lines), tl;dr one sentence |
| `recap pack x.review/` / `recap unpack x.review` | dir ↔ zip |
| `recap model x.review` | print the parsed JSON model |
| `recap serve`, `build`, `md`, `server`, `publish` | §4 |

## 6. Comments

`comments.json`: `[{id, anchor: {section?, block?, file?, line?}, author, body, created, resolved?}]`. Anchors are section / block ids (stable: from `{#id}` or `id=` attr, else derived). The authoring agent reads them with `recap comments x.review` and resolves after editing.
