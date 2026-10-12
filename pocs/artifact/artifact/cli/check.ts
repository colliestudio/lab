import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildArtifact, findEntry, fmtBytes, formatMessages, renderStatic, repoRoot } from "./build.ts";

export const WARN_BYTES = 5e6, MAX_BYTES = 25e6;
export interface Report { errors: string[]; warnings: string[]; info: string[]; bytes: number }

function typecheck(dir: string): string[] {
  const tmp = mkdtempSync(join(tmpdir(), "artifact-tsc-"));
  try {
    const nm = join(repoRoot, "node_modules");
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"], types: [], resolveJsonModule: true, allowImportingTsExtensions: true, allowArbitraryExtensions: true,
        paths: {
          artifact: [join(repoRoot, "artifact/kit/index.ts")],
          react: [join(nm, "@types/react")], "react/*": [join(nm, "@types/react/*")], "react-dom": [join(nm, "@types/react-dom")], "react-dom/*": [join(nm, "@types/react-dom/*")],
          "*": [join(nm, "*"), join(nm, "@types/*")],
        },
      },
      include: [resolve(dir) + "/**/*.ts", resolve(dir) + "/**/*.tsx", join(repoRoot, "artifact/kit/virtual.d.ts")],
      exclude: [resolve(dir) + "/node_modules"],
    }));
    const r = spawnSync(join(nm, ".bin/tsc"), ["-p", tmp, "--pretty", "false"], { encoding: "utf8" });
    return (r.stdout + r.stderr).split("\n").filter((l) => /error TS\d+/.test(l)).map((l) => l.replace(resolve(dir) + "/", ""));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function check(dir: string, opts: { types?: boolean } = {}): Promise<Report> {
  const rep: Report = { errors: [], warnings: [], info: [], bytes: 0 };
  try { findEntry(dir); } catch (e) { rep.errors.push((e as Error).message); return rep; }
  const r = await buildArtifact(dir, { minify: true }).catch((e) => { rep.errors.push(String(e.message ?? e)); return null; });
  if (!r) return rep;
  if (r.errors.length) rep.errors.push(await formatMessages(r.errors, "error"));
  if (r.warnings.length) rep.warnings.push(await formatMessages(r.warnings, "warning"));
  const { meta } = r.collected.registry;
  for (const k of ["kind", "audience", "summary"] as const) if (!meta[k]) rep.warnings.push(`artifact.json: no ${k} (readers see the header; say who it's for)`);
  for (const m of r.collected.missing) rep.errors.push(`missing evidence: ${m} (referenced in the source, not in evidence/)`);
  for (const u of r.collected.unreferenced) rep.warnings.push(`unused evidence: ${u} (never mentioned in the source, so not inlined)`);
  rep.bytes = r.bytes;
  if (r.bytes > MAX_BYTES) rep.errors.push(`output is ${fmtBytes(r.bytes)} (limit ${fmtBytes(MAX_BYTES)})`);
  else if (r.bytes > WARN_BYTES) rep.warnings.push(`output is ${fmtBytes(r.bytes)}: trim recordings/images, or cut heavy components`);
  if (!r.errors.length) {
    if (opts.types !== false) for (const l of typecheck(dir)) rep.errors.push(l);
    const s = await renderStatic(dir);
    if ("error" in s) {
      if (!/window|document|navigator|self|HTMLElement/.test(s.error)) rep.errors.push(`render error: ${s.error}`);
    } else {
      const ids = [...s.html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
      const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
      for (const d of new Set(dup)) rep.errors.push(`duplicate Section id "${d}" (set id= on one of them)`);
      if (!ids.length) rep.warnings.push("no <Section>: the outline and present mode have nothing to walk");
    }
  }
  rep.info.push(`html ${fmtBytes(r.bytes)} (js ${fmtBytes(r.js)}, css ${fmtBytes(r.css)})`);
  rep.info.push("largest: " + r.parts.slice(0, 5).map((p) => `${p.name} ${fmtBytes(p.bytes)}`).join(", "));
  return rep;
}
