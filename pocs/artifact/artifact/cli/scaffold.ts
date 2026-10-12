import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** The placeholder texts `artifact new` writes; `check` errors while they are still there. */
export const TEMPLATE_SUMMARY = "One or two sentences: what the reader should take away.";
export const TEMPLATE_AUDIENCE = "who this is for";

const TEMPLATE = `import { Section, Callout } from "artifact";

// artifact.json has "shell": "page": the host draws the title, the summary (the headline), a meta line and a readable column.
// Write only the sections. Conclusion first, then the evidence, then what you need from the reader.
// Data: put JSON in data/<name>.json and read it with useData("<name>"). Tables, cards, Decision, Diff, Img: see COMPONENTS.md.
// Wrap a wide Table, Grid or Img in <Wide> to let it use more than the text column. For a map, story, sheets or deck set "shell": "bare".
export default function Artifact() {
  return (
    <>
      <Section title="Where things stand" lead="The finding in a sentence or two, with the numbers that matter.">
        <p>Replace this with the evidence behind the summary.</p>
      </Section>

      <Section title="What needs a decision">
        <Callout tone="info" title="Decision">Say what you need from the reader and what you recommend.</Callout>
      </Section>
    </>
  );
}
`;

export function scaffold(dirArg: string, kind = "status"): string {
  const dir = resolve(dirArg.endsWith(".artifact") ? dirArg : dirArg + ".artifact");
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const title = basename(dir, ".artifact").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  writeFileSync(join(dir, "artifact.json"), JSON.stringify({
    title, kind, shell: "page", audience: TEMPLATE_AUDIENCE, summary: TEMPLATE_SUMMARY,
    sources: [], created: new Date().toISOString().slice(0, 10),
  }, null, 2) + "\n");
  writeFileSync(join(dir, "index.tsx"), TEMPLATE);
  return dir;
}
