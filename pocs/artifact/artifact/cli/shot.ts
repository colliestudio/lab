// `artifact shot`: build the artifact and save PNGs of it (themes, present slides) so an agent can look at its own output.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildArtifact, formatMessages, listPages } from "./build.ts";

const NAMES = ["Google Chrome for Testing", "Chromium", "chrome-headless-shell", "headless_shell", "chrome"];

function walkFind(dir: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkFind(p, depth + 1);
    return NAMES.includes(e.name) ? [p] : [];
  });
}

/** A Chromium to drive: $ARTIFACT_CHROME, playwright's own, the newest in a playwright cache (any chromium-* or chromium_headless_shell-*), or one on PATH. */
export async function findChrome(): Promise<string> {
  if (process.env.ARTIFACT_CHROME) return process.env.ARTIFACT_CHROME;
  const { chromium } = await import("playwright-core");
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* not installed for this version */ }
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")].filter((b): b is string => !!b);
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => /^chromium(_headless_shell)?-\d+/.test(d)).sort((a, b) => Number(b.match(/\d+$/)?.[0]) - Number(a.match(/\d+$/)?.[0]));
    for (const d of dirs) { const f = walkFind(join(base, d))[0]; if (f) return f; }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) for (const n of ["google-chrome", "chromium", "chromium-browser", "chrome"]) if (dir && existsSync(join(dir, n))) return join(dir, n);
  throw new Error(`no Chromium found (looked in ${bases.join(", ")} and PATH): run \`npx playwright-core install chromium\` or set ARTIFACT_CHROME=/path/to/chrome`);
}

export interface ShotOpts { out?: string; themes?: ("light" | "dark")[]; present?: string; width?: number; height?: number; chrome?: boolean; split?: boolean; page?: string }

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
    const pageIds: (string | undefined)[] = o.page === "all" ? ["home", ...listPages(abs).map((p) => p.id)] : o.page ? [o.page] : [undefined];
    for (const theme of o.themes ?? ["light"]) for (const pid of pageIds) {
      const base = pid ? `${name}-${pid}` : name;
      const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: o.height ?? 800 }, colorScheme: theme });
      const page = await ctx.newPage();
      const errs: string[] = [];
      page.on("pageerror", (e) => errs.push(e.message));
      await page.goto("file://" + file + (pid ? `#/${pid}` : ""));
      await page.waitForSelector(".a-content", { timeout: 10_000 });
      await page.waitForTimeout(400);
      // async parts (map layout, diagrams, players) settle
      await page.waitForFunction(() => !document.querySelector(".a-map:not(:has(svg)), .a-flow:has(.a-muted)"), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
      // scroll through the page so anything lazy (images, players) loads before the full-page capture
      await page.evaluate(async () => {
        const step = Math.max(400, innerHeight - 100);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
        scrollTo(0, 0);
        await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = () => r(null); }))));
      });
      await page.waitForTimeout(200);
      await page.addStyleTag({ content: o.chrome === false ? ".h-bar{display:none!important}" : ".h-bar{position:static!important}" });
      if (o.split) {
        // viewport-sized slices of the full page: each PNG is readable on its own
        const dims = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.clientWidth }));
        const sh = o.height ?? 800;
        for (let y = 0, n = 1; y < dims.h; y += sh, n++) {
          const p = join(out, `${base}-${theme}-p${n}.png`);
          await page.screenshot({ path: p, fullPage: true, clip: { x: 0, y, width: dims.w, height: Math.min(sh, dims.h - y) } });
          paths.push(p);
        }
      } else {
        const p = join(out, `${base}-${theme}.png`);
        await page.screenshot({ path: p, fullPage: true });
        paths.push(p);
      }
      if (o.present != null) {
        await page.reload(); await page.waitForSelector(".a-content"); await page.waitForTimeout(800);
        await page.keyboard.press("p");
        await page.waitForSelector(".h-present-bar");
        const read = () => page.locator(".h-present-bar").evaluate((e) => ({ slide: Number(e.getAttribute("data-slide")), slides: Number(e.getAttribute("data-slides")), step: Number(e.getAttribute("data-step")), steps: Number(e.getAttribute("data-steps")) }));
        const total = (await read()).slides;
        // --present takes the same 1-based numbers the files carry (present-2.png = slide 2)
        const want = o.present === "all" ? null : new Set(o.present.split(",").map((x) => Number(x) - 1).filter((n) => Number.isInteger(n) && n >= 0 && n < total));
        // walk every state (slide, step) once; a slide's later steps get `-s<k>` suffixes so nothing is skipped
        for (let guard = 0; guard < 500; guard++) {
          const st = await read();
          if (!want || want.has(st.slide)) {
            await page.waitForTimeout(450);
            const sp = join(out, `${base}-${theme}-present-${st.slide + 1}${st.step ? `-s${st.step}` : ""}.png`);
            await page.screenshot({ path: sp });
            paths.push(sp);
          }
          await page.keyboard.press("ArrowRight");
          await page.waitForTimeout(80);
          const nx = await read();
          if (nx.slide === st.slide && nx.step === st.step) break;
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
    // the sticky host bar would be drawn mid-capture: hide it for element shots, unstick it for full pages
    await page.addStyleTag({ content: o.selector ? ".h-bar{display:none!important}" : ".h-bar{position:static!important}" }).catch(() => {});
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    const jpeg = /\.jpe?g$/i.test(o.out);
    const opts = { path: resolve(o.out), ...(jpeg ? { type: "jpeg" as const, quality: o.quality ?? 72 } : { type: "png" as const }) };
    if (o.selector) await page.locator(o.selector).first().screenshot(opts);
    else await page.screenshot({ ...opts, fullPage: !!o.full });
    return resolve(o.out);
  } finally { await browser.close(); }
}
