# desktop-tauri

**Idea.** Canvas as a Mac app on Tauri v2: double-click a `.canvas` file to open it; the agent-bridge runs inside the app where nobody sees it; one MCP endpoint serves every open board; each agent gets a hidden view of the board with its own camera and can take screenshots of it. This is the Tauri half of a shell comparison. The other half is `idea/desktop-electron`, scored the same way.

## How it works

```
Canvas.app/Contents/MacOS/
  canvas-desktop  (Rust, 4.7 MB)            canvas-service  (Node SEA sidecar, 110 MB)
  ├ menu, File>Open, recent, Finder opens   ├ Room per open .canvas  (agent-bridge: file ⇄ Y.Doc, 3-way merge, seats)
  ├ board windows  ──── ws://127.0.0.1:<eph>/b/<id>/canvas ────┤ y-websocket per board
  ├ hidden agent-view windows (1 per board×seat)               ├ HTTP API /canvases, /b/<id>/{doc,query,cmd,undo,log}
  └ WKWebView takeSnapshot ◀── {op:screenshot} (stdin/stdout JSON lines) ── /b/<id>/screenshot
                                                                └ ONE MCP endpoint: /mcp (streamable HTTP)
  claude ── stdio ──▶ canvas-service mcp  (shim: reads service.json for the port, calls the HTTP API)
```

- **Shell (Rust, `desktop/src-tauri/src/main.rs`)** starts the sidecar (`serve --shell`) and waits for its `ready` line, about 60–100 ms. It opens files given as CLI args, through File › Open…, Open Recent, and Finder/`open -a` (`RunEvent::Opened`; opens that arrive before the service is up are queued). One window per file: `tauri://localhost/index.html?bridge=ws://127.0.0.1:<port>/b/<id>`, which is the unchanged web app in its existing `?bridge=` mode. Closing the last window keeps the app running so agents can still reach it. Quitting closes the sidecar's stdin; the service then flushes every file and exits, and it also exits if the app crashes.
- **Sidecar (`desktop/service/`)**: `room.ts` is `bridge/server.ts` turned into a class: same file sync, watcher, `.ystate` sidecar and seats. It reuses `bridge/host.ts`, `query.ts`, `canonical.ts` and `client.ts`. `main.ts` runs one loopback HTTP server on an ephemeral port that serves all rooms and `/mcp`, and writes `~/Library/Application Support/studio.collie.canvas.spike/service.json` (port, pid). Board id = sha1 of the real path, so `/tmp` and `/private/tmp` give one board.
- **MCP (`desktop/service/tools.ts`)**: the bridge's tools, each with a `board` argument (id, path or file name; optional when only one board is open), plus `list_canvases`, `open_canvas {file, show}` and `canvas_screenshot`. Two transports run the same code:
  - **stdio shim**, the stable one to register: `canvas-service mcp [--as Name]`. It ships inside the .app, needs no Node install, and finds the running app through `service.json`.
  - **streamable HTTP** at `/mcp`: one session = one seat. Duplicate names become "Claude 2". DNS-rebinding protection is on. The port changes on every launch.
- **Agent vision (`snapshot.rs`)**: per (board, seat) a hidden, undecorated, **incognito** `WebviewWindow` that loads the same page. Its own storage holds its own player id ("Claude (view)") and a style that turns off CSS transitions and animations. Each screenshot:
  1. waits until the page has synced with the service (polls `evaluateJavaScript` through objc2);
  2. sets the camera (`fit`, a list of nodes, or x/y/zoom);
  3. calls `WKWebView takeSnapshotWithConfiguration` with `afterScreenUpdates` and converts NSImage → PNG at 1 image px per CSS px (`scale: 2` on request);
  4. returns the PNG as an MCP image block.

  The people's windows never move.
- **Cross-origin iframes**: link nodes with `"embed": true` now render a sandboxed iframe. This is the only web-app change; existing content is unaffected.
- **Security surface**: board windows get **zero Tauri capabilities** (`app.security.capabilities: []`, `withGlobalTauri: false`), so the page has no IPC into Rust. Everything privileged runs in Rust or the sidecar.
  - The service binds 127.0.0.1 and refuses any `Origin` except `tauri://localhost`, plus `http://localhost:5260` in debug builds for `tauri dev`.
  - CSP: `default-src 'self'`, `connect-src` only for loopback, `frame-src http: https:` (for embeds), `script-src 'self'`.

## What's built (branch `idea/desktop-tauri`)

- `desktop/src-tauri/`: Tauri v2 app with these crates: tauri, tauri-plugin-dialog (used from Rust only), objc2, objc2-web-kit, objc2-app-kit, block2. Bundle config includes `externalBin`, `fileAssociations` (`.canvas`, role Editor) and an ad-hoc-signed `.app` (unsigned for distribution, not notarized).
- `desktop/service/`: multi-file service, MCP tools (10), stdio shim.
- `desktop/build-sidecar.mjs`: esbuild → one CJS file → Node SEA (postject, ad-hoc re-sign). `--runtime bun` → `bun build --compile` instead.
- Menu: Canvas (About/Hide/Quit), File (Open… ⌘O, Open Recent, Close), Edit (standard, so text fields get copy and paste), Agents (Connect Claude Code…: copies `claude mcp add …` and shows it in a dialog; Show Agent Views), Window.
- Scripts: `pnpm desktop:build` (vite build + sidecar + `tauri build`), `pnpm desktop:dev` (Vite HMR on :5260 + `cargo run`), `pnpm desktop:sidecar`, `pnpm desktop:service` (service under tsx, no shell). `desktop/scripts/measure-memory.py` adds up memory for the app's processes.
- Diagnostics env vars:
  - `CANVAS_CAPTURE_MODE=hidden|offscreen|transparent|visible` (default `hidden`)
  - `CANVAS_KEEP_RENDERING=1` (sets WebKit's inactive scheduling policy to none and turns off occlusion detection through SPI; it didn't help, see findings)
  - the shell logs to `~/Library/Application Support/studio.collie.canvas.spike/canvas.log`
- Web app: unchanged apart from `embed` on link nodes. All 244 tests pass and `pnpm typecheck` now covers `desktop/`.

## Demo (on the Mini)

```sh
cd ~/code/canvas-wt/desktop-tauri
pnpm install
pnpm desktop:build          # Rust comes from mise (mise.toml: rust = "stable"); ~1.5 min clean, ~45 s after
APP=$PWD/desktop/src-tauri/target/release/bundle/macos/Canvas.app
mkdir -p /tmp/demo && [ -f /tmp/demo/board.canvas ] || echo '{"nodes":[],"edges":[]}' > /tmp/demo/board.canvas
open -a "$APP" /tmp/demo/board.canvas          # same Apple-Event path as a Finder double-click
open -a "$APP" /tmp/demo/second.canvas         # second window, same service (file must exist for `open`)
```

1. **Agent, without touching your Claude config**:
   ```sh
   echo "{\"mcpServers\":{\"canvas\":{\"command\":\"$APP/Contents/MacOS/canvas-service\",\"args\":[\"mcp\"]}}}" > /tmp/demo/mcp.json
   claude --mcp-config /tmp/demo/mcp.json --strict-mcp-config
   ```
   Ask: "list the canvases, add three notes about an order flow to board.canvas, link them, then take a screenshot and fix the layout". To register it for real, use Agents › Connect Claude Code… (copies `claude mcp add canvas -- '<APP>/Contents/MacOS/canvas-service' mcp`).
2. **Live file edits**: edit `/tmp/demo/board.canvas` in an editor, or `git checkout` it. The window updates and agent edits are written back within about 300 ms.
3. **Cross-origin capture**: `python3 -m http.server 5261 --bind 127.0.0.1` in a folder with an `index.html`, then add to the file `{"id":"e1","type":"link","url":"http://127.0.0.1:5261/","embed":true,"x":0,"y":300,"width":420,"height":260}`. Ask the agent for a screenshot; the iframe's contents show up.
4. **Double-click in Finder**: the app registers as a `.canvas` handler, but the current default on this Mini is the Wails spike, which exports UTI `studio.collie.canvas.document`. Use Get Info › Open with › Canvas (desktop-tauri) › Change All, or right-click › Open With.
5. **See an agent's view**: Agents › Show Agent Views moves the hidden windows on screen.

## Scorecard

Measured on the Mac Mini (Apple Silicon, macOS 26, 4K display, Command Line Tools only), release build, 2026-10-11.

| | Result | How measured |
|---|---|---|
| **Packaged size** | **110 MB** .app (37 MB zipped). Shell 4.7 MB (web assets included); Node SEA sidecar 110.1 MB. With `--runtime bun` the sidecar is 61.9 MB (22.5 MB gzip), so the app is about 67 MB | `du -sh`, `ls -la Contents/MacOS`, `ditto -c -k` |
| **Idle memory** | 1 board window: **~125 MB** footprint / ~175 MB RSS. + 1 agent view: ~180 MB. + 2nd board window: **~231 MB** footprint / 193 MB RSS. Per process: shell 24, sidecar 22–27, WebKit GPU 17, Networking 8, **each WebContent ~50–55** (MB footprint) | `desktop/scripts/measure-memory.py`: `footprint` per pid. WebContent/GPU pids come from WKWebView SPI `_webProcessIdentifier`/`_gpuProcessIdentifier` logged by the app; Networking is matched by start time. 20 s idle |
| **Cold start → board visible** | **0.41–0.51 s** (4 runs) from `open -a` to synced and rendered. Breakdown: `open` → `main` 60–80 ms, sidecar ready 55–96 ms, window → visible ~250–470 ms. First launch after a fresh build: ~2.2 s (1.2 s before `main`: LaunchServices and first-run code checks on a new binary) | Epoch timestamp before `open`; the app logs epoch when the page reports `room.provider.synced` and nodes in the DOM |
| **Screenshot latency** | Warm: **35–45 ms** in the app (snapshot alone 18–25 ms); **~205 ms** for an MCP `tools/call` over HTTP measured with curl (resolve + base64 + JSON). First shot for a new seat: 150–300 ms (window create ~30–60 ms + sync ~90 ms) | `timings` in the app log; `time` around curl MCP calls (5 runs) |
| **Screenshot fidelity** | Exact pixels of the web app as WebKit renders it, at 1000×750 (1x), ~440 KB PNG, readable. **Cross-origin iframes are captured**: a sandboxed iframe on another port, with its script output. Claude Code (haiku) read the note titles and the iframe text from the MCP image. A hidden window gets **no `requestAnimationFrame`**, but the snapshot still paints the current DOM; rAF-driven content would be stale | `claude -p --mcp-config … --strict-mcp-config` end to end; PNGs inspected |
| **File association** | Works: `CFBundleDocumentTypes` (.canvas, Editor) in Info.plist; LaunchServices lists the app as a `.canvas` handler after first launch; `open -a` and Finder opens arrive as `RunEvent::Opened`, also while the app is running. Not tested: a real double-click, because the default handler is the Wails spike and I didn't change Alex's defaults | `NSWorkspace URLsForApplicationsToOpenURL` (read only), `open -a` |
| **How the bridge is embedded** | Node sidecar (`externalBin`) as a SEA, controlled over stdin/stdout JSON lines, and it dies with the app. Same code as the dev bridge (`bridge/host.ts` etc.) | n/a |
| **MCP wiring** | One endpoint for the whole app: stdio shim `canvas-service mcp` inside the .app (stable path; port found through `service.json`) plus streamable HTTP `/mcp` (port per launch). Tools take `board`; `list_canvases`, `open_canvas {show}`, `canvas_screenshot` → image. The menu item copies `claude mcp add …` | Tested: HTTP via curl, stdio shim via `claude -p` |
| **Dev ergonomics** | Rust via mise, user level (no dotfile edits, `~/.cargo`/`~/.rustup`). First `cargo build` (debug, ~350 crates) 45 s; incremental debug 3–6 s; release clean 80 s, incremental 38–42 s (LTO, codegen-units=1). `tauri dev`: up in 12 s, **Vite HMR works** for web changes, a Rust edit gets the board back in 5.9 s. Sidecar rebuild 5 s. CLT was enough: no full Xcode needed | `time` |
| **Cross-platform** | See notes below: snapshot code is macOS only (`snapshot.rs`); WebView2 and WebKitGTK need their own ~80 lines each | Reasoning |
| **Security** | No IPC capabilities at all; strict CSP; service on loopback with an origin allowlist. Open gaps: no token (any local process can act as any agent), a sandboxed plugin can't reach the service but local apps can | Config review |

## Findings that matter for the shell decision

- **Hidden-window capture works on WKWebView.** `takeSnapshot` on a never-shown window gives correct, fresh pixels, including **out-of-process cross-origin iframes**, in ~20 ms. The worry that "Tauri capture is less mature" doesn't hold on macOS. It takes ~150 lines of objc2 (eval-with-result + snapshot), because Tauri exposes neither JS results nor snapshots on macOS.
- **No animation frames when not visible.** I tried hidden, offscreen (-30000,-30000), alpha 0 and visible windows, with the display awake: only the visible window ran rAF. The public `inactiveSchedulingPolicy = none` and the private `_setWindowOcclusionDetectionEnabled:NO` didn't change it. Consequences:
  - DOM/CSS content is fine; transitions are turned off in agent views so a snapshot never catches one halfway.
  - `<canvas>`/WebGL or rAF-animated plugins would look stale or empty to agents. Fixes: plugins draw on state change, not only in rAF; or the agent view becomes a 1×1 px visible window. Electron's `capturePage` on a hidden `BrowserWindow` has a similar throttle switch (`backgroundThrottling: false`); worth checking side by side.
- **Size is mostly Node.** The Tauri shell is 4.7 MB; the SEA sidecar is 110 MB, so the "Tauri is small" advantage mostly goes away while the bridge stays in Node. Options:
  - Bun-compiled sidecar: 62 MB, it worked (serve + MCP + edits), but it's a different runtime from dev and tests.
  - Port the bridge to Rust (yrs): about 2–3 weeks, because `src/core/store` + commands + board logic would have to exist twice (TS for the browser, Rust for the host). Not worth it while the plugin logic is TS.
  - Run the bridge inside a hidden webview (JSC) instead of Node: no fs/watch, so it needs Rust shims; awkward.
- **Memory**: each extra view costs one WebContent process (~50 MB). Agent views add up: 5 agents × 2 boards ≈ +500 MB. Close views after idle (not built).

## Cross-platform notes (reasoned, not run)

- **Windows (WebView2 = Chromium)**:
  - Capture: `ICoreWebView2::CapturePreview` (PNG) or CDP `Page.captureScreenshot` through `CallDevToolsProtocolMethod`, which also works for hidden controllers and is the same capture path as the Electron/headless fallback.
  - Rendering: matches Chrome/Electron. The page origin becomes `http://tauri.localhost`, so the service allowlist needs it.
  - The SEA sidecar needs a Windows build of `canvas-service`.
- **Linux (WebKitGTK)**:
  - Capture: `webkit_web_view_get_snapshot` (async, cairo surface); hidden-window behaviour similar to macOS or worse.
  - Rendering: WebKitGTK lags Safari, and its GPU/compositing differs by distro; expect font and backdrop-filter differences.
  - The `tauri://` origin works.
- **Rendering differences**: three engines (WebKit macOS, Chromium Windows, WebKitGTK Linux) → agent screenshots differ by platform and from any headless-Chrome fallback. Electron gives one engine everywhere.

## Gaps

- Menu items (Open…, Recent, Connect Claude Code, Show Agent Views) are built but **not clicked**: headless, and no Accessibility permission for System Events. File opening was tested through CLI args, `open -a` and `open_canvas {show}`.
- Launching the binary directly a second time (`Canvas.app/Contents/MacOS/canvas-desktop f.canvas`) starts a second instance with its own service and overwrites `service.json`. `open -a` is fine. Fix: `tauri-plugin-single-instance` (~15 lines).
- Agent views appear in people's player list as "Claude (view)". They need an observer flag in the web app.
- No idle cleanup of agent views; no auth tokens (same gaps as the agent-bridge).
- Snapshot only covers the viewport, not the whole board as one large image (needs a temporary resize or tiling).
- Bun sidecar: file watching wasn't checked.
- The web app's own Open…/Save buttons still use browser file APIs inside the desktop window; they should be hidden or routed to the service in desktop mode.
- Not built: drag-and-drop of files, Share/host via relay, menu-bar mode.

## Effort to make it real

- Single instance, close idle agent views, observer flag, hide web Open/Save in desktop mode: ~2 days.
- Signing and notarization (Developer ID, hardened runtime; the SEA needs `allow-jit`/`allow-unsigned-executable-memory` entitlements) + auto-update (tauri-plugin-updater): ~2–3 days.
- Windows/Linux capture paths + CI builds of the sidecar per target: ~1 week.
- Smaller sidecar (bun, or trimming the Node build): ~1–2 days to evaluate. A Rust port of the host: weeks, not recommended yet.
