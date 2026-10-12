import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { advise, smallMaps, unpublishedCommits } from "./advice.ts";
import { sourceText } from "./evidence.ts";
import { buildArtifact, findEntry, fmtBytes, formatMessages, renderStatic, repoRoot } from "./build.ts";

// A render that needs the browser (not a bug in the artifact): the error text starts with one of these ReferenceErrors.
const BROWSER_ONLY = /^ReferenceError: (window|document|navigator|self|HTMLElement|localStorage|sessionStorage|matchMedia|location|requestAnimationFrame|ResizeObserver|MutationObserver|IntersectionObserver|CSS) is not defined/;

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
      exclude: [resolve(dir) + "/node_modules", resolve(dir) + "/evidence"],
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
  for (const u of r.collected.unsafe) rep.errors.push(`evidence path leaves evidence/: ${u} (paths must stay inside evidence/, no .. or symlinks elsewhere)`);
  for (const m of r.collected.missing) rep.errors.push(`missing evidence: ${m} (referenced in the source, not in evidence/)`);
  for (const u of r.collected.unreferenced) rep.warnings.push(`unused evidence: ${u} (never mentioned in the source, so not inlined)`);
  for (const [p, n] of Object.entries(r.collected.sizes)) if (/\.png$/i.test(p) && n > 400_000) rep.warnings.push(`${p} is ${fmtBytes(n * 0.75)} inlined: save screenshots as .jpg (artifact capture -o x.jpg) to cut it ~4x`);
  rep.bytes = r.bytes;
  if (r.bytes > MAX_BYTES) rep.errors.push(`output is ${fmtBytes(r.bytes)} (limit ${fmtBytes(MAX_BYTES)})`);
  else if (r.bytes > WARN_BYTES) rep.warnings.push(`output is ${fmtBytes(r.bytes)}: trim recordings/images, or cut heavy components`);
  if (!r.errors.length) {
    if (opts.types !== false) for (const l of typecheck(dir)) rep.errors.push(l);
    const s = await renderStatic(dir);
    if ("error" in s) {
      if (!BROWSER_ONLY.test(s.error)) rep.errors.push(`render error: ${s.error}`);
    } else {
      const multi = Object.keys(s.pageHtml).length > 1;
      for (const [pid, html] of Object.entries(s.pageHtml)) {
        const tag = multi ? `[page ${pid}] ` : "";
        const ids = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
        const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
        for (const d of new Set(dup)) rep.errors.push(`${tag}duplicate Section id "${d}" (set id= on one of them)`);
        if (/data-section=""/.test(html)) rep.errors.push(`${tag}a Section/Slide has an empty id: present mode skips it (give it an id= or a title)`);
        const vt = [...html.matchAll(/view-transition-name:\s*([^;"]+)/g)].map((m) => m[1].trim()).filter((n) => n !== "none");
        for (const d of new Set(vt.filter((x, i) => vt.indexOf(x) !== i))) rep.warnings.push(`${tag}view-transition-name "${d}" is on more than one element: the browser skips the whole transition. Use <Morph name when={false}> and navigate(id, { morph }) to name one pair`);
        if (!ids.length && meta.shell !== "bare") rep.warnings.push(`${tag}no <Section>: the outline and present mode have nothing to walk`);
        for (const w of advise(html, meta).warnings) rep.warnings.push(tag + w);
      }
      for (const w of await smallMaps(s.maps)) rep.warnings.push(w);
    }
    if (meta.repo) {
      for (const sha of unpublishedCommits(sourceText(dir), meta, meta.repo)) rep.warnings.push(`commit ${sha} is not on any remote branch of ${meta.repo}: a link to it will 404 for others`);
    }
  }
  rep.info.push(`html ${fmtBytes(r.bytes)} (js ${fmtBytes(r.js)}, css ${fmtBytes(r.css)})`);
  rep.info.push("largest: " + r.parts.slice(0, 5).map((p) => `${p.name} ${fmtBytes(p.bytes)}`).join(", "));
  return rep;
}
