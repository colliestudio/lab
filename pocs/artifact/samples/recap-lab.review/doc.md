---
kind: review
title: recap-lab - visual reviews and plans you zoom into
tldr: An agent's review or plan becomes one bundle a reader zooms through - headline, change map, areas, annotated code - with real Collie Demo recordings embedded, opened locally, as one offline HTML file, or from a self-hosted server.
status: ready
risk: low
risk_why: Lab code with no users; what lasts is the doc.md format and node ids agents learn to write, and the hosted server, which today accepts uploads from anyone when started without a token and renders their raw HTML.
ask: Look at the viewer tour and the map vs plan; decide the two questions (server token default, patch scope); approve the format as the base for the real tool.
repo: recap-lab (local lab)
base: main
head: 06b211e
plan: ../recap-lab.plan
author: dev agent (dogfood)
date: 2026-10-05
---

```map
groups:
  - { id: authoring, label: Authoring (agent side) }
  - { id: core, label: Format + parser }
  - { id: delivery, label: Delivery }
  - { id: reading, label: Viewer (reader side) }
nodes:
  - { id: skill, label: Authoring skill, kind: doc, change: added, group: authoring, section: skill, files: [skill/**] }
  - { id: cli, label: "CLI: collect, check, md", kind: module, change: added, group: authoring, section: cli, files: [src/cli.ts, src/collect.ts, src/check.ts, src/md.ts, bin/**] }
  - { id: format, label: "Format + model (SPEC, model.ts)", kind: doc, change: added, group: core, section: format, files: [SPEC.md, src/model.ts] }
  - { id: parser, label: "Parser (doc.md, patch, bundle)", kind: module, change: added, group: core, section: parser, files: [src/parse/**] }
  - { id: server, label: "serve / build / server", kind: service, change: added, group: delivery, section: server, files: [src/server/**] }
  - { id: viewer, label: "Viewer shell (zoom ladder, focus)", kind: ui, change: added, group: reading, section: viewer, files: [viewer/src/**, viewer/index.html, viewer/vite.config.ts] }
  - { id: map, label: Change map, kind: ui, change: added, group: reading, section: map, files: [viewer/src/components/MapView.tsx] }
  - { id: tests, label: "Tests + fixture harness", kind: module, change: added, section: tests, files: [test/*.ts, viewer/fixtures/*.ts, viewer/harness/**] }
  - { id: replay, label: "Collie Demo .replay", kind: external, change: unchanged, note: "replay-lab recordings; embedded as-is, played with rrweb-player" }
  - { id: mechanical, label: "Lockfile, fixtures, screenshots, samples", kind: config, change: added, mechanical: true, section: mechanical }
edges:
  - { from: skill, to: cli, label: drives }
  - { from: cli, to: parser, label: "collect, check" }
  - { from: format, to: parser, label: defines }
  - { from: parser, to: server, label: Doc JSON }
  - { from: server, to: viewer, label: "boot + files" }
  - { from: viewer, to: map, label: renders }
  - { from: replay, to: viewer, label: "demo blocks" }
  - { from: tests, to: parser, label: checks }
```

Everything is new on top of an empty init commit. Read it in map order: the format and the JSON model are the contract, the parser and CLI produce it, three deliveries serve it, and the viewer renders it at four zoom levels. Press `p` (or "vs plan") to see the map against the reconstructed plan: everything planned was built, accounts and the GitHub Action stay deferred, and the test harness was not in the plan.

```questions
- q: Should `recap server` refuse to start without a publish token?
  options: ["refuse unless --open", "start, but warn loudly", "keep today's behaviour (open uploads, silent)"]
  recommend: "refuse unless --open"
  why: "Without a token anyone who finds the port can upload, and uploaded markdown renders as raw HTML on the server's origin (see Delivery)."
- q: "What should `recap collect` put in changes.patch for a whole-repo review like this one?"
  options: ["everything (today)", "--exclude pathspecs", "everything, but drop nested bundles' patches and binaries from the model"]
  recommend: "--exclude pathspecs, plus marking fixtures and nested bundles mechanical"
  why: "Collected whole, this patch was 5.4 MB (98k lines), mostly the sample bundles' own patches and the viewer screenshots; the single-file build inlines all of it, and collect flagged only the lockfile as mechanical. (Answered since: this bundle is re-collected with --exclude, 0.8 MB.)"
```

## Format and model {#format}

`SPEC.md` fixes the format (`collie-doc/0`): Markdown + YAML frontmatter + typed fences, a required map, four zoom levels; `src/model.ts` is the JSON contract the parser writes and the viewer and server read.

```data-model
entities:
  - name: Doc
    change: added
    fields:
      - { name: "kind, title, tldr, goal, risk, ask", type: frontmatter, change: added, note: "level 0; goal stands in for tldr in plans" }
      - { name: map, type: "DocMap {groups, nodes, edges}", change: added, note: "level 1; node change includes planned and deferred" }
      - { name: overviewBlocks, type: "Block[]", change: added, note: "between the map and the first section, in source order" }
      - { name: sections, type: "Section[]", change: added, note: "summary = first paragraph = the map hover" }
      - { name: files, type: "FileChange[]", change: added, note: "from changes.patch, mechanical flag per file" }
      - { name: questions, type: "Question[]", change: added, note: "collected from every questions block" }
      - { name: planLink, type: "PlanLink?", change: added, note: "done / notDone / deferred / unplanned node ids" }
  - name: ViewerBoot
    change: added
    fields:
      - { name: doc, type: Doc, change: added }
      - { name: files, type: "Record<path, base64>?", change: added, note: "single-file mode" }
      - { name: api, type: "string?", change: added, note: "\"/api\" or \"/d/<id>/api\"; absent = read-only" }
```

```files
paths: [SPEC.md, src/model.ts]
```

## Parser {#parser}

`src/parse` turns `doc.md` + `changes.patch` into the model: a line scanner splits typed fences from prose and `##` sections, every YAML object is checked against allowed keys, diffs are pulled from the patch by file, hunk and line range, and `plan:` is resolved and matched by node id.

```diff file=src/parse/doc.ts lines=37-71,93-157
@38: the allowed keys per YAML object: an unknown key is the symptom of an unquoted ", " or ": " inside { }
@69: QUOTE_HINT suffix is what check turns into an error; every other parser warning stays a warning
@111: the close must be the same character and at least as long, so a 4-backtick fence can hold a 3-backtick example
@114: an unclosed fence warns but swallows the rest of the doc; check whether a missing close should be an error
@120: fences of unknown types (ts, sh) stay part of the markdown, so ordinary code samples still render
@149: bare flags become "true"; double-quoted values honour backslash escapes, single-quoted don't
```

```callout tone=warn
A `@<n>: text` line inside a `code` or `diff` body is always a note: there is no way to show a literal `@52: …` line (e.g. an example of the note syntax). Found while writing the plan; the example had to move to prose.
```

```files
paths: [src/parse/doc.ts, src/parse/patch.ts, src/parse/bundle.ts, src/parse/index.ts]
notes:
  src/parse/bundle.ts: "dir or zip, plan: resolution, linkPlan()"
  src/parse/patch.ts: "unified diff + mechanical heuristics (lockfile, generated, rename, whitespace)"
```

## CLI for authors {#cli}

`collect` writes the patch and a scaffold doc (one node per top-level directory), `check` lints until clean (structural and YAML-key problems are errors, budgets are warnings), `md` renders the PR-comment fallback.

```checklist
- "pnpm recap collect --base main --head 06b211e --exclude 'samples/*.review/**' --exclude 'samples/*.plan/**' --exclude 'viewer/screenshots/**' -o /tmp/x.review"
- pnpm recap check samples/recap-lab.review
- pnpm recap md samples/recap-lab.review
- pnpm recap model samples/recap-lab.plan
```

```files
paths: [src/cli.ts, src/collect.ts, src/check.ts, src/md.ts, bin/recap.js]
notes:
  src/collect.ts: "groups by first path segment (two for src/, packages/ …); only lockfiles and generated paths count as mechanical"
```

## Delivery: serve, build, server {#server}

One viewer HTML, booted by injecting `window.__RECAP__` three ways: `recap serve` (local API, comments into the bundle, live reload over SSE), `recap build` (everything inlined into one offline file), and `recap server` + `publish` (zip upload, unlisted random ids, same API under `/d/<id>`).

```diff file=src/server/http.ts lines=54-63
@55: escaping "<" covers both </script> and <!-- in doc text, which would otherwise end or comment out the boot script
@61: a replacer function, not a string: doc text containing $& or $' must not be expanded by String.replace
```

```diff file=src/server/build.ts
@11: only files the doc references are inlined (demos, shots, markdown images), not the whole bundle
@15: trace.zip is dropped from each .replay here; the player only needs the JSON streams
```

```diff file=src/server/hosted.ts lines=25-54,76-90
@29: no --token and no RECAP_TOKEN = anyone may POST and PUT; the startup line says nothing in that case
@39: a non-zip body is rejected before the parser sees it, and a failed first upload removes its directory
@46: bundle.review is swapped before doc.json is written; a crash between the two serves the new zip with the old model
@88: re-publish (PUT) keeps the id and comments.json, but there are no versions: comments may anchor to sections that are gone
```

```code file=viewer/src/components/Markdown.tsx lines=6-27
@15: href goes into the attribute unescaped
@26: marked passes raw HTML through and the viewer sets it as innerHTML
```

```callout tone=risk
**Stored XSS on a hosted server.** Doc markdown is rendered as raw HTML (no sanitizer) and links are not escaped. Locally that is the author's own content; on `recap server` it is anyone's upload (open by default, above), running on the server's origin next to the comments API. Before any shared deployment: sanitize (DOMPurify or marked without HTML) and require a token.
```

```files
paths: [src/server/http.ts, src/server/build.ts, src/server/hosted.ts, src/server/serve.ts, src/server/publish.ts, src/server/bundle.ts, src/server/index.ts]
```

## Viewer shell: zoom ladder and focus {#viewer}

A React + Vite single-file app: the level decides what renders (Headline, + Map, + Areas, + Code), keys `1`-`4` and `+`/`-` zoom without losing your place, a map click focuses one area with only its neighbours, and every block type has a renderer, including a real Collie Demo player. The tour below is a real recording of it.

```demo
src: demos/viewer-tour.replay
caption: "Recorded with replay-lab (node bin/demo.js run) against the single-file build of the replay-lab-backend sample: Headline, key 2 to the Map, hover and click a node to focus, Esc, keys 3 and 4, t for dark."
```

```before-after
before: { demo: demos/viewer-tour.replay, step: 3, caption: "Map (level 1): every area, coloured by change" }
after: { demo: demos/viewer-tour.replay, step: 5, caption: "Focus: one area, its neighbours on a compact map, Esc back" }
caption: Clicking a map node trades the whole system for one area in context.
```

```diff file=viewer/src/App.tsx lines=52-73,119-135,150-161
@53: zooming changes page height a lot; the first visible section is remembered and put back at the same offset
@70: focus forces at least level 2, otherwise the focused section would not render
@123: keys are ignored while typing (comment box) and with modifiers, so Cmd+1 still switches tabs
@129: p (plan overlay) only exists when the review links a plan
@158: each level renders itself plus everything above it; nothing is hidden with CSS
```

```files
paths:
  - viewer/src/App.tsx
  - viewer/src/boot.ts
  - viewer/src/ctx.tsx
  - viewer/src/util.ts
  - viewer/src/main.tsx
  - viewer/src/highlight.ts
  - viewer/src/vite-env.d.ts
  - viewer/src/app.css
  - viewer/src/theme.css
  - viewer/src/components/Headline.tsx
  - viewer/src/components/SectionView.tsx
  - viewer/src/components/Markdown.tsx
  - viewer/src/components/Comments.tsx
  - viewer/src/components/bits.tsx
  - viewer/src/components/icons.tsx
  - viewer/src/blocks/index.tsx
  - viewer/src/blocks/demo.tsx
  - viewer/src/blocks/before-after.tsx
  - viewer/src/blocks/diff.tsx
  - viewer/src/blocks/files.tsx
  - viewer/src/blocks/flow.tsx
  - viewer/src/blocks/simple.tsx
  - viewer/index.html
  - viewer/vite.config.ts
notes:
  viewer/src/theme.css: "Collie UI token values copied as CSS variables (light + midnight)"
  viewer/src/blocks/demo.tsx: "unzips the .replay in the browser, rrweb-player, step list = seek"
```

## Change map {#map}

The map is laid out with ELK (layered, orthogonal edges) in both directions and the viewer picks the one that fits; edge labels are placed by the viewer, not ELK, so they sit on their own line without widening the layout.

```diff file=viewer/src/components/MapView.tsx lines=68-116,194-206
@69: giving labels to ELK doubles the layers; placing them afterwards keeps the map compact
@104: candidates outside the map box are skipped, so a label can't be clipped by the SVG edge
@113: no free spot = label hidden until one of its nodes or the edge is hovered; on dense maps check the important ones still show
@205: left-to-right unless it would shrink below 85% and top-down is clearly bigger
```

```files
paths: [viewer/src/components/MapView.tsx]
```

## Tests and fixture harness {#tests}

Node test runner suites for the patch parser, doc parser, format additions, check, bundles and the three servers; `viewer/fixtures` generates Doc JSON fixtures and screenshots the viewer, `viewer/harness` exercises the demo block alone. Not in the plan.

```checklist
- pnpm test
- pnpm typecheck
```

```files
paths:
  - test/patch.test.ts
  - test/doc.test.ts
  - test/format.test.ts
  - test/check.test.ts
  - test/bundle.test.ts
  - test/server.test.ts
  - viewer/fixtures/lib.ts
  - viewer/fixtures/make.ts
  - viewer/fixtures/shots.ts
  - viewer/harness/demo.html
  - viewer/harness/demo.tsx
  - viewer/harness/vite.config.ts
```

## Authoring skill {#skill}

`skill/SKILL.md` is what an agent follows: read the whole unit once, name 3-8 areas, isolate the mechanical, order by dependency, then write each level within budgets (12 nodes, 8 sections, 150-line diffs, 3-8 key hunks); it was revised from the samples agents wrote with it.

```files
paths: [skill/SKILL.md]
```

## Lockfile, fixtures, screenshots, samples {#mechanical .mechanical}

Generated or hand-authored data with no logic: the lockfile, root config, JSON and patch fixtures. The viewer screenshots (3.9 MB of PNGs) and the three earlier sample bundles (their own patches and recordings) are in the branch but left out of this patch with `--exclude`.

```files
pnpm-lock.yaml: lockfile
package.json: "deps: react, elkjs, mermaid, marked, rrweb-player, fflate, yaml"
pnpm-workspace.yaml:
tsconfig.json:
mise.toml:
test/fixtures/**: "parser and server fixtures: a retries review + plan, a bundle with two .replay recordings"
viewer/fixtures/*.json: hand-built Doc JSON for the viewer's dev server
viewer/fixtures/retries.patch:
samples/README.md:
```
