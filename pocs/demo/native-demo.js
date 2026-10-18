// Same journey, Playwright-native only: screencast video with chapters + action
// annotations, and a trace grouped by step. No rrweb.
import { launchChrome } from "./src/chrome.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { start } from "./app/server.js";

const OUT = "out/native";
mkdirSync(OUT, { recursive: true });
const server = await start(7100);
const browser = await launchChrome();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  // Context-level recording is full-size; page.screencast.start() captured at 800×500 inside a 1280×800 frame.
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 }, showActions: { position: "bottom", fontSize: 18 } },
});
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();

const t0 = Date.now();

const chapters = [];
let group = false;
async function say(title) {
  if (group) await context.tracing.groupEnd();
  await context.tracing.group(title);
  group = true;
  chapters.push({ at: Date.now() - t0, title });
  await page.screencast.showChapter(title, { duration: 2200 });
  await page.waitForTimeout(2300);
}
const slow = (ms = 600) => page.waitForTimeout(ms);

await page.goto("http://localhost:7100/");
await say("A new user signs in");
await page.locator("#name").pressSequentially("Alex", { delay: 55 });
await page.locator("#login button").click();
await slow(1200);
await say("Add a todo");
await page.locator("#text").pressSequentially("Review the replay demo", { delay: 55 });
await page.locator("#add button").click();
await slow(1200);
await say("Tick it off");
await page.locator("#list li:last-child input").check();
await slow();
await say("Export report hits a broken endpoint");
await page.locator("#report").click();
await slow(2000);
await say("Reload: user restored from localStorage");
await page.reload();
await slow(1500);
await context.tracing.groupEnd();

await context.tracing.stop({ path: `${OUT}/trace.zip` });
const video = page.video();
await context.close();
await video.saveAs(`${OUT}/video.webm`);
await video.delete();
await browser.close();
server.close();

// A plain HTML page: <video> + WebVTT chapters. Still native — no replay tech.
const ts = (ms) => new Date(ms).toISOString().slice(11, 23);
const vtt = "WEBVTT\n\n" + chapters.map((c, i) => `${ts(c.at)} --> ${ts(chapters[i + 1]?.at ?? c.at + 5000)}\n${c.title}\n`).join("\n");
writeFileSync(`${OUT}/chapters.vtt`, vtt);
writeFileSync(`${OUT}/index.html`, `<!doctype html><meta charset="utf-8"><title>todo-demo · video</title>
<style>body{font:14px system-ui;margin:16px;background:#f1f5f9;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:16px}video{width:100%;border-radius:8px;background:#000}
button{all:unset;display:block;padding:6px 10px;border-radius:6px;cursor:pointer}button:hover,button.on{background:#fef3c7}small{color:#64748b;margin-right:8px}</style>
<video id="v" src="video.webm" controls><track kind="chapters" src="chapters.vtt" default></video>
<aside><b>Chapters</b><div id="list"></div><p><small>deep debug:</small><br><code>npx playwright show-trace trace.zip</code></p></aside>
<script>
const C=${JSON.stringify(chapters)};const v=document.getElementById("v");
const bs=C.map(c=>{const b=document.createElement("button");b.innerHTML="<small>"+(c.at/1000).toFixed(1)+"s</small>"+c.title;b.onclick=()=>{v.currentTime=c.at/1000;v.play()};document.getElementById("list").append(b);return b});
v.ontimeupdate=()=>{let k=-1;C.forEach((c,i)=>{if(c.at/1000<=v.currentTime)k=i});bs.forEach((b,i)=>b.classList.toggle("on",i===k))};
</script>`);
console.log(chapters);
