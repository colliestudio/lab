---
kind: plan
title: recap-lab - visual reviews and plans, big picture first
goal: A reviewer opens one file and gets the change at four zoom levels - headline, map, areas, code - with real recordings instead of drawings, and a plan and its review share one map.
status: done
risk: medium
risk_why: The source format (doc.md fences, node ids, bundle layout) is what agents learn to write; once samples and skills depend on it, changing it means rewriting every doc.
ask: Decide the three open questions (names and extensions, where the shared server lives, agent-written vs derived map); approve the one-model, four-level, bundle design.
repo: recap-lab (local lab)
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
  - { id: skill, label: Authoring skill, kind: doc, change: planned, group: authoring, section: skill }
  - { id: cli, label: "CLI: collect, check, md", kind: module, change: planned, group: authoring, section: cli }
  - { id: format, label: "Format + model (SPEC, model.ts)", kind: doc, change: planned, group: core, section: format }
  - { id: parser, label: "Parser (doc.md, patch, bundle)", kind: module, change: planned, group: core, section: parser }
  - { id: server, label: "serve / build / server", kind: service, change: planned, group: delivery, section: server }
  - { id: viewer, label: "Viewer shell (zoom ladder, focus)", kind: ui, change: planned, group: reading, section: viewer }
  - { id: map, label: Change map, kind: ui, change: planned, group: reading, section: map }
  - { id: replay, label: "Collie Demo .replay", kind: external, change: unchanged, note: "replay-lab recordings; embedded as-is, played with rrweb-player" }
  - { id: accounts, label: Accounts + teams, kind: module, change: deferred, group: delivery, section: later }
  - { id: gh-action, label: GitHub Action, kind: job, change: deferred, group: delivery, section: later }
edges:
  - { from: skill, to: cli, label: drives }
  - { from: cli, to: parser, label: "collect, check" }
  - { from: format, to: parser, label: defines }
  - { from: parser, to: server, label: Doc JSON }
  - { from: server, to: viewer, label: "boot + files" }
  - { from: viewer, to: map, label: renders }
  - { from: replay, to: viewer, label: "demo blocks" }
  - { from: gh-action, to: server, label: "publish + sticky comment", change: deferred }
  - { from: accounts, to: server, label: "owns docs", change: deferred }
```

**Reconstructed after the fact.** This plan was written after recap-lab was built, from the lead's design notes (decisions D3-D13) and the spec, so the review of the build can link a plan and show planned vs done. The design itself was decided before the build; only this document is late.

Agent-written PR descriptions and visual recaps put whatever the agent writes first at the top, which is rarely the big picture. recap-lab fixes the order instead: every doc has a headline, a map, per-area sections and code, and the reader zooms in only where they care. One model serves plans and reviews, so a review can mark the plan's map as done, not done or deferred.

```questions
- q: Names - CLI and format, and one file extension or two?
  options: ["two: .review / .plan", "one: .collie (kind in frontmatter)", "fold under the Demo CLI (demo review, demo plan)"]
  recommend: "two extensions now; settle the CLI name together with the Collie Demo CLI"
  why: "The kind in the file name tells you what you are opening and makes plan: ../x.plan read naturally; the CLI name should come from the suite naming, not from this lab."
- q: Where does the shared server (publish, unlisted links, comments) live?
  options: ["recap-lab (lab, now)", "colliestudio/collie-demo server/", "own repo colliestudio/collie-server"]
  recommend: "recap-lab now; own repo once the collie-demo repo exists"
  why: "It serves .replay, .review and .plan alike, so it should not sit inside one tool; the collie-server.plan sample argues it in full."
- q: Should the map be agent-written or derived from code (import graph) and corrected by the agent?
  options: [agent-written, "derived, agent corrects", "agent-written, collect suggests edges"]
  recommend: "agent-written; collect suggests edges from imports later"
  why: "The map shows intent (areas a reviewer would name), which an import graph doesn't know; import edges are a useful hint for the scaffold, not the answer."
```

## Format and model {#format}

One doc model, two kinds (`kind: plan | review`): Markdown with YAML frontmatter and typed fences, parsed to the JSON model the viewer and server consume. Bundle = a dir or the same files zipped.

```callout tone=decision
**D3 one model, two kinds; D4 a fixed four-level ladder; D6 Markdown + typed fences; D7 bundle = dir or zip.** Agent-Native also converged on one model for plans and recaps, but has no levels, so its big picture is whatever comes first. Fixed levels make the agent write each level. Markdown + YAML is cheap to author and degrades readably on GitHub; MDX with JSON attributes was brittle in Agent-Native.
```

```data-model
entities:
  - name: Doc
    change: planned
    fields:
      - { name: kind, type: "review | plan", change: planned }
      - { name: "title, tldr, goal, risk, ask", type: frontmatter, change: planned, note: level 0 }
      - { name: map, type: "DocMap (groups, nodes, edges)", change: planned, note: level 1; node ids shared between plan and review }
      - { name: overviewBlocks, type: "Block[]", change: planned, note: "between the map and the first section: the questions live here" }
      - { name: sections, type: "Section[]", change: planned, note: "level 2+, each opened by a map node" }
      - { name: files, type: "FileChange[]", change: planned, note: "from changes.patch" }
      - { name: planLink, type: "PlanLink?", change: planned, note: "done / notDone / deferred / unplanned node ids" }
  - name: Bundle
    change: planned
    fields:
      - { name: doc.md, change: planned, note: required source }
      - { name: changes.patch, change: planned, note: written by collect; diffs reference it }
      - { name: "assets/, demos/*.replay", change: planned, note: "a .replay sits inside as-is" }
      - { name: comments.json, change: planned }
```

```steps
- { title: "SPEC.md: ladder, bundle, frontmatter, map, block table", area: format, status: done }
- { title: "src/model.ts: the JSON contract between parser, viewer and server", area: format, status: done }
```

## Parser {#parser}

Turns `doc.md` + `changes.patch` into the Doc model: fences by type, attributes, YAML bodies with per-object key checks, diffs by reference, plan link by node id.

```callout tone=decision
**D8 diffs by reference.** `diff file=x hunks=1,3` pulls hunks from `changes.patch` with real line numbers, and `@line: note` annotates them. Agents pasting excerpts (Agent-Native) lose line numbers and drift from the code.
```

````code lang=md
```diff file=src/retry.ts hunks=2 lines=40-80
```
````

A body line `@52: note` puts a note on new-side line 52 of the shown hunk.

```steps
- { title: "Unified diff parser, mechanical-file heuristics (lockfiles, generated, renames)", area: parser, status: done }
- { title: "doc.md scanner: frontmatter, map, sections, typed fences, attrs", area: parser, status: done }
- { title: "Bundle reader (dir or zip), resolve plan: and link nodes by id", area: parser, status: done }
```

## CLI for authors {#cli}

`recap collect` writes the patch and a scaffold doc; `recap check` lints until the doc is clean; `recap md` renders the PR comment fallback.

```callout tone=decision
**D12 PR fallback.** `recap md` prints headline, risk, ask and the map as Mermaid, so a sticky PR comment is readable without clicking through.
```

```steps
- { title: "collect --base/--head (or --root): patch + scaffold, one node per top-level area", area: cli, status: done }
- { title: "check: map ↔ sections, diff refs, demo files, unknown YAML keys, budgets", area: cli, status: done }
- { title: "md, model, pack/unpack, comments", area: cli, status: done }
```

## Delivery: serve, build, server {#server}

One static viewer, booted from `window.__RECAP__`, delivered three ways: local server, one offline HTML file, or a self-hostable server with unlisted links.

```callout tone=decision
**D9 one viewer, three deliveries.** `recap serve` (127.0.0.1, comments write into the bundle, live reload), `recap build` (single HTML, files inlined as base64, read-only) and `recap server` + `publish` (same API under `/d/<id>`). No hosted-page-plus-localhost bridge as in Agent-Native; hosted is just someone running `server`.
```

```api
endpoints:
  - { method: GET, path: "${api}/doc", change: planned, summary: The parsed Doc model }
  - { method: GET, path: "${api}/files/<path>", change: planned, summary: "One bundle file (demos, assets)" }
  - { method: "GET, POST", path: "${api}/comments", change: planned, summary: "Comments; POST takes {anchor, author, body}" }
  - { method: POST, path: /api/docs, change: planned, summary: "recap server: upload a bundle zip, get an unlisted /d/<id> link" }
```

```steps
- { title: "serve with SSE live reload; build to one HTML; server + publish (zip upload, random ids)", area: server, status: done }
```

## Viewer shell: zoom ladder and focus {#viewer}

A React + Vite single-file app: zoom control and keys `1`-`4`, click a map node to focus its area, blocks for every type, a real Collie Demo player for `demo` blocks.

```callout tone=decision
**D10 real recordings over drawings; D13 React + Vite, Collie UI tokens only.** The `demo` block plays a `.replay` with rrweb-player and seeks to steps; `before-after` can take a demo frame. Collie UI isn't published, so the viewer borrows its CSS variables and themes, not its components.
```

```steps
- { title: "Zoom ladder (levels gate what renders), keys, hash state, keep the reader's place", area: viewer, status: done }
- { title: "Focus mode: one section, its neighbours on a compact map, Esc back", area: viewer, status: done }
- { title: "Blocks: diff with notes, flow (Mermaid), data-model, api, steps, questions, demo, before-after", area: viewer, status: done }
```

## Change map {#map}

The map is required and is the navigation: nodes = areas, coloured by change, edges = calls or data flow; with a linked plan, an overlay marks each node done, not done, deferred or unplanned.

```callout tone=decision
**D5 the map is required; D11 the plan link.** A review's `plan:` points at the plan bundle; nodes match by id, so the agent must reuse the plan's ids for the same components.
```

```steps
- { title: "ELK layered layout, both directions, pick what fits", area: map, status: done }
- { title: "Hover summary, click to focus, vs-plan overlay (key p)", area: map, status: done }
```

## Authoring skill {#skill}

`skill/SKILL.md` teaches an agent to find the big picture first (read the whole unit, name 3-8 areas, isolate the mechanical, order by dependency), then fill each level within budgets.

```steps
- { title: "Skill: ladder rules, block picks, diff and demo how-to, plan rules", area: skill, status: done }
- { title: "Three hand-authored samples by an agent that didn't build the viewer", area: skill, status: done }
```

## Later: accounts, teams, GitHub Action {#later}

Not in the lab: sign-in and teams with visibility beyond unlisted ids, and a GitHub Action that publishes on push and keeps one sticky PR comment current. Also out: agent-feedback events, Agent-Native format compatibility, and maps derived from code (the agent writes the map; `collect` only scaffolds). The shared-server plan (`collie-server.plan`) covers accounts and the Action in detail.
