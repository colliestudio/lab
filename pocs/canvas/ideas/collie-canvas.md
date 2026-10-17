# Collie Canvas (desktop app)

Version 0.3.1. A window shell over a canvas serve (the "backend"): `Collie Canvas.app`, bundle id `studio.collie.canvas`. It replaces the browser tab for daily use; the canvases, the MCP endpoint and the screenshots stay on the serve (`server/serve.ts`, the always-on one on the Mini at `http://mini.internal:5310`). The app has no writer of its own and never opens the canvases folder, so it cannot fight the serve over iCloud.

0.1.0 ran the bridge in the app on the iCloud folder (spike write-up: `ideas/desktop-electron.md`). That path is gone.

## Use

- **One main window.** It shows the canvas list or one canvas and navigates in place, like the website: opening a canvas (switcher, link, Open Recent, Cmd+N) replaces what it shows. **Cmd+[ / Cmd+]** (Go menu) go back and forward; **Cmd+Shift+B** goes to the canvas list. Title = canvas name.
- **Pop out**: File > **Open in Own Window** (Cmd+Shift+O), or **Alt+Enter** in the switcher, opens a canvas as a separate app process with its own Dock icon and Cmd+Tab entry, one window, titled with the canvas name. Dock icon = first letter on a color that stays the same for that name. The main window leaves that canvas (goes to the list). Close the window to end the pop-out.
- **No duplicate**: opening a canvas that is popped out (switcher, link, Open Recent, back/forward landing on it) focuses its window instead. The switcher marks them "own window". The Window menu lists them.
- **Cmd+N** new canvas (`Untitled`, `Untitled 2`...), **Cmd+O / Cmd+K** quick switcher (the app takes these keys before the canvas page; File > Import .canvas File... is the import): type to filter, Enter opens here, Alt+Enter in its own window, a last row creates a canvas with the typed name. **Cmd+W** closes the window.
- In a pop-out, links to another canvas, the switcher, Cmd+N and "Canvases" hand over to the main app (started if it isn't running); a pop-out only ever shows its own canvas.
- **Restore**: the main window (canvas, size, position) and the pop-outs come back on relaunch. Quitting the main app leaves running pop-outs running (independent processes). A pop-out you closed is not brought back; one that was running when the app or machine quit is, on the next launch of the main app. State: `~/Library/Application Support/Collie Canvas/state.json` (backend, main window, recent), `popouts/<name>-<hash>/` (one folder per pop-out: its Electron profile, `instance.json`), `shims/`; logs: `logs/main.log` in each. A 0.2 state file (list of windows) opens its first window as the main window.
- **Backend unreachable**: the window shows the address and a reason with Retry; it also retries every 3 s.
- **Collie Canvas > Backend...** sets the backend address (checked against `/api/info`; "Use anyway" for one that isn't up yet). Changing it closes the pop-outs (not brought back) and opens the canvas list.
- **Connect Claude Code...** shows `claude mcp add --transport http canvas <backend>/mcp` and copies it.
- Double-clicking a `.canvas` file (or File > Import .canvas File...) imports it as a new canvas on the backend.

## How pop-outs work

- One binary, two roles. `Collie Canvas --canvas=<name>` is a pop-out: own Electron profile under `popouts/<slug>-<hash>/` (so the single-instance lock is per canvas), own process, own Dock icon (`app.dock.setIcon` with a PNG the app draws from `ui.html?mode=icon`).
- Coordination: unix sockets in the per-user temp folder (`$TMPDIR/collie-canvas-<hash of data dir>/`, owner and mode checked; short paths, macOS limits them to 104 bytes). A pop-out answers ping / focus / quit; the main app answers ping / open. Registry = `popouts/*/instance.json` (canvas, pid, keep, sock, title, url, icon, focus count). A pop-out is "running" only if its socket answers; a stale file or socket is ignored and replaced.
- **Cmd+Tab and Dock name**: macOS lists an app by its bundle's `CFBundleDisplayName`, so each pop-out runs from `shims/<slug>-<hash>.app`: an APFS clone (`cp -c`, ~15 ms) of the app with its Info.plist display name and bundle id changed (`plutil`), document types dropped, and the outer bundle re-signed ad hoc (not `--deep`: that rewrites the 200 MB framework; the clone costs ~100 KB; first time ~0.5 s), rebuilt when the app is updated. `lsappinfo` lists it as the canvas name (checked on the Mini). `CFBundleName` must stay (Electron finds its helper apps by it). If the clone fails the pop-out runs from the app itself and is listed as "Collie Canvas". Dev runs (`pnpm start`) always use the plain binary.
- **Cost per pop-out** (Mini, one canvas open): ~400 MB RSS (main process + GPU + renderer helpers; shared framework pages are counted in each) and ~8 MB of profile on disk, against ~380 MB for the main app. Idle pop-outs are not suspended. Many pop-outs add up; the point is to keep a few canvases one Cmd+Tab away.
- **Restore safety**: `keep` becomes true only once the pop-out's window has shown; the main app restarts a kept, not-running pop-out at most twice in a row (`starts`), then gives up (logged). On main start, profiles of pop-outs that are neither running nor kept, and clones that belong to none of them or come from another build of the app, are deleted (only inside `popouts/` and `shims/`). Runs with `CANVAS_BACKEND` and no `CANVAS_USER_DATA` neither keep nor restore pop-outs. install.sh also ends running pop-outs (SIGTERM); the new app brings them back.
- Test hooks (`CANVAS_TEST=1`): `CANVAS_TEST_TTL=<s>` ends an instance by itself.

## Install and update (MacBook)

```
curl -fsSL http://mini.internal:5412/apps/install.sh | sh
```

Same command updates (downloads the newest build, checks sha256 and signature, quits a running app, replaces `~/Applications/Collie Canvas.app`, clears quarantine, opens it; the previous app comes back if the new one doesn't start). Settings are not touched.

On the Mini, after a change: `COLLIE_APPS_DIR=<served folder> pnpm --dir desktop publish-app` (unsigned arm64, ad-hoc signature) writes `collie-canvas-<yyyymmdd-hhmm>-<sha>.zip` (newest 5 kept), `collie-canvas-latest.zip`, `latest.json`, `install.sh` to `local/recap-out/apps/` (served at `http://mini.internal:5412/apps/`). A dirty worktree marks the build `-dirty`.

## Develop

- `desktop/` is its own install (not in the root workspace, so the serve release pulls no Electron): `pnpm --dir desktop install` once, then `pnpm --dir desktop typecheck`. `pnpm --dir desktop build` bundles the main process, the preload and `ui/ui.html` (the switcher, Backend, unreachable and icon pages) into `desktop/build`. The canvas UI is not in the app: it is the backend's page.
- Run against a scratch serve: `CANVAS_BACKEND=http://127.0.0.1:5233 CANVAS_USER_DATA=/tmp/x pnpm --dir desktop start`. A UI change needs no app rebuild: deploy the serve. Without CANVAS_USER_DATA the override is for that run only (nothing read from or written to state.json).
- `pnpm --dir desktop test:e2e` (builds first; refuses a port that is already listening): Electron (Playwright) against a scratch serve it starts itself (needs `pnpm build` first); logic and socket tests are `desktop/src/*.test.ts` in `pnpm test`; the e2e spawns real pop-out processes, which end by `CANVAS_TEST_TTL` at the latest and are quit over their sockets.
- Security: backend pages run sandboxed, no node, no preload API; only the app's own `ui.html` gets the shell bridge (checked in the preload and on each IPC call).

## Known gaps

- Unsigned (ad-hoc), no auto-update: the install command is the update path.
- Online only: no local or offline mode; the backend must be reachable (tailnet).
- A backend page can start pop-outs only through links to its own canvases; fine for a backend you chose, unguarded for one you do not trust.
- Window title is the name the window was opened with: a rename on the serve is not followed (a popped-out canvas that is renamed or deleted keeps its old name).
- One main window only (no second main window); a pop-out can't be moved back into the main window (close it and open the canvas there).
- Dock icon and Cmd+Tab name were checked through `lsappinfo` and the rendered PNG, not by eye (the Mini's screen is not available to agents).
- The `.canvas` file association stays (imports); the default handler for `.canvas` becomes this app once installed.
- Nothing tested from the MacBook yet (install, Gatekeeper, tailnet latency).
