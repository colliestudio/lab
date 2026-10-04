// Harness: the demo block in a 720px column with the fixture replays (test/fixtures/sample.review).
import { createRoot } from "react-dom/client";
import { DemoBlock, DemoFrame } from "../src/blocks/demo.tsx";

const getFile = async (path: string) => {
  const r = await fetch("/" + path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return new Uint8Array(await r.arrayBuffer());
};

createRoot(document.getElementById("root")!).render(
  <>
    <h3>All steps</h3>
    <DemoBlock block={{ id: "d1", level: 2, type: "demo", src: "demos/todo.replay", caption: "Todo journey" }} getFile={getFile} />
    <h3>Subset steps [2, 3]</h3>
    <DemoBlock block={{ id: "d2", level: 2, type: "demo", src: "demos/todo.replay", steps: [2, 3], caption: "Loading and adding todos" }} getFile={getFile} />
    <h3>HTTP stage (no screen)</h3>
    <DemoBlock block={{ id: "d3", level: 2, type: "demo", src: "demos/webhooks.replay" }} getFile={getFile} />
    <h3>DemoFrame step 3 / step 5</h3>
    <div style={{ display: "flex", gap: 12 }}>
      <DemoFrame src="demos/todo.replay" step={3} getFile={getFile} />
      <DemoFrame src="demos/todo.replay" step={5} getFile={getFile} />
    </div>
    <h3>Missing file</h3>
    <DemoBlock block={{ id: "d4", level: 2, type: "demo", src: "demos/nope.replay" }} getFile={getFile} />
  </>,
);
