// Deck state that outlives a page: every slide is its own page and remounts on navigation.
import { useSyncExternalStore } from "react";

export interface DeckState { overview: boolean; notes: boolean; presenting: boolean; step: number }
let state: DeckState = { overview: false, notes: false, presenting: false, step: 0 };
const subs = new Set<() => void>();
export const getDeck = () => state;
export function setDeck(p: Partial<DeckState>) {
  const next = { ...state, ...p };
  if ((Object.keys(p) as (keyof DeckState)[]).every((k) => state[k] === next[k])) return;
  state = next; subs.forEach((f) => f());
}
export function useDeck(): DeckState {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, getDeck, getDeck);
}
