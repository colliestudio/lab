---
kind: plan
title: Retry failed webhook deliveries
tldr: Stop dropping failed deliveries; retry them with backoff, keep attempt history, and let operators replay and get alerted.
status: accepted
repo: acme/relay
author: product agent
date: 2026-10-01
---

```map
groups:
  - { id: delivery, label: Delivery worker }
nodes:
  - { id: queue, label: Delivery queue, kind: queue, change: unchanged }
  - { id: destination, label: Customer endpoint, kind: external, change: unchanged }
  - { id: worker, label: Worker ack path, kind: job, change: changed, group: delivery, section: worker }
  - { id: retry, label: Retry scheduler, kind: module, change: planned, group: delivery, section: retry }
  - { id: attempts, label: Attempts table, kind: db, change: planned, section: attempts }
  - { id: api, label: Deliveries API, kind: api, change: changed, section: api }
  - { id: ui, label: Failed deliveries page, kind: ui, change: planned, section: ui }
  - { id: alerts, label: Exhausted-retries alert, kind: external, change: planned, section: alerts }
edges:
  - { from: queue, to: worker, label: receive }
  - { from: worker, to: destination, label: POST event }
  - { from: worker, to: retry, label: on failure, change: planned }
  - { from: retry, to: queue, label: re-enqueue later, change: planned }
  - { from: worker, to: attempts, label: record, change: planned }
  - { from: ui, to: api, change: planned }
  - { from: attempts, to: alerts, label: exhausted count, change: planned }
```

Today a failed delivery is acked and lost. The plan: make the worker hand failures to a retry scheduler, keep a history of attempts, and give operators a page to see and replay what finally failed.

```questions
- q: Backoff caps?
  options: ["30s base, 1h cap, 8 attempts", "1m base, 6h cap, 12 attempts"]
  recommend: "30s base, 1h cap, 8 attempts"
  why: Covers a ~2h outage without holding jobs for most of a day.
- q: Count 429 as retryable?
  options: [yes, no]
  recommend: yes
```

## Worker ack path {#worker}

Failures stop being acked; the worker records the attempt and asks the scheduler for the next time.

```steps
- { title: Record each attempt before ack/nack, status: todo, area: worker }
- { title: Nack with delay instead of ack on failure, status: todo, area: worker }
```

## Retry scheduler {#retry}

Capped exponential backoff with jitter; pure function of attempt number and now, so it's trivial to test.

```code lang=go
func (r *RetryScheduler) Next(attempt int, now time.Time) (time.Time, bool)
```

## Attempts table {#attempts}

A `delivery_attempts` table, one row per attempt; reversible migration.

```data-model
entities:
  - name: delivery_attempts
    change: planned
    fields:
      - { name: event_id, type: text, change: planned }
      - { name: attempt, type: int, change: planned }
      - { name: status, type: int, change: planned }
```

## Deliveries API {#api}

Filter by status and a replay endpoint.

```api
- { method: GET, path: /deliveries, change: changed, summary: "status filter" }
- { method: POST, path: "/deliveries/{id}/replay", change: planned }
```

## Failed deliveries page {#ui}

A list of failed deliveries with a replay button.

## Exhausted-retries alert {#alerts}

Page the on-call when exhausted retries for one destination pass a threshold.

```files
internal/delivery/worker.go: ack path
internal/delivery/retry.go: new
internal/store/migrations/: new migration
web/src/pages/FailedDeliveries.tsx: new page
```
