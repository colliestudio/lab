# recap-lab

Visual reviews (`.review`, after a change) and plans (`.plan`, before one) that an agent writes and a person zooms through: headline, change map, areas, annotated code, embedded Collie Demo recordings.
Collie Studio lab prototype (task-1): local-only, format `collie-doc/0`, CLI `recap` (both names are placeholders).

## Quickstart

```sh
pnpm install
pnpm viewer:build                                   # optional: serve/build build the viewer on first use
pnpm recap serve samples/recap-lab.review           # local viewer + comments, live reload on doc.md
pnpm recap build samples/recap-lab.review -o x.html # one offline HTML file
pnpm recap server --data ./data [--token T]         # self-hosted server (127.0.0.1 unless --host + token)
pnpm recap publish samples/recap-lab.review --to http://127.0.0.1:<port>   # unlisted link; edit secret saved to
                                                    # .recap-publish.json next to the bundle (gitignored); re-publish: --id <id>
pnpm recap md samples/recap-lab.review              # GitHub comment fallback (headline + Mermaid map)
```

For agents (`skill/SKILL.md` is the full guide):

```sh
pnpm recap collect --base main -o x.review [--exclude 'samples/**']...   # changes.patch + doc.md scaffold
# rewrite doc.md: areas, map, sections, picked hunks
pnpm recap check x.review                            # until 0 errors (links, diff refs, demo files, budgets)
pnpm recap serve x.review                            # look at each zoom level once
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
- Single-file builds are 3-4 MB (the viewer bundles mermaid, elk, rrweb); nothing is lazy-loaded.
- Recordings aren't redacted; check `.replay` files for secrets before sharing.
- Map layout (ELK) is good up to ~12 nodes; the budget `check` enforces.
