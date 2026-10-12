---
name: artifact
description: Make an artifact: a page that shows what you did, found or propose (status, review, plan, explainer, postmortem), written as React with a component kit and built into one HTML file. Use when a person needs to read or decide something technical and prose in chat is not enough.
---

# artifact

An artifact is a directory `x.artifact/`. You write the page; the kit gives you parts; the host (outline, present mode, comments) wraps it for you. You pick the structure: nothing here is a required shape.

```
x.artifact/
  artifact.json   {"title","kind","audience","summary","sources":[...],"created"}   kind is a free label
  index.tsx       default export = the page (or index.mdx: Markdown + the same components)
  data/*.json     import prs from "./data/prs.json"   or   useData("prs")
  evidence/       *.patch  *.replay  images  source files: cited by path, inlined at build
```

```sh
artifact new notes/status-1012 --kind status   # scaffold with a small example
artifact dev notes/status-1012.artifact        # live reload on 127.0.0.1:4177 (Mini: http://mini.internal:4177)
artifact check notes/status-1012.artifact      # errors: bundle, types, render, missing evidence, size
artifact build notes/status-1012.artifact -o status.html   # one file, share it
```

Run `check` until it says ok; look at it once in `dev` (both themes, press `p` to present). `index.tsx` may define its own components; `import { ... } from "artifact"` for the kit.

## Taste (guidance, not rules)

- **Big picture first.** A reader should get the point from the top screen: one callout or sentence of conclusion, then the sections that let them check it.
- **Say who it is for** (`audience`) and write to them. A stakeholder wants decisions and risk; a reviewer wants diffs and evidence.
- **Cite where facts come from** (`<Source>`, header `sources`). Mark what may be out of date (`<Stale>`). Never present a guess as status.
- **Decisions are explicit**: `<Decision>`/`<Questions>`, with your recommendation and who has to decide.
- **Don't overload.** Pick the 5 things that matter; put the rest in `<Depth level={4}>` or leave it out. One map beats three tables.
- Use `<Section>` for every part you want in the outline and in present mode; content outside Sections becomes loose "intro" slides.
- Prefer real evidence (`<Diff>`, `<Replay>`, screenshots) over describing it. Pick hunks; do not paste whole patches.

## Kit (all from "artifact")

Layout: `<Page width="wide">` `<Section id? title lead?>` (nest for subsections) `<Stack row gap>` `<Grid cols={3} | min="16rem">` `<Card title aside tone href footer>` `<CardGrid items={[{title, body, status, href}]}/>` `<Lanes lanes={[{title, children}]}/>` `<Tabs><Tab label="A">…</Tab></Tabs>` `<Callout tone="info|success|warn|critical" title>`

Status and facts: `<Badge tone>` `<Status s="ok|done|merged|warn|risk|stale|blocked|failed|todo|open|planned|doing|review|info">label?</Status>` `<PR n={42} title state="open|draft|merged|closed" checks="pass|fail|pending" stack={[2,3]} href />` (also inside Table cells) `<Stale says="3 open" now="1 open" asOf="Oct 12" />` `<Source label href kind="pr|thread|commit|file|doc" from="where it came from" />`

Reading flow: `<Steps items={[{title, body, status}]}/>` `<Questions items={["q" | {q, why, options, owner}]}/>` `<Decision question options={[{label, note}]} recommend={0} owner="Alex" why />` `<Checklist items={["x" | {text, done, note, status}]}/>` `<Timeline items={[{when, title, body, status, lane?}]}/>` (give items a `lane` for one column per actor/agent)

Data: `<Table columns={["name", {key:"state", label, render:(v,row)=>…, align, sort}]} rows={rows} />` (sortable; a row field `href` links the first cell) `<Chart data={[{label, value}]} kind="bar|line" unit />` or `series={[{name, points}]}` `<Compare items={[{label, src:"evidence/a.png", node?, caption}]}/>` `<Img src="evidence/x.png" caption />`

Technical:
- `<Map nodes={[{id,label,group?,state?,note?,href?}]} edges={[{from,to,label?}]} groups={[{id,label}]} />` boxes and arrows laid out for you; click a node to focus it and its neighbours. `state` colours (ok, done, warn, blocked, todo, new, changed…). Up to ~12 nodes reads well.
- `<Diff patch="evidence/x.patch" file="src/a.ts" hunks="1,3" notes={{12: "why"}} />` parsed at build; only requested files are inlined. Give `file` as a string literal so pruning works.
- `<Code file="evidence/a.ts" ranges="1-10,40-52" highlight="4" title />` or `code={str}` / string child; several ranges with gaps marked.
- `<Replay src="evidence/x.replay" steps={[2,3]} caption />` Collie Demo recording with clickable steps. Adds ~120 KB.
- `<Flow chart={"sequenceDiagram\n…"} />` Mermaid (sequence, flow, state, ER, gantt, pie). Adds ~3 MB: prefer `<Map>` for boxes and arrows, use Flow for sequence diagrams.

Opt-in: `<Depth level={1..4}>` content shown by the reader's 1–4 keys (1 = headline … 4 = detail; unmarked content always shows). `<Step>` marks reveal one by one in present mode. `useData("name")` reads data/name.json.

## Evidence

Reference files by string literal, `evidence/x.patch` (git diff output), `evidence/x.replay` (Collie Demo), `evidence/x.png`, source files for `<Code>`. The build inlines what you reference, parses patches (the raw patch is not in the output), re-zips replays without trace.zip, and turns images into data URIs. `import shot from "./evidence/x.png"` also works. Build fails on missing evidence; `check` warns about unused files. Recordings are not redacted: check for secrets before sharing.

## Three shapes (examples, not templates)

**Status dashboard** (several sources, "where are we"): Callout with the one-line state → Grid of Cards with `<Status>` per workstream → Table of PRs (`<PR>` cells) → `<Decision>`s that need someone → Sources and `<Stale>` for claims you could not verify.

**Review walk-through** (after a change): Callout with verdict + risk → `<Map>` of what changed (state=new/changed) → one Section per area: two sentences, then `<Diff file hunks notes>` or `<Replay steps>` → `<Questions>` for the reviewer.

**Explainer** (how X works): headline sentence → `<Flow>` or `<Map>` of the parts → Steps for the main path → `<Compare>` before/after or variants → `<Code ranges>` for the 2–3 lines that matter → what to read next (`<Source>`).

## Host features the reader has

Outline (from Sections), theme toggle, **Present** (`p`: → / ← step through Sections and `<Step>`s), **Comment** (`c`, click any element; stored in the reader's browser) then **Copy feedback** (Markdown with element ids: paste it back to you), Depth keys when you used `<Depth>`.

## Limits

The built file runs your code: fine for a file the reader opens; do not host it for others yet. Output over 5 MB warns, over 25 MB refuses. Server-side `check` render cannot catch errors that only happen in effects: look at `dev` once.
