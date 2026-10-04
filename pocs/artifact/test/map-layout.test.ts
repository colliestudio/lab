import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../src/parse/index.ts";
import type { DocMap } from "../src/model.ts";
import { approxMeasure, layoutMap, mapMetrics } from "../viewer/src/map-layout.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const maps: [string, () => Promise<DocMap>][] = [
  ...["replay-lab-backend.review", "collie-ui-slice.review", "collie-server.plan"].map((s) =>
    [s, async () => (await loadBundle(root + "samples/" + s)).doc.map] as [string, () => Promise<DocMap>]),
  ["retries fixture", async () => JSON.parse(readFileSync(root + "test/fixtures/retries.review.json", "utf8")).map],
];

for (const [name, load] of maps) for (const dir of ["RIGHT", "DOWN"] as const) {
  test(`map layout reads at a glance: ${name} ${dir}`, async () => {
    const m = mapMetrics(await layoutMap(await load(), dir, approxMeasure));
    assert.deepEqual(m.outside, [], "no edge runs around the outside of the map");
    assert.ok(m.crossings <= 2, `${m.crossings} crossings`);
    assert.equal(m.labelHitsEdge, 0, "no edge runs through another edge's label");
    assert.equal(m.labelHitsNode, 0, "no label on a node");
  });
}

test("map layout: a→b plus b→a is one line with arrows at both ends", async () => {
  const l = await layoutMap({
    groups: [], nodes: [{ id: "a", label: "A", change: "added" }, { id: "b", label: "B", change: "added" }],
    edges: [{ from: "a", to: "b", label: "spawn" }, { from: "b", to: "a", label: "logs" }],
  }, "RIGHT", approxMeasure);
  assert.equal(l.edges.length, 1);
  assert.equal(l.edges[0].both, true);
  assert.equal(l.edges[0].label, "spawn · logs");
});
