# Idea: plugin-loader — third-party plugins loaded at runtime, sandboxed

**In two sentences.** A plugin is a manifest (id, version, capabilities) plus one ES module that anyone can install into a table from a URL or local files; the table records its plugins (code pinned by hash) so every peer loads the same set, and each device approves before running it. The code runs in a sandboxed iframe and talks to the app only through a message bridge: it declares types, kits and menu entries, receives the part of the doc it may read, and returns plain data (changes, log events, render trees) that the host checks against its capabilities before applying.

Branch `idea/plugin-loader`. Code: `src/loader/`, examples: `examples/plugins/{dice,votes}/`.

## How it works

```
plugin (sandboxed iframe, opaque origin, CSP)        host (app)
  runtime.js adapts the module to messages     <-->  PluginHost (host.ts)
  commands(doc, args, ctx) -> {changes,events}        readableDoc(): what it may see (policy.ts)
  types.X.render(node, ctx) -> render tree            checkResult(): all-or-nothing capability check
                                                      treeToHtml(): allowlisted HTML (tree.ts)
                                                      one store command `ext.apply` = core undo step + log
```

- **Manifest** (`manifest.ts`): `id` (= node namespace `x-<id>` and log prefix `<id>.`; built-in ids reserved), `name`, `version`, `main`, `capabilities`:
  `nodes:read:all`, `nodes:write`, `ui:kit`, `ui:menu`, `log:write`, `network:none` | `network:https://origin`. A plugin always sees its own nodes (those carrying `x-<id>`).
- **Install**: Plugins panel → Examples / Install from URL (manifest URL; `main` resolved relative) / From files (pick manifest.json + .js). Consent dialog lists capabilities in plain words. Source is hashed (SHA-256; weak fallback hash on plain-http pages, no `crypto.subtle`).
- **Room-level trust**: the doc's `meta['x-plugins']` holds `{manifest, hash, source, from, addedBy}`. It syncs with Yjs, persists in IndexedDB and goes into the saved `.canvas` file (the file carries its plugins). Any peer can write that list, so every entry is re-validated (`parseManifest`) on read. Each device keeps approvals in localStorage, keyed by hash + id + capabilities (a peer widening an approved plugin's capabilities re-prompts); an unapproved plugin shows "awaiting approval" and its nodes fall back to their plain JSON Canvas `text` ("Die d6 (needs the Dice plugin)"). Code that doesn't match the pinned hash is refused.
- **Sandbox** (`sandbox.ts`): one hidden `<iframe sandbox="allow-scripts">` per plugin (opaque origin: no app DOM, cookies, localStorage, IndexedDB; no popups, no top navigation), CSP `default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'` (or the declared origins). Code arrives by postMessage and is imported from a blob URL. Messages are matched on `event.source` both ways (other frames can't speak for a plugin). CSP violations are reported to the panel. If the frame navigates itself (allowed by any sandbox; CSP has no `navigate-to`), the host stops the plugin on `pagehide`/second `load`.
- **Network is not airtight.** `network:none` blocks fetch/XHR/WebSocket/images, but a plugin can still leak what it was shown: in the URL of a self-navigation (one request, then it's killed), and via WebRTC ICE (`RTCPeerConnection` with a STUN server; CSP doesn't cover it). Fix options: run the plugin in a Worker inside the iframe (no `location`, no `RTCPeerConnection`), or a sandbox origin served with real CSP headers. Treat it as "no casual network", not a guarantee.
- **Bridge** (`host.ts`): declarations become ordinary in-process registrations: `ObjectType` per plugin type (match on `x-<id>.kind`), kits (need `ui:kit`), one menu provider (need `ui:menu`; entries are data: label, command, `type`/`min`/`max` filter, submenu `group`, optional `prompt`). Every call is async request/response with a 2 s timeout.
- **Commands**: host sends the readable doc (own nodes; with `nodes:read:all` everything this viewer may see, and nodes hidden from the viewer come redacted to geometry) → plugin returns `{changes, events, select}` → `app.dispatch('ext.apply', …)` re-checks against the current doc inside the dispatch (sync) → one undo step, log entries under the local player.
- **Policy** (`policy.ts`): writes only to own nodes, only own namespace + `x y width height text color label`; adds must carry `x-<id>` and only those fields; no `owner`; event types must start `<id>.`; event `actor` stripped (no impersonation); size caps. One denied change refuses the whole result.
- **Render trees** (`tree.ts`): `{tag?, text?, class?, style?, action?, title?, children?}`. Allowlisted tags and style properties, no `url(`, classes prefixed `px-<id>-`, text escaped. `action` becomes `data-action`, so the core's existing `onAction` path sends clicks back to the plugin. Renders are async and cached per node content: `renderKey` triggers a request, the reply re-renders; a stale render shows until the new one arrives.

## What's built

- `src/loader/`: manifest, policy, tree, runtime (sandbox side, plain JS), host (bridge, room list, approvals, notices), sandbox (iframe transport + localStorage approvals), panel (UI), plugins.css, index (`mountPluginLoader`).
- `examples/plugins/dice`: d6 (pips) / d20, click to roll, Roll menu, log events; plus a "Sandbox tests (Dice)" submenu that tries to: paint a selected card, turn cards face up (`x-cards`), count visible nodes, phone home, read localStorage, log as another player.
- `examples/plugins/votes`: sticky notes with one vote per player (▲ n button), edit text (host prompt), clear votes, sort by votes.
- Tests: `src/loader/loader.test.ts` (14): manifest validation, read filtering + redaction, write/event denials, render sanitizing, end-to-end host with an in-process transport (install, kit, render, roll, undo, denial leaves doc alone, peer approval after a Yjs sync, tampered code refused, invalid peer entries ignored, capability change re-prompts, uninstall unregisters). 242 tests pass, typecheck clean.
- Verified in Chrome at `http://mini.internal:5211`: both plugins load in sandboxed iframes; die click rolls through the real pointer path; context menu shows plugin entries; reload keeps plugins (IndexedDB + approval); clearing approvals → "Plugins (2 to allow)", die shows its fallback text; Allow → renders and runs. Denials seen live: `x-cards.faceUp` and `color` on a card refused, fetch blocked by CSP (`connect-src blocked https://example.com/…`), `localStorage blocked (SecurityError)`, impersonation logged as the local player, look sees only its own 2 nodes.
- Review (headless Chromium, two contexts on the 5192 signaling): demo steps 2–6 pass; peer sees "Plugins (2 to allow)" and fallback text, no iframes until Allow; rolls/notes sync both ways. A malicious test plugin: popups, top navigation, `parent.document`, images and posting to a sibling plugin frame are blocked; self-navigation leaked one URL and, before the fix, the navigated page kept answering calls (fixed: plugin stopped). Also fixed: a manifest `name` with markup ran script in the app (placeholder used `innerHTML`); peer-written room entries skipped validation (a reserved id like `cards` would own every card); approval ignored capability changes.

## Demo

1. `cd ~/code/canvas-wt/plugin-loader && pnpm exec vite --port 5211 --strictPort --host 0.0.0.0`, open `http://localhost:5211` (or `http://mini.internal:5211`; plain http there = weak hash, see Open questions).
2. Toolbar **Plugins** → Examples **Dice** → OK on the consent dialog. Same for **Sticky votes**.
3. **Add…** → "Die (d6) · Dice plugin" and "Sticky note · Votes plugin" (both land at the view center: drag the note off the die). Click the die: it rolls (log: "rolled 4"). ⌘Z undoes the roll. Click ▲ on the note to vote; right-click it → Edit text…, Sort notes by votes (right-click the empty table).
4. Denials: select a card and the die (Shift-click), right-click → Sandbox tests (Dice) → *Turn selected cards face up* / *Paint selection red*: toast "denied", nothing changes, Plugins panel → Sandbox log shows why. *Phone home*: CSP blocks the fetch. *Read app storage*, *Log as another player*, *Count what I can see*: see the Log.
5. Peer view: in devtools `localStorage.removeItem('canvas-poc:plugin-approvals')`, reload: "Plugins (2 to allow)", die shows its fallback text; Plugins → **Allow on this device**.
6. Multiplayer (needs signaling on 5192): Share → second browser joins → it sees the room's plugins awaiting approval.

## What it says about the core / plugin API

**Fit without core changes.** Zero changes to `src/core/`. The bridge lives entirely on the public API: `registerType/Kit/Menu/Command`, `store.meta`, `dispatch`, `hiddenFrom`, `view.render`, `onAction` via `data-action`. Commands already return plain-data `Change[]` + events: that is exactly the shape that crosses a message boundary. JSON Canvas fallback text makes "plugin missing" graceful for free. One small app change: `main.ts` keeps `x-plugins` across New table (it calls `store.load`, which clears meta).

**What can't cross a message boundary (today's in-process API is sync and DOM-shaped):**

| In-process hook | Problem | Bridge answer here / proposal |
|---|---|---|
| `render(node, el)` (DOM) | no DOM access across the boundary | declarative render tree, async + cached (built). Alt: an iframe per node for rich UIs (charts, canvas) — heavier, no shared styling, focus/drag issues |
| `Command` (sync, reads `DocView`) | async round trip | host snapshots readable doc, applies via `ext.apply` with re-check (built). Gap: result computed on a slightly stale doc |
| `MenuProvider`, `canDrop`, `movable`, `grabbable`, `concealed`, `when` (sync predicates) | called during a gesture | declarative filters (built for menus: type/min/max/group/prompt). Proposal: drop/move rules as data (accepts kinds, overlap threshold) |
| `onDragStart/onDrop/onDragEnd/dragOver` | sync, mid-gesture, mutate | proposal: fire-and-forget events after the gesture → plugin returns changes merged into the gesture's undo step (needs a `store.merged` window held open for async) |
| `registerLayout`, `registerParentRule`, `registerRiderRule`, `repairs`, `migrations`, import/export filters | sync, run on every read/transaction | can't be async. Proposal: declarative layouts (row/fan/grid params) or run small pure functions in a synchronous sandbox (QuickJS-wasm in the host thread) |
| `registerKey` | `when(app)` sync | proposal: keys as data bound to "hovered/selected node of type X" → command |
| `registerHider`, cursor rules | privacy-critical, sync | keep built-in only; plugins can't define privacy |
| clock-style tickers (`setInterval` + DOM) | no DOM | proposal: render tree with a declarative countdown element (`{countdown: endsAt}`) the host animates |

## Fit with the big vision

- **Multiplayer**: plugin list is part of the CRDT doc; everyone runs the same hash. Commands run on the actor's device only; results sync as normal changes, so peers don't need the plugin to *see* the effect (they need it to render nicely).
- **Agent native**: commands are named, args are JSON, results are plain data. An agent can call `plugins.run('votes','sort',{})` the same way; the capability check applies to agents too. Manifest = a ready tool description.
- **Local first**: plugin code lives in the doc and the `.canvas` file; works offline; no registry required.
- **Hosting / Collie Server**: a server peer can hold an allowlist of hashes per team, refuse rooms with unapproved plugins, or run trusted plugins headless (the runtime is DOM-free; a Worker/QuickJS on the server would work).
- **Secrets / host model**: plugins never get secrets; network is per-origin and declared. Hidden nodes come redacted. A future "host/dealer" holding secrets would answer plugin reads with the same redaction.
- **Marketplace security**: manifest + hash = what to sign. Marketplace = signed manifests (publisher key) + review of capabilities; the device approval prompt shows publisher + capability diff on upgrade.

## Open questions

- Async command results apply to a doc that may have moved on: OK for dice/votes; for contested state (two players grabbing one card) needs a compare-and-set precondition in the result.
- Source in the doc bloats every room and file (dice ≈ 7 KB). Alternative: store only `{url, hash}` and fetch; loses offline/peer-to-peer distribution. Maybe: in-doc by default, content-addressed blob store on Collie Server.
- Upgrades: replacing a plugin by id re-prompts everyone (new hash). Data migrations across plugin versions?
- `allow-scripts` iframe can still burn CPU / spam postMessage; add a Worker inside the iframe or kill on repeated timeouts. Plugin iframes are same-process on most setups (opaque origin, not site-isolated): Spectre-class reads of app memory are out of scope for this POC.
- Values written to allowed fields aren't type-checked (`x: "abc"` on its own node) and event `private`/`targets`/`cue`/`key` pass through unchecked; a plugin can only spoil its own nodes / log lines, but a schema check belongs in `checkResult`.
- A plugin's own nodes go to it unredacted even when hidden from the viewer (e.g. in another player's hand).
- The runtime shares a realm with plugin code: a plugin can tamper with it, which is fine (the boundary is the iframe), but means runtime checks are convenience only; all enforcement must stay host-side (it is).
- Render tree vocabulary: how rich before it becomes a UI framework? Needs images (data: or declared asset hashes), SVG subset, inputs.
- `crypto.subtle` missing on plain-http dev URLs (`mini.internal:5211`) → weak 64-bit non-cryptographic hash: not collision-resistant, so a determined peer could swap in different code under an existing approval. Treat pinning as off there. Real deployments are https.
- Trust granularity: per hash per device today. Per publisher? Per room ("I trust whatever this room's owner approves")?

## Effort to make it real

- Harden what's here (CAS preconditions, timeout/kill, upgrade prompts, signed manifests, tests in a real browser): ~1 week.
- Declarative drag/drop/layout/keys + async gesture hooks: ~1–2 weeks; needs core work on holding an undo step open.
- Port one built-in (clock or battleline) to the external API to prove coverage: ~3–5 days; will expose missing primitives.
- Marketplace (registry, publisher keys, review, capability diffs): weeks, mostly product/infra.
