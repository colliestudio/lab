# replay-lab

Scratch prototype: narrated, seekable DOM replays with console / network / storage, recorded by a Playwright script. Project docs: `cs/docs/projects/collie-demo/` (README.md = product, engineering.md = build notes, market.md).

```
npm run record        # runs demo.js → out/todo-demo/ + out/todo-demo.replay
open out/todo-demo/index.html
npx playwright show-trace out/todo-demo/trace.zip   # the same run in Playwright's trace viewer
```

## Pieces

- `app/`: a tiny todo app to film: a login cookie, localStorage, fetches, and a broken endpoint that throws.
- `src/recorder.js`: `record(browser, {name, url})` → `{page, say, go, click, type, pause, finish}`.
- `src/player.js`: bundle dir → one self-contained `index.html`.
- `demo.js`: the journey (what an agent would write).

## Bundle (`<name>.replay` = zip)

| file | what | source |
|---|---|---|
| manifest.json | name, url, start, duration, viewport, color scheme, counts | recorder |
| rrweb.json | DOM replay events | rrweb, injected in-page → `exposeBinding` |
| steps.json | `{t, text}` captions | `say()` (also an rrweb custom event → timeline marker) |
| console.json | `{t, level, text, source/stack}` | `page.on('console')`, `page.on('pageerror')` |
| network.json | method, url, type, status, timing, headers, bodies (fetch/xhr/document, ≤64 KB) | `context.on('request' / 'requestfinished' / 'requestfailed')` |
| storage.json | event log: cookie snapshots on change; local/session `snapshot`, `set`, `remove`, `clear` | cookies: `context.cookies()` after each response; storage: in-page `Storage.prototype` patch |
| trace.zip | the full Playwright trace | `context.tracing` |

Every stream is stamped with `Date.now()` on one machine, so the player lines them up against rrweb's own timestamps.
Storage is event-sourced: the player replays writes up to the current time to show the state *at that moment*.
