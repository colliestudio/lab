// The deck: one slide per page, keys, view transitions between slides, a light table (Esc), a "why" drawer (N),
// and a present mode (P) that is the deck itself, full screen, chrome gone.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { imageSrc, navigate, usePresentControl, useRoute, withTransition } from "artifact";
import { SLIDES, type SlideSpec } from "./plan";
import { getDeck, setDeck, useDeck } from "./store";
import { renderSlide, notesFor, thumbFor, demoKind, useRelease } from "./slides";
import "./deck.css";

export const HUES: Record<string, string> = {
  authoring: "#7c5cff", reading: "#0ea5a0", decisions: "#f0613a", technical: "#3b82f6", cli: "#22a35a", multipage: "#e0408f",
};
export const hueOf = (s?: SlideSpec) => (s?.theme ? HUES[s.theme] : "#8b8b98");
export const byId = (id: string) => SLIDES.find((s) => s.id === id);
const idx = (id: string) => SLIDES.findIndex((s) => s.id === id);

/** A slide change reports itself to CSS as html[data-nav-dir=next|prev|jump|zoom]. */
type Vt = "next" | "prev" | "jump" | "zoom";

let current = "home";
/** Go to a slide. `step` is the build step to land on (going back lands on the last one, like a keynote). */
export function go(id: string, kind: Vt = "jump", step = 0) {
  if (!byId(id)) return;
  // the deck's own state changes with the page, inside one transition; the tile title (or cover list entry) morphs into the headline
  const overviewTitle = document.querySelector<HTMLElement>(`.o-tile[data-id="${id}"] .o-title`);
  if (id === current) { void withTransition(() => setDeck({ overview: false }), { direction: "zoom", morph: overviewTitle ?? `head-${id}` }); return; }
  void withTransition(() => { setDeck({ overview: false, step }); void navigate(id, { transition: false }); }, { direction: kind, morph: overviewTitle ?? `head-${id}` });
}
export function next() {
  const s = byId(current), st = getDeck().step;
  if (s?.steps && st < s.steps) { setDeck({ step: st + 1 }); return; }
  const n = SLIDES[idx(current) + 1];
  if (n) go(n.id, "next");
}
export function prev() {
  const s = byId(current), st = getDeck().step;
  if (s?.steps && st > 0) { setDeck({ step: st - 1 }); return; }
  const p = SLIDES[idx(current) - 1];
  if (p) go(p.id, "prev", p.steps ?? 0);
}
export const toggleOverview = () => {
  const open = getDeck().overview;
  void withTransition(() => setDeck({ overview: !open }), { direction: "zoom", morph: open ? document.querySelector<HTMLElement>(".o-tile[aria-current] .o-title") ?? undefined : `head-${current}` });
};
export const toggleNotes = () => setDeck({ notes: !getDeck().notes });

export function startPresent() {
  setDeck({ presenting: true, overview: false, notes: false });
  document.documentElement.dataset.deckPresent = "";
  const el = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
  el.requestFullscreen?.().catch(() => { /* not allowed: present in the window */ });
}
export function stopPresent() {
  setDeck({ presenting: false });
  delete document.documentElement.dataset.deckPresent;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

const typing = (t: EventTarget | null) => {
  const e = t as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName ?? ""));
};
const hostDialogOpen = () => !!document.querySelector(".h-composer, .h-panel, .h-pop, .a-lightbox, .h-corner-menu");

// One set of global listeners for the whole deck (pages come and go; this stays).
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  // capture: Esc is the light table (or leaves present) unless a host dialog is open; P is the kit's, routed to us by usePresentControl
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if ((e.key === "p" || e.key === "P") && getDeck().presenting) { e.preventDefault(); e.stopImmediatePropagation(); stopPresent(); }
    else if (e.key === "Escape" && !hostDialogOpen()) {
      e.stopImmediatePropagation();
      if (getDeck().presenting) stopPresent(); else toggleOverview();
    }
  }, true);
  // bubble: arrows after components had their say (Walkthrough, tabs and radios use arrows too)
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || hostDialogOpen()) return;
    if (getDeck().overview) return; // the light table handles its own keys
    const t = e.target as HTMLElement;
    const onControl = !!t.closest?.("button, a[href], [role=radio], [role=tab], summary, [tabindex]:not(body)");
    const inWidget = !!t.closest?.("[role=radiogroup], [role=tablist], .a-walk, .a-map");
    if (["ArrowRight", "PageDown"].includes(e.key) && !inWidget) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "PageUp"].includes(e.key) && !inWidget) { e.preventDefault(); prev(); }
    else if ((e.key === " " || e.key === "Enter") && !onControl) { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
    else if (e.key === "Backspace") { e.preventDefault(); prev(); }
    else if (e.key === "Home") { e.preventDefault(); go(SLIDES[0].id, "prev"); }
    else if (e.key === "End") { e.preventDefault(); go(SLIDES[SLIDES.length - 1].id, "next"); }
    else if (e.key === "n" || e.key === "N") toggleNotes();
  });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && getDeck().presenting) stopPresent(); });
  // present: the cursor hides when it rests
  let idle: ReturnType<typeof setTimeout> | undefined;
  addEventListener("mousemove", () => {
    document.documentElement.removeAttribute("data-idle");
    clearTimeout(idle);
    if (getDeck().presenting) idle = setTimeout(() => document.documentElement.setAttribute("data-idle", ""), 2200);
  }, { passive: true });
}

/** The slide's content; the frame around it is the layout. */
export function SlideView({ id }: { id: string }) {
  const deck = useDeck();
  useRelease();
  return <>{renderSlide(byId(id)!, deck.step)}</>;
}

/** The deck frame, as the artifact's Layout: it stays mounted while the slide inside it changes. */
export function DeckFrame({ children }: { children?: ReactNode }) {
  const route = useRoute();
  const id = byId(route.page) ? route.page : "home";
  const spec = byId(id)!;
  current = id;
  useEffect(install, []);
  usePresentControl(() => startPresent()); // p and the corner menu's Present run the deck, not the kit's slide walk
  const deck = useDeck();
  // a direct load or Back lands on a build step past the end: clamp it
  useEffect(() => { if (deck.step > (spec.steps ?? 0)) setDeck({ step: spec.steps ?? 0 }); }, [route.page]);

  const touch = useRef<{ x: number; y: number } | null>(null);
  const i = idx(id);
  const style = { "--hue": hueOf(spec) } as CSSProperties;
  return (
    <div className="deck" style={style} data-kind={spec.kind} data-overview={deck.overview ? "" : undefined}
      onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
      onTouchEnd={(e) => {
        const s = touch.current; touch.current = null; if (!s) return;
        const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
        if ((e.target as HTMLElement).closest(".f-demo, .d-notes")) return;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) { if (dx < 0) next(); else prev(); }
      }}>
      <Top i={i} />
      <main className="d-stage" inert={deck.overview || undefined} aria-label={`Slide ${i + 1} of ${SLIDES.length}: ${spec.head}`}>
        {children}
      </main>
      <Notes spec={spec} step={deck.step} open={deck.notes} />
      <Rail i={i} />
      <Pager i={i} />
      {deck.overview && <Overview i={i} />}
    </div>
  );
}

function Top({ i }: { i: number }) {
  const deck = useDeck();
  return (
    <header className="d-top" style={{ viewTransitionName: "d-top" } as CSSProperties}>
      <button className="d-mark" onClick={() => go("home", "prev")} aria-label="First slide">
        <span className="d-mark-dot" aria-hidden />artifact kit <span className="d-mark-v">0.1</span>
      </button>
      <div className="d-tools">
        <span className="d-count" aria-hidden><b>{String(i + 1).padStart(2, "0")}</b> / {SLIDES.length}</span>
        <button className="d-tool" aria-pressed={deck.notes} onClick={toggleNotes} title="Why (N)">Why <kbd>N</kbd></button>
        <button className="d-tool" onClick={toggleOverview} title="All slides (Esc)" aria-label="All slides">
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>{[0, 5.5, 11].flatMap((x) => [0, 5.5, 11].map((y) => <rect key={`${x}${y}`} x={x} y={y} width="4" height="4" rx="1" fill="currentColor" />))}</svg>
          <kbd>Esc</kbd>
        </button>
        <button className="d-tool d-tool-play" onClick={startPresent} title="Present (P)" aria-label="Present">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2.5 1.5v9l8-4.5z" fill="currentColor" /></svg>
          <kbd>P</kbd>
        </button>
      </div>
    </header>
  );
}

/** Bottom rail: one tick per slide, segmented by chapter; the current chapter shows its name. */
function Rail({ i }: { i: number }) {
  const groups: { name: string; hue: string; items: { s: SlideSpec; k: number }[] }[] = [];
  SLIDES.forEach((s, k) => {
    const g = groups[groups.length - 1];
    if (g && g.name === s.group) g.items.push({ s, k }); else groups.push({ name: s.group, hue: hueOf(s), items: [{ s, k }] });
  });
  return (
    <nav className="d-rail" aria-label="Slides" style={{ viewTransitionName: "d-rail" } as CSSProperties}>
      {groups.map((g) => {
        const on = g.items.some((x) => x.k === i);
        return (
          <div key={g.name} className="d-seg" data-on={on ? "" : undefined} style={{ "--hue": g.hue, flexGrow: g.items.length } as CSSProperties}>
            <div className="d-ticks">
              {g.items.map(({ s, k }) => (
                <button key={s.id} className="d-tick" data-done={k < i ? "" : undefined} aria-current={k === i ? "step" : undefined}
                  aria-label={`${k + 1}. ${s.head}`} title={`${k + 1}. ${s.head}`} onClick={() => go(s.id, k > i ? "next" : "prev")} />
              ))}
            </div>
            <span className="d-seg-name">{g.name}</span>
          </div>
        );
      })}
    </nav>
  );
}

/** Narrow screens: prev / count / next instead of the rail. */
function Pager({ i }: { i: number }) {
  return (
    <nav className="d-pager" aria-label="Slide navigation">
      <button onClick={prev} disabled={i === 0 && !getDeck().step} aria-label="Previous">‹</button>
      <button className="d-pager-mid" onClick={toggleOverview}>{i + 1} / {SLIDES.length}</button>
      <button onClick={next} disabled={i === SLIDES.length - 1} aria-label="Next">›</button>
    </nav>
  );
}

function Notes({ spec, step, open }: { spec: SlideSpec; step: number; open: boolean }) {
  const n = notesFor(spec, step);
  return (
    <aside className="d-notes" data-open={open ? "" : undefined} aria-hidden={!open} id={`why-${spec.id}`} style={{ viewTransitionName: "d-notes" } as CSSProperties}>
      <div className="d-notes-in">
        <div className="d-notes-k">Why</div>
        <div className="d-notes-body">{n.body}</div>
        {n.meta && <div className="d-notes-meta">{n.meta}</div>}
        <button className="d-notes-x" onClick={toggleNotes} aria-label="Hide why" tabIndex={open ? 0 : -1}>×</button>
      </div>
    </aside>
  );
}

/** Esc: every slide on a light table, grouped by chapter. Arrows move, Enter opens, Esc returns. */
function Overview({ i }: { i: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cur = ref.current?.querySelector<HTMLButtonElement>("[aria-current]");
    cur?.focus({ preventScroll: true });
    cur?.scrollIntoView({ block: "center" });
  }, []);
  const groups: { name: string; items: SlideSpec[] }[] = [];
  for (const s of SLIDES) { const g = groups[groups.length - 1]; if (g && g.name === s.group) g.items.push(s); else groups.push({ name: s.group, items: [s] }); }
  const key = (e: React.KeyboardEvent) => {
    const tiles = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".o-tile") ?? [])];
    const k = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (k < 0) return;
    let to = -1;
    if (e.key === "ArrowRight") to = Math.min(tiles.length - 1, k + 1);
    else if (e.key === "ArrowLeft") to = Math.max(0, k - 1);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const r = tiles[k].getBoundingClientRect(), cx = r.left + r.width / 2, down = e.key === "ArrowDown";
      let best = Infinity;
      tiles.forEach((t, j) => {
        const q = t.getBoundingClientRect();
        const dy = down ? q.top - r.top : r.top - q.top;
        if (dy < 8) return;
        const score = dy * 4 + Math.abs(q.left + q.width / 2 - cx);
        if (score < best) { best = score; to = j; }
      });
    } else if (e.key === "Home") to = 0; else if (e.key === "End") to = tiles.length - 1;
    if (to >= 0) { e.preventDefault(); tiles[to].focus(); tiles[to].scrollIntoView({ block: "nearest" }); }
  };
  let n = 0;
  return (
    <div className="o-root" role="dialog" aria-label="All slides" ref={ref} onKeyDown={key}>
      <div className="o-head">
        <h2>All slides</h2>
        <span className="o-hint"><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> back</span>
        <button className="s-btn o-close" onClick={toggleOverview}>Back to slide {i + 1}</button>
      </div>
      {groups.map((g) => (
        <section key={g.name} className="o-group" style={{ "--hue": hueOf(g.items.find((s) => s.theme) ?? g.items[0]) } as CSSProperties}>
          <h3 className="o-gname"><span className="o-gdot" aria-hidden />{g.name}<span className="o-gn">{g.items.length}</span></h3>
          <div className="o-tiles">
            {g.items.map((s) => {
              const k = n++;
              const thumb = thumbFor(s);
              const kind = demoKind(s);
              return (
                <button key={s.id} className="o-tile" data-kind={s.kind} data-id={s.id} aria-current={k === i ? "true" : undefined}
                  onClick={() => go(s.id, k > i ? "next" : k < i ? "prev" : "zoom", s.steps && k < i ? s.steps : 0)}
                  style={{ "--hue": hueOf(s) } as CSSProperties}>
                  {thumb && <img className="o-thumb" src={imageSrc(thumb)} alt="" loading="lazy" />}
                  <span className="o-n">{String(k + 1).padStart(2, "0")}</span>
                  {kind && <span className="o-kind">{kind}</span>}
                  <span className="o-title" data-morph={`head-${s.id}`}>{s.head}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A view-transition name: carried between slides (and into the light table). */
export const vt = (name: string): CSSProperties => ({ viewTransitionName: name } as CSSProperties);
export function Kicker({ spec }: { spec: SlideSpec }) {
  return <div className="s-kicker" style={vt(`kick-${spec.theme ?? spec.group.toLowerCase()}`)}><span className="s-kicker-dot" aria-hidden />{spec.group}</div>;
}
export type { ReactNode };
