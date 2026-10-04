---
kind: review
title: Demos capture the backend - logs, traces, webhooks, DB rows
tldr: A demo can now record what the server did - logs, OTel spans linked to each browser request, outbound webhooks and SQLite row changes - and backend-only features get their own card-based "http" stage.
status: ready
risk: low
risk_why: Lab code with no users; the lasting part is four new optional streams in the replay/0 format that the real Collie Demo will inherit, so their shapes are what to get right.
ask: Approve the four stream shapes (server, spans, inbound, db) as the replay/0 baseline; check the trace-propagation approach (browser fetch patch, root span in the browser).
repo: alexluong/replay-lab
base: caf9d31
head: 4f680ea
author: recap-lab samples agent
date: 2026-10-05
---

```map
groups:
  - { id: capture, label: Recording (runner process) }
  - { id: subject, label: App under demo (child process) }
  - { id: output, label: Output }
nodes:
  - { id: journeys, label: "Journeys (todo, webhooks)", kind: module, change: added, group: capture, section: journeys, files: [journeys/*, demo.js] }
  - { id: runner, label: Runner run.js, kind: service, change: added, group: capture, section: runner, files: [run.js] }
  - { id: backend-taps, label: Catcher + DB watch, kind: module, change: added, group: capture, section: runner, files: [src/backend.js] }
  - { id: recorder, label: "Recorder (r.say, r.http, r.until)", kind: module, change: changed, group: capture, section: recorder, files: [src/recorder.js] }
  - { id: todo-app, label: Todo app + webhooks, kind: service, change: changed, group: subject, section: app, files: [app/server.js] }
  - { id: app-db, label: "SQLite (todos, webhooks, deliveries)", kind: db, change: added, group: subject, section: app }
  - { id: otel-sdk, label: OTel auto-instrumentation, kind: external, change: added, group: subject, section: runner }
  - { id: bundle, label: Bundle writer (replay/0), kind: module, change: changed, group: output, section: format, files: [src/bundle.js] }
  - { id: player, label: "Player (Server tab, waterfall, http stage)", kind: ui, change: changed, group: output, section: player, files: [src/player.js] }
  - { id: deps, label: package.json + lockfile, kind: config, change: changed, mechanical: true, section: mechanical, files: [package.json, package-lock.json] }
edges:
  - { from: journeys, to: recorder, label: "say / http / until" }
  - { from: runner, to: todo-app, label: "spawn (+ OTel loader)", change: added }
  - { from: recorder, to: todo-app, label: "requests + traceparent", change: changed }
  - { from: todo-app, to: app-db, label: read/write, change: added }
  - { from: todo-app, to: backend-taps, label: signed webhooks, change: added }
  - { from: backend-taps, to: app-db, label: polls rows, change: added }
  - { from: otel-sdk, to: runner, label: OTLP spans, change: added }
  - { from: todo-app, to: runner, label: stdout/stderr, change: added }
  - { from: runner, to: bundle, label: "finish(extra streams)", change: added }
  - { from: recorder, to: bundle, label: core streams }
  - { from: bundle, to: player, label: .replay }
```

Before this range the recorder only saw the browser. Now `run.js` owns the app as a child process and collects four kinds of backend evidence next to the browser streams, all on one clock and joined by W3C trace ids: the browser request is the root span, the server's spans and log lines hang off it, and the webhook catcher's hits join through their `traceparent`. The todo app grew a real backend feature (signed webhooks with retries) to have something worth demoing, and journeys that need no page at all play on a new `http` stage.

```questions
- q: Keep the OTel packages as hard dependencies of the recorder?
  options: [dependencies (now), optionalDependencies, the app brings its own SDK]
  recommend: the app brings its own SDK
  why: The runner only needs an OTLP receiver; the SDK belongs to the app under demo. Shipping auto-instrumentations with Collie Demo adds ~2.6k lockfile lines for an opt-in feature.
```

## Format: four optional backend streams {#format}

The `replay/0` bundle gains `server`, `spans`, `inbound` and `db` streams, written only when a recording has them, so a browser-only `.replay` is byte-for-byte the same shape as before.

```data-model
entities:
  - name: server.json (one entry per log line)
    change: added
    fields:
      - { name: t, type: epoch ms, change: added }
      - { name: stream, type: "stdout | stderr", change: added }
      - { name: text, type: string, change: added, note: app's own timestamp/trace prefix stripped }
      - { name: traceId, type: "32 hex?", change: added, note: parsed from the app's trace= log prefix }
  - name: spans.json (one entry per OTel span)
    change: added
    fields:
      - { name: traceId / spanId / parentSpanId, type: hex, change: added }
      - { name: name, type: string, change: added }
      - { name: kind, type: "OTel SpanKind (2 server, 3 client)", change: added }
      - { name: service, type: string, change: added }
      - { name: start / end, type: epoch ms, change: added }
      - { name: status, type: "error?", change: added }
      - { name: attributes, type: object, change: added }
  - name: inbound.json (one entry per request the catcher received)
    change: added
    fields:
      - { name: t, type: epoch ms, change: added }
      - { name: method / path / headers / body, change: added }
      - { name: status, type: int, change: added, note: what the catcher answered (scripted) }
      - { name: traceId / parentSpanId, change: added, note: from the incoming traceparent }
  - name: db.json (one entry per row change)
    change: added
    fields:
      - { name: t, type: epoch ms, change: added }
      - { name: table, type: string, change: added }
      - { name: op, type: "snapshot | insert | update | delete", change: added }
      - { name: key, type: rowid, change: added }
      - { name: changed / before / after, change: added, note: update carries only the changed columns }
  - name: network.json entry
    change: changed
    fields:
      - { name: traceId / spanId, type: hex, change: added, note: from the request's traceparent }
      - { name: type, type: "+ 'api'", change: changed, note: calls made by r.http }
  - name: manifest.json
    change: changed
    fields:
      - { name: stage, type: "ui | http", change: added }
      - { name: counts / files, change: changed, note: list optional streams only when present }
```

```diff file=src/bundle.js hunks=1
@8: The opt-in list. Anything not here is not written, even if a caller passes it.
@14: Empty optional streams are dropped from files and counts, so old readers see an unchanged manifest.
```

```files
src/bundle.js: optional streams; sorts the new ones by t
```

## Recorder: trace context and API calls {#recorder}

Every same-origin `fetch` from the page and every `r.http` call now carries a fresh `traceparent`, so the network row is the root of the server's trace. Journeys get `r.http.*` for API-only steps, `r.until` for effects that land after the response, and `stage: "http"` for recordings with no page.

```flow
sequenceDiagram
  participant P as Page fetch / r.http
  participant R as Recorder
  participant A as App (OTel)
  participant C as Catcher
  P->>R: request + traceparent 00-T-S-01
  R->>R: network row {traceId T, spanId S}
  P->>A: request
  A->>A: server span (parent S), db span
  A->>C: webhook POST + traceparent (parent = deliver span)
  C->>C: inbound row {traceId T}
  A-->>R: spans via OTLP, logs "trace=T"
```

```diff file=src/recorder.js hunks=1,4
@31: Patches window.fetch in the page. XHR, document and static requests get no traceparent, so they never link to backend spans.
@35: Respects a traceparent the app already set.
@124: Playwright's context.request emits no request events and is absent from library-mode traces, so the call is recorded by hand.
@126: The client is the root span here too, same as the browser path.
```

```files
src/recorder.js: traceparent fetch patch; stage; r.http, r.until, onStep, stream(); finish(outDir, extra)
```

## Runner: the app as a child, plus backend taps {#runner}

`run.js` starts the app itself, so it can stamp its stdout/stderr on the replay clock (`--logs`), boot it under OTel zero-code instrumentation with a local OTLP receiver (`--otel`), and hand journeys a programmable webhook catcher and a SQLite row watcher.

```diff file=run.js hunks=1
@19: The journey module declares its stage; webhooks.js exports stage = "http".
@33: OTLP/HTTP JSON receiver in ~25 lines: no collector, no SDK in the runner.
@60: ESM apps need the loader hook; --import alone leaves node:http uninstrumented and every span becomes its own root.
@78: Log lines link to traces only because the demo app prints trace=<id>. A real app needs its logger to do the same.
@111: Keep-alive sockets on the receiver hold the process open.
```

```diff file=src/backend.js hunks=1
@9: Scripted answers: respond([500, 500]) fails the next two deliveries, then 200s.
@14: The catcher joins the trace through the incoming traceparent: its parent is the app's outbound span.
@48: Polling every 120 ms, so short-lived states (pending, sending) are usually missed. A trigger or CDC hook would be exact.
```

```callout tone=warn
`dbWatch` takes SQLite only and reads the file read-only while the app writes it. Postgres needs a different tap (logical replication or triggers).
```

```files
run.js: new runner (--journey, --logs, --otel)
src/backend.js: catcher + dbWatch
```

## Todo app: signed webhooks with retries {#app}

The demo app moves from an in-memory array to `node:sqlite` and gains a real backend feature: each new todo is POSTed, HMAC-signed, to every registered webhook, retried after 300/600/1200 ms and dead-lettered after 4 attempts. Optional OTel spans and a `trace=` log prefix are no-ops without the SDK.

```flow
stateDiagram-v2
  [*] --> pending: todo created
  pending --> sending: attempt n
  sending --> delivered: 2xx
  sending --> retrying: non-2xx, n ≤ 3
  retrying --> sending: after 300 / 600 / 1200 ms
  sending --> dead: non-2xx, n = 4
```

```api
endpoints:
  - method: POST
    path: /api/webhooks
    change: added
    summary: Register a receiver URL; returns its signing secret.
    request: '{"url": "http://127.0.0.1:PORT/hook"}'
    response: '{"id": 1, "url": "…", "secret": "whsec_…"}'
  - method: GET
    path: /api/deliveries
    change: added
    summary: Delivery history - status, attempts, last HTTP status.
    response: '[{"id": 1, "webhook_id": 1, "event": "todo.created", "status": "delivered", "attempts": 1, "last_status": 200}]'
  - method: POST
    path: /api/todos
    change: changed
    summary: Now inserts into SQLite and enqueues a todo.created delivery per webhook.
  - method: POST
    path: "{webhook.url} (outbound)"
    change: added
    summary: "Headers x-webhook-event, x-webhook-signature: sha256=<hmac>, x-webhook-attempt."
    request: '{"id": 3, "event": "todo.created", "data": {"id": 2, "text": "Ship webhooks", "done": false}}'
```

```diff file=app/server.js hunks=2,3
@15: DB_PATH points the app at a file the runner's dbWatch can read; in-memory otherwise.
@27: @opentelemetry/api is imported optionally, so the app runs unchanged without the SDK.
@42: Backoff is a constant, not config. Fine for a demo app.
@47: Retries stay in the originating request's trace (AsyncLocalStorage survives setTimeout). Good for the waterfall, but one POST /api/todos trace now spans seconds.
@54: Signature over the exact body bytes sent.
@65: Dead-lettered after BACKOFF.length + 1 = 4 attempts.
@138: The response carries the signing secret, so it lands in network.json of every recording.
```

```callout tone=risk
**Secrets in recordings.** `POST /api/webhooks` returns `whsec_…`, and the recorder stores response bodies verbatim. The bundled `webhooks-otel.replay` contains one (a throwaway local secret). Redaction at record time is planned in the notes, not built; anything published before then leaks such values.
```

## Journeys: shared todo, new webhooks {#journeys}

The todo journey moves out of `demo.js` into `journeys/todo.js` so both runners use it; `journeys/webhooks.js` is the first `http`-stage journey: three scenarios, all driven through the API with the catcher scripted to fail.

```demo
src: demos/webhooks-otel.replay
steps: [2, 3, 4]
caption: Recorded with `node run.js --journey webhooks --otel` (lab HEAD 174bedd; this range's code paths unchanged since). Watch the Received cards - attempt 1 delivered, attempts 1-3 with two 500s, then four 503s and a dead row in the DB cards.
```

```files
journeys/todo.js: moved from demo.js, unchanged steps
journeys/webhooks.js: new, stage = "http"
demo.js: now imports the shared journey
```

## Player: Server tab, waterfall, http stage {#player}

The player shows the new streams when present: a Server tab of log lines, a per-request waterfall (browser root → server → db / outbound → receiver) under a network row's detail, and, for `http` recordings, a card timeline with its own play/scrub clock instead of the rrweb pane.

```demo
src: demos/todo-otel.replay
steps: [5]
caption: Recorded with `node run.js --journey todo --otel`. Step 5 clicks Export report; open the 500 in Network to see the waterfall - server span, db.todos.select, the failing POST to the report worker - and its stderr line.
```

```diff file=src/player.js hunks=8
@291: The waterfall is built per network row from spans sharing its traceId.
@293: Catcher hits become synthetic leaf spans, parented by the outbound span id they received.
@300: Tree by parentSpanId; spans whose parent never arrived are still listed, at depth 1.
```

```callout tone=info
The `http` stage (hunk 5, ~80 lines of string-built HTML) is lab-quality by design. Its seams - the stage switch on `manifest.stage` and `setNow()` replacing the rrweb clock - are what the real player keeps.
```

```files
src/player.js: Server tab, trace links, waterfall, http-stage cards + clock
```

## Dependencies {#mechanical .mechanical}

`@opentelemetry/api` and `@opentelemetry/auto-instrumentations-node` added as regular dependencies; the lockfile grows by ~2,600 lines, all from the auto-instrumentations bundle.

```checklist
- node run.js --journey webhooks --otel → counts show server, spans, inbound, db; player shows cards
- node run.js --journey todo --otel → Network row for /api/report shows "⧉ trace" and a waterfall
- node demo.js → browser-only bundle has no server/spans/inbound/db files
```
