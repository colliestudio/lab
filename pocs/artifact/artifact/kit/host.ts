// What an artifact can ask of the host (feedback drawer, present mode, download, theme), and how it takes present mode over.
import { useEffect, useRef, useSyncExternalStore } from "react";

interface Api { openFeedback?: () => void; download?: () => Promise<void>; startPresent?: () => void; toggleTheme?: () => void }
export const hostApi: Api = {};
let control: { start: () => void } | undefined;
const subs = new Set<() => void>();
const sub = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
/** The present handler an artifact registered with `usePresentControl`, if any. */
export const useHostPresentControl = () => useSyncExternalStore(sub, () => control, () => undefined);

/** Open the feedback drawer (decisions and comments). */
export const openFeedback = (): void => hostApi.openFeedback?.();
/** Save the artifact as one HTML file. */
export const download = (): Promise<void> => hostApi.download?.() ?? Promise.resolve();
/** Start present mode: the artifact's own (`usePresentControl`) when it registered one, else the host's slide walk. */
export const startPresent = (): void => hostApi.startPresent?.();
/** Switch between the light and dark theme. */
export const toggleTheme = (): void => hostApi.toggleTheme?.();

/**
 * Let the artifact run present mode itself (a deck frame, a cinematic stage). While this component is mounted, `p`, the corner
 * menu's Present and `startPresent()` call `start` instead of the host's slide walk. Set `"present": "artifact"` in
 * artifact.json to also drop the host's own walk when no handler is mounted.
 */
export function usePresentControl(start: () => void): void {
  const ref = useRef(start); ref.current = start;
  useEffect(() => {
    const mine = { start: () => ref.current() };
    control = mine; subs.forEach((s) => s());
    return () => { if (control === mine) { control = undefined; subs.forEach((s) => s()); } };
  }, []);
}
