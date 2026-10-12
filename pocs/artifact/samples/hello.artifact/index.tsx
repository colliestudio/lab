import {
  Badge, Callout, Card, CardGrid, Chart, Checklist, Code, Compare, Decision, Depth, Diff, Flow, Grid, Lanes, Map, PR, Questions,
  Replay, Section, Source, Stale, Status, Step, Steps, Table, Tab, Tabs, Timeline, useData,
} from "artifact";

type Pr = { n: number; title: string; state: string; checks: string; owner: string; stack: [number, number]; href: string };

export default function Hello() {
  const prs = useData<Pr[]>("prs");
  const events = useData<{ when: string; lane: string; title: string; status: string; body?: string }[]>("events");
  return (
    <>
      <Callout tone="info" title="Where we are">
        The kit builds one HTML file from <code>index.tsx</code>. Two of three PRs are on track; <b>one is blocked on a decision</b> (below).
      </Callout>

      <Section id="status" title="Status at a glance">
        <Grid cols={3}>
          <Card title="Kit" aside={<Status s="doing" />}>Components, host, CLI.</Card>
          <Card title="Demos" aside={<Status s="todo" />}>Two to build next.</Card>
          <Card title="Review" aside={<Status s="blocked">Needs Alex</Status>} tone="warn">Waiting on the decision below.</Card>
        </Grid>
        <Table
          columns={[
            { key: "n", label: "PR", render: (_, r) => <PR n={r.n as number} title={r.title as string} state={r.state as string} checks={r.checks as string} stack={r.stack as [number, number]} href={r.href as string} /> },
            "owner",
            { key: "checks", render: (v) => <Status s={v === "pass" ? "ok" : v === "fail" ? "failed" : "waiting"} /> },
          ]}
          rows={prs}
        />
        <p>
          The plan says <Stale says="3 PRs open" now="1 open, 1 merged, 1 draft" asOf="Oct 12" /> — sources:{" "}
          <Source label="PR #41" kind="pr" href="https://example.com/pr/41" from="GitHub" />{" "}
          <Source label="plan.md" kind="file" from="workspace" />
        </p>
      </Section>

      <Section id="decision" title="What needs a decision">
        <Decision question="Ship the kit before the demos are redone?" recommend={0} owner="Alex"
          options={[{ label: "Yes, ship now", note: "Demos follow in a second pass." }, { label: "Wait for the demos" }]}
          why="Both paths work; waiting costs about a day." />
        <Questions items={[{ q: "Is 5 MB the right size warning?", why: "Recordings dominate." }, "Keep the name?"]} />
      </Section>

      <Section id="map" title="How the pieces fit">
        <Map
          groups={[{ id: "write", label: "Authoring" }, { id: "read", label: "Reading" }]}
          nodes={[
            { id: "agent", label: "Agent writes index.tsx", group: "write", state: "done", note: "Free structure; imports the kit." },
            { id: "ev", label: "Evidence", group: "write", state: "done", note: "patches, recordings, images" },
            { id: "build", label: "artifact build", state: "doing", note: "esbuild bundle, evidence inlined." },
            { id: "html", label: "One HTML file", group: "read", state: "ok" },
            { id: "host", label: "Host chrome", group: "read", state: "warn", note: "Present mode is new; needs a look." },
          ]}
          edges={[{ from: "agent", to: "build" }, { from: "ev", to: "build", label: "inlined" }, { from: "build", to: "html" }, { from: "html", to: "host" }]}
        />
        <Flow caption="Review loop">{`sequenceDiagram
  participant A as Agent
  participant R as Reader
  A->>R: artifact.html
  R->>A: copied feedback
  A->>R: revised artifact`}</Flow>
      </Section>

      <Section id="change" title="A change, in evidence">
        <p>Evidence is referenced by path; the build parses the patch and inlines only the lines shown.</p>
        <Tabs>
          <Tab label="Diff">
            <Diff patch="evidence/resolve-tsx.patch" file="bin/recap.js" notes={{ 7: "Resolve tsx from the repo, not from the caller's cwd." }} />
          </Tab>
          <Tab label="Code ranges"><Code file="evidence/glob-excerpt.ts" ranges="1-6,14-20" highlight="3" title="src/glob.ts" /></Tab>
          <Tab label="Recording"><Replay src="evidence/todo.replay" caption="Todo app with OTel traces (Collie Demo)." /></Tab>
        </Tabs>
        <Compare items={[
          { label: "Before", src: "evidence/before.svg", caption: "Fixed viewer: one shape per kind." },
          { label: "After", src: "evidence/after.svg", caption: "Any structure the author picks." },
        ]} />
      </Section>

      <Section id="detail" title="Detail levels (optional)">
        <Depth level={1}><p>Press 1 to 4 to show less or more. Level 1 is always visible.</p></Depth>
        <Depth level={3}><Callout tone="neutral">Level 3 and deeper hides when you pick 1 or 2.</Callout></Depth>
        <Depth level={4}><Checklist items={[{ text: "Tabs", done: true }, { text: "Present mode", done: true, note: "press p" }, { text: "MDX", status: "todo" }]} /></Depth>
      </Section>

      <Section id="plan" title="Plan and timeline">
        <Steps items={[{ title: "Build the kit", status: "doing" }, { title: "Redo two demos", status: "todo" }, "Show Alex"]} />
        <Step><Callout tone="success">Step marks reveal one by one in present mode.</Callout></Step>
        <Step><Timeline items={events} /></Step>
        <Lanes lanes={[
          { title: "Now", children: <Card title="Kit">in progress</Card> },
          { title: "Next", children: <Card title="Demos">two</Card> },
          { title: "Later", tone: "neutral", children: <Card title="Server">not yet</Card> },
        ]} />
        <CardGrid items={[{ title: "Small", body: "Cards from data.", status: "ok" }, { title: "Quick", body: "No JSX per card.", status: "info" }]} />
        <Chart caption="Output size by example (KB)" data={[{ label: "empty", value: 280 }, { label: "map", value: 1900 }, { label: "replay", value: 520 }]} unit="" />
        <p>Done: <Badge tone="success">3</Badge> Open: <Badge tone="warn">2</Badge></p>
      </Section>
    </>
  );
}
