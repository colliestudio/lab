import { Replay } from "artifact";

export default function Recordings() {
  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "2.5rem 1.5rem 4rem", display: "grid", gap: "2.5rem" }}>
      <header>
        <h1 style={{ margin: 0 }}>Recordings</h1>
        <p className="a-muted">Seekable DOM recordings instead of screenshots: anything that moves, or has a before and after. Click a chapter to jump to it.</p>
      </header>
      <section>
        <h2>One agent undoes only its own step</h2>
        <p>Claude, then another person, edit a board hosted by the agent bridge. <code>canvas undo</code> removes only Claude's note.</p>
        <Replay src="evidence/agent-bridge-undo.replay" />
      </section>
      <section>
        <h2>A messy wall becomes a timeline</h2>
        <p>The same recording as a short silent loop: chapters 2 and 3 only (the snap and the undo), no controls.</p>
        <Replay src="evidence/eventstorm-timeline.replay" steps={[2, 3]} loop />
      </section>
    </main>
  );
}
