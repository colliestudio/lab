import { createContext, useContext } from "react";

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
