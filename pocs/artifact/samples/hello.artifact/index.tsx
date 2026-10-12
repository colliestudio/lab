import {
  Badge, Callout, Card, CardGrid, Img, Chart, Checklist, Code, Compare, Decision, More, Diff, Flow, Grid, Lanes, Map, PR, Questions,
  Replay, Walkthrough, When, Stages, TimeAxis, Stats, Scorecard, Facts, Actions, RiskMatrix, Gallery, DecisionIndex, Section, Source, Stale, Status, Step, Steps, Table, Tab, Tabs, Timeline, useData,
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

      <Stats items={[{ value: 16, label: "branches" }, { value: 150, label: "commits", sub: "this week" }, { value: 0, label: "merged", tone: "warn" }, { value: 5, label: "decisions", tone: "accent", href: "#decision" }]} />

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
        <DecisionIndex />
        <Decision id="d-ship" question="Ship the kit before the demos are redone?" recommend={0} owner="Alex"
          options={[{ label: "Yes, ship now", note: "Demos follow in a second pass." }, { label: "Wait for the demos" }]}
          why="Both paths work; waiting costs about a day." />
        {/* a two-level decision tree: the follow-ups appear only after the answer above */}
        <When decision="d-ship" is="a">
          <Decision id="d-order" question="Which demo goes first?" recommend={0} owner="Alex"
            options={["The collie-ui explainer", "The status page", { label: "Both in parallel", key: "both" }]} />
          <When decision="d-order" is="both">
            <Decision id="d-split" question="Who reviews the second one?" recommend="A fresh reviewer" owner="Alex" options={["A fresh reviewer", "The same reviewer"]} />
          </When>
        </When>
        <When decision="d-ship" is="b">
          <Callout tone="warn" title="Waiting">Then the next question is how long we wait.</Callout>
          <Decision id="d-wait" question="How long do we wait for the demos?" options={["One day", "Until they pass review"]} recommend={0} />
        </When>
        <When decision="d-ship" unanswered><p className="a-muted">Answer the decision above and the follow-up questions appear here.</p></When>
        <Questions items={[{ q: "Is 5 MB the right size warning?", why: "Recordings dominate." }, "Keep the name?"]} />
      </Section>

      <Section id="options" title="Options, scored">
        <Scorecard options={["Ship now", "Wait for demos", "Cut scope"]} recommend={0} verdict={["Do this", "Costs a day", "Loses the map"]}
          rows={[
            { name: "Time to value", weight: "high", cells: [{ grade: "best", text: "today" }, { grade: "weak", text: "tomorrow" }, { grade: "ok", text: "today" }] },
            { name: "Risk", cells: [{ grade: "ok", text: "known gaps" }, { grade: "best", text: "lowest" }, { grade: "weak", text: "rework later" }] },
            { name: "Reader value", cells: [{ grade: "best", text: "full kit" }, { grade: "best", text: "full kit" }, { grade: "bad", text: "partial" }] },
          ]} />
        <Actions items={[
          { title: "Merge the kit", why: "Demos are blocked on it.", effort: "10 min", rec: "Merge after the review fixes.", owner: "Alex", sources: [{ label: "review.md", from: "vault" }] },
          { title: "Redo the collie-ui explainer", why: "Proves the kit on a real page.", effort: "1 h", status: "todo" },
        ]} />
        <Grid cols={2}>
          <Card title="Facts"><Facts items={[["main", "up to date"], ["board", <Status key="s" s="doing" />], ["last run", <PR key="p" n={44} state="open" conflict updatedAt="2026-10-10T10:00:00Z" asOf="2026-10-12T10:00:00Z" review="changes" />]]} /></Card>
          <RiskMatrix risks={[{ id: "R1", title: "Bundle too big", like: "high", impact: "med", mitigation: "Avoid Flow" }, { id: "R2", title: "Host bugs", like: "med", impact: "high" }, { id: "R3", title: "Name clash", like: "low", impact: "low" }]} />
        </Grid>
        <Gallery layout="tiles" hint="Click a tile to open its detail."
          items={[
            { label: "viewer", thumb: "evidence/before.svg", status: "done", summary: "The fixed review viewer.", badges: <Badge>3 PRs</Badge>, detail: <Card title="viewer">Detail opens under the grid; put Tabs, Diff or Img in here.</Card> },
            { label: "artifact kit", thumb: "evidence/after.svg", status: "doing", summary: "Free-form pages.", badges: <Badge tone="warn">1 open</Badge>, detail: <Card title="artifact kit"><Img src="evidence/after.svg" caption="Click the image to enlarge it." /></Card> },
          ]} />
        <Gallery items={[
          { label: "Before", src: "evidence/before.svg", aside: <p>The fixed viewer.</p> },
          { label: "After", src: "evidence/after.svg", aside: <p>Free-form.</p>, caption: "One at a time, with a detail pane" },
        ]} />
      </Section>

      <Section id="walk" title="One request, step by step" lead="Switch scenarios with the tabs; ↑/↓ move between steps, ←/→ between scenarios.">
        <Walkthrough
          states={["QUEUED", "SENDING", "SENT", "FAILED"]}
          scenarios={[
            { id: "bug", label: "Today (bug)", steps: [
              { title: "Request queued", when: "10:00", who: "client", state: "QUEUED", body: "The client submits; nothing has been sent yet." },
              { title: "Worker sends it", when: "10:01", who: "worker", state: "SENDING", body: "The first attempt times out after 30 s." },
              { title: "Retry gives up", when: "10:03", who: "worker", state: "FAILED", tone: "bad", body: "The retry budget is zero, so the request fails and nobody is told.", note: "error: retry budget exhausted (0/0)" },
            ] },
            { id: "fix", label: "Fix A: retry twice", steps: [
              { title: "Request queued", when: "10:00", who: "client", state: "QUEUED", body: "Same as today." },
              { title: "Worker sends it", when: "10:01", who: "worker", state: "SENDING", body: "The first attempt times out after 30 s." },
              { title: "Second attempt succeeds", when: "10:02", who: "worker", state: "SENT", tone: "good", body: "The retry goes through." },
            ] },
          ]}
          visual={(step) => <Card title={`Request row: ${step.state}`}><Facts items={[["status", step.state ?? ""], ["last attempt", String(step.when ?? "")]]} /></Card>}
        />
      </Section>

      <Section id="stages" title="Three releases, same questions">
        <p>Each release fixed one more case; the last one made stuck orders recoverable.</p>
        <Stages stages={[{ title: "v1", sub: "Sep 1", tone: "success" }, { title: "v2", sub: "Sep 12", tone: "warn" }, { title: "v3", sub: "Oct 12", tone: "critical" }]}
          rows={[
            { label: "What changed", cells: ["Added retries", "Moved the check", "Removed the fallback"] },
            { label: "Can the order be acknowledged?", cells: [{ text: "yes", tone: "success" }, { text: "sometimes", tone: "warn" }, { text: "no", tone: "critical" }] },
            { label: "Stuck orders", cells: ["0", "3", "212"] },
          ]} />
      </Section>

      <Section id="when" title="When it happened (time axis)">
        <TimeAxis title="Six quiet weeks, then 36 hours of impact" lead="Left of the hatched break: weeks. Right of it: hours."
          segments={[{ from: "2026-09-01T00:00:00Z", to: "2026-10-12T00:00:00Z", label: "6 weeks" }, { from: "2026-10-12T00:00:01Z", to: "2026-10-13T12:00:00Z", weight: 2, label: "36 hours" }]}
          bands={[{ from: "2026-09-12T00:00:00Z", to: "2026-10-12T09:00:00Z", label: "gap exists", tone: "warn" }, { from: "2026-10-12T09:00:00Z", to: "2026-10-13T06:00:00Z", label: "no way out", tone: "critical" }]}
          events={[
            { at: "2026-09-01T00:00:00Z", label: "PR 1 merged", lane: "code" }, { at: "2026-09-12T00:00:00Z", label: "PR 2 merged", lane: "code", tone: "warn" },
            { at: "2026-10-12T08:00:00Z", label: "PR 3 merged", lane: "code", tone: "critical" },
            { at: "2026-10-12T10:00:00Z", label: "first stuck order", lane: "impact", tone: "critical" }, { at: "2026-10-12T14:00:00Z", to: "2026-10-13T04:00:00Z", label: "orders pile up", lane: "impact", tone: "warn" },
            { at: "2026-10-13T08:00:00Z", label: "fix ships", lane: "impact", tone: "success" },
          ]} />
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

      <Section id="folding" title="Folding and detail" lead="Click any heading to fold its section. Detail the reader can skip goes in More.">
        <p>The chevron appears when you hover a heading; Fold all / Unfold all live in the ? panel.</p>
        <More label="Checklist of what shipped">
          <Checklist items={[{ text: "Tabs", done: true }, { text: "Present mode", done: true, note: "press p" }, { text: "MDX", status: "todo" }]} />
        </More>
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
