# Idea: sandbox-origin — untrusted frames on a separate origin with real headers

**In two sentences.** Plugins and agent-made HTML pages run in frames loaded from a separate sandbox origin (one subdomain per frame) whose tiny frame-host page is served with real HTTP headers (CSP with `frame-ancestors` and a `sandbox` directive, Permissions-Policy) and receives the code by postMessage. On top of the headers, the frame host cancels every navigation of its own frame through the Navigation API, and plugin code runs inside a dedicated Worker in that frame, which closes the self-navigation, meta refresh and WebRTC leaks the plugin-loader and prototype reviews found.

Branch `idea/sandbox-origin` (based on `idea/plugin-loader`). Code: `src/sandbox/`, `sandbox/server.mjs`, `signaling/src/sandbox.ts`, `scripts/sandbox-attacks.mjs`, demo `sandbox.html`.

## How it works

```
app (5217)                                 sandbox origin (5227), one origin per frame
  openFrame('worker'|'page')  ──iframe──>  http://p-dice-x1y2.localhost:5227/worker
  checks e.source + e.origin               headers: CSP, Permissions-Policy, no-referrer
  plugin: send {start: runtime+loader}     boot (allowed by CSP hash): navigation guard,
          {load: source (hash-checked)}      new Worker(blob) ← runtime + plugin module
  page:   send {render: bridge + html}     boot: navigation guard, drop RTC globals,
                                             document.open/write(html)
```

- **Frame host** (`src/sandbox/framehost.js`, plain JS so Node, the Worker and tests share it): `serve(path, query) → {status, headers, body}`.
  - `/worker` (plugins): `default-src 'none'; script-src 'sha256-<boot>' blob:; worker-src blob:; connect-src 'none' | <declared origins>; base-uri 'none'; form-action 'none'; frame-ancestors <app origins>; sandbox allow-scripts allow-same-origin`. No `unsafe-inline`, no `unsafe-eval`. `?connect=` takes only `scheme://host[:port]` values (≤ 8), anything else is a 400.
  - `/page` (HTML pages): `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'none'; worker-src 'none'; webrtc 'block'` + the same common part.
  - Both: Permissions-Policy denying 26 device features, `Referrer-Policy: no-referrer`, `nosniff`, `no-store`.
- **Navigation guard.** CSP has no `navigate-to`, and no sandbox flag stops a frame navigating itself. The boot script registers a `navigate` listener that cancels every navigation (location, `navigation.navigate`, meta refresh, link clicks, reload) and reports the blocked URL to the app. It captures `Reflect.apply`, `Event.prototype.preventDefault` and the `destination.url` getter before untrusted code runs, so replacing those later doesn't disarm it. The listener survives `document.open()`.
  - Needs a **real origin**: in an opaque-origin document (`sandbox` without `allow-same-origin`, i.e. the old srcdoc frames) the Navigation API fires no events (tested). That is why frames get `allow-scripts allow-same-origin`, which is safe here because the frame's origin is never the app's, and why each frame gets its own subdomain (`<hint>-<random>`): siblings can't reach each other's DOM, localStorage, IndexedDB or BroadcastChannel. Cookies are the exception: a page can set a cookie on the parent domain (see What remains).
  - Defense in depth: the app still kills a frame that loads a second document.
- **Plugins in a Worker** (`originTransport` in `src/loader/sandbox.ts`, now the app's transport; the old one is kept as `srcdocTransport`). The frame host only starts the Worker the app sends and relays messages. A Worker has no `location` to navigate with, no DOM, no `RTCPeerConnection`, no `window.open`; its blob inherits the frame's CSP (fetch, WebSocket, `import()`/`importScripts()` from the network all blocked). The plugin API needed no change: render trees and commands were already plain data.
- **Pages** (`src/sandbox/page.ts`): `sandboxPage(html)` and a `pageFrame(html, vw, vh, scale, state)` with the prototype branch's signature and its bridge script (`data-goto`, `data-store`, `window.canvas`). The prototype plugin switches by changing one import, plus replacing the frame instead of reassigning `srcdoc` when re-rendering (`index.ts:47`).
- **Messages.** App → frame goes to the exact frame origin; frame → app is accepted only if `e.source` is that frame and `e.origin` equals its origin (the old srcdoc frames could only check the source, their origin was `null`). The frame host accepts messages only from its parent and from an origin matching the configured app list (the same list as `frame-ancestors`).
- **Integrity over http.** The app hashes plugin source before sending it (as before: `hashSource` must match the room's pinned hash, then exactly that string goes to the frame). New: when `crypto.subtle` is missing (plain http on `mini.internal`), a plain-JS SHA-256 (`src/sandbox/sha256.js`, checked against WebCrypto) gives the same `sha256-…` value. Pinning now works on http, and an http device and an https device agree on hashes (seen: Dice = `sha256-4c1329f1e7ec…` on `localhost` and on `mini.internal`). The weak 64-bit fallback is gone. The frame does not re-hash: it's the executor, the app is the party that decides what runs.

### Dev and production

- **Dev:** `pnpm dev:sandbox` (= `node sandbox/server.mjs --port 5227 --sink`) next to Vite. The app builds frame URLs as `<protocol>//<label>.<page host>:5227` (`x.localhost:5227` or `x.mini.internal:5227`; an IP page host uses `localhost`). The Mini dev proxy already forwards any `*.mini.internal:<port>`, so nothing in collielab changed. The server listens on 127.0.0.1 and ::1 only. `--sink` adds `/__sink/*` (records requests, `GET /__sink/log`) and a UDP sink on the same port number, for the attack lab. `SANDBOX_APP_ORIGINS` overrides who may embed (default: any port on localhost, `*.localhost`, 127.0.0.1, `mini.internal`, `*.mini.internal`).
- **Production (described, not deployed):** the same Worker answers `<label>.<SANDBOX_HOST>` by host name (`signaling/src/sandbox.ts`, tested). Config as comments in `signaling/wrangler.deploy.toml`:
  - a wildcard host on a **registrable domain of its own** (e.g. `*.canvas-frames.example`): cookie and site isolation from the app, plus a separate renderer process (site isolation is per site, so a subdomain of `collie.studio` would share the app's process). Note that all frames under it are still one site with each other: they share a process and can share `Domain=` cookies (pages only) until the domain is on the Public Suffix List
  - wildcard DNS record + a certificate for the wildcard (Universal SSL covers `*.<zone>` one level deep, so use the zone apex's wildcard, not `*.frames.collie.studio`)
  - route `*.canvas-frames.example/*`, vars `SANDBOX_HOST`, `APP_ORIGINS="https://canvas.lab.collie.studio"`
  - `run_worker_first = true` with an `ASSETS` binding, so the app's static files are never served on a sandbox host name
  - build the app with `VITE_SANDBOX_URL="https://{label}.canvas-frames.example"`

## What's built

- `src/sandbox/`: `framehost.js` (+ d.ts), `sha256.js` (+ d.ts), `client.ts` (frame URLs, `openFrame`), `page.ts` (pages), `lab.ts` (attacks), `demo.ts` + `sandbox.html` (demo), `sandbox.test.ts`.
- `sandbox/server.mjs` (dev origin + sink), `signaling/src/sandbox.ts` + Worker route + test, `scripts/sandbox-attacks.mjs` (`pnpm test:attacks`).
- Loader: `originTransport`, `workerCode()`, `hashSource` JS fallback. Plugins panel, host, policy unchanged.
- Tests: 251 vitest (9 new: SHA-256 vs WebCrypto on 200 lengths + UTF-8, `hashSource` with and without `crypto.subtle`, headers per path, connect-origin validation, origin patterns, frame URL config, Worker host routing); typecheck clean; Worker bundles (`wrangler deploy --dry-run`).
- `pnpm test:attacks` (headless Chrome, its own ports): runs every attack before/now and fails if a "now" result differs from the table below; then installs Dice in the real app, checks its frame is `p-dice-….localhost:<port>/worker`, adds a die and rolls it through the Worker. Passes.
- Also checked headless at `http://mini.internal:5217` (not a secure context): demo page, guard, Dice running with the same SHA-256 as on localhost.

### Attacks: results (headless Chrome, `pnpm test:attacks`)

Before = the srcdoc frames + CSP meta of plugin-loader / prototype. Now = sandbox origin. "Leak" = the sink saw it.

| attack | page before | page now | plugin before | plugin now |
|---|---|---|---|---|
| fetch / WebSocket / sendBeacon / image | blocked | blocked (CSP header) | blocked | blocked (CSP; Worker has no Image/sendBeacon) |
| CSS `url()`, `<link rel=prefetch>` | blocked | blocked | – | – |
| self-navigation `location.href = …?secret` | **leak** | blocked (guard) | **leak** (then stopped) | blocked (WorkerLocation is read-only) |
| `navigation.navigate`, meta refresh, link click | **leak** | blocked (guard) | – | – |
| navigate after replacing `preventDefault`/`call`/`Reflect.apply` | **leak** | blocked (captured at boot) | – | – |
| `document.open()` then navigate | **leak** | blocked (listener survives) | – | – |
| form submit, `window.open`, top navigation, child frame navigating its parent | blocked | blocked (sandbox) | blocked | blocked (no window) |
| read `parent.document` | blocked | blocked (cross-origin) | blocked | blocked |
| read a sibling sandbox frame | blocked (opaque) | blocked (own subdomain each) | blocked | blocked |
| app localStorage | blocked | blocked: the frame sees its own empty storage on its own origin | blocked | blocked |
| WebRTC STUN (`RTCPeerConnection`) | **leak** (UDP) | blocked (globals removed) | **leak** (UDP) | blocked (not in Workers) |
| WebRTC with constructors from a child frame (`window[0].RTCPeerConnection`) | blocked* | **leak** (UDP) | – | – |
| `import()` / `importScripts()` from the network | – | – | blocked | blocked |
| control: fetch to a declared `network:` origin | – | – | allowed | allowed (as intended) |

\* the old page frame was opaque, so its about:blank child was cross-origin to it; the direct WebRTC attack leaked there anyway.

**What remains:**
- **Pages can still reach WebRTC** through a same-origin child frame's fresh globals. Chrome ignores CSP `webrtc 'block'` ("unrecognized directive"; tested) and has no Permissions-Policy for WebRTC; `frame-src 'none'` doesn't stop about:blank children, and `window[0]` can't be intercepted. Making the page opaque again would close this but reopen every navigation leak, a worse trade. Options: scripts-off (static) mode for untrusted pages; a curated script runtime; accept "no casual network" for pages. Plugins don't have this hole.
- **Browsers without the Navigation API** get no guard (the frame host reports `unguarded`); then pages fall back to the old "one request, then killed". Chrome/Edge have it; Firefox and Safari shipped it recently. Not tested outside Chrome here.
- Not testable from a page: DNS-prefetch side channels (`<link rel=dns-prefetch>`, anchor hover prefetch), timing/CPU covert channels, Spectre-class reads (mitigated in production by the separate site → separate process; not in dev, where `*.localhost` is one site with the app).
- **Pages share cookies on the parent domain.** A page (plugins can't: Workers have no `document.cookie`) can set `Domain=<sandbox host>`; every other frame on that host reads it, so two pages can pass data across rooms in one browser. Seen on `*.mini.internal` (review, headless Chrome): a page's `Domain=mini.internal` cookie was readable by a sibling frame *and by the app* (and is sent to every dev service on `mini.internal`). Not on `*.localhost`. Headers can't turn cookies off for a real origin; production fix: put the frames domain on the Public Suffix List (as `googleusercontent.com` does), which makes every label its own site (no shared cookies, a process per frame).
- A plugin's Worker can still burn CPU or spam messages (as before).
- WebRTC packets are only observable when the browser runs on the Mini (UDP isn't proxied): from the MBP the demo's WebRTC rows rely on the notes ("RTCPeerConnection is not defined").

## Demo

Running: Vite on 5217, sandbox origin on 5227 (with sink).

1. `http://mini.internal:5217/sandbox.html`. Section 1: type a name in the signup page (log: `set`, `goto` from the bridge; frame origin `demo-….mini.internal:5227`). "Load a page that tries to leak": type; every keystroke shows `blocked navigation …?typed=…`; nothing reaches the sink.
2. Section 2: **Run all attacks** (~1 min). Red = leaked, before vs now.
3. `http://mini.internal:5217/` → Plugins → Examples → Dice → OK. Devtools → Elements: `iframe[data-plugin=dice]` src `http://p-dice-….mini.internal:5227/worker`; panel hash is `sha256-…` on plain http. Add… → Die, click to roll; right-click → Sandbox tests (Dice) → Phone home: the panel log shows the CSP block.
4. Restart: `cd ~/code/canvas-wt/sandbox-origin && pnpm dev:sandbox` and `pnpm exec vite --port 5217 --strictPort`. Full check: `pnpm test:attacks`.

## What it says about the core / plugin API

- No core change. The plugin protocol moved from a window to a Worker untouched: plugins already return render trees and plain-data changes, so they never needed the DOM. That makes "plugins are DOM-free" a rule worth keeping (it also gives the agent-bridge its DOM-free logic entry for free; the same Worker code can run in Node).
- One sandbox module now serves both untrusted-code paths (`openFrame` + kind). Rich plugin UIs (an iframe per node) would use the `/page` kind with the same guard and channel.
- Hash pinning belongs to the app side and works on http; the frame is a dumb executor.

## Fit with the vision

- **Multiplayer / local first:** no change to how plugins travel (in the doc, pinned by hash); the sandbox origin is a static, stateless page any host can serve: Node dev server, the Cloudflare Worker, later Collie Server or a desktop shell (which would serve it from a custom scheme).
- **Self-hosting:** needs a second host name with a wildcard. That's the one operational cost; document it in hosting docs. A desktop/Tauri build could use a custom protocol instead.
- **Agent native:** agent-made pages become safer to show by default (navigation leaks closed); scripts-on pages still carry the WebRTC caveat.

## Open questions

- Pages: scripts-off by default with a per-page "allow scripts" consent, or accept the WebRTC hole?
- Production domain: which registrable domain for frames (needs its own zone in Cloudflare for wildcard TLS)? Ties to Q1 in the synthesis.
- Dev https: `*.localhost` is a secure context, `*.mini.internal` isn't. JS SHA-256 covers hashing; clipboard and File System Access (eventstorm, kanban) still need https. Proposal: the Mini dev proxy serves `https://*.mini.internal:<port>` with Caddy `tls internal` (on-demand certificates for subdomains) and the MBP trusts Caddy's root once. A collielab change, not done here.
- Per-frame random origins: each one can create storage the browser keeps. Short-lived (no data written by plugins today), but a cleanup or a stable label per plugin hash may be better for production.
- Firefox/Safari: run `pnpm test:attacks` with their engines (playwright `firefox`/`webkit`) before relying on the guard there.

## Effort

- Merge-ready for plugins (rebase with plugin-loader, docs, Firefox/WebKit runs): 1–2 days.
- Prototype plugin on `pageFrame` from here: ~half a day (import swap, replace frame on re-render, keep keys/Escape forwarding).
- Production sandbox host (domain, wildcard cert, route, `run_worker_first` + ASSETS, CI build var): ~1 day, plus Alex's call on the domain.
- Scripts-off page mode with consent: 1–2 days.
