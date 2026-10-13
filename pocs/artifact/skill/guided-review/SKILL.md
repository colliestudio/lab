---
name: guided-review
description: "Build a guided review page for a PR: reviewer mode (audience: the author + you, comments to keep/edit/drop and copy as a GitHub review) or requester mode (audience: the reviewer). Use when asked to review a PR as a guided review or to prepare a PR for review. Never posts to GitHub."
---

# guided-review

**Contract.** `/guided-review <owner/repo#n | PR URL> [reviewer|requester]`. Mode default: `requester` if the PR author is the current gh user (`viewerIsAuthor` in `data/pr.json`), else `reviewer`. Output dir/file name: `pr-<repo>-<n>-<mode>` (`.artifact`, built to `pr-<repo>-<n>-<mode>.html`). Never post, approve or comment on GitHub; the page only produces text for the human to paste.

Build with the `artifact` skill (read its ARTIFACT.md and COMPONENTS.md). Calm `page` shell, one narrow column, a `Wide` only for the diff.

## Inputs (read-only)
`artifact gather gh-pr pr-<repo>-<n>-<mode>.artifact --pr owner/repo#n` writes `data/pr.json` (meta, files, commits, existing review comments, reviews) and `evidence/pr.patch`. For context or tests use a scratch clone (`gh repo clone`, checkout the PR head) outside the repo; delete it after. Client code stays on this machine: no uploads, no pasting it elsewhere.

## Reviewer mode: the order
1. **Verdict** (`<Verdict recommend matters readTime comments>`): TL;DR plus the 3 things that matter.
2. **Why the PR exists**: the intent in your words, then what the description claims.
3. **Context today**: how it works now (diagram, code outside the PR that matters).
4. **The change layer by layer** (`<Layers>`, top to bottom; changed layers full, affected-but-unchanged dimmed with why; `flows` for what moves between layers; files per layer).
5. **Code walk in execution order**: `<LayerTag>`, the hunks (`<Diff hunks notes>`), your comments, extra snippets from outside the diff.
6. **Demo** only when it earns it: worked examples, or a small lab/calculator ported from the PR's code and checked against the real code.
7. **Tests**: what they cover and miss; run them if offline-safe.
8. **Risks**.
9. **Full diff** on its own page (`pages/diff.tsx`: `<ReviewDiff patch comments>`).
10. **Your review**: `<ReviewComments>` and `<CopyReview comments title summary>` (kept/edited only, GitHub-ready).

Comments are data (`data/review.json`): `{id, file, line|range, severity: blocking|should-fix|question|nit|praise, body, suggestion?, evidence?, dupOf?}`.

## Requester mode (audience: the reviewer)
Intent; "Where to start" (a short `<Layers>`); what to scrutinize, including assumptions you did not check; how you verified; a lab if it helps; the diff with author notes (`<ReviewDiff notes>`). No verdict, no CopyReview.

## Rules
- Verify every comment against the code (open the file; run it when cheap). State uncertainty as a question, not a finding.
- Be kind and specific to the author: name the line, say why, offer the fix.
- Re-check existing reviewers' comments (`pr.json` comments): mark repeats with `dupOf`, do not restate them.
- Keep it readable: one claim per picture, long detail in `<More>` or the diff page; `artifact check` clean, `shot` it and look.
- Finish by telling the user the HTML path and the verdict you recommend; they decide and post.

Sample: `samples/pr-review.artifact` (reviewer mode).
