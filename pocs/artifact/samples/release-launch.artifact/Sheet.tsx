import { useEffect, useRef } from "react";
import type { Feature, Theme } from "./model.ts";
import { Snippet, Stage, Ticks } from "./Demo.tsx";

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const QUOTE = /^Alex \(([^)]+)\):\s*/;

function Why({ text }: { text: string }) {
  const m = text.match(QUOTE);
  if (!m) return <p>{text}</p>;
  return (
    <blockquote className="l-quote">
      <p>{cap(text.slice(m[0].length))}</p>
      <footer>Alex, {m[1]}</footer>
    </blockquote>
  );
}

/**
 * One feature, full screen. It shares its view-transition name with its card, so opening morphs the card into the sheet.
 * ← / → (or a swipe) move between sheets without closing; Esc closes.
 */
export function Sheet({ f, theme, index, total, prev, next, dir, onClose, onGo, onAnswer }: {
  f: Feature; theme: Theme; index: number; total: number; prev: Feature; next: Feature; dir: 1 | -1 | 0;
  onClose: () => void; onGo: (id: string, dir: 1 | -1) => void; onAnswer: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [f.id]);

  // swipe left / right on touch screens
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sx = 0, sy = 0, on = false;
    const down = (e: PointerEvent) => { if (e.pointerType !== "touch") return; on = !(e.target as HTMLElement).closest(".l-stage-live, pre, .a-map"); sx = e.clientX; sy = e.clientY; };
    const up = (e: PointerEvent) => {
      if (!on) return; on = false;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 50) onGo(dx < 0 ? next.id : prev.id, dx < 0 ? 1 : -1);
    };
    el.addEventListener("pointerdown", down); el.addEventListener("pointerup", up);
    return () => { el.removeEventListener("pointerdown", down); el.removeEventListener("pointerup", up); };
  }, [next.id, prev.id, onGo]);

  const tid = `sheet-${f.id}`;
  return (
    <>
      <div className="l-scrim" onClick={onClose} aria-hidden />
      <article ref={ref} className="l-sheet" role="dialog" aria-modal="true" aria-labelledby={`${tid}-title`} tabIndex={-1}
        data-t={f.theme} data-morph={`f-${f.id}`}>
        <header className="l-sheet-bar">
          <span className="l-chip" data-t={f.theme}><i aria-hidden />{theme.title}</span>
          <span className="l-sheet-meta">Round {f.roundLabel}</span>
          <span className="l-status" data-s={f.status}>{f.status}</span>
          <span className="l-grow" />
          <span className="l-count" aria-live="polite">{index + 1} / {total}</span>
          <button className="l-icon" onClick={() => onGo(prev.id, -1)} aria-label={`Previous: ${prev.title}`} title="Previous (←)">‹</button>
          <button className="l-icon" onClick={() => onGo(next.id, 1)} aria-label={`Next: ${next.title}`} title="Next (→)">›</button>
          <button className="l-icon l-close" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
        </header>
        <div className="l-progress" aria-hidden><span style={{ width: `${((index + 1) / total) * 100}%` }} /></div>
        <div className="l-sheet-scroll" ref={scroller}>
          <div className="l-sheet-body" key={f.id} data-dir={dir} data-aid={tid}>
            <h2 className="l-sheet-title" id={`${tid}-title`}>{f.title}</h2>
            <p className="l-sheet-lede" data-aid={`${tid}-lede`}><Ticks text={f.oneLiner} /></p>
            <Stage f={f} onAnswer={onAnswer} />
            <div className="l-sheet-cols">
              <section className="l-why" data-aid={`${tid}-why`}>
                <h3 className="l-label">Why it's here</h3>
                <div data-aid={`${tid}-why-text`}><Why text={f.why} /></div>
              </section>
              {f.demo.kind !== "none" && (
                <section className="l-how" data-aid={`${tid}-how`}>
                  <h3 className="l-label">How you write it</h3>
                  <Snippet f={f} />
                </section>
              )}
            </div>
            <div className="l-commits" data-aid={`${tid}-commits`}>
              <span className="l-label">Commits</span>
              {f.commits.map((c) => <code key={c}>{c}</code>)}
            </div>
            <button className="l-next" onClick={() => onGo(next.id, 1)} data-t={next.theme}>
              <span className="l-label">Next <kbd>→</kbd></span>
              <span className="l-next-title">{next.title}</span>
              <span className="l-next-one"><Ticks text={next.oneLiner} /></span>
            </button>
          </div>
        </div>
      </article>
    </>
  );
}
