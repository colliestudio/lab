# Developing on a headless Linux box

Checked on Debian 13 (x86_64), as a normal user, in a fresh container.

## Prerequisites

- `git`, `curl`, `ca-certificates`, `build-essential`, `procps` (some tests use `pgrep`).
- [mise](https://mise.jdx.dev) (`curl https://mise.run | sh`). Each `pocs/<name>/mise.toml` pins node (and pnpm 11 for canvas); run `mise trust && mise install` in the poc, then prefix commands with `mise exec --` (or activate mise in your shell). Without mise: node 22.12+ and pnpm 11 (canvas needs `pnpm@11.20`).
- Google Chrome stable for canvas screenshots and the e2e tests that use a browser (`google-chrome-stable` from Google's apt repo). No tool downloads its own Chromium. Another binary: `CANVAS_CHROME=/path/to/chrome` (canvas), `ARTIFACT_CHROME=...` (artifact), `DEMO_CHROME=...` (demo). An already running Chrome: `CANVAS_CDP=http://127.0.0.1:9222`. Without Chrome the browser tests skip and say so.
- A UTF-8 locale (`export LANG=C.UTF-8`): under `LANG=C`, `pgrep`/`ps` print non-ASCII arguments as `?` and the canvas-wait test cannot find its process.
- In a container, Chrome needs `--no-sandbox` when it is started by hand (tests that start it themselves add it). Run containers with `--init` so killed processes are reaped (a few tests check that).

## Per poc (run inside `pocs/<name>`)

| poc | install | check |
|---|---|---|
| `canvas` | `pnpm install --frozen-lockfile` | `pnpm typecheck && pnpm test && pnpm build` |
| `artifact` | `pnpm install --frozen-lockfile` | `pnpm typecheck && pnpm test` |
| `demo` | `npm ci` | no checks; `node demo.js` etc. (see its README) |

`pocs/canvas/desktop` is not part of the canvas install and is not needed here.

## Canvas serve in the foreground

```
cd pocs/canvas
pnpm build                                  # once; serve shows the built app from dist/
mkdir -p ~/boards
pnpm serve ~/boards --port 5231             # 127.0.0.1 only
pnpm serve ~/boards --port 5231 --host 0.0.0.0 --allow-origin http://<name-you-browse-to>:5231   # reachable from elsewhere
```

## macOS only

- `pocs/canvas/desktop`: the Electron app build, `package` and `publish-app` (they exit with a message on Linux).
- The always-on serve under launchd: `pnpm serve:release` / `serve:service` (`scripts/serve-service.sh`) install and start a launchd agent. Its tests run on Linux against a stub `launchctl`.
- Tests skipped off macOS: the iCloud download request (`brctl`) check; the `plutil` plist lint inside the serve-service test.
