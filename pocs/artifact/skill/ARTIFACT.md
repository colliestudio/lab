---
name: artifact
description: Make an artifact: a page that shows what you did, found or propose (status, review, plan, explainer, investigation, decision walk), written as React with a component kit and built into one HTML file. Use when a person needs to read or decide something technical and prose in chat is not enough.
---

# artifact

An artifact is a directory `x.artifact/`. You write the page; the kit gives you parts (`skill/COMPONENTS.md` lists them with props); the host (outline, present mode, feedback drawer) wraps it. You pick the structure: nothing here is a required shape.

```
x.artifact/
  artifact.json   {"title","kind","audience","summary","sources":[...],"created"}   kind is a free label
  index.tsx       default export = the page (or index.mdx: Markdown + the same components)
  data/*.json     import prs from "./data/prs.json"   or   useData("prs")
  evidence/       *.patch  *.replay  images  source files: cited by path, inlined at build
```

`artifact.json` also takes `asOf` (ISO gather time, shown in the header) with `timeZone` (default UTC), `repo` (a local path: `check` warns about cited commits that are on no remote branch), `width` ("wide"|"full"), `header` ("full"), `host: {"download": false}`. `audience` is shown as written. `summary` is printed large under the title and is slide 1 when presenting: make it your headline and don't restate it in a Callout.

## Commands

Run `artifact <cmd>` (on your PATH after `bin/recap-sync`), else `node <recap-lab>/bin/artifact.js <cmd>`.

```sh
artifact new notes/status-1012 --kind status        # scaffold with a small example
artifact dev notes/status-1012.artifact             # live reload on 127.0.0.1:4177 (loopback only; --port N)
artifact check notes/status-1012.artifact           # bundle, types, render, evidence, size; advice (taste warnings)
artifact build notes/status-1012.artifact -o status.html   # one self-contained file
artifact shot notes/status-1012.artifact --theme both --present all   # PNGs in <dir>/.shots/: Read them
artifact capture http://127.0.0.1:5211 -o <dir>/evidence/app.jpg --selector main --wait 800   # screenshot a running app (--steps steps.json; .jpg is ~4x smaller)
artifact gather gh-prs <dir> --repos owner/a,owner/b --since ISO   # → data/gh-prs.json; also board --workspaces a,b; git-log --repo p --ref origin/main [--branches 'idea/*' --base main]; trim with --fields / --count
```

Loop: write, `check` until ok, `shot` and look at the PNGs (both themes; `--present 2,3|all` is 1-based like the file numbers and shoots every step; `--split --height 800` cuts a tall page; `--no-chrome` hides the host bar), fix, build.

## Taste (guidance, not rules)

- **Big picture first.** The top screen carries the point; the sections let the reader check it.
- **Say who it is for** and write to them: a stakeholder wants decisions and risk, a reviewer wants diffs and evidence.
- **Cite where facts come from** (`<Source>`, header `sources`); mark what may be stale (`<Stale>`); never present a guess as status.
- **One claim per picture.** State the takeaway in a sentence above every chart, timeline or map. If a picture needs a legend to explain itself, split it.
- **Keep one time zone** and label it.
- **Don't overload.** Pick the 5 things that matter; put skippable detail in `<More label="…">` or leave it out. One map beats three tables. `check` warns about long pages and 20+ row tables outside `<More>`.
- **Decisions are explicit** (`<Decision>` with your recommendation and owner), used when they carry something, not by habit. The host header is optional too.
- Prefer real evidence (`<Diff>`, `<Replay>`, screenshots) over describing it; pick hunks, never paste whole patches.
- Use `<Section>` for every part you want in the outline and in present mode (content outside Sections becomes loose "intro" slides). Readers can fold any Section by clicking its heading; Fold all / Unfold all are in the "?" panel. Heavy blocks stay open unless you set `collapsed`.

## Evidence

Reference files by string literal: `evidence/x.patch` (git diff output), `x.replay` (Collie Demo), `x.png`, source files for `<Code>`. The build inlines what you reference, parses patches (the raw patch is not in the output), re-zips replays without trace.zip and turns images into data URIs. `import shot from "./evidence/x.png"` also works. Paths must stay inside `evidence/` (no `..`, no symlinks out). Only string literals starting at `evidence/` count (or a whole-string value in `data/*.json`); `` `evidence/${id}.jpg` `` is a glob over the files there. Build fails on missing evidence; `check` warns about unused files. Recordings are not redacted: check for secrets before sharing. Text props (`Decision why`, question strings) are plain text: use nodes for `<code>`.

## Custom components and CSS

Write components inline or next to `index.tsx`; `import "./mine.css"` bundles a stylesheet. Use the tokens so both themes work: `var(--collie-color-fg|fg-muted|canvas|surface|border-subtle|accent-subtle|success-subtle|…)`, `--a-card`, `--a-line`, `--a-muted`, `--a-radius`, `--collie-space-*`. Files you cite under `evidence/` are not typechecked. Present-mode hooks for your components are in COMPONENTS.md.

## Three shapes (examples, not templates)

**Status:** `summary` as the one-line state → `<Stats>` → Cards with `<Status>` per workstream → Table of `<PR>`s → `<Decision>`s → `<Stale>` for unverified claims.
**Review walk-through:** verdict + risk → `<Map>` of what changed → a Section per area (two sentences, then `<Diff file hunks notes>` or `<Replay steps>`) → `<Questions>`.
**Investigation / explainer:** headline → `<TimeAxis>` or `<Map>` → `<Walkthrough>` of one case step by step → `<Compare>` variants → `<Code ranges>` for the lines that matter → `<Source>`s.

## Decision walk (async grill)

For a batch of decisions when the reader is away from chat: prepare the tree (each `<Decision>` with `id`, options, your `recommend`, `why`; follow-ups inside `<When>`), put `<DecisionIndex />` at the top, and let the reader walk it (present mode works and ends on a generated Summary slide). The Feedback drawer shows progress ("3/5 decided"); **Copy decisions** (or **Copy all feedback**, with comments) gives Markdown with each id, the chosen option and key, whether it was the recommended one, and the note: one paste back to you, applied by id. Only decisions on visible branches are listed. For quick back-and-forth, grill in chat instead.

## What the reader has

Outline (toggle for full width), theme, **Present** (`p`: title slide, then → / ← through Sections and `<Step>`s, ↑/↓ scroll, `#links` jump between slides, a Summary slide when there are decisions), **Feedback** drawer (`c` adds a comment on any element; decisions tab; copy as Markdown with element ids), **Download** (the same single HTML file), `?` for shortcuts and fold all.

## Limits

The built file runs your code: fine for a file the reader opens; don't host it for others yet. Output over 5 MB warns, over 25 MB refuses. `check`'s render can't catch errors that only occur in effects: look at `shot` once.
