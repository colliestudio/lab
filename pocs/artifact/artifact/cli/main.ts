import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildArtifact, fmtBytes, formatMessages } from "./build.ts";
import { check, MAX_BYTES, WARN_BYTES } from "./check.ts";
import { scaffold } from "./scaffold.ts";
import { dev } from "./dev.ts";
import { gatherCmd } from "./gather.ts";

const USAGE = `artifact: agent-written pages (React + a component kit), one self-contained HTML out

  artifact new <dir> [--kind k]          scaffold <dir>.artifact with a small example
  artifact capture <url|file.html> -o evidence/x.png|.jpg [--selector css] [--wait ms|css] [--width N] [--height N] [--theme dark] [--full] [--steps steps.json]
                                         screenshot a running app into evidence (jpg is ~4x smaller)
  artifact record <url|file.html> -o evidence/x.replay (--steps 'say:…; click:text=Save; type:#name=Ada; key:Enter; wait:500; drag:.a->.b' | --script journey.mjs)
                                         [--width N] [--height N] [--theme dark] [--max seconds, 90] [--no-network] [--no-console] [--inline-images] [--fast]
                                         a seekable DOM recording for <Replay>; each say:"…" is a chapter. Not redacted (passwords are masked): check before sharing
  artifact gather gh-pr <dir> --pr owner/repo#12   a PR for a guided review: data/pr.json (meta, files, existing review comments) + evidence/pr.patch
  artifact gather gh-prs|board|git-log <dir> [options]   (--fields a,b / --count trim output; git-log --branches 'idea/*' --base main = unique commits per branch)   write <dir>/data/<kind>.json (see ARTIFACT.md)
  artifact chrome-path                   print the Chromium that shot/capture/record would use (exit 1 when none)
  artifact dev <dir> [--port N]          live-reload server on 127.0.0.1 (default 4177)
  artifact check <dir>                   bundle + types + render + evidence + size; exit 1 on errors
  artifact build <dir> -o out.html       one HTML file, everything inlined; reports sizes
  artifact shot <dir> [--theme light|dark|both] [--present 2,3|all] [--page id|all] [--split] [--height N] [-o outdir] [--width N] [--no-chrome] [--motion]
                                         PNGs of the page to look at; default <dir>/.shots. --present takes 1-based slide numbers (every step is shot);
                                         --split cuts the page into --height-tall (default 800) PNGs: name-p1.png, p2…
                                         shots run with prefers-reduced-motion: reduce (count-ups and transitions settle); --motion keeps animations
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: { kind: { type: "string" }, port: { type: "string" }, host: { type: "string" }, o: { type: "string", short: "o" }, theme: { type: "string" }, present: { type: "string" }, width: { type: "string" }, pr: { type: "string" }, "no-chrome": { type: "boolean" }, motion: { type: "boolean" }, "no-types": { type: "boolean" }, help: { type: "boolean", short: "h" }, split: { type: "boolean" }, page: { type: "string" }, selector: { type: "string" }, wait: { type: "string" }, height: { type: "string" }, full: { type: "boolean" }, steps: { type: "string" }, repos: { type: "string" }, workspaces: { type: "string" }, repo: { type: "string" }, branches: { type: "string" }, fields: { type: "string" }, count: { type: "boolean" }, base: { type: "string" }, since: { type: "string" }, name: { type: "string" }, limit: { type: "string" }, force: { type: "boolean" }, script: { type: "string" }, max: { type: "string" }, "no-network": { type: "boolean" }, "no-console": { type: "boolean" }, "inline-images": { type: "boolean" }, fast: { type: "boolean" }, "body-limit": { type: "string" } },
  });
  const dir = positionals[0];
  if (cmd === "chrome-path") {
    const { findChrome } = await import("./shot.ts");
    try { console.log(await findChrome()); return 0; } catch (e) { console.error((e as Error).message); return 1; }
  }
  if (values.help) { console.log(USAGE); return 0; }
  if (cmd === "gather" && positionals.length >= 2) return gatherCmd(positionals[0], positionals[1], values as Record<string, string | boolean | undefined>);
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
      for (const u of r.collected.unsafe) console.error(`error: evidence path leaves evidence/: ${u}`);
      if (r.collected.missing.length || r.collected.unsafe.length) return 1;
      if (r.bytes > MAX_BYTES && !values.force) { console.error(`output is ${fmtBytes(r.bytes)}, over ${fmtBytes(MAX_BYTES)}; trim evidence or --force`); return 1; }
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, r.html);
      console.log(`${out}  ${fmtBytes(r.bytes)}  (js ${fmtBytes(r.js)}, css ${fmtBytes(r.css)})`);
      console.log("  " + r.parts.slice(0, 6).map((p) => `${p.name} ${fmtBytes(p.bytes)}`).join(" · "));
      const recs = Object.entries(r.collected.sizes).filter(([p]) => p.endsWith(".replay"));
      if (recs.length) console.log("  recordings (inlined, decoded when scrolled to): " + recs.map(([p, n]) => `${p.replace(/^evidence\//, "")} ${fmtBytes(n)}`).join(" · "));
      const pg = r.parts.filter((x) => x.name.startsWith("page "));
      if (pg.length) console.log("  pages: " + pg.map((x) => `${x.name.slice(5)} ${fmtBytes(x.bytes)}`).join(" · ") + " (their own source; shared parts above)");
      if (r.bytes > WARN_BYTES) console.warn(`warning: over ${fmtBytes(WARN_BYTES)}; large files are slow to open and share`);
      return 0;
    }
    case "shot": {
      const { shot } = await import("./shot.ts");
      const themes = values.theme === "both" ? (["light", "dark"] as const) : values.theme === "dark" ? (["dark"] as const) : (["light"] as const);
      const paths = await shot(dir, { out: values.o, themes: [...themes], present: values.present, split: values.split, page: values.page, height: values.height ? Number(values.height) : undefined, width: values.width ? Number(values.width) : undefined, chrome: !values["no-chrome"], motion: values.motion });
      for (const p of paths) console.log(p);
      return 0;
    }
    case "capture": {
      if (!values.o) { console.error("capture needs -o evidence/x.png"); return 2; }
      const { capture } = await import("./shot.ts");
      const w = (x?: string) => (x ? Number(x) : undefined);
      const p = await capture(dir, { out: values.o, selector: values.selector, wait: values.wait, width: w(values.width), height: w(values.height), theme: values.theme === "dark" ? "dark" : "light", full: values.full, steps: values.steps });
      console.log(`${p}  ${fmtBytes(statSync(p).size)}`);
      return 0;
    }
    case "record": {
      if (!values.o) { console.error("record needs -o evidence/x.replay"); return 2; }
      if (!values.steps && !values.script) { console.error("record needs --steps '…' or --script journey.mjs"); return 2; }
      const { record } = await import("./record.ts");
      const n = (x?: string) => (x ? Number(x) : undefined);
      const r = await record(dir, { out: values.o, steps: values.steps, script: values.script, width: n(values.width), height: n(values.height), theme: values.theme === "dark" ? "dark" : "light", max: n(values.max), network: !values["no-network"], console: !values["no-console"], bodyLimit: n(values["body-limit"]), fast: values.fast, inlineImages: values["inline-images"] });
      console.log(`${r.path}  ${fmtBytes(r.bytes)}  ${(r.durationMs / 1000).toFixed(1)}s  ${r.steps.length} steps, ${r.events} events`);
      for (const w of r.warnings) console.warn("warning: " + w);
      console.warn("warning: recordings are not redacted (password inputs are masked; page text, typed text and fetch bodies are kept): check for secrets before sharing");
      return 0;
    }
    case "dev": {
      const port = values.port ? Number(values.port) : 4177;
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error(`bad --port ${values.port}`); return 2; }
      const s = await dev(dir, port, values.host);
      console.log(`serving http://${s.host}:${s.port}   (on the Mini: http://mini.internal:${s.port})`);
      await new Promise(() => {});
      return 0;
    }
    default: console.log(USAGE); return 2;
  }
}

