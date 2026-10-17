import { WebrtcProvider } from 'y-webrtc';
import { WebsocketProvider } from 'y-websocket';
import type { App } from './app';
import type { Store } from './store';
import { mountPresenceView, Presence, type PlayerInfo } from './presence';
import { openRelay, type RelayConnection } from './relay';

// Multiplayer transport. Today: y-webrtc (peer-to-peer, the Y.Doc syncs over WebRTC data channels)
// with our own signaling server (Cloudflare Worker + Durable Object, see /signaling).
// Tomorrow: a room Durable Object can join as one more Yjs peer over WebSocket (always-on
// persistence, a dealer holding secrets) next to the WebRTC mesh; both providers share the same
// Y.Doc and Awareness, so nothing above this file changes.

export interface Room {
  id: string;
  provider: { destroy(): void };
  /** How the status pill names this connection (default: "room <id>"). */
  label?: string;
  presence: Presence;
  /** Is the signaling WebSocket up? */
  signalingConnected(): boolean;
  /** Peers with an open WebRTC (or same-browser BroadcastChannel) connection. */
  connectedPeers(): number;
  /** 'room': a table shared through the signaling server; 'bridge': a bridge process hosts it. */
  kind?: 'room' | 'bridge';
  /** In a room: is a bridge (agents, a .canvas file) in it, and is the path to it open? */
  bridge?(): 'none' | 'connecting' | 'online';
  leave(): void;
}

/**
 * Dev server (port 5190/5191): ws://<page host>:5192. Deployed: the same origin, since one Worker
 * serves the app and `/r/<room>`. `?signal=` overrides both.
 */
export function signalingUrl(loc: Location = location): string {
  const override = new URLSearchParams(loc.search).get('signal');
  if (override) return override;
  const ws = loc.protocol === 'https:' ? 'wss' : 'ws';
  // dev servers (any port) use the separate wrangler signaling on 5192; a deploy serves it same-origin
  const dev = loc.port === '5190' || loc.port === '5191' || !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  return dev ? `${ws}://${loc.hostname}:5192` : `${ws}://${loc.host}`;
}

export const roomDbName = (id: string) => `canvas-poc:room:${id}`;

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export function joinRoom(app: App, id: string, me: PlayerInfo, signal = signalingUrl()): Room {
  const base = signal.replace(/\/+$/, '');
  const provider = new WebrtcProvider(`canvas-poc:${id}`, app.store.ydoc, {
    signaling: [`${base}/r/${encodeURIComponent(id)}`],
    // no password: y-webrtc would need crypto.subtle, which plain-http pages don't have
    peerOpts: { config: { iceServers: ICE } },
  });
  const presence = new Presence(provider.awareness, me);
  app.presence = presence;
  app.viewer = me.id;
  mountPresenceView(app, presence);
  let peers = 0;
  provider.on('peers', (e: { webrtcPeers: string[]; bcPeers: string[] }) => {
    peers = e.webrtcPeers.length + e.bcPeers.length;
  });
  // The signaling server says when a bridge is in the room. Browsers cannot reach a Node process over
  // WebRTC, so while one is there we also open the relay to it (see core/relay.ts). Without a bridge
  // nothing extra is open.
  let bridgeIn = false;
  let relay: RelayConnection | undefined;
  const onSignal = (m: { type?: string; online?: boolean }) => {
    if (m?.type !== 'bridge') return;
    bridgeIn = !!m.online;
    if (bridgeIn && !relay) relay = openRelay({ url: `${base}/r/${encodeURIComponent(id)}?relay=peer`, doc: app.store.ydoc, awareness: provider.awareness });
    else if (!bridgeIn && relay) {
      relay.destroy();
      relay = undefined;
    }
  };
  for (const c of provider.signalingConns) c.on('message', onSignal);
  const destroy = () => {
    for (const c of provider.signalingConns) c.off('message', onSignal);
    relay?.destroy();
    relay = undefined;
    provider.destroy();
  };
  window.addEventListener('beforeunload', destroy);
  return {
    id,
    provider,
    kind: 'room',
    bridge: () => (!bridgeIn ? 'none' : relay?.connected() ? 'online' : 'connecting'),
    presence,
    signalingConnected: () => provider.signalingConns.some((c: { connected: boolean }) => c.connected),
    connectedPeers: () => peers,
    leave: destroy,
  };
}

export const HOSTED_REFUSAL = 'this board is a file the service or bridge keeps: it cannot be replaced from here';

/** A board kept by a service or bridge: the store refuses whole-document replaces. */
export function guardHosted(store: Store) {
  store.refuseLoad = HOSTED_REFUSAL;
}

/**
 * Join a canvas bridge (bridge/server.ts): a Node process that hosts the doc for a .canvas file on
 * disk, over WebSocket (y-websocket protocol). Agents and tools edit through it; they show up here
 * as players (an `observer` joins without being one). The bridge is the host and the persistence (the file), so nothing is stored locally.
 */
export function joinBridge(app: App, url: string, me: PlayerInfo, token?: string, opts: { observer?: boolean } = {}): Room & { synced: Promise<void> } {
  guardHosted(app.store);
  const provider = new WebsocketProvider(url.replace(/\/+$/, ''), 'canvas', app.store.ydoc, { params: token ? { token } : {} });
  const presence = new Presence(provider.awareness, me);
  // an observer (the screenshot page) is never a peer: cleared before the socket opens, so nobody sees it
  if (opts.observer) provider.awareness.setLocalState(null);
  app.presence = presence;
  app.viewer = me.id;
  mountPresenceView(app, presence);
  window.addEventListener('beforeunload', () => provider.destroy());
  const synced = new Promise<void>((resolve) => provider.once('sync', () => resolve()));
  return {
    id: url,
    label: `bridge ${new URL(url).host}`,
    kind: 'bridge',
    provider,
    presence,
    synced,
    signalingConnected: () => provider.wsconnected,
    connectedPeers: () => presence.peers().length,
    leave: () => provider.destroy(),
  };
}
