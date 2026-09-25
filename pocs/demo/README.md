# replay-lab

Scratch prototype for **Collie Demo**: narrated, seekable demos with console / network / storage and, optionally, the backend (logs, OpenTelemetry spans, webhooks, DB changes).
Project docs: `cs/docs/projects/collie-demo/` (README.md = product, engineering.md = build notes + format v0, market.md).
Code still says "replay" until naming is locked.

## Run

```
npm i
node serve.js 7101 &                           # static server for out/ (Range support, video seeking)

node demo.js                                   # UI demo, app in-process        → out/todo-demo/
node run.js                                    # UI demo, app as a child process → out/todo-plain/
node run.js --otel                             # + server logs + OTel spans      → out/todo-otel/
node run.js --journey webhooks --otel          # backend-only demo (http stage)  → out/webhooks-otel/
node native-demo.js                            # Playwright-native video + trace → out/native/
node app/server.js --record                    # :7103, in-page recorder widget (no Playwright)

open http://localhost:7101/<name>/index.html
npx playwright show-trace out/<name>/trace.zip
```

## Pieces

| Path | What |
|---|---|
| `app/` | Todo app to film: login cookie, localStorage, SQLite, a broken `/api/report`, signed webhooks with backoff + dead-letter, optional OTel spans/log trace ids. |
| `src/recorder.js` | Playwright recorder: `record(browser, {name, url, stage})` → `say / go / click / type / pause / http.* / until / finish`. |
| `src/inpage.js` | In-page recorder (plain `<script>` + widget), no Playwright. |
| `src/backend.js` | `catcher()` webhook receiver (programmable failures), `dbWatch()` SQLite row diffs. |
| `src/bundle.js` | Writes the bundle dir + `<name>.replay` zip. |
| `src/player.js` | Bundle → one self-contained `index.html` (ui or http stage, synced panels, waterfall). |
| `run.js` | Runner: starts the app as a child, `--journey`, `--logs`, `--otel` (local OTLP receiver). |
| `journeys/` | `todo.js` (UI), `webhooks.js` (backend, `stage = "http"`). |

Format, capture internals and gotchas: see `engineering.md` in cs.
