import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface PresentState {
  active: boolean;
  /** Index of the current slide (0 = title slide) and how many there are. */
  slide: number; slides: number;
  /** Steps revealed on the current slide, and how many `<Step>` marks it has. */
  step: number; steps: number;
}
export const PresentCtx = createContext<PresentState>({ active: false, slide: 0, slides: 0, step: 0, steps: 0 });

/** Present-mode state for custom components: `const { active, step } = usePresent()`. Outside present mode `active` is false. */
export function usePresent(): PresentState { return useContext(PresentCtx); }

/** The revealed step count while presenting, -1 otherwise: drive a switcher with it (`items[Math.max(0, step)]`). */
export function usePresentStep(): number { const p = useContext(PresentCtx); return p.active ? p.step : -1; }

/**
 * Register `n` present steps for a custom component without writing empty `<Step>`s: render `markers` once (anywhere in
 * the component) and read `step` (0..n revealed). Outside present mode `step` is `n` (everything shown).
 */
export function usePresentSteps(n: number): { step: number; markers: ReactNode } {
  const p = useContext(PresentCtx);
  const box = useRef<HTMLSpanElement>(null);
  const [step, setStep] = useState(n);
  useEffect(() => {
    if (!p.active || !box.current) { setStep(n); return; }
    setStep(box.current.querySelectorAll("[data-step]:not([data-present-hidden])").length);
  }, [p.active, p.step, p.slide, n]);
  const markers = createElement("span", { ref: box, hidden: true, "data-steps-group": "" }, Array.from({ length: n }, (_, i) => createElement("span", { key: i, "data-step": "" })));
  return { step: p.active ? step : n, markers };
}
