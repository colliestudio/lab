import type { PlayerInfo } from './presence';

// This browser's player identity, kept in localStorage. `named` = the person picked a name
// themselves (entries without it, from before, count as unnamed and get asked once more).

export const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5a5', '#d6338a', '#8a6d00', '#2f4b7c', '#c0392b'];
export const PLAYER_KEY = 'canvas-poc:player';
export const MAX_NAME = 24;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export interface StoredPlayer extends PlayerInfo {
  named: boolean;
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Load the player, creating (and saving) an unnamed default "Player N" the first time. Never asks. */
export function loadPlayer(storage: KV = localStorage, key = PLAYER_KEY, random = Math.random): StoredPlayer {
  let saved: Partial<StoredPlayer> | null = null;
  try {
    saved = JSON.parse(storage.getItem(key) ?? 'null');
  } catch {
    saved = null;
  }
  if (saved && typeof saved.id === 'string' && typeof saved.name === 'string' && saved.name.trim() && typeof saved.color === 'string') {
    return { id: saved.id, name: saved.name, color: saved.color, named: saved.named === true };
  }
  const n = 1 + Math.floor(random() * 99);
  const p: StoredPlayer = { id: typeof saved?.id === 'string' ? saved.id : randomId(), name: `Player ${n}`, color: PALETTE[n % PALETTE.length], named: false };
  storage.setItem(key, JSON.stringify(p));
  return p;
}

/** The person chose a name (and maybe a color): save it as named. Blank names keep the old one. */
export function savePlayer(choice: { name: string; color?: string }, storage: KV = localStorage, key = PLAYER_KEY): StoredPlayer {
  const cur = loadPlayer(storage, key);
  const name = choice.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) || cur.name;
  const color = choice.color && /^#[0-9a-f]{6}$/i.test(choice.color) ? choice.color : cur.color;
  const p: StoredPlayer = { id: cur.id, name, color, named: true };
  storage.setItem(key, JSON.stringify(p));
  return p;
}
