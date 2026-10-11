# desktop-electron

**Idea.** A desktop app whose back end *is* the canvas bridge, invisible to the user: double-click a `.canvas`, it opens in a window, every change autosaves to the file, edits to the file (editor, `git checkout`) show live. One local MCP endpoint serves every open board to every agent; each agent gets a seat (name, cursor, undo, log) and a hidden browser window of its own to *see* the board through screenshots. This branch is the Electron spike; `idea/desktop-tauri` is the same brief in Tauri, scored on the same card.

## How it works

```
 Electron main process (Node 24)
 ├─ BridgeService (bridge/service.ts) on 127.0.0.1:<random port>
 │   ├─ BoardFile per open .canvas (bridge/board.ts): Y.Doc + seats + two-way file sync + .ystate
 │   ├─ WS  /b/<id>/…      y-websocket: the windows (and hidden agent views) join here
 │   ├─ GET /…             the built web app (desktop/build/web), CSP header
 │   ├─ *   /b/<id>/cmd …  the bridge's HTTP API per board (CLI-compatible)
 │   └─ *   /mcp           one MCP endpoint (streamable HTTP), a seat per session
 ├─ BrowserWindow per file: http://127.0.0.1:<port>/?bridge=ws://127.0.0.1:<port>/b/<id>
 └─ AgentViews: per (agent seat × board) a hidden BrowserWindow, ?agentView=<actor id>, own camera
        └─ canvas_screenshot = webContents.capturePage()  (browser-level: cross-site iframes included)

 Claude Code ──stdio──> shim.mjs (app binary in Node mode) ──HTTP──> /mcp
                        finds the port in endpoint.json; starts the app when it isn't running
```

- **Bridge in-process.** The agent-bridge's server was split into `BoardFile` (one file: doc, file sync, browsers, API) and `BridgeService` (one HTTP/WS server, many boards, path routing). `pnpm bridge <file>` is now a thin wrapper over the same service (same routes, tests unchanged). The desktop main process creates the service directly: no child process, no IPC.
- **The renderer is the web app unchanged**, in its existing `?bridge=` mode, served from the bridge's own origin. Two additive web changes: `?agentView=<id>` (no chrome, no presence, `app.viewer` = the agent's seat so it sees what that seat may see), and link nodes with `x-embed: true` render the page live in a sandboxed iframe (needed to prove cross-origin capture).
- **One window per file**, all on one service. File ▸ New / Open… / Open Recent (own list + macOS recent documents), Reveal in Finder. Files arrive via argv, `open-file` (Finder double-click, `open -a`, Dock drop) and `second-instance` (CLI while running). Closing a window closes its board unless an agent is seated at it. With no windows the app keeps running (macOS) and keeps hosting for agents.
- **One MCP endpoint.** `/mcp` (streamable HTTP, stateful sessions). Session = seat: name from `x-canvas-as` (the shim sends `CANVAS_AS`), else the client's name (`claude-code` → "Claude"), made unique ("Claude 2"). Tools: `list_canvases`, `open_canvas`, and the bridge's `canvas_list/add_node/update_node/connect/remove/undo/log` (now in `bridge/tools.ts`, shared with `bridge/mcp.ts`) with a `board` argument (id, path or file name; optional with one board open), plus `canvas_screenshot`. The shim ends its session on exit; idle sessions expire after 30 min.
- **Agents see the board.** `canvas_screenshot {board, target: "board" | "viewport" | <node id/title>, width, height, padding, format, hidpi}` lazily creates the seat's hidden window (`show:false`, `paintWhenInitiallyHidden`, `backgroundThrottling:false`, in-memory partition `agent-views`), sets the camera (`app.view.fit`), waits two frames and for iframes to fire `load` (max 3 s), then `capturePage({stayHidden:true})`; scaled to width × height unless `hidpi`. Views close when the agent leaves, the board closes, or after 5 idle minutes.
- **Connect Claude Code** (Canvas menu and Agents menu) shows and copies the exact command, never runs it:
  `claude mcp add canvas -s user -e ELECTRON_RUN_AS_NODE=1 -e CANVAS_AS=Claude -- "<Canvas.app>/Contents/MacOS/Canvas" "<Canvas.app>/Contents/Resources/app.asar.unpacked/build/shim.mjs"`
  (plus the direct-HTTP variant, valid only while the port stays). The shim runs on the app's own binary, so it needs no Node on the machine.

## What's built (branch `idea/desktop-electron`)

- `bridge/board.ts`, `bridge/service.ts` (refactor + multi-file + localOnly guard + static serving), `bridge/tools.ts` (shared MCP tools), `bridge/server.ts` and `bridge/mcp.ts` slimmed.
- `desktop/src/main.ts` (app, windows, menus, recents, security, debug routes `/app/metrics`, `/app/window-shot`, dev-only `/app/eval`), `desktop/src/mcp.ts` (endpoint), `desktop/src/views.ts` (hidden agent windows, screenshots), `desktop/src/shim.ts` (stdio ↔ HTTP relay, auto-start).
- `desktop/build.mjs` (vite build → `build/web`; esbuild bundles main + shim: the packaged app has no `node_modules`), `desktop/electron-builder.yml` (unsigned `dir` target, `.canvas` association, shim unpacked), `desktop/scripts/dev.mjs` (vite HMR in the app), `desktop/scripts/mcp-smoke.mjs` (drives the endpoint through the shim like Claude Code), `desktop/scripts/measure.sh` (the scorecard numbers).
- Web: `?agentView=` mode, `x-embed` link nodes (`board.add {embed:true}`).
- Tests: the existing 244 pass; desktop verified end to end with the scripts below (no new unit tests).

## Demo on the Mini

From `~/code/canvas-wt/desktop-electron` (`pnpm install` done):

1. Build the app: `pnpm --dir desktop run package` (~6 s) → `desktop/dist/mac-arm64/Canvas.app` (unsigned, built locally, so no Gatekeeper prompt).
2. Open a board: `mkdir -p ~/canvas-demo && open -a ~/code/canvas-wt/desktop-electron/desktop/dist/mac-arm64/Canvas.app ~/canvas-demo/board.canvas` (created if missing). Use `open -a <path>`: plain double-click currently goes to the `desktop-wails` spike's Canvas.app, which LaunchServices picked as the default `.canvas` handler. A second file: same command with another path → second window, same back end.
3. Edit in the window (Add ▸ Note, double-click to edit) → `cat ~/canvas-demo/board.canvas` shows it (autosave, ~300 ms). Edit the file in an editor → the window updates, the log says "File edited the file".
4. Canvas ▸ Connect Claude Code… → Copy command → paste in a terminal (this registers it in your user config; `claude mcp remove canvas -s user` undoes). In a Claude session: "list the canvases, add three notes about the checkout flow to board.canvas, then take a screenshot and fix the layout". Its cursor and log entries show up as "Claude"; a second session shows up as "Claude 2" (or set `CANVAS_AS`).
5. Without Claude: `cd desktop && node scripts/mcp-smoke.mjs /tmp ~/canvas-demo/board.canvas http://example.com/` adds notes, an embedded page and writes three screenshots to `/tmp`. With the packaged app use `CANVAS_EXE=…/Canvas.app/Contents/MacOS/Canvas CANVAS_SHIM=…/Contents/Resources/app.asar.unpacked/build/shim.mjs`.
6. Agents ▸ Show Agent Views (debug) reveals the hidden windows the agents see through.
7. Numbers: `desktop/scripts/measure.sh /tmp/canvas-measure` (own userData, kills only the app it started).
8. Dev loop: `pnpm --dir desktop dev ~/canvas-demo/board.canvas` (vite on 5253, HMR in the windows; main-process changes = restart, bundle ~0.1 s).

## Scorecard (Electron 44.7.0 / Chromium 152 / Node 24.21, Mac Mini M-series, macOS 26, measured 2026-10-11)

| Item | Result | How measured |
| --- | --- | --- |
| Packaged app size | **242 MB** `.app` (Electron framework 240 MB, `app.asar` 2.2 MB); **110 MB** zipped | `du -sh`; `ditto -c -k` |
| Idle memory, 1 window | **~317 MB** (main/bridge 125, GPU 58, network 43, renderer 91) | `app.getAppMetrics()` working set, summed, 25 s idle, plain 2-note board (`/app/metrics`) |
| + 1 hidden agent view | **~405 MB** (+85–90 MB per view) | same, while an MCP session holds a view |
| Embedded cross-site page | +~70 MB each (own OOPIF renderer), per window that shows it | process list with `localhost:5252` embeds |
| Cold start → board visible | **2.1–2.4 s** first launch after a build / fresh profile; **0.40–0.47 s** warm. Inside the app: bridge listening 46–65 ms after main starts, window synced + painted 170–250 ms after creation | `open -a App file` timestamp → app log line written after `room.synced` + 2 rAF (`measure.sh`) |
| Screenshot latency | first per seat+board **250–550 ms** (creates the view: ~120 ms + sync); then **80–110 ms** for 1200×800 PNG (~60–130 KB); shim adds <10 ms | `canvas_screenshot` round trip through the shim (`mcp-smoke.mjs`) |
| Screenshot fidelity | Same Chromium as the user's window: pixel-identical rendering; **cross-site iframe captured** (`http://localhost:5252` in a page on `127.0.0.1:<port>`: different site, separate OOPIF process); agent cursors visible; chrome hidden | visual check of the PNGs; process count |
| File association | Works: `CFBundleDocumentTypes` (`canvas`, Editor, rank Default) in Info.plist; LaunchServices lists the app as a `.canvas` handler; `open -a App f.canvas` → `open-file`; CLI while running → `second-instance` | `NSWorkspace URLsForApplicationsToOpenURL`; app log. Default handler on this Mini is another spike's app with the same name |
| Bridge embedding | In-process in main; zero Node compat issues (ws, yjs, y-protocols, MCP SDK bundled by esbuild into a 1.9 MB `main.cjs`). Needed one refactor (BoardFile/BridgeService) that also benefits `pnpm bridge` | |
| MCP wiring | One streamable-HTTP endpoint + stdio shim on the app binary (`ELECTRON_RUN_AS_NODE=1`; reads `app.asar.unpacked`), auto-starts the app; seat per session; tools take `board` | `mcp-smoke.mjs` against dev and packaged builds |
| Dev ergonomics | web build 1.0 s, main+shim bundle 0.1 s, `electron-builder --dir` 4–6 s; `pnpm dev` = vite HMR in the app windows; main = restart. TypeScript end to end, same toolchain as the web app | wall clock |
| Security | Renderer: `contextIsolation`, `sandbox` (`app.enableSandbox()`), `nodeIntegration:false`, **no preload at all** (the renderer only talks WS/HTTP to its own origin). CSP header on the app HTML (`script-src 'self'`, `connect-src` own ws, `frame-src http: https:`, `object-src 'none'`). Popups denied (http links → default browser), navigation pinned to the app origin, `<webview>` blocked, all permission requests denied. Bridge binds 127.0.0.1; `localOnly` rejects foreign `Origin` (CSRF, cross-site WS) and non-localhost `Host` (DNS rebinding): verified 403 for each. Agent views in a separate in-memory partition | curl with forged headers |

## Cross-platform (untested, reasoning)

- **Windows**: same code; electron-builder `nsis` target writes the `.canvas` association to the registry; files arrive via argv / `second-instance` (no `open-file`; handled). Shim: the `.exe` with `ELECTRON_RUN_AS_NODE` works the same; userData path differs (shim currently hard-codes the macOS path → read `%APPDATA%`). `capturePage` on hidden windows works on Windows. Code signing matters more (SmartScreen).
- **Linux**: AppImage/deb; associations via `.desktop` + MIME XML (electron-builder generates for deb, AppImage needs integration). Hidden-window capture works on X11; on Wayland it is the shakiest platform (may need `offscreen: true` rendering for agent views). Shim path: `~/.config`.
- Same Chromium everywhere = identical rendering and identical screenshot behaviour on all three, and the headless fallback (Playwright Chromium) renders the same too. That is Electron's main argument against OS webviews.

## Gaps

- Agent-view windows are not sandboxed from each other per agent: a view sees what its seat may see only because `app.viewer` is set client-side; real per-seat secrecy needs the host model (stage 3).
- No auth on `/mcp` (any local process can join and pick a name). Tokens per agent and "unverified" labels: later, with the backend contract.
- Screenshots: no id labels drawn on nodes yet; `viewport` target has no pan/zoom tool (the agent's camera only moves via board/node targets).
- Recent files/Open dialog/menus not exercised headless (code paths only). Default app icon. No auto-update, no signing/notarization (by brief).
- Shim userData path is macOS-only; dev builds need `CANVAS_USER_DATA` passed to the shim when overridden.
- Closing the last window leaves the app running with no visible sign except the Dock (menu bar extra would fit "keeps hosting").
- Board plugins other than board/core still don't run in the bridge (see agent-bridge).
- `x-embed` iframes are view-only (`pointer-events:none`) and get `allow-same-origin` (Chromium warns; harmless for cross-site pages, would matter for a same-origin URL).

## Effort to make it real

- Product-quality shell (icon, menus polish, menu-bar extra, settings, crash/log viewer, window state restore): ~1 week.
- Signing + notarization + auto-update (electron-updater) + Windows/Linux builds in CI: ~1 week.
- Agent auth tokens, per-workspace endpoints, permissions per seat: ~1 week (shared with the backend contract work).
- Screenshot polish (id labels overlay, viewport tool, region crop, JPEG default by size): ~2 days.
- Size: 240 MB is Chromium; there's no meaningful trimming (language packs already limited to `en`). If size is the deciding metric, Tauri wins it outright; Electron buys identical rendering and mature hidden-window capture.
