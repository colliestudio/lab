// `artifact record`: drive a page with Playwright and write a seekable DOM recording (`.replay`, format replay/0):
// rrweb (the page as it moved), steps (chapters from `say`), console and network, all on one clock. No video, no Playwright trace.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";
import { findChrome } from "./shot.ts";

const require = createRequire(import.meta.url);
// rrweb's UMD bundle is vendored through the dependency, so a recording needs no network. The sourceMappingURL line
// must go: injected as an init script it would make the page fetch it.
const rrwebSource = () => readFileSync(join(dirname(dirname(require.resolve("rrweb"))), "umd/rrweb.min.js"), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, "");

export type StepSpec =
  | { say: string } | { click: string } | { hover: string } | { type: [string, string] } | { go: string }
  | { wait: number | string } | { key: string } | { drag: [string, string] } | { scroll: number } | { pause: number };

const KINDS = ["say", "click", "hover", "type", "go", "wait", "key", "drag", "scroll", "pause"];
const KIND_RE = new RegExp(`\\s*;\\s*(?=(?:${KINDS.join("|")}):)`);

/** `type:#name=Ada` → ["#name","Ada"]: the first `=` outside brackets/quotes and past a leading `text=`-style engine prefix. */
function splitEq(s: string): [string, string] {
  let i = /^[a-z-]+=/.exec(s)?.[0].length ?? 0, depth = 0, q = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "=" && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  throw new Error(`type step needs <selector>=<text>: ${s}`);
}

/**
 * The mini script of `--steps`: `say:Open the board; click:text=New card; type:#title=Fix login; key:Enter; wait:500; drag:.a->.b`
 * (one step per line or `;`-separated), or a JSON array like capture's (`[{"say":"…"},{"click":"sel"},{"type":["sel","text"]}]`).
 */
export function parseSteps(src: string): StepSpec[] {
  const text = src.trim();
  if (text.startsWith("[")) {
    return (JSON.parse(text) as Record<string, unknown>[]).map((s): StepSpec => {
      const [k] = Object.keys(s);
      if (!KINDS.includes(k)) throw new Error(`unknown step ${JSON.stringify(s)}`);
      if (k === "fill") throw new Error("use type");
      return s as unknown as StepSpec;
    });
  }
  const out: StepSpec[] = [];
  for (const line of text.split(/\r?\n/).flatMap((l) => l.split(KIND_RE))) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const m = /^([a-z]+):\s*([\s\S]*)$/.exec(l);
    if (!m || !KINDS.includes(m[1])) throw new Error(`unknown step "${l}" (expected ${KINDS.join(", ")} as kind:value)`);
    const [, k, v] = m;
    if (k === "type") out.push({ type: splitEq(v) });
    else if (k === "drag") { const [a, b] = v.split("->").map((x) => x.trim()); if (!a || !b) throw new Error(`drag needs <from>-><to>: ${v}`); out.push({ drag: [a, b] }); }
    else if (k === "wait") out.push({ wait: /^\d+$/.test(v) ? Number(v) : v });
    else if (k === "scroll" || k === "pause") out.push({ [k]: Number(v) } as StepSpec);
    else out.push({ [k]: v } as StepSpec);
  }
  return out;
}

export interface RecordOpts {
  out: string;
  /** mini script text or the path of a file holding it (or JSON) */
  steps?: string;
  /** module whose default export is `async ({page, say, click, type, go, pause, …}) => {}` */
  script?: string;
  width?: number; height?: number; theme?: "light" | "dark";
  /** seconds; the recording stops (and is kept) when it is reached */
  max?: number;
  network?: boolean; console?: boolean;
  /** bytes kept of each fetch/xhr body */
  bodyLimit?: number;
  /** skip the human pacing (caption read time, click highlights): quick, for tests */
  fast?: boolean;
  /** inline images into the snapshot so the replay shows them offline (bigger) */
  inlineImages?: boolean;
}

export interface Driver {
  page: import("playwright-core").Page;
  say(text: string, readMs?: number): Promise<void>;
  go(urlOrPath: string): Promise<void>;
  click(what: string): Promise<void>;
  hover(what: string): Promise<void>;
  type(what: string, text: string): Promise<void>;
  key(k: string): Promise<void>;
  drag(from: string, to: string): Promise<void>;
  scroll(dy: number): Promise<void>;
  wait(w: number | string): Promise<void>;
  pause(ms: number): Promise<void>;
}

export interface RecordResult { path: string; bytes: number; durationMs: number; steps: string[]; events: number; truncated: boolean; warnings: string[] }

class Stop extends Error {}

const INIT = (inlineImages: boolean) => `${rrwebSource()}
;(() => {
  if (window.top !== window || !/^(https?|file):$/.test(location.protocol)) return;
  const start = () => rrweb.record({
    emit: (e) => window.__rec("rrweb", e),
    sampling: { mousemove: 100, scroll: 200, input: "last" },
    maskInputOptions: { password: true },
    slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaDescKeywords: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true },
    inlineImages: ${inlineImages},
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();`;

// a selector (`#id`, `.cls`, `[attr]`, `tag.cls`, `a > b`, `text=…`) or else visible text: a button/link/tab/menu name, then any exact text
const looksLikeCss = (x: string) => /^([#.[]|(css|xpath|text|role|id|data-testid|internal:[a-z-]+)=)/.test(x.trim()) || /^[a-z][\w-]*[#.[]/i.test(x.trim()) || /\s>\s|\[[\w-]+[=\]]/.test(x);

export async function record(url: string, o: RecordOpts): Promise<RecordResult> {
  const { chromium } = await import("playwright-core");
  const base = /^[a-z]+:\/\//i.test(url) ? url : "file://" + resolve(url);
  const viewport = { width: o.width ?? 1280, height: o.height ?? 800 };
  const fast = !!o.fast, max = (o.max ?? 90) * 1000, bodyLimit = o.bodyLimit ?? 2048;
  let stepList: StepSpec[] = [];
  if (o.steps) stepList = parseSteps(existsSync(o.steps) ? readFileSync(o.steps, "utf8") : o.steps);
  if (!stepList.length && !o.script) throw new Error("record needs --steps '…' or --script journey.mjs");

  const browser = await chromium.launch({ executablePath: await findChrome() });
  const warnings: string[] = [];
  const s = { rrweb: [] as { timestamp: number }[], console: [] as unknown[], network: [] as Record<string, unknown>[], steps: [] as { t: number; text: string }[] };
  const startedAt = Date.now();
  let truncated = false, failed: unknown;
  try {
    const context = await browser.newContext({ viewport, colorScheme: o.theme ?? "light" });
    let main: import("playwright-core").Page | null = null;
    await context.exposeBinding("__rec", ({ page }, kind: string, data: { timestamp: number }) => { if (page === main && kind === "rrweb") s.rrweb.push(data); });
    await context.addInitScript({ content: INIT(!!o.inlineImages) });
    const page = (main = await context.newPage());
    if (o.console !== false) {
      page.on("console", (m) => { const l = m.location(); s.console.push({ t: Date.now(), level: m.type(), text: m.text().slice(0, 500), source: l.url ? `${l.url}:${l.lineNumber}` : undefined }); });
      page.on("pageerror", (e) => s.console.push({ t: Date.now(), level: "error", text: `Uncaught ${e.name}: ${e.message}`.slice(0, 500) }));
    }
    if (o.network !== false) {
      const entries = new Map<unknown, Record<string, unknown>>();
      const SECRET = /^(cookie|authorization|proxy-authorization|set-cookie|x-api-key)$/i;
      const clean = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => !SECRET.test(k)));
      context.on("request", (r) => {
        const api = r.resourceType() === "fetch" || r.resourceType() === "xhr";
        const e = { id: s.network.length + 1, t: Date.now(), method: r.method(), url: r.url().slice(0, 300), type: r.resourceType(), ...(api ? { requestHeaders: clean(r.headers()), requestBody: r.postData()?.slice(0, bodyLimit) } : {}) };
        entries.set(r, e); s.network.push(e);
      });
      const done = async (r: import("playwright-core").Request, failure?: string) => {
        const e = entries.get(r); if (!e) return;
        e.end = Date.now(); e.duration = (e.end as number) - (e.t as number);
        if (failure) { e.error = failure; return; }
        const res = await r.response().catch(() => null); if (!res) return;
        e.status = res.status();
        if (e.type === "fetch" || e.type === "xhr") {
          e.responseHeaders = clean(await res.allHeaders().catch(() => ({})));
          try { const b = await res.text(); e.responseBody = b.length > bodyLimit ? b.slice(0, bodyLimit) + "…[truncated]" : b; } catch { /* body gone */ }
        }
      };
      context.on("requestfinished", (r) => void done(r));
      context.on("requestfailed", (r) => void done(r, r.failure()?.errorText ?? "failed"));
    }

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const pause = async (ms: number) => { if (Date.now() - startedAt > max) throw new Stop(); await sleep(fast ? Math.min(ms, 30) : ms); };
    const target = (x: string) => {
      if (looksLikeCss(x)) return page.locator(x).first();
      return page.getByRole("button", { name: x, exact: true }).or(page.getByRole("link", { name: x, exact: true })).or(page.getByRole("tab", { name: x, exact: true }))
        .or(page.getByRole("menuitem", { name: x, exact: true })).or(page.getByText(x, { exact: true })).first();
    };
    const field = (x: string) => (looksLikeCss(x) ? page.locator(x).first() : page.getByLabel(x, { exact: true }).or(page.getByPlaceholder(x, { exact: true })).first());
    let mouse = { x: viewport.width / 2, y: viewport.height / 2 };
    const moveTo = async (x: number, y: number) => { await page.mouse.move(x, y, { steps: fast ? 2 : 18 }); mouse = { x, y }; };
    // the ring is a real element in the page, so the recording shows it
    const ring = async (b: { x: number; y: number; width: number; height: number }) => {
      if (fast) return;
      await page.evaluate((b) => {
        const d = document.createElement("div");
        Object.assign(d.style, { position: "fixed", left: b.x - 4 + "px", top: b.y - 4 + "px", width: b.width + 8 + "px", height: b.height + 8 + "px", border: "2px solid #f59e0b", borderRadius: "6px", boxShadow: "0 0 0 4px rgba(245,158,11,.22)", pointerEvents: "none", zIndex: "2147483647", transition: "opacity .3s", opacity: "1" });
        document.documentElement.append(d);
        setTimeout(() => { d.style.opacity = "0"; }, 700); setTimeout(() => d.remove(), 1100);
      }, b).catch(() => {});
    };
    const aim = async (loc: import("playwright-core").Locator) => {
      await loc.waitFor({ state: "visible", timeout: 10_000 });
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const b = await loc.boundingBox();
      if (!b) throw new Error("target has no box");
      await ring(b);
      await moveTo(b.x + b.width / 2, b.y + b.height / 2);
      await pause(450);
      return b;
    };
    const settle = async () => { await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {}); await pause(500); };
    const d: Driver = {
      page,
      async say(text, readMs) {
        s.steps.push({ t: Date.now(), text });
        await page.evaluate((text) => (window as unknown as { rrweb?: { record: { addCustomEvent(k: string, p: unknown): void } } }).rrweb?.record.addCustomEvent("step", { text }), text).catch(() => {});
        await pause(readMs ?? Math.min(3500, 800 + 35 * text.length));
      },
      async go(u) { await page.goto(new URL(u, page.url() === "about:blank" ? base : page.url()).href, { waitUntil: "load", timeout: 30_000 }); await pause(600); },
      async click(w) { const el = target(w); await aim(el); await el.click(); await settle(); },
      async hover(w) { const el = target(w); await aim(el); await el.hover(); await pause(500); },
      async type(w, text) {
        const el = field(w); await aim(el); await el.click();
        await el.press("ControlOrMeta+a"); // select-all then type: fill("") leaves stale text in React number inputs
        await el.pressSequentially(text, { delay: fast ? 0 : 50 }); await pause(300);
      },
      async key(k) { await page.keyboard.press(k); await settle(); },
      async drag(a, b) {
        const from = target(a), to = target(b);
        await aim(from); const tb = await to.boundingBox(); if (!tb) throw new Error("drag target has no box");
        await page.mouse.down(); await moveTo(tb.x + tb.width / 2, tb.y + tb.height / 2); await pause(250); await page.mouse.up();
        await settle();
      },
      async scroll(dy) { await page.mouse.move(mouse.x, mouse.y); await page.mouse.wheel(0, dy); await pause(600); },
      async wait(w) { if (typeof w === "number") await pause(w); else await page.waitForSelector(w, { timeout: 15_000 }); },
      pause,
    };

    try {
      await page.goto(base, { waitUntil: "load", timeout: 30_000 });
      await pause(700);
      if (o.script) {
        const mod = await import(pathToFileURL(resolve(o.script)).href);
        if (typeof mod.default !== "function") throw new Error(`${o.script}: default export must be an async function ({page, say, click, type, go, pause, …}) => {}`);
        await mod.default({ ...d, context, url: base });
      }
      for (const [i, st] of stepList.entries()) {
        const [k] = Object.keys(st) as (keyof StepSpec)[];
        try {
          const v = (st as Record<string, unknown>)[k];
          if (k === "say") await d.say(v as string);
          else if (k === "click") await d.click(v as string);
          else if (k === "hover") await d.hover(v as string);
          else if (k === "type") await d.type((v as string[])[0], (v as string[])[1]);
          else if (k === "go") await d.go(v as string);
          else if (k === "wait") await d.wait(v as number | string);
          else if (k === "key") await d.key(v as string);
          else if (k === "drag") await d.drag((v as string[])[0], (v as string[])[1]);
          else if (k === "scroll") await d.scroll(v as number);
          else if (k === "pause") await d.pause(v as number);
        } catch (e) { if (e instanceof Stop) throw e; throw new Error(`step ${i + 1} (${k}:${JSON.stringify((st as Record<string, unknown>)[k])}) failed: ${(e as Error).message.split("\n")[0]}`); }
      }
      await pause(800);
    } catch (e) {
      if (e instanceof Stop) { truncated = true; warnings.push(`stopped at --max ${o.max ?? 90}s: the recording ends there`); } else failed = e;
    }
    await context.close();
  } finally { await browser.close(); }
  if (failed) throw failed;

  s.rrweb.sort((a, b) => a.timestamp - b.timestamp);
  s.steps.sort((a, b) => a.t - b.t);
  if (!s.rrweb.length) warnings.push("no DOM events were captured (non-http(s) page, or it crashed): the recording is empty");
  const durationMs = (s.rrweb.at(-1)?.timestamp ?? Date.now()) - (s.rrweb[0]?.timestamp ?? startedAt);
  const counts = { rrweb: s.rrweb.length, steps: s.steps.length, console: s.console.length, network: s.network.length, storage: 0 };
  const manifest = { format: "replay/0", name: resolve(o.out).split("/").pop()!.replace(/\.replay$/, ""), url: base, recorder: "artifact", stage: "ui", startedAt: new Date(startedAt).toISOString(), durationMs, viewport, colorScheme: o.theme ?? "light", counts, files: ["manifest.json", "rrweb.json", "steps.json", "console.json", "network.json", "storage.json"] };
  const files = { "manifest.json": manifest, "rrweb.json": s.rrweb, "steps.json": s.steps, "console.json": s.console, "network.json": s.network, "storage.json": [] };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([f, v]) => [f, strToU8(JSON.stringify(v))])), { level: 9 });
  if (zip.length > 300_000) {
    const text = JSON.stringify(s.rrweb);
    const data = (text.match(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g) ?? []).reduce((n, x) => n + x.length, 0);
    warnings.push(`${(zip.length / 1024).toFixed(0)} KB is big for a clip (usually 25-60 KB)` + (data > text.length / 3 ? `: ${(data / 1024).toFixed(0)} KB of the DOM is inlined data: URIs (images or fonts embedded in the page) that repeat in the snapshot; record the app itself rather than a page that embeds screenshots` : ": a long run or a very large page; try a shorter flow"));
  }
  mkdirSync(dirname(resolve(o.out)), { recursive: true });
  writeFileSync(resolve(o.out), zip);
  return { path: resolve(o.out), bytes: zip.length, durationMs, steps: s.steps.map((x) => x.text), events: s.rrweb.length, truncated, warnings };
}
