# recap-lab

Visual reviews (`.review`, after a change) and plans (`.plan`, before one) that an agent writes and a person zooms through: headline, change map, areas, annotated code, embedded Collie Demo recordings.
Collie Studio lab prototype (task-1): local-only, format `collie-doc/0`, CLI `recap` (both names are placeholders).

## Artifact kit (task-5, replaces the fixed format going forward)

Agent-written React pages with a component kit, built into one HTML file: `bin/artifact.js new|dev|check|build`, kit in `artifact/kit/`, host chrome in `artifact/host/`, guide `skill/ARTIFACT.md`, example `samples/hello.artifact`. The `recap` code below keeps working, not extended.

## Quickstart

```sh
pnpm install
pnpm viewer:build                                   # optional: serve/build build the viewer on first use
pnpm recap serve samples/recap-lab.review           # local viewer + comments, live reload on doc.md
pnpm recap build samples/recap-lab.review -o x.html # one offline HTML file: how docs are shared today
                                                    # --code key (default: only hunks blocks show) | none | full
pnpm recap server --data ./data [--token T]         # self-hosted server (127.0.0.1 unless --host + token)
pnpm recap publish samples/recap-lab.review --to http://127.0.0.1:<port>   # unlisted link; edit secret saved to
                                                    # .recap-publish.json next to the bundle (gitignored); re-publish: --id <id>
pnpm recap md samples/recap-lab.review              # the doc as Markdown (= viewer "Copy as Markdown"); --short: PR comment
```

For agents (`skill/SKILL.md` is the full guide):

```sh
pnpm recap collect --base main -o x.review [--exclude 'samples/**']...   # changes.patch + doc.md scaffold
# rewrite doc.md: areas, map, sections, picked hunks
pnpm recap check x.review                            # until 0 errors (links, diff refs, demo files, budgets)
pnpm recap serve x.review                            # look at each zoom level once
pnpm recap build x.review -o x.html                   # share: one file; readers comment in it and "Copy feedback"
pnpm recap comments x.review --import -              # pasted feedback → comments.json
pnpm recap comments x.review --open                  # reader comments → edit doc.md → check
```

## The format in 10 lines

A bundle is a dir `name.review/` (or the same zipped into one file): `doc.md`, `changes.patch`, `assets/`, `demos/*.replay`, `comments.json`.
`doc.md` = YAML frontmatter (title, tldr, risk, risk_why, ask, base/head, `plan:` link) + Markdown + typed fenced blocks.
One ` ```map ` block (YAML: groups, nodes with `change`/`section`, edges) comes before the first section.
Text between the map and the first `##` is the overview; `questions` there are the decisions asked of the reader.
Each `## Title {#id}` is an area; its first paragraph is the summary shown on map hover; `.mechanical` sections go last.
Blocks: `callout`, `flow` (Mermaid), `demo`, `before-after`, `data-model`, `api`, `steps`, `questions`, `checklist`, `files`, `diff`, `code`.
`diff file=x hunks=1,3 lines=40-80` points into `changes.patch`; `@<line>: note` lines annotate it (`\@` escapes in code).
`files` blocks take paths, globs or dirs; map node `files:` globs attach file diffs to a node.
A review's `plan:` links its plan by node id: planned & done / not done / deferred / unplanned, deferred plan work as ghost nodes.
Full spec: `SPEC.md`; the JSON model the parser emits and the viewer reads: `src/model.ts`.

## Zoom ladder

| level (= key) | shows |
|---|---|
| 1 Headline | title, tl;dr, risk + why, the ask, decisions, stats |
| 2 Map | change map (click a node to focus its area), overview |
| 3 Areas | per-area narrative, flows, demos, before/after, data model, API |
| 4 Code | file trees, annotated diffs and code, every changed file |

`+`/`-` step, `p` map vs plan, `t` theme, `Esc` leaves focus.

## Layout

```
SPEC.md            the format and CLI
skill/SKILL.md     authoring guide for agents
src/               model.ts, parse/ (doc.md, patch, bundle), check, collect, md, cli, server/ (serve, build, server, publish)
viewer/            React + Vite single-file viewer (pnpm viewer:dev: ?bundle=<path>, real parser behind a mock API)
samples/           five hand-authored bundles (start with recap-lab.plan + recap-lab.review; samples/README.md)
test/              node:test suites + fixtures
```

## Status and limits

- Lab POC; nothing published. `pnpm typecheck`, `pnpm test`, `recap check samples/*` clean.
- Hosted server: unlisted ids, per-doc edit secrets, passive file types only, strict CSP; no accounts, no comment states, comments are unauthenticated.
- Single-file builds: ~2.7 MB viewer (mermaid, elk, rrweb, gzipped) + code + recordings; `build` reports sizes, warns over 5 MB, refuses over 25 MB (`--force`).
- Feedback in a single file lives in the reader's browser until they copy it; nothing syncs.
- Recordings aren't redacted; check `.replay` files for secrets before sharing.
- Map layout (ELK) is good up to ~12 nodes; the budget `check` enforces.

## Installed copies

The dogfood VMs (`acme-ws`, `other-ws`) run copies of this repo and its skill. After changing code or `skill/SKILL.md`, run `bin/recap-sync` from the cs workspace root. Inventory: cs `workspace` skill § Installed outside this workspace.
