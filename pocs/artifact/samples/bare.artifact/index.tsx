import { Morph, navigate, usePages } from "artifact";
import { Frame } from "./Nav";

export const page = { title: "Overview" };

export default function Home() {
  const pages = usePages().filter((p) => p.id !== "home");
  return (
    <Frame>
      <h1 style={{ fontSize: "3rem", margin: 0 }}>Release notes</h1>
      <p className="a-muted">Pick a demo. The card's swatch morphs into the next page's hero.</p>
      <div className="b-cards">
        {pages.map((p) => (
          <a key={p.id} className="b-card" href={p.href} onClick={(e) => { e.preventDefault(); navigate(p.id); }}>
            <Morph name={`hero-${p.id}`} className="b-swatch" />
            <h3>{p.title}</h3><p className="a-muted">{p.summary}</p>
          </a>
        ))}
      </div>
    </Frame>
  );
}
