// Writes a recording to disk: bundle dir (one JSON per stream) + <name>.replay zip.
// Shared by the Playwright recorder and the in-page recorder's save endpoint.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

export const STREAMS = ["rrweb", "steps", "console", "network", "storage"];
// Opt-in backend streams: only written when the recording has them, so .replay stays small otherwise.
export const OPTIONAL = ["server", "spans"];

export function writeBundle(outDir, manifest, streams) {
  const dir = `${outDir}/${manifest.name}`;
  // Entries can arrive out of order (e.g. the in-page navigation entry is back-dated); the player expects time order.
  for (const k of ["console", "network", "storage", "steps", "server"]) streams[k]?.sort((a, b) => a.t - b.t);
  const names = [...STREAMS, ...OPTIONAL.filter((k) => streams[k]?.length)];
  mkdirSync(dir, { recursive: true });
  const hasTrace = existsSync(`${dir}/trace.zip`);
  manifest = {
    format: "replay/0",
    ...manifest,
    counts: Object.fromEntries(names.map((k) => [k, streams[k].length])),
    files: ["manifest.json", ...names.map((k) => `${k}.json`), ...(hasTrace ? ["trace.zip"] : [])],
  };
  const zip = {};
  const files = { "manifest.json": manifest, ...Object.fromEntries(names.map((k) => [`${k}.json`, streams[k]])) };
  for (const [f, v] of Object.entries(files)) {
    const text = JSON.stringify(v, null, f === "rrweb.json" ? 0 : 2);
    writeFileSync(`${dir}/${f}`, text);
    zip[f] = strToU8(text);
  }
  if (hasTrace) zip["trace.zip"] = [readFileSync(`${dir}/trace.zip`), { level: 0 }];
  writeFileSync(`${outDir}/${manifest.name}.replay`, zipSync(zip, { level: 9 }));
  return { dir, bundle: `${outDir}/${manifest.name}.replay`, manifest };
}
