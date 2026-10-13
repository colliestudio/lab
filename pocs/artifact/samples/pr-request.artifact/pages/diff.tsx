import { ReviewDiff, Link, type AuthorNote } from "artifact";

export const page = { title: "Full diff" };
const notes: AuthorNote[] = [
  { file: "artifact/host/comments.tsx", line: 149, body: "The fallback for stores without update(): remove + add, so the comment moves to the end. See #12 for why I left it." },
  { file: "artifact/host/host.css", line: 59, body: "The fix. `align-self: start` made the fixed drawer as tall as its content." },
];
export default function DiffPage() {
  return <>
    <p><Link to="home">Back to the request</Link>. The blue cards are my notes.</p>
    <ReviewDiff patch="evidence/pr.patch" notes={notes} />
  </>;
}
