import { ReviewDiff, Link, useData, type ReviewComment } from "artifact";

export const page = { title: "Full diff" };
export default function DiffPage() {
  const { comments } = useData<{ comments: ReviewComment[] }>("review");
  return <>
    <p><Link to="home">Back to the review</Link>. Decide on each comment here or on the main page; both share the same choices.</p>
    <ReviewDiff patch="evidence/pr.patch" comments={comments} />
  </>;
}
