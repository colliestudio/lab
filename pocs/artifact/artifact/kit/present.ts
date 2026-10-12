import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface PresentState {
  active: boolean;
  /** Index of the current slide (0 = title slide) and how many there are. */
  slide: number; slides: number;
  /** Steps revealed on the current slide, and how many `<Step>` marks it has. */
  step: number; steps: number;
  /** Host hook: reveal `k` of the steps that start at marker `el` (so a component's own selection and the slide counter agree). */
  setStepFor?: (el: Element, k: number) => void;
}
export const PresentCtx = createContext<PresentState>({ active: false, slide: 0, slides: 0, step: 0, steps: 0 });

/** Present-mode state for custom components: `const { active, step } = usePresent()`. Outside present mode `active` is false. */
export function usePresent(): PresentState { return useContext(PresentCtx); }

/** The revealed step count while presenting, -1 otherwise: drive a switcher with it (`items[Math.max(0, step)]`). */
export function usePresentStep(): number { const p = useContext(PresentCtx); return p.active ? p.step : -1; }

/**
 * Register `n` present steps for a custom component without writing empty `<Step>`s: render `markers` once (anywhere in
 * the component). `step` is how many are revealed (0..n); `setStep(k)` moves it, and while presenting it moves the slide's
 * own step counter too, so a click in the component and → / Space stay in sync. Outside present mode `step` is your own
 * selection (it starts at `initial`, default n = everything shown). `active` is true while presenting.
 */
export function usePresentSteps(n: number, initial = n): { step: number; setStep: (k: number) => void; active: boolean; markers: ReactNode } {
  const p = useContext(PresentCtx);
  const box = useRef<HTMLSpanElement>(null);
  const [revealed, setRevealed] = useState(n);
  const [local, setLocal] = useState(Math.min(initial, n));
  useEffect(() => {
    if (!p.active || !box.current) return;
    setRevealed(box.current.querySelectorAll("[data-step]:not([data-present-hidden])").length);
  }, [p.active, p.step, p.slide, n]);
  const setStep = (k: number) => {
    const v = Math.max(0, Math.min(n, k));
    setLocal(v);
    const first = box.current?.querySelector("[data-step]");
    if (p.active && first) p.setStepFor?.(first, v);
  };
  const markers = createElement("span", { ref: box, hidden: true, "data-steps-group": "" }, Array.from({ length: n }, (_, i) => createElement("span", { key: i, "data-step": "" })));
  return { step: p.active ? revealed : local, setStep, active: p.active, markers };
}
