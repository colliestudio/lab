import { PrHeader, Section, Table, Code, Checklist, Callout, Link, Linked, Compare, useData, ghUrl } from "artifact";

export default function Page() {
  const pr = useData<{ files: { path: string; additions: number; deletions: number }[] }>("pr");
  const why: Record<string, string> = {
    "artifact/host/comments.tsx": "Start here. Edit and Delete, the in-place update, and the compatibility wrapper.",
    "artifact/host/host.css": "The scroll fix: a fixed-height flex column.",
    "artifact/kit/feedback.ts": "Two optional fields on stored shapes.",
    "artifact/host/Host.tsx": "One prop wired through.",
    "test/feedback-drawer.test.ts": "Read last: the scroll cases use fixed waits.",
  };
  return <>
    <PrHeader />

    <Section title="What this does">
      <p>The drawer's list now scrolls in the bare shell and readers can edit or delete their comments (fixes #12). I did not change how answers are stored; <Linked>{"`artifact/kit/feedback.ts`"}</Linked> only gets two optional fields.</p>
    </Section>

    <Section title="Where to start" lead="Five files; the order below is the order I would read them.">
      <Table columns={["file", "+/-", "why"]} rows={[...pr.files].sort((a, b) => Object.keys(why).indexOf(a.path) - Object.keys(why).indexOf(b.path)).map((f) => ({
        file: <a href={ghUrl.diff(f.path)} target="_blank" rel="noreferrer"><code>{f.path}</code></a>,
        "+/-": `+${f.additions} −${f.deletions}`, why: why[f.path] ?? "",
      }))} />
    </Section>

    <Section title="Before and after">
      <Compare items={[
        { label: "Before", node: <Code code={".h-panel { align-self: start; max-height: calc(100vh - 3.5rem); overflow: auto; }"} lang="css" start={56} source={{ path: "artifact/host/host.css", ref: "base" }} /> },
        { label: "After", node: <Code code={".h-panel { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }\n.h-panel-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }"} lang="css" start={59} source="artifact/host/host.css" /> },
      ]} />
    </Section>

    <Section title="What to scrutinize">
      <Callout tone="warn" title="A custom store without update()">An edited comment moves to the end of its list (<a href={ghUrl.file("artifact/host/comments.tsx", 149)} target="_blank" rel="noreferrer"><code>comments.tsx:149</code></a>). I accepted it for old backends; tell me if you disagree.</Callout>
      <Callout tone="info" title="Not checked">Safari. The drawer's height uses <code>dvh</code>, which older iOS lacks.</Callout>
    </Section>

    <Section title="How I verified it">
      <Checklist items={[{ text: "scroll in doc and bare shells at 1280 and 400 px", done: true }, { text: "edit a comment and a decision note, reload", done: true }, { text: "run the full suite once under load", done: false, note: "one test flakes" }]} />
      <p>The full diff has my notes at the lines to look at: <Link to="diff">open it</Link>.</p>
    </Section>
  </>;
}
