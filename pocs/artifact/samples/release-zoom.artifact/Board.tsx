// The map of the release: every feature as a tile in its theme's region, what was removed in the bottom-left corner,
// and what comes next along the right edge. Click a tile to zoom in; arrows travel; Esc on a page zooms back out here.
import { Morph, usePresent, useRoute } from "artifact";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { BAND_H, BOARD_H, EDGE_X, G, HUE, LABEL, MID_X, REGIONS, SUB, feature, layout, rel, theme, type Dir, type RegionBox } from "./model.ts";
import { ARROWS, keyIsBusy, visited, zoomIn } from "./travel.ts";
import { Mini } from "./demos.tsx";
import "./zoom.css";

const sub = (cb: () => void) => { addEventListener("resize", cb); return () => removeEventListener("resize", cb); };
/** Scale that fits the whole board in the window; 0 means "too narrow for a map": stack the regions instead. */
function useFit(): number {
  const key = useSyncExternalStore(sub, () => `${innerWidth}x${innerHeight}`, () => "1280x800");
  const [w, h] = key.split("x").map(Number);
  if (w < 820) return 0;
  return Math.max(0.55, Math.min(w / G.W, h / BOARD_H, 1.25));
}

const hueStyle = (t: string) => ({ "--h": HUE[t] } as React.CSSProperties);
const geo = (b: { x: number; y: number; w: number; h: number }, o = { x: 0, y: 0 }) =>
  ({ "--x": b.x - o.x, "--y": b.y - o.y, "--w": b.w, "--h2": b.h } as React.CSSProperties);

export function Board() {
  const present = usePresent().active;
  const fitted = useFit();
  const fit = present ? 0 : fitted;
  const r = rel();
  const root = useRef<HTMLDivElement>(null);
  const [seen] = useState(visited);
  const route = useRoute();
  const [lit] = useState(route.previous !== "home" ? route.previous : undefined); // the place we came from lights up

  useLayoutEffect(() => {
    if (lit) root.current?.querySelector<HTMLElement>(`[data-tile="${lit}"]`)?.focus({ preventScroll: true });
  }, []);

  // Arrows move between tiles on the board (spatially), Enter zooms in.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const dir = ARROWS[e.key];
      if (!dir || keyIsBusy(e)) return;
      const tiles = [...(root.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])];
      const cur = document.activeElement?.closest<HTMLElement>("[data-tile]");
      e.preventDefault();
      if (!cur) { (tiles.find((t) => t.dataset.tile === lit) ?? tiles[0])?.focus(); return; }
      nearest(cur, tiles, dir)?.focus();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const boxes = layout();
  const explored = r.features.filter((f) => seen.has(f.id)).length;
  return (
    <div className="zb" data-mode={fit ? "map" : "flow"} ref={root}>
      <div className="zb-board" style={fit ? ({ zoom: fit, "--bh": BOARD_H } as React.CSSProperties) : undefined}>
        <header className="zb-intro" id="intro" data-section="intro" data-title="Artifact kit v0.1" style={geo({ x: G.M, y: G.M, w: G.LEFT, h: 2 * BAND_H + G.BGAP })}>
          <div className="zb-eyebrow">{r.product} · release notes</div>
          <h1 className="zb-version"><span>v</span>0.1</h1>
          <div className="zb-date">Oct 13, 2026 · {r.numbers.rounds} rounds over Oct 12–13</div>
          <p className="zb-headline" id="headline">{r.headline}</p>
          <dl className="zb-nums">
            <div><dt>{r.features.length}</dt><dd>features</dd></div>
            <div><dt>{r.numbers.tests}</dt><dd>kit tests</dd></div>
            <div><dt>{r.numbers.components}</dt><dd>components</dd></div>
            <div><dt>{r.numbers.kitCommits}</dt><dd>kit commits</dd></div>
          </dl>
          <figure className="zb-tests" id="tests-by-round">
            <figcaption>Kit tests after each round</figcaption>
            <div className="zb-tests-bars">
              {r.numbers.testsByRound.map((t) => (
                <span key={t.round} title={`Round ${t.round}: ${t.tests} tests`} style={{ "--v": Math.round(((t.tests - 70) / (128 - 70)) * 44) } as React.CSSProperties}>
                  <b>{t.tests}</b><i />{t.round}
                </span>
              ))}
            </div>
          </figure>
          <div className="zb-howto">
            <span><b>Click</b> a tile to zoom in</span>
            <span><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> travel</span>
            <span><kbd>Esc</kbd> back to the map</span>
          </div>
          <div className="zb-explored" title="Tiles you have opened (kept in this browser)">
            <i style={{ "--p": explored / r.features.length } as React.CSSProperties} />
            {explored ? <>Explored {explored} of {r.features.length}</> : <>Nothing explored yet</>}
          </div>
        </header>

        {boxes.map((b) => <Region key={b.theme} b={b} seen={seen} lit={lit} fit={fit} />)}

        <Removed fit={fit} lit={lit} />
        <Edge fit={fit} lit={lit} />
      </div>
    </div>
  );
}

function Region({ b, seen, lit, fit }: { b: RegionBox; seen: Set<string>; lit?: string; fit: number }) {
  const t = theme(b.theme);
  const n = REGIONS.find((r) => r.theme === b.theme)!.tiles.length;
  return (
    <section className="zb-region zb-h" id={`region-${b.theme}`} data-section={`region-${b.theme}`} data-title={t.title} style={{ ...hueStyle(b.theme), ...geo(b) }}>
      <h2 className="zb-rtitle">{t.title}<span className="zb-count">{n}</span></h2>
      <p className="zb-rsub">{SUB[b.theme]}</p>
      <div className="zb-tiles">
        {b.tiles.map((s, i) => <Tile key={s.id} id={s.id} style={geo(s, b)} seen={seen.has(s.id)} lit={lit === s.id} i={i} />)}
        {b.note?.kind === "call" && (
          <a className="zb-note" href="#/next" style={geo(b.note, b)} onClick={(e) => { if (e.altKey) return; e.preventDefault(); zoomIn("next", e.currentTarget); }}>
            <b>Your call</b><span>What of this map should the kit keep?</span><em>Answer on the edge →</em>
          </a>
        )}
        {b.note?.kind === "self" && (
          <div className="zb-note zb-self" style={geo(b.note, b)}>
            <b>You are inside one</b>
            <span>This map is 29 hash routes in a single HTML file: a page per tile, plus the corner and the edge.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Tile({ id, style, seen, lit, i }: { id: string; style: React.CSSProperties; seen: boolean; lit: boolean; i: number }) {
  const f = feature(id);
  return (
    <Morph name={`zt-${id}`} when={false} className="zb-tile" style={{ ...style, viewTransitionClass: "zt", "--i": i } as React.CSSProperties}>
      <a className="zb-hit" href={`#/${id}`} data-tile={id} data-lit={lit || undefined} id={`tile-${id}`} title={f.oneLiner.replace(/`/g, "")}
        aria-label={`${f.title}${f.status === "improved" ? " (improved)" : ""}`}
        onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); zoomIn(id, e.currentTarget); }} />
      <div className="zb-prev"><Mini f={f} /></div>
      <div className="zb-label">
        <span>{LABEL[id] ?? f.title}</span>
        <small>
          <em>r{f.roundLabel}</em>
          {f.status === "improved" && <em className="zb-imp">improved</em>}
          {seen && <em className="zb-seen" title="Explored">●</em>}
        </small>
      </div>
    </Morph>
  );
}

function Removed({ fit, lit }: { fit: number; lit?: string }) {
  const r = rel();
  const box = { x: G.M, y: G.M + 2 * (BAND_H + G.BGAP), w: G.LEFT, h: BAND_H };
  return (
    <section className="zb-slot" id="removed" data-section="removed" data-title="Left behind" style={geo(box)}>
    <Morph name="zt-removed" when={false} className="zb-removed" style={{ viewTransitionClass: "zt" } as React.CSSProperties}>
      <div className="zb-removed-in">
        <a className="zb-hit" href="#/removed" data-tile="removed" data-lit={lit === "removed" || undefined} aria-label="Removed in v0.1"
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); zoomIn("removed", e.currentTarget.parentElement); }} />
        <h2 className="zb-rtitle">Left behind <span className="zb-count">{r.removed.length}</span></h2>
        <p className="zb-rsub">Tried, then cut on Alex's “not this”.</p>
        {r.removed.map((x) => (
          <div key={x.id} className="zb-gone">
            <s>{x.id === "detail-levels" ? "Detail 1–4 zoom levels" : "The recap POC's fixed format"}</s>
            <span>→ {LABEL[x.replacedBy ?? ""] ?? x.replacedBy}</span>
          </div>
        ))}
      </div>
    </Morph>
    </section>
  );
}

function Edge({ fit, lit }: { fit: number; lit?: string }) {
  const r = rel();
  const box = { x: EDGE_X, y: 0, w: G.W - EDGE_X, h: BOARD_H };
  return (
    <section className="zb-slot" id="next-up" data-section="next-up" data-title="Next up" style={geo(box)}>
    <Morph name="zt-next" when={false} className="zb-edge" style={{ viewTransitionClass: "zt" } as React.CSSProperties}>
      <div className="zb-edge-in">
        <a className="zb-hit" href="#/next" data-tile="next" data-lit={lit === "next" || undefined} aria-label="Next up, and one question for you"
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); zoomIn("next", e.currentTarget.parentElement); }} />
        <div className="zb-edge-head"><h2>Next up</h2><span>off the map, as of Oct 13</span></div>
        <ol className="zb-next">
          {r.nextUp.map((n, i) => (
            <li key={n.title} data-now={i === 0 || undefined}>
              <b>{i === 0 ? "Artifacts own the layout" : n.title}</b>
              <span>{i === 0 ? "Round 14, in progress: this map is one of four prototypes." : n.oneLiner}</span>
            </li>
          ))}
        </ol>
        <div className="zb-edge-cta">One question for you →</div>
      </div>
    </Morph>
    </section>
  );
}

/** The tile nearest in a direction, by on-screen position (straight ahead counts more than sideways). */
function nearest(cur: HTMLElement, all: HTMLElement[], dir: Dir): HTMLElement | undefined {
  const c = cur.getBoundingClientRect();
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best: HTMLElement | undefined, score = Infinity;
  for (const t of all) {
    if (t === cur) continue;
    const r = t.getBoundingClientRect();
    // the edge and the corner are tall: aim at the point nearest to us
    const tx = Math.max(r.left, Math.min(cx, r.right)), ty = Math.max(r.top, Math.min(cy, r.bottom));
    const px = t.dataset.tile === "next" || t.dataset.tile === "removed" ? tx : r.left + r.width / 2;
    const py = t.dataset.tile === "next" || t.dataset.tile === "removed" ? ty : r.top + r.height / 2;
    const dx = px - cx, dy = py - cy;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const side = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const s = along + side * 2.2;
    if (s < score) { score = s; best = t; }
  }
  return best;
}
