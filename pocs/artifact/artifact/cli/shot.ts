// `artifact shot`: build the artifact and save PNGs of it (themes, present slides) so an agent can look at its own output.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildArtifact, formatMessages } from "./build.ts";

const NAMES = ["Google Chrome for Testing", "Chromium", "chrome-headless-shell", "chrome"];

function walkFind(dir: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkFind(p, depth + 1);
    return NAMES.includes(e.name) ? [p] : [];
  });
}

/** A Chromium to drive: $ARTIFACT_CHROME, playwright's own, or the newest in the playwright cache. */
export async function findChrome(): Promise<string> {
  if (process.env.ARTIFACT_CHROME) return process.env.ARTIFACT_CHROME;
  const { chromium } = await import("playwright-core");
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* not installed for this version */ }
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!base || !existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => /^chromium(_headless_shell)?-\d+/.test(d)).sort((a, b) => Number(b.match(/\d+$/)?.[0]) - Number(a.match(/\d+$/)?.[0]));
    for (const d of dirs) { const f = walkFind(join(base, d))[0]; if (f) return f; }
  }
  throw new Error("no Chromium found: run `npx playwright-core install chromium` or set ARTIFACT_CHROME=/path/to/chrome");
}

export interface ShotOpts { out?: string; themes?: ("light" | "dark")[]; present?: string; width?: number; height?: number; chrome?: boolean }

/** Writes `<name>-<theme>.png` (full page) and, with `present`, `<name>-<theme>-present-<n>.png` (viewport). Returns the paths. */
export async function shot(dir: string, o: ShotOpts = {}): Promise<string[]> {
  const abs = resolve(dir);
  const r = await buildArtifact(abs);
  if (r.errors.length) throw new Error(await formatMessages(r.errors, "error"));
  const out = resolve(o.out ?? join(abs, ".shots"));
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "artifact-shot-"));
  const file = join(tmp, "a.html");
  writeFileSync(file, r.html);
  const name = basename(abs).replace(/\.artifact$/, "");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: await findChrome() });
  const paths: string[] = [];
  try {
    for (const theme of o.themes ?? ["light"]) {
      const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: o.height ?? 800 }, colorScheme: theme });
      const page = await ctx.newPage();
      const errs: string[] = [];
      page.on("pageerror", (e) => errs.push(e.message));
      await page.goto("file://" + file);
      await page.waitForSelector(".a-content", { timeout: 10_000 });
      await page.waitForTimeout(400);
      // async parts (map layout, diagrams, players) settle
      await page.waitForFunction(() => !document.querySelector(".a-map:not(:has(svg)), .a-flow:has(.a-muted)"), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
      if (o.chrome === false) await page.addStyleTag({ content: ".h-bar{display:none!important}" });
      const p = join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: p, fullPage: true });
      paths.push(p);
      if (o.present != null) {
        await page.reload(); await page.waitForSelector(".a-content"); await page.waitForTimeout(800);
        await page.keyboard.press("p");
        await page.waitForSelector(".h-present-bar");
        const total = Number((await page.locator(".h-present-bar span").innerText()).match(/\/(\d+)/)?.[1] ?? 1);
        const want = o.present === "all" ? Array.from({ length: total }, (_, i) => i) : o.present.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < total);
        let at = 0;
        for (const n of want) {
          while (at < n) { await page.keyboard.press("ArrowRight"); at++; }
          // slides, not steps: skip through revealed steps until the slide index changes
          for (let g = 0; g < 50; g++) {
            const cur = Number((await page.locator(".h-present-bar span").innerText()).match(/^(\d+)/)?.[1]) - 1;
            if (cur >= n) break;
            await page.keyboard.press("ArrowRight");
          }
          await page.waitForTimeout(500);
          const sp = join(out, `${name}-${theme}-present-${n + 1}.png`);
          await page.screenshot({ path: sp });
          paths.push(sp);
        }
      }
      if (errs.length) console.warn(`warning: page errors (${theme}): ${errs.join("; ")}`);
      await ctx.close();
    }
  } finally { await browser.close(); rmSync(tmp, { recursive: true, force: true }); }
  return paths;
}

export interface CaptureOpts {
  out: string; selector?: string; wait?: number | string; width?: number; height?: number; theme?: "light" | "dark";
  full?: boolean; steps?: string; quality?: number; scale?: number;
}
type Step = { click: string } | { fill: [string, string] } | { type: [string, string] } | { press: string } | { wait: number | string } | { goto: string } | { hover: string };

/**
 * Screenshot a URL (or local html file) into evidence: `.png` or `.jpg` (jpeg, `quality` 72 by default, much smaller).
 * `selector` captures one element, `wait` is ms or a selector to wait for, `steps` a JSON file of
 * `[{"click":"sel"},{"fill":["sel","text"]},{"press":"Enter"},{"wait":500|"sel"},{"goto":"url"}]` run before the shot.
 */
export async function capture(url: string, o: CaptureOpts): Promise<string> {
  const { chromium } = await import("playwright-core");
  const { readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const target = /^[a-z]+:\/\//i.test(url) ? url : "file://" + resolve(url);
  const browser = await chromium.launch({ executablePath: await findChrome() });
  try {
    const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: o.height ?? 800 }, colorScheme: o.theme ?? "light", deviceScaleFactor: o.scale ?? 1 });
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: "load", timeout: 30_000 });
    const waitFor = async (w: number | string) => (typeof w === "number" || /^\d+$/.test(String(w)) ? page.waitForTimeout(Number(w)) : page.waitForSelector(String(w), { timeout: 15_000 }));
    if (o.wait != null) await waitFor(o.wait);
    if (o.steps) {
      for (const s of JSON.parse(readFileSync(o.steps, "utf8")) as Step[]) {
        if ("click" in s) await page.click(s.click);
        else if ("hover" in s) await page.hover(s.hover);
        else if ("fill" in s) await page.fill(s.fill[0], s.fill[1]);
        else if ("type" in s) await page.type(s.type[0], s.type[1]);
        else if ("press" in s) await page.keyboard.press(s.press);
        else if ("wait" in s) await waitFor(s.wait);
        else if ("goto" in s) await page.goto(s.goto);
      }
    }
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    const jpeg = /\.jpe?g$/i.test(o.out);
    const opts = { path: resolve(o.out), ...(jpeg ? { type: "jpeg" as const, quality: o.quality ?? 72 } : { type: "png" as const }) };
    if (o.selector) await page.locator(o.selector).first().screenshot(opts);
    else await page.screenshot({ ...opts, fullPage: !!o.full });
    return resolve(o.out);
  } finally { await browser.close(); }
}
