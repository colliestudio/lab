import { Morph } from "artifact";
import { Frame } from "../Nav";

export const page = { title: "Beta demo", summary: "Offline mode that syncs when you are back." };

export default function Page() {
  return (
    <Frame>
      <Morph name="hero-beta" className="b-hero" />
      <h1 style={{ margin: 0 }}>Beta demo</h1>
      <p>Offline mode that syncs when you are back. Select any text or alt-click an element to comment on it.</p>
    </Frame>
  );
}
