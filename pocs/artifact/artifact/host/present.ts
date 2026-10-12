import { useCallback, useEffect, useRef, useState } from "react";
import type { PresentState } from "../kit/present.ts";

interface Slide { els: HTMLElement[]; title: string }
const stepsOf = (s?: Slide) => (s ? s.els.flatMap((e) => (e.hasAttribute("data-step") ? [e] : []).concat([...e.querySelectorAll<HTMLElement>("[data-step]")])) : []);

/**
 * Present mode over the DOM. Slides: the header (title + summary), then each top-level [data-section] (or the child
 * Sections of a page wrapped in one), with loose runs of elements between Sections as slides of their own.
 * `[data-step]` elements inside the current slide appear one per press. Everything else is hidden with
 * [data-present-hidden] (css); the content's React state is never touched.
 * Keys: → space PageDown Enter next; ← PageUp Backspace back; ↑/↓ scroll a tall slide; Esc or p leaves.
 */
export function usePresent(root: React.RefObject<HTMLElement | null>, head: React.RefObject<HTMLElement | null>, title: string, summary?: React.RefObject<HTMLElement | null>, onEdge?: (dir: 1 | -1) => void) {
  const [active, setActive] = useState(false);
  const [pos, setPos] = useState({ slide: 0, step: 0 });
  const [count, setCount] = useState(0);
  const posRef = useRef(pos); posRef.current = pos;
  const edge = useRef(onEdge); edge.current = onEdge;

  const slides = useCallback((): Slide[] => {
    const out: Slide[] = head.current ? [{ els: [head.current], title }] : [];
    let c = root.current as HTMLElement | null;
    if (!c) return out;
    while (c && c.children.length === 1 && !(c.children[0] as HTMLElement).dataset.section) c = c.children[0] as HTMLElement;
    if (!c) return out;
    // a page wrapped in one Section: its child Sections are the slides (heading and lead text come first as one slide)
    const only = [...c.children].filter((e) => (e as HTMLElement).dataset.section);
    let loose: HTMLElement[] = [];
    if (only.length === 1 && c.children.length === 1 && only[0].querySelector(":scope > .a-section-body > [data-section]")) {
      const w = only[0] as HTMLElement;
      loose = [...w.children].filter((e) => !e.classList.contains("a-section-body")) as HTMLElement[]; // its heading and lead come first
      c = w.querySelector<HTMLElement>(":scope > .a-section-body")!;
      c.dataset.wrappedTitle = w.dataset.title ?? "";
    }
    const wrapped = c.dataset.wrappedTitle;
    const first = out.length;
    const flush = () => { if (loose.length) out.push({ els: loose, title: out.length === first ? wrapped ?? "Intro" : "More" }); loose = []; };
    for (const e of Array.from(c.children) as HTMLElement[]) {
      if (e.dataset.section) { flush(); out.push({ els: [e], title: e.dataset.title ?? "" }); } else if (!e.hasAttribute("data-chrome")) loose.push(e); // data-chrome: fixed UI that is not a slide
    }
    flush();
    if (summary?.current) out.push({ els: [summary.current], title: "Summary" }); // generated when the page has decisions
    return out;
  }, [root, head, title, summary]);

  const apply = useCallback((p: { slide: number; step: number }, scroll: "top" | "step" | "none" = "top") => {
    const ss = slides();
    document.querySelectorAll<HTMLElement>("[data-step]").forEach((st) => st.removeAttribute("data-present-hidden"));
    ss.forEach((s, i) => {
      s.els.forEach((e) => e.toggleAttribute("data-present-hidden", i !== p.slide));
      if (i === p.slide) stepsOf(s).forEach((st, j) => st.toggleAttribute("data-present-hidden", j >= p.step));
    });
    setCount(ss.length);
    const cur = ss[p.slide];
    if (scroll === "step" && p.step > 0) stepsOf(cur)[p.step - 1]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    else if (scroll === "top") scrollTo({ top: 0 });
  }, [slides]);

  const go = useCallback((dir: 1 | -1) => {
    const ss = slides();
    const { slide, step } = posRef.current;
    const n = stepsOf(ss[slide]).length;
    let next = { slide, step };
    if (dir === 1) next = step < n ? { slide, step: step + 1 } : slide < ss.length - 1 ? { slide: slide + 1, step: 0 } : next;
    else next = step > 0 ? { slide, step: step - 1 } : slide > 0 ? { slide: slide - 1, step: stepsOf(ss[slide - 1]).length } : next;
    if (next.slide === slide && next.step === step) { edge.current?.(dir); return; } // the end of this page: a tour moves on
    const sameSlide = next.slide === slide;
    setPos(next); apply(next, sameSlide ? (dir === 1 ? "step" : "none") : "top");
  }, [slides, apply]);

  /** Jump to the slide holding `target` (an in-page link), with its steps all shown so the target is visible. */
  const goTo = useCallback((target: Element) => {
    const ss = slides();
    const i = ss.findIndex((s) => s.els.some((e) => e.contains(target)));
    if (i < 0) return false;
    const p = { slide: i, step: stepsOf(ss[i]).length };
    setPos(p); apply(p, "none");
    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    return true;
  }, [slides, apply]);

  /** A component moved its own step: reveal `k` steps from the marker `el` on the current slide. */
  const setStepFor = useCallback((el: Element, k: number) => {
    const ss = slides();
    const slide = posRef.current.slide;
    const all = stepsOf(ss[slide]);
    const first = all.indexOf(el as HTMLElement);
    if (first < 0) return;
    const next = { slide, step: Math.max(0, Math.min(all.length, first + k)) };
    setPos(next); apply(next, "none");
  }, [slides, apply]);

  const startAt = useCallback((slide = 0) => {
    const ss = slides();
    if (ss.length < 1) return;
    document.documentElement.dataset.present = "";
    const p = { slide: Math.min(Math.max(0, slide), ss.length - 1), step: 0 };
    setPos(p); setActive(true); apply(p);
  }, [slides, apply]);
  const stop = useCallback(() => {
    delete document.documentElement.dataset.present;
    document.querySelectorAll("[data-present-hidden]").forEach((e) => e.removeAttribute("data-present-hidden"));
    setActive(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // Space/Enter belong to the control only where it consumes them (decision options, links, disclosure summaries); plain buttons let the slide step
      if ((e.key === " " || e.key === "Enter") && t.closest("[role=radio], a[href], summary")) return;
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(1); }
      else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === "Escape" || e.key === "p") stop();
    };
    const link = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
      const id = a?.getAttribute("href")?.slice(1);
      const t = id ? document.getElementById(decodeURIComponent(id)) : null;
      if (t && goTo(t)) e.preventDefault();
    };
    // after a click on a plain button inside a slide, drop focus so → / Space keep stepping
    const blur = (e: MouseEvent) => { const b = (e.target as HTMLElement).closest?.("button"); if (b && !b.closest("[role=radio]")) setTimeout(() => b.blur(), 0); };
    addEventListener("keydown", k);
    document.addEventListener("click", link, true);
    document.addEventListener("click", blur);
    return () => { removeEventListener("keydown", k); document.removeEventListener("click", link, true); document.removeEventListener("click", blur); };
  }, [active, go, goTo, stop]);

  const ss = active ? slides() : [];
  const state: PresentState = { active, slide: pos.slide, slides: count, step: pos.step, steps: active ? stepsOf(ss[pos.slide]).length : 0, setStepFor };
  return { active, start: startAt, stop, next: () => go(1), prev: () => go(-1), label: active ? `${pos.slide + 1}/${count} ${ss[pos.slide]?.title ?? ""}` : "", state, goTo };
}
