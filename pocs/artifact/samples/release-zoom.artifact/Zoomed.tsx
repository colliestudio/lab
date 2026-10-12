// A place on the map, zoomed in: the paper the tile grew into, a minimap of where you are, and the four ways out.
import { Decision, Morph, useTheme } from "artifact";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { BAND_H, BOARD_H, EDGE_X, G, HUE, LABEL, ORDER, feature, layout, neighbour, rel, theme, type Dir } from "./model.ts";
import { ARROWS, keyIsBusy, travel, travelDir, zoomOut } from "./travel.ts";
import { HowCode, LiveDemo, Shots } from "./demos.tsx";
import "./zoom.css";

/** `code` spans in the release copy. */
export const md = (t: string) => t.split(/`([^`]+)`/).map((x, i) => (i % 2 ? <code key={i}>{x}</code> : x));

const hueOf = (id: string) => (id === "removed" ? 20 : id === "next" ? 200 : HUE[feature(id).theme]);

/** The frame every zoomed page shares. */
function Zoomed({ id, children }: { id: string; children: React.ReactNode }) {
  useTheme(); // re-render on theme change so the paper's tint follows
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (keyIsBusy(e)) return;
      if (e.key === "Escape") { e.preventDefault(); zoomOut(id); return; }
      const dir = ARROWS[e.key];
      if (!dir) return;
      e.preventDefault();
      travelDir(id, dir);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [id]);
  const style = { "--h": hueOf(id) } as React.CSSProperties;
  return (
    <>
      {typeof document !== "undefined" && createPortal(<Morph name={`zt-${id}`} when={false} className="zf-paper zb-h" style={{ ...style, viewTransitionClass: "zt" } as React.CSSProperties} />, document.body)}
      <Morph name="zb-content" className="zf zb-h" style={style}>
        {children}
        <Compass id={id} />
      </Morph>
      <Edges id={id} />
    </>
  );
}

/** The top bar: minimap (click = zoom out), where you are, and the position in the reading order. */
function TopBar({ id, crumb }: { id: string; crumb: React.ReactNode }) {
  const i = ORDER().indexOf(id);
  return (
    <div className="zf-top">
      <button className="zf-mapbtn" onClick={() => zoomOut(id)} title="Back to the map (Esc)" aria-label="Back to the map (Esc)">
        <Minimap here={id} />
        <span className="zf-mapbtn-label"><kbd>Esc</kbd> map</span>
      </button>
      <div className="zf-crumb">{crumb}</div>
      <div className="zf-pos" aria-label={`Place ${i + 1} of ${ORDER().length}`}>{String(i + 1).padStart(2, "0")}<span>/{ORDER().length}</span></div>
    </div>
  );
}

/** The whole board in miniature: regions as tinted blocks, tiles as cells, this page lit. Cells travel there. */
function Minimap({ here }: { here: string }) {
  const k = 0.1;
  const go = (to: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (to === here) return;
    const a = cellCenter(here), b = cellCenter(to);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    travel(here, to, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };
  return (
    <Morph name="zb-mini" className="zf-mini" style={{ width: G.W * k, height: BOARD_H * k }}>
      {layout().map((r) => (
        <span key={r.theme} className="zf-mini-r zb-h" style={{ "--h": HUE[r.theme], left: r.x * k, top: r.y * k, width: r.w * k, height: r.h * k } as React.CSSProperties} />
      ))}
      {layout().flatMap((r) => r.tiles).map((t) => (
        <span key={t.id} role="link" aria-label={feature(t.id).title} title={LABEL[t.id]} onClick={go(t.id)}
          className="zf-mini-t zb-h" data-here={t.id === here || undefined}
          style={{ "--h": HUE[t.theme], left: t.x * k, top: t.y * k, width: t.w * k, height: t.h * k } as React.CSSProperties} />
      ))}
      <span className="zf-mini-t zf-mini-gone" data-here={here === "removed" || undefined} title="Removed" onClick={go("removed")}
        style={{ left: G.M * k, top: (G.M + 2 * (BAND_H + G.BGAP)) * k, width: G.LEFT * k, height: BAND_H * k }} />
      <span className="zf-mini-t zf-mini-edge" data-here={here === "next" || undefined} title="Next up" onClick={go("next")}
        style={{ left: EDGE_X * k, top: 0, width: (G.W - EDGE_X) * k, height: BOARD_H * k }} />
      <span className="zf-mini-intro" style={{ left: G.M * k, top: G.M * k, width: G.LEFT * k * 0.7 }} />
    </Morph>
  );
}
function cellCenter(id: string): [number, number] {
  if (id === "removed") return [G.M + G.LEFT / 2, G.M + 2 * (BAND_H + G.BGAP) + BAND_H / 2];
  if (id === "next") return [EDGE_X + 100, BOARD_H / 2];
  const t = layout().flatMap((r) => r.tiles).find((x) => x.id === id)!;
  return [t.x + t.w / 2, t.y + t.h / 2];
}

const NAME = (id: string) => (id === "removed" ? "Left behind" : id === "next" ? "Next up" : LABEL[id] ?? feature(id).title);
const GLYPH: Record<Dir, string> = { left: "←", up: "↑", down: "↓", right: "→" };

/** The four neighbours as a compass at the end of the page (and the arrow keys anywhere). */
function Compass({ id }: { id: string }) {
  const dirs: Dir[] = ["up", "left", "right", "down"];
  return (
    <nav className="zf-compass" aria-label="Neighbours on the map">
      <div className="zf-compass-title">Travel</div>
      {dirs.map((d) => {
        const n = neighbour(id, d);
        return (
          <button key={d} className="zf-dir" data-dir={d} disabled={!n} onClick={() => travelDir(id, d)}>
            <kbd>{GLYPH[d]}</kbd><span>{n ? NAME(n) : "edge of the map"}</span>
          </button>
        );
      })}
      <button className="zf-dir zf-out" onClick={() => zoomOut(id)}><kbd>Esc</kbd><span>Zoom out to the map</span></button>
    </nav>
  );
}

/** Left and right neighbours as quiet labels on the screen edges (wide screens). */
function Edges({ id }: { id: string }) {
  const l = neighbour(id, "left"), r = neighbour(id, "right");
  return (
    <>
      {l && <button className="zf-side" data-side="left" onClick={() => travelDir(id, "left")} aria-label={`Travel left to ${NAME(l)}`}><kbd>←</kbd><span>{NAME(l)}</span></button>}
      {r && <button className="zf-side" data-side="right" onClick={() => travelDir(id, "right")} aria-label={`Travel right to ${NAME(r)}`}><span>{NAME(r)}</span><kbd>→</kbd></button>}
    </>
  );
}

const ROUND_DATE: Record<string, string> = { "2026-10-12": "Oct 12", "2026-10-13": "Oct 13" };

export function FeaturePage({ id }: { id: string }) {
  const f = feature(id), t = theme(f.theme), r = rel();
  const round = r.rounds.find((x) => x.round === f.roundLabel);
  const crumb = <><span className="zf-dot" />{t.title}</>;
  return (
    <Zoomed id={id}>
      <section className="zf-hero" data-section="top" data-title={f.title} id="top">
        <TopBar id={id} crumb={crumb} />
        <div className="zf-chips">
          <span className="zf-chip zf-chip-theme">{t.title}</span>
          <span className="zf-chip">Round {f.roundLabel}</span>
          <span className="zf-chip" data-tone={f.status}>{f.status === "new" ? "New" : "Improved"}</span>
        </div>
        <h1 className="zf-title" data-long={f.title.length > 34 || undefined}>{f.title}</h1>
        <p className="zf-lead">{md(f.oneLiner)}</p>
      </section>

      <section className="zf-demo" data-section="see-it" data-title="See it" id="see-it">
        <h2 className="zf-h">{f.demo.kind === "live" ? "Live: the real component" : f.demo.kind === "shot" ? "As it looks in a real page" : "The call"}</h2>
        <div className="zf-stage" data-kind={f.demo.kind}>
          {f.demo.kind === "live" ? <LiveDemo f={f} /> : f.demo.kind === "shot" ? <Shots f={f} /> : <HowCode f={f} />}
        </div>
        {f.demo.kind === "live" && f.demo.shot && <p className="zf-aside">Also in a real page: {f.demo.shotFrom}.</p>}
      </section>

      <section className="zf-why" data-section="why" data-title="Why and how" id="why">
        <div className="zf-cols">
          <div>
            <h2 className="zf-h">Why it exists</h2>
            <p className="zf-whytext">{md(f.why)}</p>
          </div>
          {f.demo.kind !== "none" && <div className="zf-how"><h2 className="zf-h">How you use it</h2><HowCode f={f} /></div>}
        </div>
        {round && (
          <div className="zf-round">
            <div className="zf-round-n"><small>Round</small>{round.round}</div>
            <div>
              <p>{md(round.summary)}</p>
              <small>{ROUND_DATE[round.date] ?? round.date}{round.tests ? ` · ${round.tests} kit tests after it` : ""} · commits {f.commits.map((c) => <code key={c}>{c}</code>)}</small>
            </div>
          </div>
        )}
      </section>
    </Zoomed>
  );
}

const GONE_TITLE: Record<string, string> = { "detail-levels": "Detail 1–4 zoom levels", "fixed-format": "The recap POC's fixed format" };

export function RemovedPage() {
  const r = rel();
  return (
    <Zoomed id="removed">
      <section className="zf-hero" data-section="top" data-title="Left behind" id="top">
        <TopBar id="removed" crumb={<><span className="zf-dot" />The corner of the map</>} />
        <div className="zf-chips"><span className="zf-chip zf-chip-theme">Removed</span><span className="zf-chip">{r.removed.length} ideas</span></div>
        <h1 className="zf-title">Left behind</h1>
        <p className="zf-lead">Two things v0.1 tried and dropped. Both were more structure than the reader needed; the agent picks the shape now.</p>
      </section>
      <section className="zf-gone-list" data-section="gone" data-title="What went, and what replaced it" id="gone">
        {r.removed.map((x) => {
          const to = x.replacedBy;
          return (
            <article key={x.id} className="zf-gone" id={`gone-${x.id}`}>
              <h2><s>{GONE_TITLE[x.id] ?? x.title}</s></h2>
              <p>{md(x.oneLiner)}</p>
              <blockquote>{x.why}</blockquote>
              <div className="zf-gone-meta">
                {x.addedRound && <span>added in round {x.addedRound}, removed in round {x.removedRound}</span>}
                {x.commits && <span>commits {x.commits.map((c) => <code key={c}>{c}</code>)}</span>}
                {to && <button className="zf-replaced" onClick={() => travel("removed", to, "right")}>Replaced by <b>{LABEL[to]}</b> →</button>}
              </div>
            </article>
          );
        })}
      </section>
    </Zoomed>
  );
}

export function NextPage() {
  const r = rel();
  return (
    <Zoomed id="next">
      <section className="zf-hero" data-section="top" data-title="Next up" id="top">
        <TopBar id="next" crumb={<><span className="zf-dot" />The edge of the map</>} />
        <div className="zf-chips"><span className="zf-chip zf-chip-theme">After v0.1</span><span className="zf-chip">as of Oct 13</span></div>
        <h1 className="zf-title">Next up</h1>
        <p className="zf-lead">What lies past the edge of this map. The first one is happening now: you are reading one of its four prototypes.</p>
      </section>
      <section className="zf-nextlist" data-section="list" data-title="The list" id="list">
        <ol>
          {r.nextUp.map((n, i) => (
            <li key={n.title} data-now={i === 0 || undefined}>
              <span className="zf-n">{i === 0 ? "now" : String(i + 1).padStart(2, "0")}</span>
              <div><b>{n.title}</b><p>{md(n.oneLiner)}</p></div>
            </li>
          ))}
        </ol>
      </section>
      <section className="zf-decide" data-section="decide" data-title="Your call" id="decide">
        <h2 className="zf-h">Your call</h2>
        <Decision id="zoom-keep" question="What of this zoom board should the kit keep?"
          options={[
            { label: "The whole board as a kit layout", note: "regions + tiles + zoom + minimap from a list of items; for releases and run recaps" },
            { label: "Only the pieces", note: "tile-to-page zoom, a minimap, arrow travel between pages; each artifact lays out its own board" },
            { label: "Nothing: a one-off for this release", note: "keep it as a sample artifact" },
          ]}
          recommend={1} owner="Alex"
          why="A board pays off when there are many peers (26 features here, 16 branches in a run recap); most artifacts are one story, where the zoom and the minimap still help but a fixed grid would not." />
        <p className="zf-credits">{r.credits}</p>
      </section>
    </Zoomed>
  );
}
