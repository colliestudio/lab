// The "journey": what an agent would write after building a feature.
import { chromium } from "playwright";
import { start } from "./app/server.js";
import { record } from "./src/recorder.js";
import { buildPlayer } from "./src/player.js";

const server = await start(7100);
const browser = await chromium.launch();
const r = await record(browser, { name: "todo-demo", url: "http://localhost:7100" });

await r.go("/");
await r.say("A new user signs in — the server sets a session cookie, the app remembers the name in localStorage");
await r.click("#name");
await r.type("#name", "Alex");
await r.click("#login button");
await r.say("Existing todos load from GET /api/todos");
await r.say("Add a todo — POST /api/todos, then the list refreshes");
await r.click("#text");
await r.type("#text", "Review the replay demo");
await r.click("#add button");
await r.say("Tick it off — a client-side change, logged to the console");
await r.click("#list li:last-child input");
await r.say("Export report hits a broken endpoint — watch the 500, the warning, and the uncaught error");
await r.click("#report");
await r.pause(1500);
await r.say("Reload: the app restores the user from localStorage, no sign-in needed");
await r.go("/");
await r.pause(1000);

const { dir, bundle, manifest } = await r.finish();
console.log(manifest.counts);
console.log("bundle:", bundle);
console.log("player:", buildPlayer(dir));
await browser.close();
server.close();
