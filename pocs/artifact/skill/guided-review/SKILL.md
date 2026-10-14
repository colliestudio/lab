---
name: guided-review
description: "Build a guided review page for a PR: reviewer mode (audience: the author + you, comments to keep/edit/drop and copy as a GitHub review) or requester mode (audience: the reviewer). Use when asked to review a PR as a guided review or to prepare a PR for review. Never posts to GitHub."
---

# guided-review

**Contract.** `/guided-review <owner/repo#n | PR URL> [reviewer|requester]`. Mode default: `requester` if the PR author is the current gh user (`viewerIsAuthor` in `data/pr.json`), else `reviewer`. Output dir/file name: `pr-<repo>-<n>-<mode>` (`.artifact`, built to `pr-<repo>-<n>-<mode>.html`). Never post, approve or comment on GitHub; the page only produces text for the human to paste.

Build with the `artifact` skill (read its ARTIFACT.md and COMPONENTS.md). Calm `page` shell, one narrow column, a `Wide` only for the diff.

## Inputs (read-only)
`artifact gather gh-pr pr-<repo>-<n>-<mode>.artifact --pr owner/repo#n` writes `data/pr.json` (url, head/base SHAs, draft, checks, files, commits, existing review comments with their URLs, reviews) and `evidence/pr.patch`. For context or tests use a scratch clone (`gh repo clone`, checkout the PR head) outside the repo; delete it after. Client code stays on this machine: no uploads, no pasting it elsewhere.

## Reviewer mode: the order
The fixed spine, top to bottom. Everything else is chosen per PR; do not add a section because the template has it.
1. **PR header** (`<PrHeader recommend comments/>`, first thing on the page; reads `data/pr.json`): linked title, `owner/repo#n`, author, state, base ← head, size, checks, "Open on GitHub" / "Files changed", the PR description and commits behind "more". `recommend` adds one line, "Recommend: request changes · 2 blocking", that links down to the Verdict. No full verdict up here.
2. **Why the PR exists**: the intent in your words, then what the description claims.
3. **Context today**: how it works now (diagram, code outside the PR that matters: `<Code source="path" …>` links to it at the right commit; existing reviewers' comments: `<ExistingComments/>`).
4. **Shape of the change** (optional, pick what fits or skip it). `<Layers>` only when the PR crosses layers (service → data, UI → store); otherwise a before/after (`<Compare>` of two `<Code>`), a sequence or flow diagram, a state change, a file map (`<Table>` of files with why), or nothing for a small PR.
5. **Code walk in execution order**: the hunks (`<Diff hunks notes>`), your comments, extra snippets from outside the diff. `<LayerTag>` only if you used Layers.
6. **Demo** only when it earns it: worked examples, or a small lab/calculator ported from the PR's code and checked against the real code.
7. **Tests**: what they cover and miss; run them if offline-safe.
8. **Risks**.
9. **Verdict** (`<Verdict recommend matters readTime comments>`): TL;DR plus the 3 things that matter, then the reader's choice.
10. **Your review**: `<ReviewComments>` and `<CopyReview comments title summary>` (kept/edited only, GitHub-ready).
11. **Full diff** on its own page (`pages/diff.tsx`: `<ReviewDiff patch comments>`).

Comments are data (`data/review.json`): `{id, file, line|range, severity: blocking|should-fix|question|nit|praise, body, suggestion?, evidence?, dupOf?}`. `dupOf` is the id of an existing comment in `pr.json`.

## Requester mode (audience: the reviewer)
Same header (no `recommend`). Then: intent; "Where to start" (a file table in reading order, or `<Layers>` when it crosses layers); before/after if it helps; what to scrutinize, including assumptions you did not check; how you verified; a lab if it helps; the diff with author notes (`<ReviewDiff notes>`). No verdict, no CopyReview. Sample: `samples/pr-request.artifact`.

## Links
Link every reference: file, symbol, line, commit, issue, PR, doc, existing comment; internal links for things on the page (comment ↔ diff, LayerTag ↔ section). The kit does most of it:
- `ghUrl.file(path, line?, {side: "base"|"head"})`, `ghUrl.commit(sha)`, `ghUrl.pr(n)`, `ghUrl.issue(n)`, `ghUrl.diff(path, line?)`, `ghUrl.files()`, `ghUrl.comment(id)` build GitHub URLs at the right SHA from `pr.json`. Use them for any `<a>` you write.
- `<Linked>text</Linked>` and `<Md>` autolink `#123`, `owner/repo#123`, URLs, and backticked `` `src/a.ts:12` `` / `` `abc1234` ``. Comment bodies, author notes and Verdict `matters` strings already go through it.
- Diff/ReviewDiff file headers and line numbers link to GitHub; a card's `file:line` links to the line, "in the diff" / "decide" jump between card and diff; `dupOf` links to the original; `<Code source="path">` shows "view on GitHub".
- Write `` `path:line` `` in prose instead of plain text, so it becomes a link.
Links open in a new tab and stay quiet; do not underline everything.

## Rules
- Verify every comment against the code (open the file; run it when cheap). State uncertainty as a question, not a finding.
- Be kind and specific to the author: name the line, say why, offer the fix.
- Re-check existing reviewers' comments (`pr.json` comments): mark repeats with `dupOf`, do not restate them.
- Keep it readable: one claim per picture, long detail in `<More>` or the diff page; `artifact check` clean, `shot` it and look.
- Finish by telling the user the HTML path and the verdict you recommend; they decide and post.

Samples: `samples/pr-review.artifact` (reviewer mode), `samples/pr-request.artifact` (requester mode).
