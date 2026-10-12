---
name: artifact
description: Build an HTML page (React + component kit, one file) for a status, review, plan, explainer or investigation. Only when the user asks for one ("make it a page/visual/artifact") or says yes to your offer. Default is an answer in chat; never start one unasked.
---

# artifact

**Chat first.** Most asks ("give me a status", "summarize the review") want a report in the conversation, not a page. Build an artifact only when asked or when the user accepts an offer. Offer at most once per topic, and only when a page would clearly beat chat (many items, a flow over time, decisions to batch, something to present or share).

An artifact is a directory `x.artifact/`. You write the page; the kit gives you parts (`COMPONENTS.md` next to this file lists them with props); the host adds the feedback layer (comments, decisions, present, download).

**Default: a plain, quiet page.** Most artifacts (review, status, investigation) are one calm column: a clear headline, what you need from the reader up top, then the evidence with each decision beside the proof it depends on. Reach for a rich experience (§ Experiences) only when the content earns it (many peers to explore, a release or launch, something Alex presents) or when asked.

```
x.artifact/
  artifact.json   {"title","kind","audience","summary","sources":[...],"created"}   kind is a free label
  index.tsx       default export = the page (or index.mdx: Markdown + the same components)
  layout.tsx      optional: a Layout that wraps every page and stays mounted (see Pages)
  data/*.json     import prs from "./data/prs.json"   or   useData("prs")
  evidence/       *.patch  *.replay  images  source files: cited by path, inlined at build
```

`artifact.json` also takes `shell` ("page" for new artifacts, "bare", "doc"; see Shell), `tour` (page ids to present in order, see Pages), `asOf` (ISO gather time, shown in the header) with `timeZone` (default UTC), `repo` (a local path: `check` warns about cited commits that are on no remote branch), `width` ("wide"|"full"), `header` ("full"), `host: {"download": false}`, `present` ("artifact" = you run present mode, see COMPONENTS.md). `audience` is shown as written. `summary` is printed large under the title and is slide 1 when presenting: make it your headline and don't restate it in a Callout.

## Commands

Run `artifact <cmd>` (on your PATH after `bin/recap-sync`), else `node <recap-lab>/bin/artifact.js <cmd>`.

```sh
artifact new notes/status-1012 --kind status        # scaffold a calm page; fill summary/audience/sources (check errors on the template text)
artifact dev notes/status-1012.artifact             # live reload on 127.0.0.1:4177 (loopback only; --port N)
artifact check notes/status-1012.artifact           # bundle, types, render, evidence, size; advice (taste warnings)
artifact build notes/status-1012.artifact -o status.html   # one self-contained file
artifact shot notes/status-1012.artifact --theme both --present all   # PNGs in <dir>/.shots/: Read them
artifact capture http://127.0.0.1:5211 -o <dir>/evidence/app.jpg --selector main --wait 800   # screenshot a running app (--steps steps.json; .jpg is ~4x smaller)
artifact record http://127.0.0.1:5211 -o <dir>/evidence/flow.replay --steps 'say:Add a card; click:text=New card; type:#title=Fix login; key:Enter'   # or --script journey.mjs
artifact gather gh-prs <dir> --repos owner/a,owner/b --since ISO   # → data/gh-prs.json; also board --workspaces a,b; git-log --repo p --ref origin/main [--branches 'idea/*' --base main]; trim with --fields / --count
```

Loop: write, `check` until ok, `shot` and look at the PNGs (both themes; `--page id|all`; `--present 2,3|all` 1-based, every step; `--split --height 800` cuts a tall page; `--no-chrome` hides host UI; reduced motion unless `--motion`), fix, build.

## Taste (guidance, not rules)

- **Big picture first.** The top screen carries the point; the sections let the reader check it.
- **Say who it is for**: a stakeholder wants decisions and risk, a reviewer diffs and evidence.
- **Cite where facts come from** (`<Source>`, header `sources`); mark what may be stale (`<Stale>`); never present a guess as status.
- **One claim per picture.** State the takeaway in a sentence above every chart, timeline or map. If a picture needs a legend to explain itself, split it.
- **Keep one time zone** and label it.
- **Don't overload.** Pick the 5 things that matter; skippable detail goes in `<More label="…">` or out. `check` warns about long pages and 20+ row tables outside `<More>`.
- **Decisions are explicit** (`<Decision>` with your recommendation and owner), used when they carry something, not by habit. Ask up top, decide beside the proof: list what you need from the reader near the top (`<DecisionIndex />`, with each recommendation; it has "Accept all recommendations"), put each `<Decision>` in the Section whose evidence it depends on, right after that proof, never batched at the end. A page about one call (a prototype review) opens with the recommendation and its Decision, evidence below. `check` warns when every Decision is in the last Section.
- Prefer real evidence (`<Diff>`, `<Replay>`, screenshots) over describing it; pick hunks, never paste whole patches.
- Use `<Section>` for every part you want in the outline and in present mode (content outside Sections becomes loose "intro" slides); `<Slide id title>` is the same marker with no heading, for your own markup. Readers can fold any Section by clicking its heading. Heavy blocks stay open unless you set `collapsed`.

## Shell: page (default) / bare (you own everything) / doc (old reader chrome)

Every shell has the feedback layer: comments, decisions and answers, the Feedback drawer with copy, Download, shortcuts, present plumbing, behind one faint corner button (bottom-right) with a menu. `artifact new` scaffolds `"shell": "page"`.

- **page**: title, `summary` as the headline, a quiet meta line (kind, as-of or date, "N sources" popover) and one centred reading column (~740 px); Sections get rhythm and a light rule between them. You write only Sections. `<Wide>` around a Grid, Table, Img, Compare or Diff lets it use more width (`width: "wide"` widens the whole column). Pages over 5 Sections get a faint on-this-page list in the right margin on very wide screens. Multi-page: a small page list sits above the title.
- **bare**: a blank full-viewport page, no header, outline or width limit. For experiences (story, sheets, deck, a board) where the layout is the point.
- **doc** (also the default when `shell` is absent): header, outline, grouped page nav, prev/next, page select. Kept for older artifacts.



- Comments work on anything, in every shell: select text and press the Comment button that appears by the selection, or alt-click an element (or `c`, then click). Readers see where a comment is ("Page › Section", then the quoted words or a label like `table cell "3"`, `image: alt`, `Decision: question`); a saved quote is highlighted on its exact words (re-found by quote and context after a reload), hovering a comment in the drawer shows its target, clicking it jumps there, and copied feedback reads `- [Page › Section] on "quoted text": comment`. Give key elements an `id` or `data-aid` so comments survive edits.
- Navigation: `usePages()`, `useRoute()`, `navigate(id, {anchor, params, morph, direction, transition, restore})`, `<Link>`, `<Morph>`, `withTransition(fn, opts)` (COMPONENTS.md). Page changes use a view transition unless reduced motion; name exactly one element pair with `morph`, tell CSS the motion with `direction` / `html[data-nav-type]`.
- Present mode and `<Step>` / `usePresentSteps` still work; Sections and `<Slide>`s (or loose elements) are the slides. To own present mode (a deck, a stage) call `usePresentControl(start)`; `openFeedback()`, `download()`, `startPresent()`, `toggleTheme()` are exported for your own buttons.

## Pages (multi-page artifacts)

Put `pages/<id>.tsx` files next to `index.tsx` (home). Each exports a default component and optionally `export const page = { title, group, order, summary, status, thumb }`. In doc the left nav lists pages by `group` with Previous / Next; in page there is a small list above the title; in bare you build the nav yourself from `usePages()`. Routes are hash links (`#/id`, `#/id/section`, `#/id?k=v`), so it is still one HTML file and Back works. `?k=v` params (`navigate(id, {params})`, `useRoute().params`) are state the host never scrolls to: use them for an open sheet, a filter, a tab. Put `<PageCards />` on the home page and link with `<Link to="id#section">`. Comments and decisions work across pages (grouped by page in the drawer), and `"tour": ["home", "a", "b"]` in artifact.json adds a Tour button that presents all of them in order. `check` renders every page; `shot --page id|all`.

- **Many pages from data:** one file `pages/[id].tsx` with `export const pages = (data) => data.items.map((i) => ({id: i.id, title: i.title, group, order, ...anything}))` (or a plain array) renders one route per entry; the component gets `{id, page}` (`PageProps`). `usePages`, tour, check, `shot --page all` and feedback see every route. Ids must be unique (`check` fails on a clash).
- **Persistent frame:** `layout.tsx` (default export, or `export const Layout` in index.tsx) wraps every page and stays mounted across routes, so a deck frame, rail or overlay keeps its state. Mark fixed UI inside it `data-chrome` so present mode does not treat it as a slide.
- **Scroll:** a new page starts at the top; Back (or `navigate(id, {restore: true})`) puts the page's scroll position back, after the host's own scrolling and while late layout settles.

**Use pages** for several items or journeys, different audiences, or anything over about 3 screens with natural parts (a page per round or journey). **Stay on one page** for one story that reads top to bottom.

## Evidence

Reference files by string literal: `evidence/x.patch` (git diff output), `x.replay` (Collie Demo), `x.png`, source files for `<Code>`. The build inlines what you reference (patches parsed, replays slimmed, images as data URIs); `import shot from "./evidence/x.png"` also works. Paths must stay inside `evidence/` (no `..`, no symlinks out). Only string literals starting at `evidence/` count (or a whole-string value in `data/*.json`); `` `evidence/${id}.jpg` `` is a glob over the files there. Missing evidence fails the build; `check` warns about unused files. Text props (`Decision why`, question strings) are plain text: use nodes for `<code>`.

## Recordings

A recording beats a screenshot for anything that moves or has a before/after (drag, undo, a flow). Clips 10-40 s, one flow each, `say:"…"` = a chapter (say what to watch for); ~25-60 KB.

- `artifact record <url|file> -o evidence/x.replay --steps '…'`: `say:t; click:<css|text=…|button name>; type:<sel>=<text>; key:Enter; go:<url>; wait:<ms|sel>; hover:; scroll:<px>; drag:<a>-><b>; pause:<ms>` (`;` or newline; or a capture-style JSON array). `--script j.mjs` for real flows: `export default async ({page, say, click, type, go, pause, key, drag, …}) => {}` (run a CLI with `execFile`, `await pause()` to watch it). Options: `--width/--height`, `--theme dark`, `--max` s (90), `--no-network/--no-console`, `--fast`. Record the running app, not a page of screenshots.
- `<Replay src steps={[2,3]} loop/>`: first frame + play, chapters (click to seek), decoded only when scrolled near; `loop` = silent autoplay clip; in present mode one step plays it.
- Passwords are masked, nothing else is redacted: check before sharing. `check` warns over 300 KB.

## Custom components and CSS

Write components inline or next to `index.tsx`; `import "./mine.css"` bundles a stylesheet. Use tokens so both themes work: `var(--collie-color-fg|fg-muted|canvas|surface|border-subtle|accent-subtle|success-subtle|…)`, `--a-card`, `--a-line`, `--a-muted`, `--a-radius`, `--collie-space-*`. Present-mode hooks: COMPONENTS.md.

## Experiences (when the content earns one)

Use `"shell": "bare"`. The four release samples are patterns that mix (a story can open sheets, a map can become a deck): read the sample, copy what you need.

- **Zoom map** (`samples/release-zoom.artifact`): many peers to explore. `pages/[id].tsx` from data, tiles are `<Morph when={false}>`, `navigate(id, {morph, transition: "zoom-in"})` and back with `direction: "back"`, `useRoute().previous` lights the tile you came from.
- **Story** (`samples/release-story.artifact`): a narrative with demos. One scrolling page, `<Slide>` per chapter, `usePresentSteps` for beats, `navigate(..., {restore: true})` back from a deep-dive page.
- **Sheets** (`samples/release-launch.artifact`): a launch or catalog. A bento of cards; `?sheet=<id>` param opens a full-screen sheet, `data-morph` on card and sheet, `<NoSteps>` around live previews, `usePresentSteps().current` to step sheets in present mode.
- **Deck** (`samples/release-deck.artifact`): something Alex presents. `layout.tsx` frame, one page per slide from `pages/[id].tsx`, `withTransition` with `direction`, `usePresentControl` + `"present": "artifact"` so `p` runs the deck.

## Three shapes (examples, not templates)

**Status:** `summary` as the one-line state → `<Stats>` → `<DecisionIndex />` (what needs the reader, with recommendations) → Cards with `<Status>` per workstream → Table of `<PR>`s, each `<Decision>` in the Section whose proof it rests on → `<Stale>` for unverified claims.
**Review walk-through:** verdict + risk → `<DecisionIndex />` or `<Questions>` up top → `<Map>` of what changed → a Section per area (two sentences, then `<Diff file hunks notes>` or `<Replay steps>`, then that area's `<Decision>`).
**Investigation / explainer:** headline → `<TimeAxis>` or `<Map>` → `<Walkthrough>` of one case → `<Compare>` variants → `<Code ranges>` → `<Source>`s.

## Decision walk (async grill)

For a batch of decisions when the reader is away from chat: prepare the tree (each `<Decision>` with `id`, options, your `recommend`, `why`; follow-ups inside `<When>`), put `<DecisionIndex />` at the top (its "Accept all recommendations" answers every open visible one; each stays editable), and let the reader walk it (present mode works and ends on a generated Summary slide). The Feedback drawer shows progress ("3/5 decided"); **Copy decisions** (or **Copy all feedback**, with comments) gives Markdown with each id, the chosen option and key, whether it was the recommended one, and the note: one paste back to you, applied by id. Only decisions on visible branches are listed. 

## What the reader has

Doc shell: outline (toggle for full width). Every shell: theme, **Present** (`p`: title slide, then → / ← through Sections and `<Step>`s, ↑/↓ scroll, `#links` jump between slides, a Summary slide when there are decisions), **Feedback** drawer (`c` adds a comment on any element; decisions tab; copy as Markdown with element ids), **Download** (the same single HTML file), `?` for shortcuts and fold all.

## Limits

The built file runs your code: fine to open, don't host it for others yet. Output over 5 MB warns, over 25 MB refuses. `check` can't catch errors that occur only in effects: look at `shot` once.
