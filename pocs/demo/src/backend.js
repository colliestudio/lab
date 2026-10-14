// Backend evidence for demos, beyond the browser: things a feature *causes*.
//   catcher — a local HTTP receiver (webhooks, third-party callbacks) you can program to fail
//   dbWatch — polls a SQLite file and records row-level inserts/updates/deletes as they happen
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

export async function catcher(port = 0) {
  const inbound = [];
  let script = []; // statuses to answer with, in order; then 200
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const status = script.length ? script.shift() : 200;
    const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(req.headers.traceparent ?? "");
    inbound.push({ t: Date.now(), method: req.method, path: req.url, headers: req.headers, body, status, traceId: tp?.[1], parentSpanId: tp?.[2] });
    res.writeHead(status, { "content-type": "text/plain" }).end(status < 300 ? "ok" : "receiver error");
  });
  await new Promise((r) => server.listen(port, r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    inbound,
    /** Answer the next requests with these statuses (then 200s). */
    respond(statuses) { script = [...statuses]; },
    close: () => server.close(),
  };
}

export function dbWatch(path, { every = 120, tables } = {}) {
  const events = [];
  let db, prev = {}, timer;
  const snap = () => {
    db ??= new DatabaseSync(path, { readOnly: true });
    const names = tables ?? db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all().map((r) => r.name);
    return Object.fromEntries(names.map((t) => [t, new Map(db.prepare(`select rowid as __rowid, * from "${t}"`).all().map(({ __rowid, ...row }) => [__rowid, row]))]));
  };
  const diff = () => {
    let cur;
    try { cur = snap(); } catch { return; } // not created yet
    const t = Date.now();
    for (const [table, rows] of Object.entries(cur)) {
      const before = prev[table];
      if (!before) { events.push({ t, table, op: "snapshot", rows: [...rows.values()] }); continue; }
      for (const [key, row] of rows) {
        const old = before.get(key);
        if (!old) events.push({ t, table, op: "insert", key, after: row });
        else {
          const changed = Object.keys(row).filter((c) => row[c] !== old[c]);
          if (changed.length) events.push({ t, table, op: "update", key, changed, before: Object.fromEntries(changed.map((c) => [c, old[c]])), after: Object.fromEntries(changed.map((c) => [c, row[c]])) });
        }
      }
      for (const [key, old] of before) if (!rows.has(key)) events.push({ t, table, op: "delete", key, before: old });
    }
    prev = cur;
  };
  return {
    events,
    start() { diff(); timer = setInterval(diff, every); },
    stop() { clearInterval(timer); diff(); db?.close(); },
  };
}
