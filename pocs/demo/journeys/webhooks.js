// A backend feature demo: todo.created webhooks — signed, retried with backoff, dead-lettered.
// No browser page: the "stage" is the API calls and what they cause.
export const stage = "http";

export default async function (r) {
  await r.say("Register a webhook endpoint (a local catcher stands in for the customer's server)");
  const hook = await r.http.post("/api/webhooks", { data: { url: r.catcher.url } });

  await r.say("Create a todo: the API answers 201 right away; delivery happens in the background");
  await r.http.post("/api/todos", { data: { text: "Ship webhooks" } });
  await r.until(() => r.catcher.inbound.length >= 1);
  await r.pause(600);

  await r.say("Flaky receiver: the next two attempts get 500, and we back off 300 ms, then 600 ms");
  r.catcher.respond([500, 500]);
  await r.http.post("/api/todos", { data: { text: "Survive a flaky receiver" } });
  await r.until(() => r.catcher.inbound.length >= 4);
  await r.pause(700);

  await r.say("Receiver down for good: after 4 attempts the delivery is dead-lettered");
  r.catcher.respond([503, 503, 503, 503]);
  await r.http.post("/api/todos", { data: { text: "Nobody is listening" } });
  await r.until(() => r.catcher.inbound.length >= 8, { timeout: 15000 });
  await r.pause(800);

  await r.say("Delivery history: 1 delivered first try, 1 delivered on attempt 3, 1 dead");
  const deliveries = await r.http.get("/api/deliveries");
  console.log(deliveries.json);
  if (!hook.json?.secret?.startsWith("whsec_")) throw new Error("no signing secret");
  await r.pause(1200);
}
