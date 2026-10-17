# Collie Canvas (desktop app)

Version 0.2.0. A window shell over a canvas serve (the "backend"): `Collie Canvas.app`, bundle id `studio.collie.canvas`. It replaces the browser tab for daily use; the boards, the MCP endpoint and the screenshots stay on the serve (`server/serve.ts`, the always-on one on the Mini at `http://mini.internal:5310`). The app has no writer of its own and never opens the boards folder, so it cannot fight the serve over iCloud.

0.1.0 ran the bridge in the app on the iCloud folder (spike write-up: `ideas/desktop-electron.md`). That path is gone.

## Use

- **One window per board** (title = board name). Opening a board that is open focuses its window. A **Boards** window shows the serve's home page (Cmd+Shift+B).
- **Cmd+N** new board (`Untitled`, `Untitled 2`…), **Cmd+O / Cmd+K** quick switcher (the app takes these keys before the board page; File > Import .canvas File... is the import) over the serve's boards (type to filter, Enter opens, a last row creates a board with the typed name), **Cmd+W** closes the window, File > Open Recent, Window menu lists the open boards.
- Links to another board of the same backend open or focus its window; other links open in the default browser.
- Windows (board + size/position) come back on relaunch. State: `~/Library/Application Support/Collie Canvas/state.json` (backend, windows, recent); log: `logs/main.log`.
- **Backend unreachable**: the window shows the address and a reason with Retry; it also retries every 3 s and loads the board when the backend answers.
- **Collie Canvas > Backend...** sets the backend address (checked against `/api/info`; "Use anyway" for one that isn't up yet). Changing it closes the board windows and opens the Boards window.
- **Connect Claude Code...** shows `claude mcp add --transport http canvas <backend>/mcp` (the serve's endpoint, not the app's) and copies it.
- Double-clicking a `.canvas` file (or File > Import .canvas File...) imports it as a new board on the backend.

## Install and update (MacBook)

```
curl -fsSL http://mini.internal:5412/apps/install.sh | sh
```

Same command updates (downloads the newest build, checks sha256 and signature, quits a running app, replaces `~/Applications/Collie Canvas.app`, clears quarantine, opens it; the previous app comes back if the new one doesn't start). Settings are not touched.

On the Mini, after a change: `COLLIE_APPS_DIR=<served folder> pnpm --dir desktop publish-app` (unsigned arm64, ad-hoc signature) writes `collie-canvas-<yyyymmdd-hhmm>-<sha>.zip` (newest 5 kept), `collie-canvas-latest.zip`, `latest.json`, `install.sh` to `local/recap-out/apps/` (served at `http://mini.internal:5412/apps/`). A dirty worktree marks the build `-dirty`.

## Develop

- `desktop/` is its own install (not in the root workspace, so the serve release pulls no Electron): `pnpm --dir desktop install` once, then `pnpm --dir desktop typecheck`. `pnpm --dir desktop build` bundles the main process, the preload and `ui/ui.html` (the switcher, Backend and unreachable screens) into `desktop/build`. The board UI is not in the app: it is the backend's page.
- Run against a scratch serve: `CANVAS_BACKEND=http://127.0.0.1:5233 CANVAS_USER_DATA=/tmp/x pnpm --dir desktop start`. A UI change needs no app rebuild: deploy the serve. Without CANVAS_USER_DATA the override is for that run only (nothing read from or written to state.json).
- `pnpm --dir desktop test:e2e` (builds first; refuses a port that is already listening): Electron (Playwright) against a scratch serve it starts itself (needs `pnpm build` first); logic tests are `desktop/src/logic.test.ts` in `pnpm test`.
- Security: backend pages run sandboxed, no node, no preload API; only the app's own `ui.html` gets the shell bridge (checked in the preload and on each IPC call).

## Known gaps

- Unsigned (ad-hoc), no auto-update: the install command is the update path.
- Online only: no local or offline mode; the backend must be reachable (tailnet).
- A backend page can open any number of board windows (and, through window.open, browser tabs); fine for a backend you chose, unguarded for one you do not trust.
- Window title is the name the window was opened with: a rename on the serve is not followed.
- The `.canvas` file association stays (imports); the default handler for `.canvas` becomes this app once installed.
- Nothing tested from the MacBook yet (install, Gatekeeper, tailnet latency).
