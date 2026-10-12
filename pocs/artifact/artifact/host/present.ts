import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Present mode over the DOM: top-level [data-section]s are slides; [data-step] elements inside the current slide
 * appear one per → press. Hides the rest with [data-present-hidden] (css), never touches React state of the content.
 */
export function usePresent(root: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const [pos, setPos] = useState({ slide: 0, step: 0 });
  const [count, setCount] = useState(0);
  const posRef = useRef(pos); posRef.current = pos;

  const slides = useCallback(() => {
    const el = root.current;
    return el ? [...el.querySelectorAll<HTMLElement>("[data-section]")].filter((s) => !s.parentElement?.closest("[data-section]")) : [];
  }, [root]);
  const stepsOf = (s?: HTMLElement) => (s ? [...s.querySelectorAll<HTMLElement>("[data-step]")] : []);

  const apply = useCallback((p: { slide: number; step: number }) => {
    const ss = slides();
    ss.forEach((s, i) => {
      s.toggleAttribute("data-present-hidden", i !== p.slide);
      if (i === p.slide) stepsOf(s).forEach((st, j) => st.toggleAttribute("data-present-hidden", j >= p.step));
    });
    root.current?.querySelectorAll<HTMLElement>("[data-step]").forEach((st) => { if (!ss[p.slide]?.contains(st)) st.removeAttribute("data-present-hidden"); });
    ss[p.slide]?.scrollIntoView({ block: "start" });
    setCount(ss.length);
  }, [root, slides]);

  const go = useCallback((dir: 1 | -1) => {
    const ss = slides();
    const { slide, step } = posRef.current;
    const n = stepsOf(ss[slide]).length;
    let next = { slide, step };
    if (dir === 1) next = step < n ? { slide, step: step + 1 } : slide < ss.length - 1 ? { slide: slide + 1, step: 0 } : next;
    else next = step > 0 ? { slide, step: step - 1 } : slide > 0 ? { slide: slide - 1, step: stepsOf(ss[slide - 1]).length } : next;
    setPos(next); apply(next);
  }, [slides, apply]);

  const start = useCallback(() => {
    if (!slides().length) return;
    document.documentElement.dataset.present = "";
    const p = { slide: 0, step: 0 };
    setPos(p); setActive(true); apply(p);
  }, [slides, apply]);
  const stop = useCallback(() => {
    delete document.documentElement.dataset.present;
    root.current?.querySelectorAll("[data-present-hidden]").forEach((e) => e.removeAttribute("data-present-hidden"));
    setActive(false);
  }, [root]);

  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(1); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === "Escape" || e.key === "p") stop();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [active, go, stop]);

  const title = slides()[pos.slide]?.dataset.title ?? "";
  return { active, start, stop, next: () => go(1), prev: () => go(-1), label: active ? `${pos.slide + 1}/${count} ${title}` : "" };
}
