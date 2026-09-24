// The todo journey, shared by demo.js (in-process app) and run.js (app as a child process).
export default async function (r) {
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
}
