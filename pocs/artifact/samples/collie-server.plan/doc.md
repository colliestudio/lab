---
kind: plan
title: One Collie server for demos, reviews and plans
goal: One self-hostable server holds `.replay`, `.review` and `.plan` bundles behind stable unlisted links, fed by the CLI and a GitHub Action that keeps one sticky PR comment current.
status: proposed
risk: medium
risk_why: Link format, artifact ids and the upload contract are public the moment the first link lands in a PR; changing them later breaks every posted link.
ask: Decide the five questions (runtime, repo, upload auth, stable PR slots, expiry); approve the artifact model and the URL scheme.
author: recap-lab samples agent
date: 2026-10-05
---

```map
groups:
  - { id: clients, label: Publishers }
  - { id: server, label: Collie server }
  - { id: viewers, label: Viewers (existing) }
nodes:
  - { id: cli-publish, label: "publish (recap / demo CLI)", kind: module, change: planned, group: clients, section: cli }
  - { id: gh-action, label: GitHub Action, kind: job, change: planned, group: clients, section: action }
  - { id: publish-api, label: Upload API, kind: api, change: planned, group: server, section: publish }
  - { id: artifact-store, label: Blob store (zips), kind: db, change: planned, group: server, section: artifacts }
  - { id: meta-db, label: Metadata (SQLite), kind: db, change: planned, group: server, section: artifacts }
  - { id: read-api, label: "Read API + /d/<id> pages", kind: api, change: planned, group: server, section: read }
  - { id: comments, label: Comments, kind: module, change: planned, group: server, section: comments }
  - { id: server-bin, label: Server process + config, kind: config, change: planned, group: server, section: selfhost }
  - { id: accounts, label: Accounts + teams, kind: module, change: deferred, group: server, section: later, note: "columns exist now (owner_id, team_id, visibility); sign-in and teams come later" }
  - { id: recap-viewer, label: Recap viewer, kind: ui, change: unchanged, group: viewers, note: "recap-lab viewer; already boots from window.__RECAP__ with an api base" }
  - { id: demo-player, label: Demo player, kind: ui, change: changed, group: viewers, section: read, note: needs to load a .replay zip from a URL }
  - { id: pr, label: GitHub PR, kind: external, change: unchanged }
edges:
  - { from: cli-publish, to: publish-api, label: "POST zip + token" }
  - { from: gh-action, to: publish-api, label: look up PR slot }
  - { from: gh-action, to: pr, label: upsert sticky comment }
  - { from: publish-api, to: artifact-store, label: write zip }
  - { from: publish-api, to: meta-db, label: row + version }
  - { from: read-api, to: artifact-store, label: read entries }
  - { from: read-api, to: recap-viewer, label: ".review / .plan" }
  - { from: read-api, to: demo-player, label: ".replay" }
  - { from: recap-viewer, to: comments, label: GET/POST }
  - { from: accounts, to: publish-api, label: "binds tokens to a team", change: deferred }
```

Today a `.replay` opens from disk and a `.review` from `recap serve` or a single HTML file; neither has a link you can paste in a PR. The server is the shared piece both tools publish to: one upload contract, one `/d/<id>` URL scheme, one store. It starts with unlisted links and a server-wide publish token, so it can run before accounts exist; everything that accounts and teams will need later (owner, visibility, team) is a column now, defaulted.

```questions
- q: Server runtime for the first version?
  options: [Node/TypeScript, Go single binary]
  recommend: Node/TypeScript
  why: Both viewers, the recap parser and the Doc model are TS today; the server is mostly glue over them. Go stays the leaning for the productized Collie Demo binary and can embed the same static viewers later.
- q: Where does the server code live?
  options: ["recap-lab (lab, now)", "colliestudio/collie-demo server/", "own repo colliestudio/collie-server"]
  recommend: recap-lab now, own repo when the collie-demo repo is created
  why: It serves two tools, so it should not sit inside Demo; a lab first matches how replay-lab and recap-lab started.
- q: Who may upload while there are no accounts?
  options: [anyone, server-wide publish tokens, GitHub OIDC from Actions only]
  recommend: server-wide publish tokens
  why: One env var for self-host, works from agents and CI alike; OIDC can be added without changing the upload API.
- q: Re-push behaviour for PR artifacts?
  options: [new link per publish, stable slot per PR + kind with versions]
  recommend: stable slot per PR + kind with versions
  why: The sticky comment and any link already pasted keep working; versions keep old comments anchored.
- q: Default expiry?
  options: [never, 30 days, 90 days]
  recommend: 90 days for slot (PR) artifacts, never for one-offs
  why: PR artifacts pile up with every push; manual publishes are deliberate.
```

## Artifact model {#artifacts}

Every upload is an **artifact** (one zip: `.replay`, `.review` or `.plan`), stored as-is and addressed by an unguessable id. Re-publishing to the same **slot** (e.g. a PR) adds a version and keeps the link.

```data-model
entities:
  - name: artifact
    change: planned
    fields:
      - { name: id, type: "text, 16 random bytes base62", change: planned, note: the public link id; never derived from content or names }
      - { name: kind, type: "replay | review | plan", change: planned, note: sniffed from the zip (manifest.json vs doc.md) and checked against the declared kind }
      - { name: slot, type: "text?", change: planned, note: "e.g. github:alexluong/replay-lab#12:review; unique per server; null = one-off" }
      - { name: title, type: text, change: planned, note: from doc frontmatter or replay manifest name }
      - { name: current_version, type: int, change: planned }
      - { name: visibility, type: "unlisted (only value now)", change: planned, note: "later: team, public; never defaults to public" }
      - { name: owner_id, type: "int? → account", change: planned, note: null until accounts exist }
      - { name: team_id, type: "int? → team", change: planned, note: null until teams exist }
      - { name: expires_at, type: "datetime?", change: planned }
      - { name: created_at / updated_at, type: datetime, change: planned }
  - name: artifact_version
    change: planned
    fields:
      - { name: artifact_id + n, type: pk, change: planned }
      - { name: sha256, type: text, change: planned, note: blob key; identical re-uploads are no-ops }
      - { name: size, type: int, change: planned }
      - { name: meta, type: json, change: planned, note: "repo, base, head, pr, commit from frontmatter or the publish call" }
      - { name: created_at, type: datetime, change: planned }
  - name: comment
    change: planned
    fields:
      - { name: id, type: text, change: planned }
      - { name: artifact_id + version, change: planned, note: comments pin to the version they were made on }
      - { name: anchor, type: json, change: planned, note: "{section, block, file, line} as in SPEC §6" }
      - { name: author / body / resolved, change: planned, note: "author is free text until accounts" }
```

```callout tone=decision
**Store the zip, not the unpacked files.** One blob per version keyed by sha256 (disk: `data/blobs/ab/abcd….zip`; S3 later). The read API serves entries straight from the zip's central directory, so a bundle is never half-written and `GET /d/<id>/raw` returns exactly what was uploaded.
```

## Upload API {#publish}

One endpoint for all kinds: `POST` a zip, get a link. With a `slot`, the server reuses the slot's artifact and adds a version, which is what keeps PR links stable across pushes.

```api
endpoints:
  - method: POST
    path: /api/artifacts
    change: planned
    summary: Upload a bundle zip (≤ 25 MB). Body is the zip; metadata in query/headers.
    request: "Authorization: Bearer <publish token>; ?kind=review&slot=github:owner/repo#12:review&expires=90d"
    response: '{"id": "4kq9Zt0bXwR2", "url": "https://collie.example/d/4kq9Zt0bXwR2", "version": 3, "delete_token": "dt_…"}'
  - method: DELETE
    path: /api/artifacts/:id
    change: planned
    summary: Delete with the publish token or the per-artifact delete_token returned at upload.
  - method: GET
    path: /api/slots/:slot
    change: planned
    summary: "Resolve a slot to its artifact: {id, url, version, title, tldr, risk}. Used by the Action."
```

```code lang=ts file=server/src/publish.ts
// sketch: slot upsert in one transaction
const sha = sha256(zip);
await blobs.putIfAbsent(sha, zip);
const a = slot ? db.artifactBySlot(slot) ?? db.newArtifact({ kind, slot }) : db.newArtifact({ kind });
const n = db.addVersion(a.id, { sha, size: zip.length, meta });
return { id: a.id, url: `${base}/d/${a.id}`, version: n };
```

```callout tone=risk
Unlisted ≠ private. Anyone with the link reads it, and a link in a public PR is public. The CLI should warn when `recap check` or the demo summary finds secret-shaped values (`whsec_`, `Bearer`, `password`) before upload; the recorder doesn't redact yet.
```

## Read API and viewer pages {#read}

`/d/<id>` serves the right viewer for the artifact's kind, booted with `api: "/d/<id>/api"`, so the recap viewer runs unchanged and the demo player gains one thing: loading a `.replay` zip from a URL.

```api
endpoints:
  - method: GET
    path: /d/:id[@v]
    change: planned
    summary: Viewer page; latest version unless @v is given. Recap viewer for review/plan, demo player for replay.
  - method: GET
    path: /d/:id/api/doc
    change: planned
    summary: Parsed Doc model (review/plan), cached per version.
  - method: GET
    path: /d/:id/api/files/*path
    change: planned
    summary: One entry from the zip (demos/x.replay, assets/…), with content-type and immutable caching.
  - method: GET
    path: /d/:id/raw
    change: planned
    summary: The zip as uploaded (download / `recap unpack`).
```

```steps
- { title: Mount the existing recap viewer under /d/:id with api base /d/:id/api, area: read-api, status: todo }
- { title: Demo player loads a .replay from a URL (fflate unzip in the browser), area: demo-player, status: todo }
- { title: Embedded demos inside a .review resolve through files/*path, area: read-api, status: todo }
```

## Comments {#comments}

Comments move from `comments.json` in the bundle to the server, keyed by artifact and version, with the same anchors; the authoring agent pulls them with `recap comments <url>`.

```api
endpoints:
  - method: GET
    path: /d/:id/api/comments
    change: planned
    summary: All comments on the artifact, each with the version it was made on.
  - method: POST
    path: /d/:id/api/comments
    change: planned
    summary: "Add {anchor, author, body}. Open to anyone with the link until accounts; rate-limited per IP."
```

```callout tone=warn
Open commenting on unlisted links invites spam once a link leaks. Rate limit plus a per-server switch (`comments: off | link | token`) is enough until accounts.
```

## CLI publish {#cli}

`recap publish x.review` and `demo publish x.replay` share one client: read `COLLIE_SERVER` / `COLLIE_TOKEN` (env, then `~/.config/collie/config.toml`), zip the bundle dir if needed, upload, print the URL. Agents publish from any harness the same way.

```code lang=sh
recap publish x.review                          # one-off unlisted link
recap publish x.review --slot pr                # slot from git remote + current PR (gh), stable link
demo publish out/webhooks.replay --slot pr      # same slot scheme, kind=replay
recap publish x.review --to http://localhost:7300 --expires 7d
```

```steps
- { title: "Shared publish client (zip, upload, config lookup) used by both CLIs", area: cli-publish, status: todo }
- { title: "--slot pr resolves github:<owner>/<repo>#<pr>:<kind> via gh", area: cli-publish, status: todo }
```

## GitHub Action and sticky comment {#action}

The Action never authors anything and needs no LLM key: the agent that made the change publishes to the PR's slots; on each push the Action looks the slots up and upserts one comment marked `<!-- collie -->` with the headline, risk, the map as Mermaid (`recap md`) and both links.

```flow
sequenceDiagram
  participant Ag as Dev agent
  participant S as Collie server
  participant GH as GitHub
  participant A as Collie Action
  Ag->>S: recap publish --slot pr (review v3)
  Ag->>S: demo publish --slot pr (replay v2)
  Ag->>GH: git push
  GH->>A: pull_request synchronize
  A->>S: GET /api/slots/...:review, ...:replay
  S-->>A: ids, urls, tldr, risk
  A->>GH: upsert the marked comment (headline, map, links)
```

```code lang=yaml file=.github/workflows/collie.yml
on: pull_request
jobs:
  collie:
    runs-on: ubuntu-latest
    permissions: { pull-requests: write }
    steps:
      - uses: colliestudio/collie-action@v0
        with:
          server: ${{ vars.COLLIE_SERVER }}
          token: ${{ secrets.COLLIE_TOKEN }}
```

```steps
- { title: "Action: resolve slots, render comment, upsert by marker", area: gh-action, status: todo }
- { title: "No artifact yet → comment says so once, no failure (informational check)", area: gh-action, status: todo }
```

## Self-host {#selfhost}

One process, one data dir: `collie server --data ./data` (`recap server` in recap-lab today) runs SQLite + blobs on disk; the hosted instance is the same server with S3 blobs. Local `recap serve` stays as it is (no server needed to look at your own work).

```code lang=sh
collie server --data ./data --port 7300 --base-url https://collie.example
# data/collie.db, data/blobs/; COLLIE_PUBLISH_TOKENS=tok1,tok2 ; COLLIE_BLOBS=s3://bucket (hosted)
```

```checklist
- Upload a .review with an embedded .replay; /d/<id> shows the doc and the demo plays
- Re-publish to the same slot; the link is unchanged, version +1, old comments still anchor
- Kill the server mid-upload; no half-written artifact is visible
- Delete with delete_token; /d/<id> → 410
```

## Later: accounts and teams {#later}

Not in this plan: sign-in (device-code `collie login`), teams with invites, `team` visibility, per-team tokens, billing. The plan only fixes what they will need: `owner_id`, `team_id` and `visibility` columns exist now, tokens are looked up server-side (so a token can later be bound to a team, as Agent-Native binds the org to the connection), and nothing ever falls back to `public`.

