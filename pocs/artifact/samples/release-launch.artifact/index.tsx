import { useCallback, useEffect, useRef, useState } from "react";
import { Decision, Slide, Stages, TimeAxis, Walkthrough, navigate, usePresentSteps, useRoute } from "artifact";
import { Hero } from "./Hero.tsx";
import { Sheet } from "./Sheet.tsx";
import { NoSteps, Terminal, Ticks, Window } from "./Demo.tsx";
import { HIGHLIGHTS, minutesBetween, reducedMotion, useRelease, type Feature } from "./model.ts";
import "./launch.css";

export const page = { title: "artifact kit 0.1" };

/** Card copy: shorter than the release.json one-liners, written for a launch page. */
const TAG: Record<string, [string, string]> = {
  pages: ["Many pages. Still one file.", "Pages are hash routes in the same HTML. Page cards, links across pages, and comments and decisions that follow you."],
  "decision-walk": ["Answer on the page", "Pick an option, write your own or say “discuss”. Follow-ups appear by answer."],
  "map-fit": ["Maps that fit", "Grouped graphs that fit their column, with zoom, drag and click-to-focus."],
  walkthrough: ["Walkthrough", "One case, step by step: scenario tabs, a state rail, every step a slide."],
  "present-mode": ["Press p to present", "Sections become slides, steps reveal one by one."],
  "code-notes": ["Code with notes", "Real hunks and line ranges, with a “why” on the lines that matter."],
  timeaxis: ["A real time axis", "Weeks, then hours, on one honest scale that says where it breaks."],
  scorecard: ["Scorecard", "Options × weighted criteria, graded, with a recommended column."],
  gallery: ["Gallery", "Tiles that drill down, variants side by side, a lightbox."],
  "feedback-drawer": ["One drawer for feedback", "Decisions and comments together; copy it all back to the agent in one paste."],
  stages: ["Stages", "A few states compared, row by row."],
  shot: ["Agents see their own page", "PNGs in both themes, every slide, every page."],
};

/** Where each card's screenshot is cropped: [zoom, x, y] as fractions of the image. */
const CROP: Record<string, [number, number, number]> = {
  pages: [1.15, 0, 0], "decision-walk": [1.9, 0.15, 0.33], "map-fit": [1.55, 0.3, 0.24], "present-mode": [1.7, 0.03, 0.03],
  "code-notes": [1.6, 0.36, 0.12], scorecard: [1.4, 0.15, 0.12], gallery: [1.35, 0.2, 0.08], "feedback-drawer": [1.8, 0.44, 0.02],
};

const scrollToEl = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });

function Preview({ f }: { f: Feature }) {
  if (f.id === "walkthrough" || f.id === "timeaxis" || f.id === "stages") {
    const p = f.demo.props!;
    return (
      <NoSteps className="l-mini" inert>
        <div className="l-mini-in">
          {f.id === "walkthrough" && <Walkthrough {...p.Walkthrough} />}
          {f.id === "timeaxis" && <TimeAxis {...p.TimeAxis} />}
          {f.id === "stages" && <Stages {...p.Stages} />}
        </div>
      </NoSteps>
    );
  }
  if (f.id === "shot") return <Terminal compact text={"artifact shot x.artifact --theme both --present all\nartifact shot x.artifact --page all --split"} />;
  const src = f.demo.shot;
  return src ? <Window src={src} alt="" crop={CROP[f.id]} /> : null;
}

function Card({ f, size, theme, onOpen }: { f: Feature; size: string; theme: string; onOpen: (id: string) => void }) {
  const [title, line] = TAG[f.id] ?? [f.title, f.oneLiner];
  return (
    <a id={`card-${f.id}`} href={`#/home?sheet=${f.id}`} className="l-card" data-size={size} data-t={f.theme} data-morph={`f-${f.id}`}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onOpen(f.id); }}>
      <div className="l-card-text">
        <span className="l-eyebrow" data-t={f.theme}><i aria-hidden />{theme}{f.status === "improved" && <em> · improved</em>}</span>
        <h3 data-aid={`card-${f.id}-title`}>{title}</h3>
        <p data-aid={`card-${f.id}-line`}>{line}</p>
      </div>
      <div className="l-card-preview" aria-hidden><Preview f={f} /></div>
      <span className="l-card-go" aria-hidden>↗</span>
    </a>
  );
}

export default function Launch() {
  const { r, commits, byId, themeOf, order, rest } = useRelease();
  const route = useRoute();
  const hashId = route.page === "home" && route.params.sheet && byId[route.params.sheet] ? route.params.sheet : null; // ?sheet=<id> is state, not a scroll target
  const [dir, setDir] = useState<1 | -1 | 0>(0);
  const lastOpen = useRef<string | null>(null);

  // present mode: the bento slide steps through its sheets (→ opens the next one)
  const ps = usePresentSteps(HIGHLIGHTS.length, 0);
  const presentId = ps.active && ps.current && ps.step > 0 ? HIGHLIGHTS[ps.step - 1].id : null;
  const openId = ps.active ? presentId : hashId;
  const f = openId ? byId[openId] : null;
  const idx = f ? order.indexOf(f) : -1;

  // the card and the sheet carry the same data-morph key; navigate names just that pair for the transition
  const open = useCallback((id: string) => {
    if (ps.active) { const i = HIGHLIGHTS.findIndex((h) => h.id === id); if (i >= 0) ps.setStep(i + 1); return; }
    setDir(0);
    void navigate("home", { params: { sheet: id }, morph: document.getElementById(`card-${id}`) ?? undefined });
  }, [ps.active]);
  const go = useCallback((id: string, d: 1 | -1) => {
    if (ps.active) { const i = HIGHLIGHTS.findIndex((h) => h.id === id); ps.setStep(i >= 0 ? i + 1 : 0); return; }
    setDir(d);
    navigate("home", { params: { sheet: id }, transition: false });
  }, [ps.active]);
  const close = useCallback(() => {
    if (ps.active) { ps.setStep(0); return; }
    void navigate("home", { morph: document.querySelector<HTMLElement>(".l-sheet[data-morph]") ?? undefined });
  }, [ps.active]);
  const answer = useCallback(() => { navigate("home", { transition: false }); setTimeout(() => scrollToEl("your-call"), 60); }, []);

  // keys while a sheet is open (present mode owns the keys while presenting)
  useEffect(() => {
    if (!f || ps.active) return;
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (document.querySelector(".a-lightbox, .h-composer, .h-panel")) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !t.closest(".l-stage-live, .a-tablist, [role=tablist]")) {
        e.preventDefault();
        const d = e.key === "ArrowRight" ? 1 : -1;
        go(order[(idx + d + order.length) % order.length].id, d);
      }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [f, idx, ps.active, close, go]);

  // lock the page behind a sheet; give focus back to the card it came from
  useEffect(() => {
    if (f) { lastOpen.current = f.id; document.documentElement.dataset.sheet = ""; return; }
    delete document.documentElement.dataset.sheet;
    if (lastOpen.current && !ps.active) document.getElementById(`card-${lastOpen.current}`)?.focus({ preventScroll: true });
  }, [f?.id]);

  const detail = r.removed.find((x) => x.id === "detail-levels")!;
  const at = Object.fromEntries(commits.map((c) => [c.h, c.at]));
  const lived = minutesBetween(at[detail.commits[0]], at[detail.commits[1]]);
  const sheetFeature = f;

  return (
    <div className="l-root">
      <Hero />

      <Slide id="new" title="What's new" className="l-section l-new">
        {ps.markers}
        <div className="l-wrap">
          <header className="l-head">
            <span className="l-kicker">What's new</span>
            <h2>Twelve highlights. Open any of them.</h2>
            <p>Each card opens to the live component, why it exists and the snippet. <kbd>←</kbd> <kbd>→</kbd> (or a swipe) move between them.</p>
          </header>
          <div className="l-bento" onPointerMove={(e) => {
            const c = (e.target as HTMLElement).closest<HTMLElement>(".l-card");
            if (!c) return;
            const r = c.getBoundingClientRect();
            c.style.setProperty("--mx", `${e.clientX - r.left}px`); c.style.setProperty("--my", `${e.clientY - r.top}px`);
          }}>
            {HIGHLIGHTS.map((h) => <Card key={h.id} f={byId[h.id]} size={h.size} theme={themeOf[byId[h.id].theme].title} onOpen={open} />)}
          </div>
        </div>
        {sheetFeature && (
          <Sheet f={sheetFeature} theme={themeOf[sheetFeature.theme]} index={ps.active ? ps.step - 1 : idx} total={ps.active ? HIGHLIGHTS.length : order.length}
            prev={order[(idx - 1 + order.length) % order.length]} next={order[(idx + 1) % order.length]}
            dir={dir} onClose={close} onGo={go} onAnswer={answer} />
        )}
      </Slide>

      <Slide id="everything" title="And fourteen more" className="l-section l-rest">
        <div className="l-wrap">
          <header className="l-head">
            <span className="l-kicker">And {rest.length} more</span>
            <h2>The parts you notice when they're missing.</h2>
          </header>
          <div className="l-rest-grid">
            {r.themes.map((t) => {
              const items = rest.filter((x) => x.theme === t.id);
              if (!items.length) return null;
              return (
                <div key={t.id} className="l-rest-group" data-t={t.id}>
                  <h3 className="l-eyebrow" data-t={t.id}><i aria-hidden />{t.title}</h3>
                  <ul>
                    {items.map((x) => (
                      <li key={x.id}>
                        <a id={`card-${x.id}`} href={`#/home?sheet=${x.id}`} className="l-row" data-morph={`f-${x.id}`}
                          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); open(x.id); }}>
                          <span className="l-row-title">{x.title.replace(/`/g, "")}{x.status === "improved" && <em className="l-status" data-s="improved">improved</em>}</span>
                          <span className="l-row-one"><Ticks text={x.oneLiner} /></span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </Slide>

      <Slide id="removed" title="What we removed" className="l-section l-removed">
        <div className="l-wrap">
          <header className="l-head">
            <span className="l-kicker">Removed, on purpose</span>
            <h2>Two ideas that didn't earn their place.</h2>
            <p>A smaller kit is easier for an agent to use well. These went out with a reason, and each one left something simpler behind.</p>
          </header>
          <div className="l-graves">
            <article className="l-grave" id="removed-detail">
              <div className="l-grave-art" aria-hidden>
                <div className="l-zoom">{[1, 2, 3, 4].map((n) => <span key={n} data-on={n === 2 ? "" : undefined}>{n}</span>)}</div>
                <span className="l-grave-label">Detail</span>
              </div>
              <div className="l-grave-dates"><span>Round {detail.addedRound}</span><span className="l-grave-line" /><span>Round {detail.removedRound}</span></div>
              <h3><s>{detail.title}</s></h3>
              <p className="l-grave-fact">Its final form lived <b>{lived} minutes</b>: <code>{detail.commits[0]}</code> at {at[detail.commits[0]].slice(11, 16)}, gone in <code>{detail.commits[1]}</code> at {at[detail.commits[1]].slice(11, 16)}.</p>
              <p>A reader control that zoomed the outline: keys 1–4 collapsed sections and stubbed heavy blocks.</p>
              <blockquote className="l-quote"><p>It takes a lot of attention and doesn't deserve it.</p><footer>Alex, Oct 12</footer></blockquote>
              <a className="l-grave-now" href="#/home?sheet=folding-more" onClick={(e) => { e.preventDefault(); open("folding-more"); }}>
                Now: click a heading to fold it, put detail in <code>&lt;More&gt;</code> <span aria-hidden>→</span>
              </a>
            </article>
            <article className="l-grave" id="removed-format">
              <div className="l-grave-art" aria-hidden>
                <div className="l-blocks">{["Headline", "Map", "Areas", "Code"].map((b, i) => <span key={b}><b>{i + 1}</b>{b}</span>)}</div>
                <span className="l-grave-label">kind: review</span>
              </div>
              <div className="l-grave-dates"><span>Recap POC</span><span className="l-grave-line" /><span>Kit v0.1</span></div>
              <h3><s>{r.removed[1].title}</s></h3>
              <p className="l-grave-fact">Fixed kinds, a zoom ladder and a fixed list of blocks: every page had the same shape before the agent knew what it needed to say.</p>
              <blockquote className="l-quote"><p>Too structured.</p><footer>Alex, Oct 12</footer></blockquote>
              <a className="l-grave-now" href="#/home?sheet=artifact-dir" onClick={(e) => { e.preventDefault(); open("artifact-dir"); }}>
                Now: a toolbox; <code>kind</code> is a free label <span aria-hidden>→</span>
              </a>
            </article>
          </div>
        </div>
      </Slide>

      <Slide id="next" title="Next up" className="l-section l-next-up">
        <div className="l-wrap">
          <header className="l-head">
            <span className="l-kicker">Next up</span>
            <h2>You're looking at round 14.</h2>
            <p>This page uses <code>"shell": "bare"</code>: no header, outline or page switcher, only a faint dot in the corner for feedback. It is one of four prototypes on the same content; the winner's patterns become kit layouts.</p>
          </header>
          <ol className="l-roadmap">
            {r.nextUp.map((n, i) => (
              <li key={n.title} id={`next-${i}`} data-now={i === 0 ? "" : undefined}>
                <span className="l-road-dot" aria-hidden />
                <div>
                  <h3>{n.title.replace(/ \(round 14, in progress\)/, "")}{i === 0 && <span className="l-status" data-s="now">in progress</span>}</h3>
                  <p><Ticks text={n.oneLiner} /></p>
                </div>
              </li>
            ))}
          </ol>
          <div className="l-call" id="your-call">
            <header>
              <span className="l-kicker">Your call</span>
              <h2>Two decisions for Alex.</h2>
              <p>Answers land in the Feedback drawer (corner dot); <b>Copy all feedback</b> hands them back to the agent.</p>
            </header>
            <Decision id="d-shape" question="Which experience should become the kit's layout?" owner="Alex"
              options={r.features.find((x) => x.id === "decision-walk")!.demo.props!.Decision.options} />
            <Decision id="d-launch-part" question="Which part of this page should the kit offer first?" owner="Alex" recommend={0}
              why="The sheet carries the most hand-written code here (morph, ← / →, deep link, focus, present steps) and fits any list of items: features, PRs, findings, branches."
              options={[
                { label: "Feature sheets: a card morphs into a full-screen sheet, ← / → between them, deep-linked" },
                { label: "Bento grid with live, inert previews" },
                { label: "Count-up hero numbers and the commit strip" },
                { label: "None: keep these per artifact" },
              ]} />
          </div>
        </div>
      </Slide>

      <Slide id="changelog" title="Every round" className="l-section l-log">
        <div className="l-wrap">
          <header className="l-head l-head-sm">
            <span className="l-kicker">Every round</span>
            <h2>The full changelog.</h2>
          </header>
          <ol className="l-rounds">
            {r.rounds.map((x) => (
              <li key={x.round} id={`round-${x.round}`}>
                <span className="l-round-n">{x.round}</span>
                <p>{x.summary.replace(/`/g, "")}</p>
                {x.tests ? <span className="l-round-t">{x.tests} tests</span> : null}
              </li>
            ))}
          </ol>
          <footer className="l-foot">
            <p>{r.credits}</p>
            <p className="l-foot-meta">{r.product} {r.version} · {r.date} · this page is one HTML file built with the kit it announces</p>
          </footer>
        </div>
      </Slide>
    </div>
  );
}
