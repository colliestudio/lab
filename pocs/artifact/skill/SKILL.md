---
name: visual-review
description: Author a visual review (`.review`, after a change) or plan (`.plan`, before one) in the collie-doc/0 format - headline, change map, per-area sections, key annotated diffs, embedded Collie Demo recordings. Use for "review/recap this PR/branch", "visual plan for X", or before handing a multi-area change to a reviewer.
---

# Visual reviews and plans

A doc is a bundle dir `name.review/` or `name.plan/`: `doc.md` (source), `changes.patch`, `assets/`, `demos/*.replay`, `comments.json`. Format: `SPEC.md`; model: `src/model.ts`. The reader starts at the headline and zooms in only where they care, so **every level must work on its own**.

## When

- **Review:** a work unit (PR, branch, commit range) touching several areas, a schema/API/format, a flow, or visible behaviour. **Skip** when the diff fits in one sentence, is one file, or is purely mechanical (bump, rename, format): say so and link the diff.
- **Plan:** before multi-area or hard-to-reverse work (data shape, wire format, public ids, auth boundary). Skip trivial, unambiguous work.

## Big picture first (before writing anything)

1. **Read the whole work unit once**, in order: every commit in range, not just the last; leave out unrelated dirty work. Take notes as you go; don't re-read.
2. **Name 3-8 areas** by intent/component (what a reviewer would call it), not by directory.
3. **Isolate the mechanical**: lockfiles, generated output, renames, formatting, dependency bumps → one `{#mechanical .mechanical}` section, last.
4. **Order by dependency**: contracts and data shapes first, then producers, then consumers, UI last. Ask "what must I understand first?".
5. **Test with the tl;dr**: if one sentence can't say what changed and why, the areas are wrong.

## The ladder: what goes where

| level | contains | rules |
|---|---|---|
| 0 Headline | frontmatter `title`, `tldr`, `risk` + `risk_why`, `ask`; `questions` (put them in the overview) | tl;dr = one sentence, the outcome, not the activity ("Failed deliveries retry with backoff", not "This PR adds…"). `risk_why` = what breaks if this is wrong. `ask` = what you need from the reader. |
| 1 Map | one ` ```map `, then the overview: 2-4 sentences, plus whole-change blocks (`questions`, a `flow` or `callout` that spans areas) | one node per area + `unchanged` context nodes (1 hop) that explain the shape; edges = calls / data flow, verb labels |
| 2 Areas | `## Title {#id}` per area: summary paragraph, then visual blocks | summary = 1-2 sentences, readable alone (it is the map hover) |
| 3 Code | `files`, `diff`, `code` | only the hunks that carry the decisions |

## Writing rules

- Budgets: **≤12 map nodes, ≤8 sections, diff blocks ≤150 lines, 3-8 key hunks** in the whole doc. Over budget = you haven't found the big picture yet.
- No boilerplate: no "this review covers", no file counts (stats come from the patch), no restating code in prose, no closing summary.
- Ground everything: diffs by reference into `changes.patch` (never retype code); entities, fields and endpoints from the real code; label anything inferred "inferred".
- Real findings (bugs, risks, leftovers) go in a `callout tone=risk|warn` in the section where they live. Decisions the reader must take go in one `questions` block in the overview (between the map and the first section), so they're read before the details.
- Node and section ids: short kebab names of the **component**, not the change (`retry-scheduler`, not `add-retries`). Plan and review share them.
- Redact secrets in prose, patches and recordings.
- YAML trap: inside `{ … }` / `[ … ]` a comma ends the value, and `: ` starts a key anywhere. Quote any label, note or list item containing `, ` or `: ` (`label: "Player (tabs, waterfall)"`). `recap check` fails on the resulting unknown keys and names them.

## Pick the block per area

| the area changes… | use |
|---|---|
| a call path, async sequence, who-talks-to-whom | `flow` (Mermaid `sequenceDiagram`/`flowchart`, ≤10 nodes) |
| a lifecycle / status field | `flow` with `stateDiagram-v2` |
| a schema, file format, payload shape | `data-model`, `change` per field |
| an HTTP/RPC/CLI contract | `api` |
| behaviour a user or operator can see (UI **or** backend) | `demo` (a real recording) > `before-after` (screenshots / replay frames) > prose. Never draw UI you could record. |
| how to verify | `checklist` of commands that actually run |

One diagram per area at most. A section with only prose + diff is fine for small areas.

## Diffs (level 3)

- `` ```diff file=src/x.ts hunks=2,4 `` with body lines `@<newLine>: note`. Hunks are numbered per file from 1; note lines are new-side numbers and must fall on a shown line.
- `lines=163-199` (or `lines=18,163-199`) cuts the shown hunks to new-side line ranges, alone or after `hunks=`. A new file is one hunk: over 150 lines, show the part that matters with `lines=` instead of excerpting by hand.
- Notes say **why / what to check**, not what the line does. 1-4 per hunk. They work on inline (pasted) diffs too.
- Plain code without diff markers: `` ```code file=src/x.ts lines=40-80 `` with an empty body pulls those lines from the patch's new side (real line numbers); `@<line>: note` lines annotate it. For sketches (plans), write the body and set `start=N` if the line numbers matter.
- One `files` block per section (`{path: note}`) for the area's footprint; notes only where the path doesn't say it.

## Demos (Collie Demo `.replay`)

- Prefer a recording of the actual change over any drawing. Record the journey that exercises it (lab today: `node run.js --journey <name> [--otel]`; later `demo run`), drop `trace.zip` from the zip (95% of the size), copy to `demos/`.
- Backend change → `http`-stage journey (API calls, webhooks, DB rows, spans are the show).
- `` ```demo `` YAML: `src`, `steps` (1-based, as numbered in the recording's step list; the ones that show this area), `caption` (what to watch for). `before-after` `step` is 1-based too.
- Check the recording for secrets before sharing; the recorder doesn't redact yet.
- Before/after: record the same journey on base and head; `before-after` with `{demo, step}` on each side.

## Plans

- `kind: plan`, `status: proposed`; `goal` = the outcome in one sentence (stands in for `tldr`; add a `tldr` only if the plan's summary differs from the goal); `ask` = which decisions you need.
- Map: new components `planned`, touched ones `changed`, neighbours `unchanged`, work explicitly left for later `deferred` (pointing at the "Later" section). Deferred nodes never count as "not done" when the review links the plan.
- Per area: approach, `steps` (with `area`), sketches (`code`, `api`, `data-model`).
- **Decide the hard-to-reverse bets in the plan** (ids, wire format, auth boundary, storage layout); defer the rest explicitly in a "Later" section with `deferred` nodes.
- One `questions` block in the overview with every open decision: `options`, `recommend`, `why`. Don't ask what you can find out from the code.
- Standalone: no "revised", "unlike before"; a reader who missed the chat must follow it.
- **Linkage:** the review sets `plan: ../x.plan` (or URL) and reuses the plan's node ids for the same components; the viewer then marks planned & done / planned, not done / unplanned. New component → new id; same component redesigned → keep the id.

## Workflow

1. `recap collect --base <base> [--head HEAD] -o x.review` → `changes.patch` + a scaffold `doc.md`. A whole repo or a first commit: `--root` (diff against the empty tree, `base: (empty)`).
2. **Rewrite** `doc.md` (the scaffold is a file dump, not a review): areas, map, sections, picks.
3. `recap check x.review` until clean (map ↔ sections, diff refs, demo files, budgets, one-sentence tl;dr).
4. `recap serve x.review` and **look** at each zoom level: does L0 alone tell the story, does the map explain the system, does each node open the right section, do notes sit on the right lines? One fix pass.
5. Share: `recap build x.review -o x.html` (one offline file), `recap publish x.review --to <url>` (unlisted link), `recap md x.review` (PR comment: headline + map + link).
6. Report the path or link and the tl;dr. Nothing else.

## Comments and updates

- `recap comments x.review` → edit `doc.md` → `recap check` → resolve the comment. Answer in the doc, not in a reply thread; the doc stays standalone.
- New commits on the same work unit: re-collect, keep the scope = the whole unit, keep node and section ids so comments and plan links still anchor.
