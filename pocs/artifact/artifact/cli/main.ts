import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildArtifact, fmtBytes, formatMessages } from "./build.ts";
import { check, MAX_BYTES, WARN_BYTES } from "./check.ts";
import { scaffold } from "./scaffold.ts";
import { dev } from "./dev.ts";

const USAGE = `artifact: agent-written pages (React + a component kit), one self-contained HTML out

  artifact new <dir> [--kind k]          scaffold <dir>.artifact with a small example
  artifact dev <dir> [--port N]          live-reload server on 127.0.0.1 (default 4177)
  artifact check <dir>                   bundle + types + render + evidence + size; exit 1 on errors
  artifact build <dir> -o out.html       one HTML file, everything inlined; reports sizes
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: { kind: { type: "string" }, port: { type: "string" }, host: { type: "string" }, o: { type: "string", short: "o" }, "no-types": { type: "boolean" }, force: { type: "boolean" } },
  });
  const dir = positionals[0];
  if (!cmd || cmd === "help" || cmd === "--help" || !dir) { console.log(USAGE); return cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0; }
  switch (cmd) {
    case "new": {
      const d = scaffold(dir, values.kind);
      console.log(`created ${d}\nnext: artifact dev ${dir.replace(/\.artifact$/, "")}.artifact   (edit index.tsx; skill/ARTIFACT.md lists the components)`);
      return 0;
    }
    case "check": {
      const r = await check(dir, { types: !values["no-types"] });
      for (const e of r.errors) console.error("error: " + e);
      for (const w of r.warnings) console.warn("warning: " + w);
      for (const i of r.info) console.log(i);
      console.log(r.errors.length ? `${r.errors.length} error(s)` : "ok");
      return r.errors.length ? 1 : 0;
    }
    case "build": {
      const out = values.o;
      if (!out) { console.error("build needs -o out.html"); return 2; }
      const r = await buildArtifact(dir);
      if (r.errors.length) { console.error(await formatMessages(r.errors, "error")); return 1; }
      for (const m of r.collected.missing) console.error(`error: missing evidence ${m}`);
      if (r.collected.missing.length) return 1;
      if (r.bytes > MAX_BYTES && !values.force) { console.error(`output is ${fmtBytes(r.bytes)}, over ${fmtBytes(MAX_BYTES)}; trim evidence or --force`); return 1; }
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, r.html);
      console.log(`${out}  ${fmtBytes(r.bytes)}  (js ${fmtBytes(r.js)}, css ${fmtBytes(r.css)})`);
      console.log("  " + r.parts.slice(0, 6).map((p) => `${p.name} ${fmtBytes(p.bytes)}`).join(" · "));
      if (r.bytes > WARN_BYTES) console.warn(`warning: over ${fmtBytes(WARN_BYTES)}; large files are slow to open and share`);
      return 0;
    }
    case "dev": {
      const s = await dev(dir, values.port ? Number(values.port) : 4177, values.host);
      console.log(`serving http://${s.host}:${s.port}   (on the Mini: http://mini.internal:${s.port})`);
      await new Promise(() => {});
      return 0;
    }
    default: console.log(USAGE); return 2;
  }
}

