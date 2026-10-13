import { Section, Callout, Diff, Link, useData, Verdict, Layers, LayerTag, ReviewComments, CopyReview, type Layer, type ReviewComment } from "artifact";

interface Review { matters: string[]; comments: ReviewComment[]; layers: Layer[]; flows: { from: string; to: string; label: string; before?: string; after?: string }[] }

export default function Page() {
  const pr = useData<{ title: string; body: string; additions: number; deletions: number; files: unknown[] }>("pr");
  const r = useData<Review>("review");
  const { comments, layers } = r;
  return <>
    <Section title="Verdict" id="verdict-section" lead="Approve with comments.">
      <Verdict recommend="comments" readTime="8 min" matters={r.matters} comments={comments}>
        <p>{pr.files.length} files, +{pr.additions} −{pr.deletions}. Everything the PR says it does, it does; the comments below are about edges.</p>
      </Verdict>
    </Section>

    <Section title="Why this PR exists">
      <p>{pr.body}</p>
    </Section>

    <Section title="The change, layer by layer">
      <Layers layers={layers} flows={r.flows} />
    </Section>

    <Section title="Code walk">
      <div id="walk-drawer"><LayerTag layer="drawer" />
        <p>The editor is small and local to the drawer: Save is blocked for empty comments, Esc cancels without closing the drawer.</p>
        <Diff patch="evidence/pr.patch" file="artifact/host/comments.tsx" hunks="5,6,7" />
      </div>
      <div id="walk-state"><LayerTag layer="state" />
        <p>Answering again with something different stamps `edited` and keeps the first mark.</p>
        <Diff patch="evidence/pr.patch" file="artifact/host/comments.tsx" hunks="4" />
      </div>
      <div id="walk-store"><LayerTag layer="store" />
        <p>The interface grows two optional-in-practice methods; stores written before them are wrapped.</p>
        <Diff patch="evidence/pr.patch" file="artifact/host/comments.tsx" hunks="2,3" />
      </div>
    </Section>

    <Section title="Tests">
      <p>One new file with four cases: scroll in doc and bare at 1280 and 400 px, edit a comment and a decision note, store update. They pass; the scroll case is the flaky one (see the comment on line 61).</p>
    </Section>

    <Section title="Risks">
      <Callout tone="warn" title="Reordering on old backends">A custom store without update() moves an edited comment to the end of its list.</Callout>
    </Section>

    <Section title="Full diff">
      <p>Every file, with the comments next to their lines: <Link to="diff">open the full diff</Link>.</p>
    </Section>

    <Section title="Your review">
      <p>Decide on each comment (Keep, Edit, Drop), pick the verdict above, then copy.</p>
      <ReviewComments comments={comments} />
      <CopyReview comments={comments} title={pr.title} summary="Edit and delete work end to end and the scroll fix addresses the root cause. Two questions and one test-stability fix below." />
    </Section>
  </>;
}
