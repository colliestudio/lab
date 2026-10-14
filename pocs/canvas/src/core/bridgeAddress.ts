// Bridge addresses and links, shared by the app (the "Bridge…" dialog) and the bridge command (the
// links it prints). Pure functions, no DOM or Node APIs.
//
// A bridge is reached at a WebSocket URL. Behind a quick tunnel it is public, so the bridge also
// prints a pairing token. The token travels in the link's #fragment (never sent to a server, not in
// the Worker's logs) and in the WebSocket URL as ?token=.

export interface BridgeAddress {
  /** ws:// or wss:// URL of the bridge, no path, no token. */
  url: string;
  token?: string;
}

export const DEFAULT_APP = 'https://canvas.lab.collie.studio';

/** Apps allowed to talk to a shared bridge, besides its own: the deploy and the dev servers. */
export const DEPLOYED_ORIGINS = [DEFAULT_APP, 'https://canvas-poc.alexluong.workers.dev'];
export const DEV_ORIGINS = ['http://localhost:5190', 'http://127.0.0.1:5190', 'http://mini.internal:5190'];

const wsScheme = (u: URL) => {
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return u.protocol;
  if (u.protocol === 'http:') return 'ws:';
  if (u.protocol === 'https:') return 'wss:';
  return null;
};

/**
 * What a person pastes: `wss://x.trycloudflare.com`, an https address, `host:5222`, a full app link
 * (`…/?bridge=wss%3A%2F%2F…#token=…`) or an address with `?token=`. Throws a readable error.
 */
export function parseBridgeAddress(input: string): BridgeAddress {
  const text = input.trim();
  if (!text) throw new Error('Paste the bridge address');
  let u: URL;
  try {
    // "host:5222" parses as a URL with scheme "host:", so only add a scheme to things that have none
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `ws://${text}`);
  } catch {
    throw new Error(`Not an address: ${text}`);
  }
  let token = new URLSearchParams(u.hash.replace(/^#/, '')).get('token') ?? u.searchParams.get('token') ?? undefined;
  const inner = u.searchParams.get('bridge');
  if (inner) {
    // an app link: the address is inside it
    const nested = parseBridgeAddress(inner);
    return { url: nested.url, token: token ?? nested.token };
  }
  const scheme = wsScheme(u);
  if (!scheme) throw new Error(`Use a ws://, wss:// or https:// address (got ${u.protocol})`);
  if (!u.hostname) throw new Error(`Not an address: ${text}`);
  // plain ws:// to a non-local host is refused by browsers on an https page, but fine on http dev pages: not our call
  if (token === '') token = undefined;
  return { url: `${scheme}//${u.host}${u.pathname.replace(/\/+$/, '')}`, token };
}

/** The link to send: the app opening straight into this bridge. */
export function bridgeLink(app: string, address: BridgeAddress): string {
  const u = new URL(app);
  u.search = '';
  u.hash = '';
  u.pathname = '/';
  u.searchParams.set('bridge', address.url);
  return u.toString() + (address.token ? `#token=${encodeURIComponent(address.token)}` : '');
}

/** Room link or bare id → room id and the signaling server for it (null: the app's own origin). */
export function parseRoomRef(input: string): { room: string; signal: string | null; app: string | null } {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(text)) return { room: text, signal: null, app: null };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`Not a room link or id: ${text}`);
  }
  const room = u.searchParams.get('room');
  if (!room || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error(`No ?room= in ${text}`);
  const signal = u.searchParams.get('signal');
  // dev servers (5190/5191) signal on 5192 of the same host, a deploy on its own origin: as in core/sync.ts signalingUrl
  const dev = u.port === '5190' || u.port === '5191';
  const ws = u.protocol === 'https:' ? 'wss' : 'ws';
  return { room, signal: signal ?? (dev ? `${ws}://${u.hostname}:5192` : `${ws}://${u.host}`), app: u.origin };
}
