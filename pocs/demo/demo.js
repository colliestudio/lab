// In-process app, browser-only capture.
import { chromium } from "playwright";
import { start } from "./app/server.js";
import { record } from "./src/recorder.js";
import { buildPlayer } from "./src/player.js";
import journey from "./journeys/todo.js";

const server = await start(7100);
const browser = await chromium.launch();
const r = await record(browser, { name: "todo-demo", url: "http://localhost:7100" });
await journey(r);
const { dir, bundle, manifest } = await r.finish();
console.log(manifest.counts);
console.log("bundle:", bundle);
console.log("player:", buildPlayer(dir));
await browser.close();
server.close();
