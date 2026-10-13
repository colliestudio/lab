import type { BridgeAddress } from './core/bridgeAddress';

// Bridges this browser has connected to, most recent first. Kept in localStorage, tokens included:
// a pairing token only opens a bridge the person already has the link to, on this device.

export interface SavedBridge extends BridgeAddress {
  /** When it last connected (ms). */
  last: number;
}

const KEY = 'canvas-poc:bridges';
const MAX = 8;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function savedBridges(store: Store = localStorage): SavedBridge[] {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((b): b is SavedBridge => typeof b?.url === 'string' && typeof b.last === 'number').sort((a, b) => b.last - a.last);
  } catch {
    return [];
  }
}

export function rememberBridge(b: BridgeAddress, store: Store = localStorage, now = Date.now()): SavedBridge[] {
  const rest = savedBridges(store).filter((s) => s.url !== b.url);
  const list = [{ url: b.url, ...(b.token ? { token: b.token } : {}), last: now }, ...rest].slice(0, MAX);
  store.setItem(KEY, JSON.stringify(list));
  return list;
}

export function forgetBridge(url: string, store: Store = localStorage): SavedBridge[] {
  const list = savedBridges(store).filter((s) => s.url !== url);
  store.setItem(KEY, JSON.stringify(list));
  return list;
}

/** The page's `?bridge=` plus a token from its #fragment, else the one saved for that address. */
export function bridgeFromLocation(loc: Pick<Location, 'search' | 'hash'>, store: Store = localStorage): BridgeAddress | null {
  const url = new URLSearchParams(loc.search).get('bridge');
  if (!url) return null;
  const token = new URLSearchParams(loc.hash.replace(/^#/, '')).get('token') ?? savedBridges(store).find((s) => s.url === url)?.token;
  return { url, ...(token ? { token } : {}) };
}

/** Where connecting to a bridge goes: this app with ?bridge=. The token rides in the #fragment, which never reaches a server. */
export function bridgeHref(a: BridgeAddress, loc: Pick<Location, 'pathname'> = location): string {
  return `${loc.pathname}?bridge=${encodeURIComponent(a.url)}${a.token ? `#token=${encodeURIComponent(a.token)}` : ''}`;
}
