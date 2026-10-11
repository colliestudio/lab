# desktop-wails

**Idea.** The desktop app as a thin native shell around the web app, with the agent bridge as its invisible backend. Wails v3 (Go) owns windows, menus, file association and the agents' eyes; the bridge runs as a bundled sidecar binary that hosts every open `.canvas` file and the single MCP endpoint. One of three comparable spikes (Electron, Tauri, Wails); same scorecard.

## How it works

```
 Canvas.app/Contents/MacOS/
   Canvas (Go, Wails v3, 8.4 MB) ──JSON lines on stdio──▶ canvas-bridge (bun-compiled TS, 59 MB)
     │ windows: WKWebView, wails://localhost/?bridge=ws://127.0.0.1:<port>/<token>/b/<board>
     │ eyes: one hidden window per (board, agent seat), captured natively (takeSnapshot via cgo)
     │                                                     │ one Board per open file (bridge logic:
     ▼                                                     │ Y.Doc, file ⇄ doc 3-way merge, .ystate)
   File > New / Open / Open Recent, Agents > Connect       │ HTTP + WS on 127.0.0.1:<ephemeral>/<token>/…
   Claude Code, .canvas association (Info.plist)           │ MCP (streamable HTTP) at /<token>/mcp
                                                           ▼
                         Claude Code ── stdio ── `canvas-bridge mcp` (shim: reads endpoint.json, relays)
```

- **Wails v3, not v2.** v2 is single-window (no window per file, no hidden windows), so v3 (`v3.0.0-beta.28`, beta) is the only option for this design. It needs Go ≥ 1.25: mise has 1.23, the build sets `GOTOOLCHAIN=go1.25.5` (auto-download, user level). Wails is used as a Go library; the `wails3` CLI (installed with `go install`) only ran `doctor` and scaffolded a reference template. `desktop/build.sh` (40 lines) replaces its Taskfiles.
- **Shell ⇄ service.** Go starts `canvas-bridge` with `CANVAS_HOME` and a random token. Control messages are JSON lines on stdin/stdout, logs go on stderr. Shell → service: `open`, `close`, `list`. Service → shell: `screenshot`, `show`, and `eval` (debug only). When the service dies, the shell restarts it on the same port and token and re-opens the boards; open windows and eyes reconnect by themselves (y-websocket). When the shell exits, the service's stdin closes: it saves every board and exits.
- **One service, many files** (`desktop/sidecar/`). `board.ts` is `bridge/server.ts` as a class: the same file sync, merge, state sidecar and relay, one instance per file. Board id = hash of the real path. `service.ts` serves:
  - one HTTP/WS server on 127.0.0.1 (ephemeral port)
  - every URL under `/<token>/`
  - a per-board HTTP API with the same shape as the bridge's, so `CANVAS_BRIDGE=http://127.0.0.1:<port>/<token>/b/<board> pnpm canvas …` still works
  - `endpoint.json` (0600) in `~/Library/Application Support/Canvas/`
- **One MCP endpoint** (`mcp.ts`). It has the bridge's tools, each with a `board` argument (id, path or file name; optional when one board is open), plus `list_canvases`, `open_canvas` (opens a window unless `show:false`) and `canvas_screenshot`. Every MCP session is its own seat. The name comes from `CANVAS_AS` (sent by the shim as `x-canvas-as`) or from the client (`claude-code` → "Claude", `codex` → "Codex"); a second "Claude" becomes "Claude 2". Each seat has its own cursor, log name and undo.
- **Agents see the board** (`shell.go` `eyeFor`/`screenshot`, `native_darwin.m`):
  - Each (board, seat) gets a hidden, frameless window loading `?bridge=…&eye=<seat id>`.
  - Eye mode in the web app (`src/main.ts`, a small addition): the window is not a player, shows only the table, and `app.viewer` is the seat, so hands stay private by seat.
  - Camera: `fit` (first time), `keep`, or `{x, y, zoom}` (world point at the centre).
  - `labels:true` overlays node ids.
  - Before capture it waits for unloaded iframes (2 s cap) and one frame. The capture is `WKWebView takeSnapshotWithConfiguration` (afterScreenUpdates), downsampled to 1 image pixel per CSS pixel.
  - Eyes idle for 5 min close.
- **Hidden-window capture works on macOS 26.7.1.** The window is ordered out (`isVisible=0`, not occlusion-visible) and still renders on snapshot. A **sandboxed cross-origin iframe** (link node with `"x-embed": true` → `http://127.0.0.1:5271`, page origin `wails://localhost`) shows up in the image, JS-rendered content included. No headless-Chrome fallback was needed on macOS.
- **Hardening** (`main.go`):
  - The page never calls Go (no bound services), so a middleware closes the Wails runtime call endpoint (`/wails/runtime` → 403). Page JS and in-page plugins can't reach the clipboard, dialogs, window or app methods.
  - A CSP header goes on app pages: `script-src 'self'` (eval refused), `connect-src 'self' ws://127.0.0.1:*`, `frame-src http: https:`.
  - Go reaches the page only through native `callAsyncJavaScript`.

## What's built (branch `idea/desktop-wails`)

- `desktop/main.go`: app, single instance (argv forwarded), open-file events, CSP and runtime block, `--print-mcp-command`.
- `desktop/shell.go`:
  - one window per board (cascaded, title + proxy icon for the file, macOS recent documents)
  - recent files (`recent.json`, File > Open Recent)
  - New/Open dialogs
  - Agents > Connect Claude Code (copies the command and shows it) and Copy MCP URL
  - eyes, screenshots
  - "board visible" timing in the log
- `desktop/sidecar.go`: start, supervise and restart the service; request/reply over stdio.
- `desktop/native_darwin.{go,m}` (cgo, Cocoa + WebKit): eval with promise results, snapshot → PNG, represented file, window state.
- `desktop/sidecar/`: `board.ts`, `service.ts`, `mcp.ts`, `shim.ts` (`canvas-bridge mcp`; starts the app with `open -g -b` when it isn't running), `main.ts`, `smoke.ts` (MCP through the shim, as Claude Code does).
- `desktop/assets/Info.plist`: `.canvas` document type and exported UTI `studio.collie.canvas.document`, bundle id `studio.collie.canvas`.
- Scripts: `desktop/build.sh` (unsigned `.app` + `lsregister`), `desktop/dev.sh` (HMR), `desktop/measure.sh` (memory, cold start).
- Web app changes, all additive:
  - `?eye=` mode (`main.ts`, `style.css`)
  - link nodes with `"x-embed": true` render a sandboxed iframe (`board/index.ts`; `isPlain` allows `x-embed`)
- Tests: 244 pass, typecheck clean.
- Build output is gitignored (`desktop/build/`, `desktop/frontend/dist/`).

## Demo (Alex, on the Mini; Command Line Tools only, no Xcode)

From `~/code/canvas-wt/desktop-wails`:

1. Build: `pnpm install && desktop/build.sh`. It makes `desktop/build/Canvas.app` (unsigned) and registers it for `.canvas`.
2. Open a file:
   - `open -b studio.collie.canvas ~/some/board.canvas`, which goes through the file association. The other spikes register `.canvas` too, so a plain `open file.canvas` or double-click picks whichever LaunchServices prefers. To choose this app: Finder › Get Info › Open with › this Canvas.app › Change All.
   - Or from the CLI: `desktop/build/Canvas.app/Contents/MacOS/Canvas ~/a.canvas ~/b.canvas` (one window each).
   - Running it again with another file adds a window to the running app.
3. Edit the file in an editor: the window updates. Edit in the window: the file changes (`git diff` = one line).
4. Agents:
   - `desktop/build/Canvas.app/Contents/MacOS/Canvas --print-mcp-command` prints the command (the same one Agents › Connect Claude Code copies): `claude mcp add canvas -- <repo>/desktop/build/Canvas.app/Contents/MacOS/canvas-bridge mcp`. Run it yourself. Add `-e CANVAS_AS=Name` to name the seat.
   - Without touching your Claude config: `npx tsx desktop/sidecar/smoke.ts desktop/build/Canvas.app/Contents/MacOS/canvas-bridge <board-name> /tmp/shot.png` lists canvases, adds a note as "Smoke", and saves a screenshot.
5. Eyes, debug: `CANVAS_EYES_VISIBLE=1` makes eye windows visible (off-screen at −4000,−4000). `CANVAS_DEBUG=1` adds the `canvas_debug_eval` tool.
6. Iframe check: run `python3 -m http.server 5271` in a dir with an `index.html`. Add to the file `{"id":"e","type":"link","url":"http://127.0.0.1:5271/","x":0,"y":0,"width":420,"height":300,"x-embed":true}`. Call `canvas_screenshot`: the page shows inside the note.
7. Dev loop: `desktop/dev.sh file.canvas`. Vite HMR runs inside the app windows; Go changes rebuild in ~4 s on rerun.
8. Logs: `~/Library/Application Support/Canvas/canvas.log` (`CANVAS_HOME` overrides the folder).

## Scorecard

Measured on the Mac Mini (Apple Silicon, macOS 26.7.1, Retina scale 2), 2026-10-11. Test boards had 1–5 notes.

| | Wails v3 spike |
|---|---|
| Packaged size | `.app` **67.5 MB** (`du -sk`); zip **24.9 MB** (`ditto -c -k`). Shell 8.4 MB (Go + Wails + embedded web app 0.45 MB). Service 59 MB (bun runtime 58 MB + 0.9 MB JS). Node SEA instead of bun: ~117 MB for the service (node 22 binary 115.9 MB). |
| Idle memory (1 board window) | **200 MB** phys footprint, all processes (`footprint`, `desktop/measure.sh mem`): shell 27, service 31, WebKit GPU 73, Networking 7.5, WebContent 62. RSS sum 206 MB. With 1 eye: 284 MB. 2 boards + 1 eye: 320 MB. **Each window or eye ≈ +60–80 MB** (one WebContent process). WebKit processes are attributed by start time (other spikes run WebKit too, so this was checked by hand). |
| Cold start → board visible | **0.31–0.43 s** warm (`measure.sh cold`, 5 runs: 1318, 432, 324, 312, 321 ms). Measured from exec to the page reporting `room.synced` + 2 frames + nodes in DOM. The first launch after a build is 1.3 s (first-run scan of the new binaries). Via LaunchServices (`open -b`): 0.39 s. Opening a 2nd file in the running app: 0.13 s. The service is ready 70–125 ms after spawn. |
| Screenshot latency | First call per seat (creates the hidden window): **220–350 ms**. After that **~100 ms** at 1000×750 and ~135 ms at 1600×1000 inside the app (log). MCP round trip from a client: ~150 ms (stdio shim and curl alike). |
| Screenshot fidelity | Same WebKit as the visible window. 1 px per CSS px (Retina 2x snapshot downsampled). PNG 430–500 KB at 1000×750 (the felt texture inflates PNG; token cost depends on pixels, not bytes). **Cross-origin sandboxed iframe captured.** Hidden windows get **no** `requestAnimationFrame` (comparison review 2026-10-11: a rAF counter in an embedded page stayed at 0 across two shots 3 s apart; timers ~1 Hz; CSS animation not advancing), same as Tauri. The capture paints the current DOM, so rAF/canvas/WebGL-driven content is stale. |
| File association | `CFBundleDocumentTypes` + exported UTI in Info.plist (hand-written; Wails' `config.yml` can generate it but its Taskfiles weren't used). Registered with `lsregister`. `open -b … file.canvas` while not running: launches and opens. While running: adds a window (Apple Event `odoc` → `ApplicationOpenedWithFile`). AppKit delivers argv files as open events too (deduped). |
| Bridge embedding | bun-compiled sidecar binary, supervised by Go (restart on crash keeps port and token, verified with `kill -9`). Graceful quit saves all boards (verified via `osascript … quit`). Porting to Go: see below. |
| MCP wiring | One endpoint per app: streamable HTTP at `127.0.0.1:<port>/<token>/mcp`, plus a stable stdio shim (`canvas-bridge mcp`) for `claude mcp add`. The shim reads `endpoint.json` and starts the app if needed. Session = seat. 10 tools with a `board` arg, including `list_canvases`, `open_canvas`, `canvas_screenshot` (MCP image). |
| Dev ergonomics | Go build 28–30 s cold (cgo + Wails), **~3 s incremental**. Vite 0.5–1 s; bun compile 0.2 s. `build.sh` ~31 s cold, 3.3 s warm. `dev.sh`: Vite HMR in the app windows (verified: CSS updated live, page state kept), service from source via tsx, Go restart ~4 s. Web Inspector in non-production builds. No Xcode needed (only for iOS). |
| Cross-platform | See below. |
| Security | Service on 127.0.0.1 only, 128-bit token in every URL (WS too), endpoint file 0600: same-user trust. No Wails bindings; runtime calls blocked (403 verified); CSP verified (eval refused). Iframes `sandbox="allow-scripts"` (opaque origin). Remaining IPC: Wails' WKScriptMessageHandler (window drag/resize messages). Unsigned (Gatekeeper prompts on other Macs). Agents' seat names are self-declared (no per-agent tokens). |

### Porting the bridge to Go instead of a sidecar

- Yjs in Go exists now: `github.com/reearth/ygo` (v1.51.6, pure Go). It claims byte-level V1/V2 compatibility with yjs 13.6, plus y-protocols sync and awareness, checked by a conformance suite. Older and partial: `skyterra/y-crdt`.
- The CRDT isn't the blocker. The bridge's value is the TypeScript shared with the browser: the Store and commands (the plugin API), board logic (rider rule, sync), canonical serialize, diff and 3-way merge, and plugin logic later. A Go port forks all of that and means two implementations of every plugin command.
- **Keep TS.** The cost is 58 MB for the bun runtime, ~30 MB of RAM, and a second process.
- A middle path worth a look: embed a JS engine in Go (QuickJS via cgo, or goja) and run the same bundled TS without Node. It needs shims for fs.watch, ws and http. That engine is also the sandbox the rule-plugin design wants. Size would drop to ~10–15 MB total. Not tried.

### Cross-platform notes (reasoned, not built)

- **Windows (WebView2, Chromium):**
  - Capture via `ICoreWebView2::CapturePreview`, or better CDP `Page.captureScreenshot` through `CallDevToolsProtocolMethod`, which covers out-of-process iframes and works with the controller hidden.
  - WebView2 suspends rendering when `IsVisible=false`, so eyes would stay "visible" off-screen or use CDP.
  - Screenshots render with Chromium, not WebKit (they match the headless-Chrome fallback; differ from macOS).
  - Needs ~150 lines of COM via Wails' `NativeWindow()`; Wails exposes no capture API on any OS.
  - bun cross-compiles the service (`--target=bun-windows-x64`).
  - Association via installer registry (Wails NSIS template).
- **Linux (WebKitGTK):**
  - `webkit_web_view_get_snapshot` gives a cairo surface. Hidden windows need a realized widget (GtkOffscreenWindow in GTK3).
  - WebKitGTK versions vary by distro, which affects CSS and features.
  - Association via a `.desktop` file's `MimeType`.
- Per OS: one native capture module and one packaging path. The Go shell, service and MCP stay the same.

## Gaps

- Not exercised by eye (headless run): menus, dialogs, the Connect Claude Code dialog (its command is checked via `--print-mcp-command`). Two windows open at once were checked through logs and screenshots of the eyes.
- Closing a window leaves its board open in the service (agents may still use it). No tabs, no menu-bar or tray hosting, no welcome screen (with nothing to open it uses `Scratch.canvas` in the app folder). Eye windows may appear in the Window menu (unchecked).
- `board.ts` duplicates `bridge/server.ts`. The real version extracts a multi-board library both use.
- Board id = hash of the path: a moved file is a new board. Seat names are trusted.
- Hidden-window rendering on `takeSnapshot` is observed behavior, not documented API. If a macOS release stops rendering ordered-out views, the fallback is an on-screen window at alpha 0, or the service driving headless Chrome (Playwright `channel:'chrome'`).
- Agent cursors render above the node they touched (existing bridge behavior, seen in screenshots).
- Wails v3 is beta (API churn; Go 1.25 floor). No first-party auto-update evaluated. Not signed or notarized (by design here).

## Effort to make it real (macOS)

- Extract the bridge into a multi-board library and drop the copy: 1–2 d.
- Window and board lifecycle, tabs or a sidebar of workspaces/backends, welcome screen, tray hosting: 3–5 d.
- Per-agent tokens and permissions on the MCP endpoint, seat visibility rules for eyes: 3–4 d.
- Signing, notarization, DMG, updates: 2–3 d.
- Windows and Linux (capture module, packaging, CI): 3–5 d each.
- **About 2–3 weeks to a solid macOS app; +1–2 weeks per extra OS.**
