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

Run the CLI as `artifact <cmd>` when it is on your PATH (`bin/recap-sync` links it), else `node <recap-lab>/bin/artifact.js <cmd>`. Examples with `artifact`:

```sh
artifact new notes/status-1012 --kind status   # scaffold with a small example
artifact dev notes/status-1012.artifact        # live reload at http://127.0.0.1:4177 (loopback only; use your own proxy/forward to view elsewhere; --port N)
artifact check notes/status-1012.artifact      # errors: bundle, types, render, missing evidence, size
artifact build notes/status-1012.artifact -o status.html   # one file, share it
artifact capture http://127.0.0.1:5211 -o notes/status-1012.artifact/evidence/app.jpg --selector main --wait 800   # screenshot a running app (--steps steps.json for click/fill/press; .jpg is ~4x smaller than .png)
artifact gather gh-prs notes/status-1012.artifact --repos owner/a,owner/b --since "2026-10-11T00:00:00Z"   # → data/gh-prs.json; also: board --workspaces dirA,dirB; git-log --repo path --ref origin/main --since "24 hours ago" (or --branches 'idea/*' --base main: unique commits per branch); trim with --fields n,title,state or --count
artifact shot notes/status-1012.artifact --theme both --present all   # PNGs in <dir>/.shots/: Read them to see your page
```

Run `check` until it says ok, then `shot` and look at the PNGs (both themes; `--present 2,3|all` (1-based, same as the file numbers) for slides and steps; `--split [--height 800]` cuts a tall page into readable PNGs (`-s1`, `-s2` suffixes); `--no-chrome` hides the host bar). `artifact.json` also takes `"depth": 2` (**the page opens at that level**: set it for any long page and put detail in `<Depth level={3|4}>`), `"asOf"` (ISO gather time, shown in the header with `"timeZone"`, default UTC), `"repo"` (a local path; `check` then warns about cited commits not on any remote branch) and `"header": "full"`. `audience` is shown as you write it. `summary` is printed large under the title and is slide 1 when presenting: make it your headline, and don't restate it in a Callout (`check` warns). `index.tsx` may define its own components; `import { ... } from "artifact"` for the kit.

## Taste (guidance, not rules)

The host header and `<Decision>` cards are options, not the default shape: use them when they carry something (a decision that needs an owner), not by habit. `check` also warns (advice only) about long pages, 20+ row tables outside Depth, and present slides empty at step 0.

- **Big picture first.** A reader should get the point from the top screen: one callout or sentence of conclusion, then the sections that let them check it.
- **Say who it is for** (`audience`) and write to them. A stakeholder wants decisions and risk; a reviewer wants diffs and evidence.
- **Cite where facts come from** (`<Source>`, header `sources`). Mark what may be out of date (`<Stale>`). Never present a guess as status.
- **Decisions are explicit**: `<Decision>`/`<Questions>`, with your recommendation and who has to decide.
- **One claim per picture.** State the takeaway in a sentence above every chart, timeline or map. If a picture needs a legend to explain itself, split it (a release strip plus a short time axis beat one overloaded timeline).
- **Keep one time zone** and label it ("15:30 UTC"); don't mix UTC and local.
- **Don't overload.** Pick the 5 things that matter; put the rest in `<Depth level={4}>` or leave it out. One map beats three tables.
- Use `<Section>` for every part you want in the outline and in present mode; content outside Sections becomes loose "intro" slides.
- Prefer real evidence (`<Diff>`, `<Replay>`, screenshots) over describing it. Pick hunks; do not paste whole patches.

## Kit (all from "artifact")

Layout: `<Page width="wide">` `<Section id? title lead?>` (nest for subsections) `<Stack row gap>` `<Grid cols={3} | min="16rem">` `<Card title aside tone href footer>` `<CardGrid items={[{title, body, status, href}]}/>` `<Lanes lanes={[{title, children}]}/>` `<Tabs><Tab label="A">…</Tab></Tabs>` `<Callout tone="info|success|warn|critical" title>`. `<Page width="wide|full">` (or `"width"` in artifact.json) widens the page.

Status and facts: `<Badge tone>` `<Status s="ok|done|merged|warn|risk|stale|blocked|failed|todo|open|planned|doing|review|info">label?</Status>` or your own word `s={{label:"fix first", tone:"warn"}}` (also Gallery `status`, CardGrid, Timeline) `<PR n={42} title state="open|draft|merged|closed" checks="pass|fail|pending" stack={[2,3]} href conflict updatedAt="ISO" asOf="gather time" review="approved|changes" />` (also inside Table cells) `<Stale says="3 open" now="1 open" asOf="Oct 12" />` `<Source label href kind="pr|thread|commit|file|doc" from="provenance, shown as \"via …\"" inline />` (`inline` = small dotted link for table cells) `<Ago iso asOf />` `<Time iso />` (absolute, in artifact.json `timeZone`)

Reading flow: `<Steps items={[{title, body, status}]}/>` `<Questions items={["q" | {q, why, options, owner}]}/>` `<Decision source="lead synthesis" id="d1" question options={[{label, note}]} recommend={0} owner="Alex" why />` (**the reader can answer it**: pick an option (keys a, b, c… or `key`), write their own, or "not sure / discuss", plus a note; `id` is a real anchor and the answer key; `<DecisionIndex />` lists decisions with answers; an open question with a lean = Decision, not Questions) `<When decision="d1" is="a|label|other|unsure" not answered unanswered>…</When>` shows content by answer (follow-up Decisions inside = a decision tree); `useAnswers()` reads them `<Checklist items={["x" | {text, done, note, status}]}/>` `<Actions items={[{title, why, effort, rec, owner, tone, status, sources:[{label,href}]}]}/>` ranked do-first list; `<Facts items={[["main","ok"]]}/>` key/value rows; `<Scorecard options rows={[{name, weight, cells:[{grade:"best|ok|weak|bad|na", text}]}]} recommend={0} verdict={[…]}/>` (alias `Matrix`); `<RiskMatrix risks={[{id,title,like:"low|med|high",impact,mitigation}]}/>` grid + table, chips link to rows; `<TimeAxis events={[{at, to?, label, lane?, tone?}]} bands={[{from, to, label, tone}]} segments={[{from, to, weight, label}]} />` a real time axis for investigations (dots, bars, shaded periods; `segments` break the axis so 6 weeks then 36 hours both read, each with its own scale; zone = artifact.json `timeZone`). `<Stages stages={[{title, sub, tone}]} rows={[{label, cells:[…]}]} />` (alias `Progression`) a few releases/phases as columns with the same rows across. `<Timeline items={[{when, title, body, status, lane?}]}/>` (with `lane`: swimlane grid, one column per actor/agent, items with the same `when` share a row; `bucket="hour"|"10min"|"day"|minutes` groups ISO times, `group` names a row, `compact` pulls rows up when lanes don't collide)

Data: `<Table columns={["name", {key:"state", label, render:(v,row)=>…, align, sort}]} rows={rows} />` (sortable; a row field `href` links the first cell) `<Chart data={[{label, value, tone}]} kind="bar|line" unit />` or `series={[{name, points}]}` `<Compare items={[{label, src:"evidence/a.png", node?, caption}]} caption/>` `<Gallery items=…/>`: variants `{label, src|node, aside, caption}` one at a time; or tiles `{label, thumb, status, summary, badges, detail}` (`layout="tiles"`): a card grid, click opens `detail` below (Tabs, Diff, Img inside are fine). Arrow keys move; each item is a present step. `<Stats items={[{value, label, tone, href, sub}]}/>` headline numbers `<Img src="evidence/x.png" caption fit="cover|contain" height thumb zoom={false} />` (click any Img/Compare image for a lightbox; `imageSrc(path)` gives the data URI for your own `<img>`/CSS)

Technical:
- `<Map nodes={[{id,label,group?,state?,note?,href?}]} edges={[{from,to,label?}]} groups={[{id,label}]} />` boxes and arrows laid out for you; scales to fit its column (Fit / 100% / + / − and drag to pan; also in present mode); click a node to focus it and its neighbours; node `section="id"` adds a "go to section" link. `state` colours (ok, done, warn, blocked, todo, new, changed…). About 10 nodes reads well (`check` warns when a map would be drawn under 65%); costs 1.5 MB (ELK).
- `<Diff patch="evidence/x.patch" file="src/a.ts" hunks="1,3" notes={{12: "why"}} />` parsed at build; only requested files are inlined. Give `file` as a string literal so pruning works.
- `<Code file="evidence/a.ts" ranges="1-10,40-52" highlight="4" notes={{4:"why", "const x =":"or by text"}} path="src/a.ts" href="https://…" />` or `code={str}` / string child; several ranges with gaps marked.
- `<Replay src="evidence/x.replay" steps={[2,3]} caption />` Collie Demo recording with clickable steps. Adds ~120 KB.
- `<Flow chart={"sequenceDiagram\n…"} />` Mermaid (sequence, flow, state, ER, gantt, pie). Adds ~3 MB: prefer `<Map>` for boxes and arrows, use Flow for sequence diagrams.

Opt-in: `<Depth level={1..4}>` (**1 = the headline, 2 = what the reader checks, 3 = supporting detail, 4 = everything/evidence**; `"depth": N` shows levels ≤ N and all unmarked content) content shown by the reader's 1–4 keys (1 = headline … 4 = detail; unmarked content always shows). `<Step>` marks reveal one by one in present mode; a custom component registers its own with `const {step, markers} = usePresentSteps(n)` (render `markers` once; `step` is 0..n, n when not presenting) (the newest scrolls into view). `useData("name")` reads data/name.json. Custom components can follow present mode with `usePresent()` (`{active, slide, step, steps}`) or `usePresentStep()` (-1 when not presenting).

## Decision walk (async grill)

For a batch of decisions when the reader is away from chat: prepare the tree (each `<Decision>` with `id`, options, your `recommend`, `why`; follow-ups inside `<When>`), put `<DecisionIndex />` at the top, and let the reader walk it (present mode works, and ends on a generated Summary slide). The drawer's Decisions tab shows progress ("3/5 decided"); **Copy decisions** (or **Copy all feedback** with comments) gives Markdown with each id, the chosen option and its key, whether it was the recommended one, and the note: one paste back to you. Apply it by id. Only decisions on the visible branches are listed. For quick back-and-forth, grill in chat instead.

## Custom components and CSS

In present mode, unmarked content shows first and `<Step>` content after it, so wrap a trailing unmarked block in a `<Step>` too if it should come last.

Write components inline in index.tsx or next to it. `import "./mine.css"` bundles a local stylesheet into the page; use the tokens so both themes work: `var(--collie-color-fg|fg-muted|canvas|surface|border-subtle|accent-subtle|success-subtle|…)`, `--a-card`, `--a-line`, `--a-muted`, `--a-radius`, `--collie-space-*`. Source files you cite (`evidence/*.ts`) are not typechecked.

## Evidence

Reference files by string literal, `evidence/x.patch` (git diff output), `evidence/x.replay` (Collie Demo), `evidence/x.png`, source files for `<Code>`. The build inlines what you reference, parses patches (the raw patch is not in the output), re-zips replays without trace.zip, and turns images into data URIs. `import shot from "./evidence/x.png"` also works. Evidence paths must stay inside `evidence/` (no `..`, no symlinks out). Only string literals starting at `evidence/` count as references (`"evidence/x.png"`, or a whole-string value in `data/*.json`). A template literal like `` `evidence/${id}.jpg` `` is a glob over the files in evidence/ (all matches inlined; no match is an error). Text props (`Decision why`, question strings) are plain text: use nodes for `<code>`. Build fails on missing evidence; `check` warns about unused files. Recordings are not redacted: check for secrets before sharing.

## Three shapes (examples, not templates)

**Status dashboard**: `summary` as the one-line state → `<Stats>` → Cards with `<Status>` per workstream → Table of `<PR>`s → `<Decision>`s that need someone → `<Stale>` for claims you could not verify.

**Review walk-through**: verdict + risk → `<Map>` of what changed → one Section per area: two sentences, then `<Diff file hunks notes>` or `<Replay steps>` → `<Questions>`.

**Explainer**: headline → `<Map>` of the parts → Steps for the main path → `<Compare>` variants → `<Code ranges>` for the lines that matter → `<Source>`s to read next.

## Host features the reader has

Outline (toggle it off for full width), theme toggle, **Present** (`p`: title slide, then → / ← through Sections and `<Step>`s; ↑/↓ scroll; `#links` jump between slides), **Comments** drawer (`c` or the bar button: Add comment, click any element; list with jump-to; Copy feedback = Markdown with element ids to paste back to you; Clear all), **Download** (the same single HTML file; `"host": {"download": false}` in artifact.json hides it), `?` lists shortcuts, Depth keys 1–4 if you used `<Depth>`.

## Limits

The built file runs your code: fine for a file the reader opens; do not host it for others yet. Output over 5 MB warns, over 25 MB refuses. Server-side `check` render cannot catch errors that only happen in effects: look at `dev` once.
