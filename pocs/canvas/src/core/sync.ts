import { WebrtcProvider } from 'y-webrtc';
import type { App } from './app';
import { mountPresenceView, Presence, type PlayerInfo } from './presence';

// Multiplayer transport. Today: y-webrtc (peer-to-peer, the Y.Doc syncs over WebRTC data channels)
// with our own signaling server (Cloudflare Worker + Durable Object, see /signaling).
// Tomorrow: a room Durable Object can join as one more Yjs peer over WebSocket (always-on
// persistence, a dealer holding secrets) next to the WebRTC mesh; both providers share the same
// Y.Doc and Awareness, so nothing above this file changes.

export interface Room {
  id: string;
  provider: WebrtcProvider;
  presence: Presence;
  /** Is the signaling WebSocket up? */
  signalingConnected(): boolean;
  /** Peers with an open WebRTC (or same-browser BroadcastChannel) connection. */
  connectedPeers(): number;
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
  return loc.port === '5190' || loc.port === '5191' ? `${ws}://${loc.hostname}:5192` : `${ws}://${loc.host}`;
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
  window.addEventListener('beforeunload', () => provider.destroy());
  return {
    id,
    provider,
    presence,
    signalingConnected: () => provider.signalingConns.some((c: { connected: boolean }) => c.connected),
    connectedPeers: () => peers,
    leave: () => provider.destroy(),
  };
}
