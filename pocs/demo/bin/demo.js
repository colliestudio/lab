#!/usr/bin/env node
// demo CLI (lab): run <journey> · sheet <dir>
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChrome } from "../src/chrome.js";
import { record } from "../src/recorder.js";
import { buildPlayer } from "../src/player.js";
import { buildSheet } from "../src/sheet.js";

const [cmd, target, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n);
const OUT = resolve(new URL("../out", import.meta.url).pathname);

async function launch() {
  return { browser: await launchChrome(), label: process.env.DEMO_CHROME ? `Chrome (${process.env.DEMO_CHROME})` : "system Chrome" };
}
const up = async (url) => { try { await fetch(url, { redirect: "manual" }); return true; } catch { return false; } };

if (cmd === "run") {
  const file = resolve(target);
  const dir = dirname(file);
  const cfgPath = ["demo.config.js", "demo.config.ts"].map((f) => `${dir}/${f}`).find(existsSync);
  const config = cfgPath ? (await import(pathToFileURL(cfgPath))).default : {};
  const journey = (await import(pathToFileURL(file))).default;
  const name = basename(file).replace(/\.demo\.[jt]s$/, "");
  const timing = { start: Date.now() };

  let app = null;
  if (!(await up(config.url))) {
    if (!config.start) throw new Error(`app not reachable at ${config.url} and no start command`);
    app = spawn(config.start, { cwd: dir, shell: true, stdio: flag("--verbose") ? "inherit" : "ignore", detached: true });
    for (let i = 0; !(await up(config.url)); i++) { if (i > 300) throw new Error("app did not start"); await new Promise((r) => setTimeout(r, 200)); }
  }
  timing.appReady = Date.now();
  const { browser, label } = await launch();
  const r = await record(browser, { name, url: config.url, stage: journey.stage, contextOptions: config.contextOptions, cookies: config.cookies });
  let failure;
  try { await journey.fn(r); } catch (e) { failure = e; console.error("journey failed:", e.message.split("\n")[0]); }
  const { dir: outDir, manifest, bundle } = await r.finish(OUT);
  const player = buildPlayer(outDir);
  timing.recorded = Date.now();
  await browser.close();
  if (app) process.kill(-app.pid);
  const ex = manifest.counts.expects ?? 0;
  const failed = (await import("node:fs")).existsSync(`${outDir}/expects.json`) ? JSON.parse((await import("node:fs")).readFileSync(`${outDir}/expects.json`, "utf8")).filter((e) => !e.pass).length : 0;
  console.log(`browser  ${label}
app      ${config.url} (${app ? "started by the runner" : "already running"})
steps    ${manifest.counts.steps} · ${ex} expect${ex === 1 ? "" : "s"} ${failed ? `(${failed} ✗)` : "✓"}
wrote    ${bundle}  (${(statSync(bundle).size / 1024).toFixed(0)} KB with trace, ${(manifest.durationMs / 1000).toFixed(0)} s)
player   ${player}
time     app ${((timing.appReady - timing.start) / 1000).toFixed(1)} s · record ${((timing.recorded - timing.appReady) / 1000).toFixed(1)} s`);
  process.exit(failure ? 1 : 0);
} else if (cmd === "sheet") {
  const { path, frames } = await buildSheet(resolve(target));
  console.log(`sheet    ${path}  (${frames} frames)`);
} else {
  console.log("usage: demo run <journey.demo.ts> | demo sheet <out/name>");
}
