import { PrHeader, ExistingComments, Section, Callout, Code, Diff, Link, Linked, useData, ghUrl, Verdict, Layers, LayerTag, ReviewComments, CopyReview, type Layer, type ReviewComment } from "artifact";

interface Review { matters: string[]; comments: ReviewComment[]; layers: Layer[]; flows: { from: string; to: string; label: string; before?: string; after?: string }[] }

export default function Page() {
  const pr = useData<{ title: string; additions: number; deletions: number; files: unknown[] }>("pr");
  const r = useData<Review>("review");
  const { comments, layers } = r;
  return <>
    <PrHeader recommend="comments" comments={comments} />

    <Section title="Why this PR exists">
      <p>The feedback drawer is where readers answer decisions and leave comments. With 30 comments it stopped scrolling in the bare shell, and a typo in a comment meant deleting it and starting over. The PR fixes both (fixes #12; follows up on <Linked>{"example/recap-lab#9"}</Linked>).</p>
    </Section>

    <Section title="Context today">
      <p>The drawer is a sticky panel with <code>max-height</code> and <code>overflow: auto</code>. Chrome lets <code>align-self: start</code> shrink a fixed box to its content, so in the bare shell, where the drawer is fixed, it grew past the screen and nothing inside scrolled.</p>
      <Code code={".h-panel { position: sticky; top: 3rem; align-self: start; max-height: calc(100vh - 3.5rem); overflow: auto; … }"} lang="css" start={56} source={{ path: "artifact/host/host.css", ref: "base" }} />
      <ExistingComments />
    </Section>

    <Section title="Shape of the change" lead="It crosses six layers, so a layer view helps here.">
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
        <p>The interface grows two methods; stores written before them are wrapped (see <a href={ghUrl.file("artifact/host/comments.tsx", 149)} target="_blank" rel="noreferrer"><code>comments.tsx:149</code></a>).</p>
        <Diff patch="evidence/pr.patch" file="artifact/host/comments.tsx" hunks="2,3" />
      </div>
    </Section>

    <Section title="Tests">
      <p>One new file with four cases: scroll in doc and bare at 1280 and 400 px, edit a comment and a decision note, store update. They pass; the scroll case is the flaky one (see <Linked>{"`test/feedback-drawer.test.ts:61`"}</Linked>). CI shows one failing check, covered in the <Link to="home#verdict-section">verdict</Link>.</p>
    </Section>

    <Section title="Risks">
      <Callout tone="warn" title="Reordering on old backends">A custom store without update() moves an edited comment to the end of its list.</Callout>
    </Section>

    <Section title="Verdict" id="verdict-section" lead="Approve with comments.">
      <Verdict recommend="comments" readTime="8 min" matters={r.matters} comments={comments}>
        <p>{pr.files.length} files, +{pr.additions} −{pr.deletions}. Everything the PR says it does, it does; the comments below are about edges.</p>
      </Verdict>
    </Section>

    <Section title="Your review">
      <p>Decide on each comment (Keep, Edit, Drop), pick the verdict above, then copy. The full diff, with the comments next to their lines, is on <Link to="diff">its own page</Link>.</p>
      <ReviewComments comments={comments} />
      <CopyReview comments={comments} title={pr.title} summary="Edit and delete work end to end and the scroll fix addresses the root cause. Two questions and one test-stability fix below." />
    </Section>
  </>;
}
