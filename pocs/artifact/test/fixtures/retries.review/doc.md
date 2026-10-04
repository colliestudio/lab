---
kind: review
title: Retry failed webhook deliveries
tldr: Failed deliveries now retry with capped exponential backoff, every attempt is recorded, and operators can list and replay failed deliveries.
status: ready
risk: medium
risk_why: Changes the delivery worker's ack path; a bug here drops or duplicates events.
ask: Approve the backoff caps (30s base, 1h cap, 8 attempts); check the migration is reversible.
repo: acme/relay
base: main
head: feat/retries
pr: https://github.com/acme/relay/pull/1093
plan: ../retries.plan
author: dev agent
date: 2026-10-05
---

# Retry failed webhook deliveries

```map
groups:
  - { id: delivery, label: Delivery worker }
nodes:
  - { id: queue, label: Delivery queue, kind: queue, change: unchanged }
  - { id: destination, label: Customer endpoint, kind: external, change: unchanged }
  - { id: worker, label: Worker ack path, kind: job, change: changed, group: delivery, section: worker, files: [internal/delivery/worker.go] }
  - { id: retry, label: Retry scheduler, kind: module, change: added, group: delivery, section: retry, files: ["internal/delivery/retry*.go"] }
  - { id: metrics, label: Delivery metrics, kind: module, change: added, group: delivery, section: metrics, files: [internal/delivery/metrics.go] }
  - { id: attempts, label: Attempts table, kind: db, change: added, section: attempts, files: ["internal/store/**"] }
  - { id: api, label: Deliveries API, kind: api, change: changed, section: api, files: ["internal/api/**", "docs/**"] }
  - { id: ui, label: Failed deliveries page, kind: ui, change: added, section: ui, files: ["web/src/**", "web/public/**"] }
  - { id: mechanical, label: "Lockfile, renames, formatting", kind: config, change: changed, mechanical: true, section: mechanical, files: [web/pnpm-lock.yaml, scripts/**, internal/clock/**, web/src/styles.css] }
edges:
  - { from: queue, to: worker, label: receive }
  - { from: worker, to: destination, label: POST event }
  - { from: worker, to: retry, label: on 5xx / 429 / error, change: added }
  - { from: retry, to: queue, label: nack with backoff delay, change: added }
  - { from: worker, to: attempts, label: record attempt, change: added }
  - { from: worker, to: metrics, label: count, change: added }
  - { from: ui, to: api, label: list failed / replay, change: added }
  - { from: api, to: attempts, label: read history, change: added }
  - { from: api, to: queue, label: replay = enqueue attempt 0, change: added }
```

Before this change a failed delivery was acked and dropped. Now the worker records every attempt, hands failures to a retry scheduler that re-enqueues them with capped exponential backoff, and gives up after 8 attempts. Operators get a page listing failed deliveries with a replay button. Read the worker first: everything else hangs off its new ack path.

## Worker ack path {#worker}

The worker no longer acks failed deliveries: it records the attempt, then either nacks the job with a backoff delay or, once attempts run out, acks it as permanently failed.

```flow caption="One delivery attempt, after this change"
sequenceDiagram
  participant Q as Delivery queue
  participant W as Worker
  participant D as Customer endpoint
  participant A as Attempts table
  participant R as Retry scheduler
  Q->>W: receive job (attempt n)
  W->>D: POST event
  D-->>W: 503
  W->>A: record attempt n (status 503)
  W->>R: Next(n, now)
  alt attempts left
    R-->>W: at = now + jitter(min(30s·2ⁿ, 1h))
    W->>Q: nack(job, at)
  else exhausted
    W->>Q: ack (failed permanently)
  end
```

```callout tone=risk
**Ack ordering.** If recording the attempt fails, the worker returns without ack or nack, so the queue redelivers after its visibility timeout. That keeps at-least-once delivery but can send the same event twice. Destinations already dedupe on `event_id`.
```

```diff file=internal/delivery/worker.go hunks=2
@42: 429 now counts as a retryable failure, same as 5xx and network errors.
@45: No ack when the attempt can't be recorded: the queue redelivers (at-least-once).
@49: Nack with a delay is how the backoff is applied; the queue holds the job until `next`.
@61: The success-path record error is ignored on purpose: the event was delivered, history is best-effort.
```

The constructor grew three dependencies; wiring in `cmd/relay` is unchanged because it builds the worker through `delivery.New`, which already had them.

```diff file=internal/delivery/worker.go hunks=1
```

## Retry scheduler {#retry}

New `RetryScheduler`: capped exponential backoff with full jitter. Defaults are 30s base, 1h cap, 8 attempts, so a destination that is down for about 2 hours still gets every event.

```code lang=go file=internal/delivery/retry.go
// Next returns when attempt+1 should run, or ok=false when attempts are exhausted.
func (r *RetryScheduler) Next(attempt int, now time.Time) (at time.Time, ok bool) {
	if attempt >= r.MaxAttempts {
		return time.Time{}, false
	}
	d := r.Base << attempt
	if d <= 0 || d > r.Cap {
		d = r.Cap
	}
	jitter := time.Duration(rand.Int64N(int64(d)))
	return now.Add(jitter), true
}
```

```callout tone=decision
Full jitter (uniform in `[0, d)`) over equal jitter: it spreads a burst of failures from one outage better, at the cost of an occasional very short first retry.
```

```questions
- q: Max attempts before giving up?
  options: ["8 (~2h of retries)", "12 (~10h)", "configurable per destination"]
  recommend: "8 (~2h of retries)"
  why: Matches the plan and keeps the queue small; per-destination config can come later without a migration.
```

```diff file=internal/delivery/retry_test.go
```

## Attempts table {#attempts}

One row per delivery attempt, plus a `last_status` column on `deliveries` so the failed list doesn't need a join. The down migration drops both.

```data-model
entities:
  - name: delivery_attempts
    change: added
    note: One row per attempt; indexed by (event_id, attempt).
    fields:
      - { name: id, type: bigserial, change: added }
      - { name: event_id, type: text, change: added }
      - { name: attempt, type: int, change: added, note: "0 = first try; replay starts again at 0" }
      - { name: status, type: int, change: added, note: "HTTP status, 0 on network error" }
      - { name: error, type: text, change: added }
      - { name: created_at, type: timestamptz, change: added }
  - name: deliveries
    change: changed
    fields:
      - { name: id, type: text, change: unchanged }
      - { name: event_id, type: text, change: unchanged }
      - { name: last_status, type: text, change: added, note: "pending | delivered | failed" }
```

```diff
--- a/internal/store/migrations/0012_delivery_attempts.down.sql
+++ b/internal/store/migrations/0012_delivery_attempts.down.sql
@@ -0,0 +1,2 @@
+ALTER TABLE deliveries DROP COLUMN last_status;
+DROP TABLE delivery_attempts;
@1: Drops the column first; safe to run with the worker stopped.
```

```files
internal/store/attempts.go: Record / ForEvent; plain SQL, no ORM.
internal/store/migrations/0012_delivery_attempts.up.sql: ""
internal/store/migrations/0012_delivery_attempts.down.sql: ""
```

## Delivery metrics {#metrics}

Three Prometheus counters (delivered, retried, exhausted) so the retry rate is visible. Not in the plan; added because the alert in the plan needs a signal.

```diff file=internal/delivery/metrics.go
@14: Metric names follow the existing `relay_` prefix.
```

## Deliveries API {#api}

`GET /deliveries` takes a `status` filter, and two endpoints are new: attempt history and replay. The old retries doc, which told destinations to poll, is deleted.

```api
endpoints:
  - method: GET
    path: /deliveries
    change: changed
    summary: New `status` query param (failed | delivered).
    request: "GET /deliveries?status=failed"
  - method: GET
    path: /deliveries/{id}/attempts
    change: added
    summary: Attempt history for one delivery.
    response: '[{"EventID": "evt_1", "Number": 0, "Status": 503, "Error": "", "At": "2026-10-05T09:00:00Z"}]'
  - method: POST
    path: /deliveries/{id}/replay
    change: added
    summary: Re-enqueue as attempt 0; history is kept.
    response: '{"status": "queued"}'
```

```diff file=internal/api/deliveries.go
@18: Both new routes are tenant-scoped through `tenantFrom(r)` inside the store calls.
```

```callout tone=warn
Replay doesn't check whether the delivery is actually failed; replaying a delivered event sends it again. Fine for operators, but worth a guard before this is exposed to tenants.
```

## Failed deliveries page {#ui}

A new page at `/deliveries/failed` lists failed deliveries with a Replay button; replayed rows disappear from the list.

```diff file=web/src/routes.ts
@@ -1,7 +1,9 @@
 import { Dashboard } from "./pages/Dashboard";
 import { Destinations } from "./pages/Destinations";
+import { FailedDeliveries } from "./pages/FailedDeliveries";
 
 export const routes = [
   { path: "/", component: Dashboard, title: "Dashboard" },
   { path: "/destinations", component: Destinations, title: "Destinations" },
+  { path: "/deliveries/failed", component: FailedDeliveries, title: "Failed deliveries" },
 ];
```

```diff file=web/src/pages/FailedDeliveries.tsx
@16: Optimistic removal after replay; a failed replay leaves the row (the finally only clears busy).
```

### How to verify

```checklist
- Point a destination at a server returning 503; see attempts 0..7 in `delivery_attempts` with growing gaps.
- After the 8th failure the delivery shows on /deliveries/failed.
- Replay it with the server back up; it is delivered and leaves the list.
- Run the down migration on a copy of prod; the worker still starts on the old binary.
```

```steps
- { title: Alert on exhausted retries, detail: Planned; not in this PR, status: todo, area: metrics }
- { title: Per-destination retry config, detail: Only if the max-attempts question goes that way, status: todo, area: retry }
```

## Mechanical changes {#mechanical .mechanical}

Lockfile bump for `date-fns`, the clock package moved out of `util`, a dev script rename and CSS re-indented; no behaviour change.

```files
web/pnpm-lock.yaml: date-fns added (used by the page's relative times, next PR)
internal/clock/clock.go: moved from internal/util; only the package line changed
scripts/run-dev.sh: renamed from scripts/dev.sh
web/src/styles.css: 4-space → 2-space indent
web/public/retry-icon.png: icon for the nav entry
```
