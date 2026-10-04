// Generates the viewer's dev fixtures (ViewerBoot JSON) from hand-written content.
// Run: pnpm exec tsx viewer/fixtures/make.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Comment, Doc, ViewerBoot } from "../../src/model.ts";
import { b64, blocks, diffOf, parsePatch, stats } from "./lib.ts";
import { shotAfter, shotBefore, sketchAfter } from "./shots.ts";

const here = dirname(fileURLToPath(import.meta.url));
const write = (name: string, boot: ViewerBoot & { comments?: Comment[] }) =>
  writeFileSync(join(here, `${name}.json`), JSON.stringify(boot, null, 1) + "\n");

// ---------------------------------------------------------------- retries.review (every block type + planLink)
const files = parsePatch(readFileSync(join(here, "retries.patch"), "utf8"));

const review: Doc = {
  format: "collie-doc/0",
  kind: "review",
  title: "Retry failed webhook deliveries",
  tldr: "Failed deliveries now retry with capped exponential backoff, and operators can see and replay the ones that give up.",
  status: "ready",
  risk: { level: "medium", why: "Changes the delivery worker's ack path; a bug here drops or duplicates events." },
  ask: "Approve the backoff caps; check the migration is reversible.",
  meta: {
    repo: "acme/relay", base: "main", head: "feat/retries", pr: "https://github.com/acme/relay/pull/1093",
    plan: "../retries.plan", author: "dev agent", date: "2026-10-05",
  },
  stats: stats(files),
  map: {
    groups: [
      { id: "worker", label: "Delivery worker" },
      { id: "ops", label: "Operator surface" },
    ],
    nodes: [
      { id: "publish", label: "Publish API", kind: "api", change: "unchanged" },
      { id: "queue", label: "Delivery queue", kind: "queue", change: "unchanged" },
      { id: "consumer", label: "Delivery consumer", kind: "module", change: "changed", group: "worker", section: "consumer", files: ["internal/deliverymq/**"] },
      { id: "retry", label: "Retry scheduler", kind: "module", change: "added", group: "worker", section: "retry", files: ["internal/retry/**"] },
      { id: "attempts", label: "delivery_attempts", kind: "db", change: "changed", section: "schema", files: ["internal/migrations/**"] },
      { id: "dest", label: "Destination endpoint", kind: "external", change: "unchanged" },
      { id: "api", label: "Failed deliveries API", kind: "api", change: "added", group: "ops", section: "api", files: ["internal/api/failed_deliveries.go", "internal/api/router.go"] },
      { id: "ui", label: "Failed deliveries page", kind: "ui", change: "added", group: "ops", section: "ui", files: ["web/**"] },
      { id: "legacy", label: "Legacy retry cron", kind: "job", change: "removed", section: "cleanup", files: ["internal/cron/**"] },
      { id: "deps", label: "Lockfile & generated", kind: "config", change: "changed", mechanical: true, section: "mechanical", files: ["go.mod", "go.sum", "**/*.gen.go", "docs/**"] },
    ],
    edges: [
      { from: "publish", to: "queue", label: "publish" },
      { from: "queue", to: "consumer", label: "deliver" },
      { from: "consumer", to: "dest", label: "POST event" },
      { from: "consumer", to: "attempts", label: "record attempt", change: "changed" },
      { from: "consumer", to: "retry", label: "on failure", change: "added" },
      { from: "retry", to: "queue", label: "re-enqueue after backoff", change: "added" },
      { from: "ui", to: "api", label: "list / replay", change: "added" },
      { from: "api", to: "attempts", label: "query failed", change: "added" },
      { from: "api", to: "retry", label: "replay", change: "added" },
      { from: "legacy", to: "queue", label: "blind re-enqueue", change: "removed" },
    ],
  },
  overview:
    "Before this change a failed delivery was `nack`ed straight back onto the queue and a cron job re-sent everything from the last hour every 5 minutes. Now the consumer hands failures to a **retry scheduler** that uses the queue's delayed publish, and deliveries that exhaust their retries become visible (and replayable) to operators. Read the scheduler first: everything else hangs off it.",
  sections: [
    {
      id: "retry", title: "Retry scheduler", mechanical: false,
      summary: "A new `retry` package decides *when* a failed delivery is tried again: capped exponential backoff with jitter, 12 retries over roughly 9 hours, then give up.",
      blocks: blocks("retry", [
        { type: "markdown", md: "The scheduler is stateless. It computes the next delay from the attempt number carried in the message and publishes a **delayed copy** to the same queue. No polling loop, no extra table to scan, and a restart loses nothing because the delayed message lives in the broker.\n\n| attempt | delay (before jitter) |\n|---|---|\n| 1 | 30 s |\n| 2 | 1 m |\n| 4 | 4 m |\n| 8 | 1 h (cap) |\n| 12 | 1 h, then give up |" },
        { type: "flow", caption: "One failed delivery, end to end.", mermaid: "sequenceDiagram\n  participant Q as Delivery queue\n  participant C as Consumer\n  participant D as Destination\n  participant R as Retry scheduler\n  Q->>C: deliver (attempt n)\n  C->>D: POST event\n  D-->>C: 503\n  C->>R: Schedule(delivery)\n  alt retries left\n    R->>Q: PublishAt(attempt n+1, now + backoff)\n    C->>Q: ack original\n  else exhausted\n    C->>C: MarkFailed\n    C->>Q: ack original\n  end" },
        { type: "callout", tone: "decision", md: "**Backoff caps:** 30 s base, 1 h max delay, 12 retries (~9 h). Stripe retries for ~3 days; we stop the same day so a dead endpoint stops costing us. Open for discussion, see the question below." },
        { type: "questions", questions: [
          { q: "Are 12 retries over ~9 hours the right default?", options: ["12 retries / ~9 h", "8 retries / ~3 h", "18 retries / ~3 days"], recommend: "12 retries / ~9 h", why: "Covers a typical deploy or outage window without keeping dead endpoints alive overnight." },
        ] },
        { type: "code", lang: "go", file: "internal/retry/backoff.go", code: "func (p Policy) Delay(attempt int) (d time.Duration, ok bool) {\n\tif attempt < 1 || attempt > p.MaxAttempts {\n\t\treturn 0, false\n\t}\n\texp := float64(p.Base) * math.Pow(2, float64(attempt-1))\n\tif exp > float64(p.Max) {\n\t\texp = float64(p.Max)\n\t}\n\thalf := exp / 2\n\treturn time.Duration(half + rand.Float64()*half), true\n}\n" },
        diffOf(files, "internal/retry/scheduler.go", {
          15: "Holds no state of its own: the attempt number travels in the message.",
          42: "PublishAt is the broker's delayed publish (RabbitMQ delayed-message plugin / SQS DelaySeconds).",
          50: "Replay keeps the attempt counter, so a replayed delivery that fails again gives up immediately.",
        }),
      ]),
    },
    {
      id: "consumer", title: "Delivery consumer: the ack path", mechanical: false,
      summary: "The consumer no longer `nack`s failures back onto the queue; it schedules a retry and acks the original **only after** the retry is safely queued.",
      blocks: blocks("consumer", [
        { type: "callout", tone: "risk", md: "This is the riskiest part of the change. Order matters: *schedule, then ack*. If the process dies between the two, the original is redelivered and the destination sees a **duplicate** attempt. The reverse order would **drop** the event. Duplicates are acceptable (deliveries carry an idempotency key); drops are not." },
        { type: "flow", caption: "Delivery states after this change.", mermaid: "stateDiagram-v2\n  [*] --> pending\n  pending --> delivered: 2xx\n  pending --> retrying: error, retries left\n  retrying --> pending: backoff elapsed\n  pending --> failed: error, exhausted\n  failed --> pending: operator replay\n  delivered --> [*]" },
        diffOf(files, "internal/deliverymq/consumer.go", {
          101: "Schedule first, ack after: a crash here means a duplicate, never a drop.",
          104: "If the broker refuses the delayed publish we nack, which falls back to the old immediate-redelivery behaviour.",
          112: "MarkFailed is best-effort like Insert: worst case the delivery is missing from the Failed page, not lost.",
        }),
      ]),
    },
    {
      id: "schema", title: "delivery_attempts: failure columns", mechanical: false,
      summary: "Two nullable columns and a partial index so the operator page can list failed deliveries per tenant cheaply.",
      blocks: blocks("schema", [
        { type: "data-model", entities: [
          { name: "delivery_attempts", change: "changed", note: "~40M rows in prod; both new columns are nullable, so the ALTER is metadata-only.", fields: [
            { name: "id", type: "uuid", change: "unchanged" },
            { name: "delivery_id", type: "uuid", change: "unchanged" },
            { name: "tenant_id", type: "text", change: "unchanged" },
            { name: "status", type: "int", change: "unchanged" },
            { name: "next_attempt_at", type: "timestamptz?", change: "added", note: "when the scheduled retry fires" },
            { name: "failed_at", type: "timestamptz?", change: "added", note: "set when retries are exhausted" },
            { name: "retry_count", type: "int", change: "removed", note: "never written; attempt number lives on the delivery" },
          ] },
          { name: "deliveries", change: "unchanged", fields: [
            { name: "id", type: "uuid", change: "unchanged" },
            { name: "attempt", type: "int", change: "unchanged", note: "carried in the queue message" },
          ] },
        ] },
        { type: "callout", tone: "warn", md: "The index is built `CONCURRENTLY`, so the migration must run **outside a transaction**. Our migrator does this for files with `CONCURRENTLY` in them; the down migration mirrors it." },
        diffOf(files, "internal/migrations/0042_delivery_attempts_retry.up.sql", { 6: "Partial index: only failed rows, which should stay a tiny fraction." }),
        diffOf(files, "internal/migrations/0042_delivery_attempts_retry.down.sql"),
      ]),
    },
    {
      id: "api", title: "Failed deliveries API", mechanical: false,
      summary: "Two tenant-scoped endpoints: list deliveries that gave up, and replay one.",
      blocks: blocks("api", [
        { type: "api", endpoints: [
          { method: "GET", path: "/tenants/{tenant}/deliveries/failed", change: "added", summary: "Failed deliveries, newest first, cursor-paginated",
            response: '{\n  "items": [\n    { "id": "dlv_8f2", "destination": "https://hooks.acme.dev/in",\n      "attempts": 12, "last_error": "503 Service Unavailable",\n      "failed_at": "2026-10-05T03:12:44Z" }\n  ],\n  "next": "c_91"\n}' },
          { method: "POST", path: "/tenants/{tenant}/deliveries/{id}/replay", change: "added", summary: "Queue one immediate attempt; 409 if the delivery has not failed",
            request: "// no body", response: '{ "status": "queued" }' },
          { method: "GET", path: "/tenants/{tenant}/events", change: "unchanged", summary: "Unchanged; listed for context" },
        ] },
        diffOf(files, "internal/api/router.go"),
      ]),
    },
    {
      id: "ui", title: "Failed deliveries page", mechanical: false,
      summary: "A new dashboard page lists deliveries that ran out of retries, with a one-click **Replay**.",
      blocks: blocks("ui", [
        { type: "before-after", caption: "Deliveries for tenant acme, before and after.",
          before: { src: "assets/before.svg", caption: "Failed deliveries are invisible: only the event log." },
          after: { src: "assets/after.svg", caption: "New page: last error, attempts, Replay." } },
        { type: "demo", src: "demos/replay-failed.replay", steps: [2, 3, 4], caption: "Operator replays a failed delivery; it succeeds on the next attempt." },
        { type: "checklist", items: [
          "Point a destination at `https://httpstat.us/503` and publish an event",
          "Watch `retry scheduled` log lines with growing delays",
          "Set `MaxAttempts: 2` locally; the delivery shows up on **Failed deliveries**",
          "Click **Replay**: one new attempt, page refreshes",
        ] },
      ]),
    },
    {
      id: "rollout", title: "Rollout", mechanical: false,
      summary: "Ship behind the existing `retries_v2` flag, tenant by tenant; the legacy cron stays off once the flag is on.",
      blocks: blocks("rollout", [
        { type: "steps", steps: [
          { title: "Run migration 0042", detail: "Outside a transaction (CONCURRENTLY index).", status: "done", area: "schema" },
          { title: "Deploy worker with flag off", status: "done", area: "consumer" },
          { title: "Enable `retries_v2` for internal tenants", status: "doing" },
          { title: "Enable for everyone, delete the cron", detail: "The cron code is already removed in this PR; the flag only gates the new path.", status: "todo", area: "cleanup" },
        ] },
      ]),
    },
    {
      id: "cleanup", title: "Remove the legacy retry cron", mechanical: false,
      summary: "The every-5-minutes cron that blindly re-sent the last hour of failures is deleted.",
      blocks: blocks("cleanup", [
        { type: "markdown", md: "It had no backoff and no cap, and it raced with the consumer: an event could be in flight and re-sent by the cron at the same time." },
      ]),
    },
    {
      id: "mechanical", title: "Lockfile, generated code, docs rename", mechanical: true,
      summary: "`amqp091-go` bump for delayed publish, regenerated OpenAPI types, and the retries doc renamed and updated.",
      blocks: blocks("mechanical", [
        { type: "files", paths: ["go.mod", "go.sum", "internal/api/openapi.gen.go", "docs/delivery-retries.md"], notes: {
          "go.mod": "amqp091-go 1.10 → 1.11 (PublishWithDeferredConfirm + x-delay)",
          "internal/api/openapi.gen.go": "regenerated by oapi-codegen",
        } },
      ]),
    },
  ],
  files,
  questions: [
    { q: "Are 12 retries over ~9 hours the right default?", options: ["12 retries / ~9 h", "8 retries / ~3 h", "18 retries / ~3 days"], recommend: "12 retries / ~9 h", why: "Covers a typical deploy or outage window without keeping dead endpoints alive overnight." },
    { q: "Should replay reset the attempt counter?", options: ["Keep counter", "Reset to 0"], recommend: "Keep counter", why: "A replay is one manual attempt; resetting would silently restart 9 hours of retries." },
  ],
  planLink: {
    src: "../retries.plan",
    title: "Retry failed webhook deliveries",
    done: ["consumer", "retry", "attempts", "api", "ui"],
    notDone: ["alerts"],
    unplanned: ["legacy"],
  },
  warnings: [],
};

const fakeReplay = new TextEncoder().encode("PK\u0003\u0004 replay/0 placeholder recording ".repeat(400));

write("retries.review", {
  doc: review,
  files: {
    "assets/before.svg": b64(shotBefore),
    "assets/after.svg": b64(shotAfter),
    "demos/replay-failed.replay": b64(fakeReplay),
    "changes.patch": b64(readFileSync(join(here, "retries.patch"))),
  },
  comments: [
    { id: "c1", anchor: { section: "consumer" }, author: "alex", body: "Can we get a test that kills the worker between Schedule and Ack?", created: "2026-10-05T09:12:00Z" },
    { id: "c2", anchor: { section: "retry", block: "retry-3" }, author: "dev agent", body: "Fixed the wording: we compared with Stripe but chose a shorter window.", created: "2026-10-05T09:40:00Z", resolved: true },
  ],
});

// ---------------------------------------------------------------- retries.plan
const plan: Doc = {
  format: "collie-doc/0",
  kind: "plan",
  title: "Retry failed webhook deliveries",
  tldr: "Retry failed deliveries with capped backoff instead of the blind cron, and let operators see and replay deliveries that give up.",
  status: "accepted",
  risk: { level: "medium", why: "Touches the consumer's ack path, the one place that can drop events." },
  ask: "Pick the backoff caps and decide whether failures should alert.",
  meta: { repo: "acme/relay", base: "main", author: "planning agent", date: "2026-10-02" },
  map: {
    groups: [{ id: "worker", label: "Delivery worker" }, { id: "ops", label: "Operator surface" }],
    nodes: [
      { id: "queue", label: "Delivery queue", kind: "queue", change: "unchanged" },
      { id: "consumer", label: "Delivery consumer", kind: "module", change: "changed", group: "worker", section: "consumer" },
      { id: "retry", label: "Retry scheduler", kind: "module", change: "planned", group: "worker", section: "retry" },
      { id: "attempts", label: "delivery_attempts", kind: "db", change: "changed", section: "schema" },
      { id: "dest", label: "Destination endpoint", kind: "external", change: "unchanged" },
      { id: "api", label: "Failed deliveries API", kind: "api", change: "planned", group: "ops", section: "api" },
      { id: "ui", label: "Failed deliveries page", kind: "ui", change: "planned", group: "ops", section: "ui" },
      { id: "alerts", label: "Failure alerts", kind: "service", change: "planned", group: "ops", section: "alerts" },
    ],
    edges: [
      { from: "queue", to: "consumer", label: "deliver" },
      { from: "consumer", to: "dest", label: "POST event" },
      { from: "consumer", to: "retry", label: "on failure", change: "planned" },
      { from: "retry", to: "queue", label: "delayed publish", change: "planned" },
      { from: "consumer", to: "attempts", label: "record", change: "changed" },
      { from: "ui", to: "api", label: "list / replay", change: "planned" },
      { from: "api", to: "attempts", label: "query", change: "planned" },
      { from: "attempts", to: "alerts", label: "failed_at set", change: "planned" },
    ],
  },
  overview: "Replace the cron with retries that live in the broker (delayed publish), record when a delivery gives up, and build the smallest operator surface that makes those deliveries visible. Alerts are optional and depend on decision 2.",
  sections: [
    {
      id: "retry", title: "Retry scheduler", mechanical: false,
      summary: "New `internal/retry` package: a backoff policy plus a scheduler that publishes delayed copies to the delivery queue.",
      blocks: blocks("retry", [
        { type: "markdown", md: "Options considered:\n\n1. **Broker delayed publish** (chosen): no new storage, survives restarts.\n2. A `retries` table polled every few seconds: more moving parts, a hot table.\n3. Keep the cron, add backoff: still races with the consumer." },
        { type: "steps", steps: [
          { title: "Policy with Delay(attempt)", detail: "Capped exponential, full jitter. Unit-test the cap and exhaustion.", status: "todo" },
          { title: "Scheduler.Schedule / Replay", detail: "Thin wrapper over `PublishAt`.", status: "todo" },
          { title: "Bump amqp091-go for x-delay support", status: "todo" },
        ] },
        { type: "code", lang: "go", file: "internal/retry/scheduler.go (sketch)", code: "type Scheduler struct {\n\tqueue  deliverymq.Publisher\n\tpolicy Policy\n}\n\nfunc (s *Scheduler) Schedule(ctx context.Context, d models.Delivery) (Outcome, error)\nfunc (s *Scheduler) Replay(ctx context.Context, d models.Delivery) error\n" },
      ]),
    },
    {
      id: "consumer", title: "Consumer: schedule, then ack", mechanical: false,
      summary: "On failure the consumer calls the scheduler and acks the original only once the retry is queued.",
      blocks: blocks("consumer", [
        { type: "flow", mermaid: "flowchart LR\n  A[deliver] --> B{2xx?}\n  B -- yes --> C[ack]\n  B -- no --> D[Schedule retry]\n  D -- queued --> C\n  D -- exhausted --> E[MarkFailed] --> C\n  D -- error --> F[nack]" },
        { type: "callout", tone: "risk", md: "Never ack before the retry is queued: that order drops events on a crash." },
      ]),
    },
    {
      id: "schema", title: "Schema: record failures", mechanical: false,
      summary: "Add `next_attempt_at` and `failed_at` to `delivery_attempts`, plus a partial index for the operator list.",
      blocks: blocks("schema", [
        { type: "data-model", entities: [
          { name: "delivery_attempts", change: "changed", fields: [
            { name: "delivery_id", type: "uuid", change: "unchanged" },
            { name: "next_attempt_at", type: "timestamptz?", change: "planned" },
            { name: "failed_at", type: "timestamptz?", change: "planned" },
          ] },
        ] },
      ]),
    },
    {
      id: "api", title: "Failed deliveries API", mechanical: false,
      summary: "List failed deliveries per tenant and replay one.",
      blocks: blocks("api", [
        { type: "api", endpoints: [
          { method: "GET", path: "/tenants/{tenant}/deliveries/failed", change: "planned", summary: "Cursor-paginated, newest first" },
          { method: "POST", path: "/tenants/{tenant}/deliveries/{id}/replay", change: "planned", summary: "One immediate attempt" },
        ] },
      ]),
    },
    {
      id: "ui", title: "Failed deliveries page", mechanical: false,
      summary: "A table of failed deliveries with last error, attempt count and a Replay button.",
      blocks: blocks("ui", [
        { type: "before-after", before: { src: "assets/before.svg", caption: "Today: event log only" }, after: { src: "assets/sketch.svg", caption: "Sketch: failed deliveries table" } },
      ]),
    },
    {
      id: "alerts", title: "Failure alerts (optional)", mechanical: false,
      summary: "Notify the tenant when a destination keeps failing. Only if decision 2 says yes.",
      blocks: blocks("alerts", [
        { type: "callout", tone: "info", md: "Could reuse the existing tenant webhook for `delivery.failed`; no email infrastructure needed." },
      ]),
    },
    {
      id: "verify", title: "How we'll know it works", mechanical: false,
      summary: "Kill-the-worker test plus a staged rollout behind `retries_v2`.",
      blocks: blocks("verify", [
        { type: "checklist", items: ["Unit tests for the policy cap and exhaustion", "Integration test: kill worker between Schedule and Ack, expect a duplicate not a drop", "Internal tenants on `retries_v2` for a week"] },
        { type: "files", notes: {
          "internal/retry/backoff.go": "Policy, Delay",
          "internal/retry/scheduler.go": "Schedule, Replay",
          "internal/deliverymq/consumer.go": "failure branch",
          "internal/migrations/0042_delivery_attempts_retry.up.sql": "columns + index",
          "internal/api/failed_deliveries.go": "List, Replay",
          "web/src/pages/FailedDeliveries.tsx": "new page",
        } },
      ]),
    },
  ],
  files: [],
  questions: [
    { q: "Backoff caps?", options: ["12 retries / ~9 h", "8 retries / ~3 h", "18 retries / ~3 days"], recommend: "12 retries / ~9 h", why: "Covers an outage window without keeping dead endpoints alive overnight." },
    { q: "Alert tenants when a delivery gives up?", options: ["Not now", "Webhook event", "Email"], recommend: "Not now", why: "The Failed page covers operators; tenant alerts can follow once we see volumes." },
  ],
  warnings: [],
};

write("retries.plan", {
  doc: plan,
  files: { "assets/before.svg": b64(shotBefore), "assets/sketch.svg": b64(sketchAfter) },
});

// ---------------------------------------------------------------- config-rename.review (small, low risk, no plan)
const files2 = parsePatch(`diff --git a/internal/config/env.go b/internal/config/env.go
index 1111111..2222222 100644
--- a/internal/config/env.go
+++ b/internal/config/env.go
@@ -8,9 +8,16 @@ import "os"
 // Env reads configuration from the environment.
 func Env() Config {
 	return Config{
-		RedisURL:    os.Getenv("RELAY_REDIS"),
-		RabbitURL:   os.Getenv("RELAY_RABBIT"),
-		LogLevel:    os.Getenv("RELAY_LOG"),
+		RedisURL:    first("REDIS_URL", "RELAY_REDIS"),
+		RabbitURL:   first("RABBITMQ_URL", "RELAY_RABBIT"),
+		LogLevel:    first("LOG_LEVEL", "RELAY_LOG"),
 	}
 }
+
+// first returns the first non-empty variable; old names still work for one release.
+func first(names ...string) string {
+	for _, n := range names {
+		if v := os.Getenv(n); v != "" {
+			return v
+		}
+	}
+	return ""
+}
diff --git a/deploy/docker-compose.yml b/deploy/docker-compose.yml
index 3333333..4444444 100644
--- a/deploy/docker-compose.yml
+++ b/deploy/docker-compose.yml
@@ -12,7 +12,7 @@ services:
     image: acme/relay:latest
     environment:
-      RELAY_REDIS: redis://redis:6379
-      RELAY_RABBIT: amqp://rabbit:5672
+      REDIS_URL: redis://redis:6379
+      RABBITMQ_URL: amqp://rabbit:5672
     depends_on:
       - redis
`);

const rename: Doc = {
  format: "collie-doc/0", kind: "review",
  title: "Standard env var names, old ones still accepted",
  tldr: "Config reads REDIS_URL / RABBITMQ_URL / LOG_LEVEL first and falls back to the RELAY_* names for one release.",
  status: "ready",
  risk: { level: "low", why: "Fallback keeps every existing deployment working." },
  ask: "Approve.",
  meta: { repo: "acme/relay", base: "main", head: "chore/env-names", author: "dev agent", date: "2026-10-04" },
  stats: stats(files2),
  map: {
    groups: [],
    nodes: [
      { id: "config", label: "Config loader", kind: "config", change: "changed", section: "config", files: ["internal/config/**"] },
      { id: "compose", label: "docker-compose", kind: "config", change: "changed", section: "deploy", files: ["deploy/**"] },
      { id: "worker", label: "Worker", kind: "service", change: "unchanged" },
    ],
    edges: [{ from: "compose", to: "config", label: "env" }, { from: "config", to: "worker", label: "Config" }],
  },
  overview: "Two files. The loader prefers the standard names and falls back to the old ones.",
  sections: [
    { id: "config", title: "Config loader", mechanical: false, summary: "`first()` picks the first non-empty variable.", blocks: [] },
    { id: "deploy", title: "docker-compose", mechanical: false, summary: "Sample compose file uses the new names.", blocks: [] },
  ],
  files: files2, questions: [], warnings: [],
};
write("config-rename.review", { doc: rename });

console.log("fixtures written:", review.stats, rename.stats);
