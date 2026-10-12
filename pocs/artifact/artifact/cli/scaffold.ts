import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const TEMPLATE = `import { meta, Section, Callout, Grid, Card, Status, Table, Steps, Questions, Source, useData } from "artifact";

// artifact.json has "shell": "bare": this page is blank and yours (the host adds only comments, decisions and a corner menu).
// Lay it out however fits the story; here, a plain centred column. Big picture first; cite where facts came from.
export default function Artifact() {
  const items = useData<{ name: string; status: string; owner: string }[]>("items");
  return (
    <main style={{ maxWidth: "60rem", margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <h1 style={{ marginBottom: 0 }}>{meta.title}</h1>
      <p className="a-muted">{meta.summary}</p>
      <Callout tone="info" title="In one line">Say the conclusion first; the sections below are for checking it.</Callout>

      <Section title="Where things are">
        <Grid cols={3}>
          {items.map((it) => (
            <Card key={it.name} title={it.name} aside={<Status s={it.status} />}>Owner: {it.owner}</Card>
          ))}
        </Grid>
        <Table columns={["name", "owner", { key: "status", render: (v) => <Status s={String(v)} /> }]} rows={items} />
      </Section>

      <Section title="What happens next">
        <Steps items={[{ title: "Decide", body: "Pick one of the options." }, { title: "Do it", body: "Then check it off." }]} />
        <Questions items={[{ q: "Which option do we take?", why: "Blocks the next step.", owner: "Alex" }]} />
        <p>Based on <Source label="example thread" kind="thread" from="chat" />.</p>
      </Section>
    </main>
  );
}
`;

export function scaffold(dirArg: string, kind = "status"): string {
  const dir = resolve(dirArg.endsWith(".artifact") ? dirArg : dirArg + ".artifact");
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const title = basename(dir, ".artifact").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  writeFileSync(join(dir, "artifact.json"), JSON.stringify({
    title, kind, shell: "bare", audience: "who this is for", summary: "One or two sentences: what the reader should take away.",
    sources: [], created: new Date().toISOString().slice(0, 10),
  }, null, 2) + "\n");
  writeFileSync(join(dir, "index.tsx"), TEMPLATE);
  writeFileSync(join(dir, "data/items.json"), JSON.stringify([
    { name: "Auth rewrite", status: "doing", owner: "Sam" }, { name: "Docs", status: "todo", owner: "Ana" }, { name: "Billing fix", status: "done", owner: "Sam" },
  ], null, 2) + "\n");
  return dir;
}
