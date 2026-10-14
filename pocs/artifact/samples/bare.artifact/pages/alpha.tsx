import { Morph } from "artifact";
import { Frame } from "../Nav";

export const page = { title: "Alpha demo", summary: "Faster search across the whole workspace." };

export default function Page() {
  return (
    <Frame>
      <Morph name="hero-alpha" className="b-hero" />
      <h1 style={{ margin: 0 }}>Alpha demo</h1>
      <p>Faster search across the whole workspace. Select any text or alt-click an element to comment on it.</p>
    </Frame>
  );
}
