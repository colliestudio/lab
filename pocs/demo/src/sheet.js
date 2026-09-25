// Contact sheet: one PNG with a frame every few seconds, each labelled with time, the current
// step's caption and any expects in that window. The agent's default self-check: look at it.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const RRWEB = readFileSync(new URL("../node_modules/rrweb/umd/rrweb.min.js", import.meta.url), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, "");
const CSS = readFileSync(new URL("../node_modules/rrweb/dist/style.css", import.meta.url), "utf8");

export async function buildSheet(dir, { every = 3000, cols = 2, tile = 560, browser } = {}) {
  const read = (f) => { try { return JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); } catch { return []; } };
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  const events = read("rrweb.json"), steps = read("steps.json"), expects = read("expects.json");
  if (!events.length) throw new Error("sheet: no rrweb events (http-stage demos: not supported yet)");
  const t0 = events[0].timestamp, total = events.at(-1).timestamp - t0;
  // Frame times: every N ms, plus just after each step starts (captions are the story).
  const times = [...new Set([...Array.from({ length: Math.floor(total / every) + 1 }, (_, i) => i * every),
    ...steps.filter((s) => !s.kind).map((s) => Math.min(total, s.t - t0 + 900))])].sort((a, b) => a - b);

  const own = !browser;
  browser ??= await chromium.launch();
  const { width, height } = manifest.viewport;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<style>${CSS} body{margin:0} .replayer-mouse{display:none}</style><div id="root"></div><script>${RRWEB}</script>`);
  await page.evaluate((events) => {
    window.__r = new rrweb.Replayer(events, { root: document.getElementById("root"), skipInactive: false, mouseTail: false, triggerFocus: false });
  }, events);
  const shots = [];
  for (const t of times) {
    await page.evaluate((t) => window.__r.pause(t), t);
    await page.waitForTimeout(120);
    shots.push({ t, png: (await page.locator(".replayer-wrapper").screenshot()).toString("base64") });
  }
  // Zoom sources: render the replay at the moment each targeted action/expect happened
  // (a click's box is only valid *before* the click; the next grid frame has moved on).
  const actions = read("actions.json"), zoomOn = [...actions, ...expects.filter((e) => e.box)].sort((a, b) => a.t - b.t);
  for (let i = 0; i < shots.length; i++) {
    const from = i ? shots[i - 1].t : -1, to = shots[i].t;
    const hit = zoomOn.filter((a) => a.box && a.t - t0 > from && a.t - t0 <= to).at(-1);
    if (!hit) continue;
    await page.evaluate((t) => window.__r.pause(t), Math.max(0, hit.t - t0 + (hit.matcher ? 50 : 300)));
    await page.waitForTimeout(120);
    shots[i].hit = hit;
    shots[i].hitPng = (await page.locator(".replayer-wrapper").screenshot()).toString("base64");
  }
  await page.close();

  // Legibility: a full frame at tile size makes 13px text ~6px. Each frame also gets a 1:1 zoom on
  // what the story touched since the previous frame: the click target, or the element an expect checked.
  // (A pixel diff doesn't work: a modal dims the whole page, and inserted content shifts everything.)
  const crop = await browser.newPage();
  for (let i = 0; i < shots.length; i++) {
    const hit = shots[i].hit;
    if (!hit) continue;
    shots[i].zoomLabel = (hit.matcher ? "checked: " + hit.matcher : hit.kind) + " @ " + ((hit.t - t0) / 1000).toFixed(1) + "s";
    shots[i].crop = await crop.evaluate(async ([png, box, W]) => {
      const im = await new Promise((ok) => { const x = new Image(); x.onload = () => ok(x); x.src = "data:image/png;base64," + png; });
      const w = Math.min(W, im.width), h = Math.min(200, im.height);
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const x0 = Math.max(0, Math.min(im.width - w, cx - w / 2)), y0 = Math.max(0, Math.min(im.height - h, cy - h / 2));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d"); g.drawImage(im, x0, y0, w, h, 0, 0, w, h);
      g.strokeStyle = "#f59e0b"; g.lineWidth = 3; g.strokeRect(box.x - x0 - 4, box.y - y0 - 4, box.width + 8, box.height + 8);
      return c.toDataURL("image/png").split(",")[1];
    }, [shots[i].hitPng, hit.box, tile]);
  }
  await crop.close();

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const stepAt = (t) => { let cur; for (const s of steps) if (s.t - t0 <= t && !s.kind) cur = s; return cur; };
  const labelled = shots.map((s, i) => {
    const step = stepAt(s.t);
    const n = step ? steps.filter((x) => !x.kind).indexOf(step) + 1 : 0;
    const next = shots[i + 1]?.t ?? Infinity;
    const ex = expects.filter((e) => e.t - t0 >= s.t && e.t - t0 < next);
    return `<figure><img src="data:image/png;base64,${s.png}">${s.crop ? `<div class="zoom"><span>${esc(s.zoomLabel)}</span><img src="data:image/png;base64,${s.crop}"></div>` : ""}<figcaption><b>${(s.t / 1000).toFixed(1)}s</b>${step ? ` · ${n}. ${esc(step.text)}` : " · (before step 1)"}${ex.map((e) => ` <span class="${e.pass ? "ok" : "bad"}">${e.pass ? "✓" : "✗"} ${esc(e.matcher)}</span>`).join("")}</figcaption></figure>`;
  });
  const off = steps.filter((s) => s.kind === "offstage").map((s) => `<li>off camera: ${esc(s.text)}</li>`).join("");
  const html = `<style>body{margin:12px;font:13px system-ui;background:#fff} h1{font-size:15px;margin:0 0 8px} .grid{display:grid;grid-template-columns:repeat(${cols},${tile}px);gap:10px}
    figure{margin:0;border:1px solid #cbd5e1;border-radius:6px;overflow:hidden} img{width:100%;display:block;border-bottom:1px solid #e2e8f0}
    figcaption{padding:5px 7px;line-height:1.3} .zoom{position:relative;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:center}
    .zoom img{width:auto;max-width:100%;display:inline-block;border:0} .zoom span{position:absolute;left:6px;top:4px;font:600 10px system-ui;color:#b45309;text-transform:uppercase} .ok{color:#059669;font-weight:600} .bad{color:#dc2626;font-weight:700} ul{margin:4px 0 10px;padding-left:18px;color:#64748b}</style>
    <h1>${esc(manifest.name)} · ${(total / 1000).toFixed(1)}s · ${steps.filter((s) => !s.kind).length} steps · ${expects.filter((e) => e.pass).length}/${expects.length} expects ✓</h1><ul>${off}</ul><div class="grid">${labelled.join("")}</div>`;
  const sheet = await browser.newPage({ viewport: { width: cols * (tile + 10) + 24, height: 400 } });
  await sheet.setContent(html);
  const out = `${dir}/sheet.png`;
  writeFileSync(out, await sheet.screenshot({ fullPage: true }));
  await sheet.close();
  if (own) await browser.close();
  return { path: out, frames: shots.length };
}
