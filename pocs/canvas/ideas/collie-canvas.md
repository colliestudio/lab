# Collie Canvas (desktop app)

The Electron shell from the desktop spike, on current `poc`, named **Collie Canvas** (`Collie Canvas.app`, bundle id `studio.collie.canvas`). Double-click a `.canvas`, it opens in its own window; the app's back end is the bridge (in-process), so agents join through one MCP endpoint. Scorecard and design of the spike: branch `idea/desktop-electron`, `ideas/desktop-electron.md` (kept here too).

## Install and update (MacBook)

```
curl -fsSL http://mini.internal:5412/apps/install.sh | sh
```

Same command updates. It downloads the newest build, checks the sha256 and the app's signature, quits a running Collie Canvas (osascript), replaces `~/Applications/Collie Canvas.app`, clears quarantine, opens it and prints the version. The previous app is kept (hidden, next to it) until the new one has stayed up 2 s; if it doesn't start, the old one goes back. Boards and settings are not touched.

On the Mini, after a change: `pnpm --dir desktop publish-app` (build ~10 s, unsigned arm64) writes to `local/recap-out/apps/` (served at `http://mini.internal:5412/apps/`): `collie-canvas-<yyyymmdd-hhmm>-<sha>.zip` (newest 5 kept), `collie-canvas-latest.zip`, `latest.json`, `install.sh`. The build number and sha show in the app's About panel and `latest.json`; a build from a dirty worktree is marked `-dirty`.

Tested on the Mini only, against a temp install dir: fresh install, update while the app runs (polite quit), failed launch restores the backup, launch of the packaged app, MCP through the packaged shim.

## What is in it

- Window per file; File > New / Open / Open Recent; `.canvas` file association (Info.plist; registered by LaunchServices once the app sits in `~/Applications`).
- Bridge in the main process (`bridge/board.ts` = one file, `bridge/service.ts` = one HTTP/WS server for many files), serving the built web app on `127.0.0.1:<random port>`. One guard (`bridge/guard.ts`: Origin/Host/JSON POST, `--allow-origin`) covers HTTP, WebSocket and `/mcp`; the dev loop adds the vite origin to it.
- One MCP endpoint `/mcp`, a seat per session. Tools: `list_canvases`, `open_canvas`, `canvas_*`, `canvas_screenshot` (hidden agent window), `chess_*`, `chat_*`. Tools take `board` to pick the file; the chess and chat tools use `canvas` for that (their `board` is the chessboard). Optional when one file is open.
- Everything from poc rides along (chat, chess rules, eventstorm, frames, prototype with page sandbox, undo changes).
- Connect Claude Code: Collie Canvas menu (or Agents menu) shows the exact `claude mcp add collie-canvas …` command; the shim runs on the app binary and starts the app if it isn't running.
- Renamed: product/window titles/menus "Collie Canvas", userData `~/Library/Application Support/Collie Canvas`, MCP server and shim `collie-canvas`. New icon (placeholder: two linked cards).

## Where boards live

Default folder: `~/Library/Mobile Documents/com~apple~CloudDocs/Collie Canvas/` (iCloud Drive > Collie Canvas), created at launch; `~/Collie Canvas/` when iCloud Drive isn't set up. Open and New dialogs start there; `.canvas` files anywhere still open. Same iCloud account on Mini and MBP = the same boards on both.

iCloud risks and what the app does about them:

| risk | handling |
|---|---|
| File evicted to a cloud-only (dataless) placeholder | before opening, the file is read off the main loop (macOS downloads it on read); an old-style `.name.canvas.icloud` stub is fetched with `brctl download` (30 s limit) and opening the stub maps to the real name |
| Bridge state (`.canvas-bridge/*.ystate`) syncing between Macs and clashing | state lives in `Application Support/Collie Canvas/boards/<id>/`, keyed by file path; nothing but the `.canvas` is in the iCloud folder |
| Half-written temp file reaching iCloud | atomic write goes through a dotfile (`.name.canvas.tmp`), which iCloud doesn't sync |
| `fs.watch` missing changes that arrive from another Mac | plus a 5 s stat poll per open board; a changed file merges into the live doc (3-way) like any edit |
| Delayed sync, conflict copies ("board 2.canvas") | not handled: a copy is just another board in the folder. Two Macs editing the same board at the same moment is last-writer-wins at iCloud level, then merged by the app per Mac once it arrives. Don't leave a board open on both Macs and expect live collaboration; use a room for that |
| Folder in the Open dialog showing only local files | Finder-level; dataless files do show with the cloud icon on macOS 26 |

Untested here (no iCloud on the Mini's test account): the iCloud path itself, eviction, real sync.

## Known gaps

- **Unsigned**, ad-hoc signature only. Install.sh clears quarantine. No auto-update (the script is the update path), no notarization.
- **No remote-bridge mode yet**: the bridge runs inside the app. Next step: a setting for local or remote bridge (code on the Mini, app on the MBP, e.g. via tunnel), and bridge as a supervised utilityProcess.
- Agents on the Mini can't reach the MBP app's endpoint (it binds 127.0.0.1); the app on the MBP serves agents on the MBP only.
- Nothing from the MacBook side was tested (install, iCloud, Gatekeeper behaviour of the ad-hoc build, file association default handler). If macOS refuses the app: `xattr -dr com.apple.quarantine "~/Applications/Collie Canvas.app"`.
- Spike gaps still apply: no auth on `/mcp`, no menu-bar extra, `x-embed` iframes view-only.
