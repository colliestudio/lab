// The y-webrtc signaling protocol, as pure functions (no Workers APIs) so it can be unit-tested
// and reused by any host (Durable Object now, a Node server or another runtime later).
//
// Client -> server JSON messages:
//   {type:'subscribe', topics:[...]}   {type:'unsubscribe', topics:[...]}
//   {type:'publish', topic, ...}       {type:'ping'}
// Server -> client: publish messages are relayed to every subscriber of the topic (the sender
// included; y-webrtc ignores its own) with `clients` = number of subscribers; ping -> {type:'pong'}.

export type Outcome =
  | { kind: 'topics'; topics: string[] } // the connection's new topic list
  | { kind: 'publish'; topic: string; message: Record<string, unknown> }
  | { kind: 'reply'; message: Record<string, unknown> }
  | { kind: 'ignore' };

const MAX_TOPICS = 32;
const MAX_TOPIC_LEN = 256;
const okTopic = (t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= MAX_TOPIC_LEN;

export function handle(raw: string, current: readonly string[]): Outcome {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: 'ignore' };
  }
  if (!msg || typeof msg !== 'object') return { kind: 'ignore' };
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'subscribe': {
      const add = Array.isArray(m.topics) ? m.topics.filter(okTopic) : [];
      const next = [...new Set([...current, ...add])].slice(0, MAX_TOPICS);
      return { kind: 'topics', topics: next };
    }
    case 'unsubscribe': {
      const drop = new Set(Array.isArray(m.topics) ? m.topics.filter(okTopic) : []);
      return { kind: 'topics', topics: current.filter((t) => !drop.has(t)) };
    }
    case 'publish':
      return okTopic(m.topic) ? { kind: 'publish', topic: m.topic, message: m } : { kind: 'ignore' };
    case 'ping':
      return { kind: 'reply', message: { type: 'pong' } };
    default:
      return { kind: 'ignore' };
  }
}

/** Relay a publish to every connection subscribed to its topic. */
export function relay<C>(conns: Iterable<C>, topicsOf: (c: C) => readonly string[], topic: string, message: Record<string, unknown>, send: (c: C, s: string) => void) {
  const receivers = [...conns].filter((c) => topicsOf(c).includes(topic));
  const out = JSON.stringify({ ...message, clients: receivers.length });
  for (const c of receivers) send(c, out);
  return receivers.length;
}

// ---- relay: a WebSocket path for peers that cannot do WebRTC (a Node bridge)
//
// `/r/<room>?relay=bridge|peer` opens a binary pipe next to the signaling sockets. The Durable Object
// holds no document: it forwards y-websocket frames (sync, awareness) between a room's bridges and
// the browsers that chose to reach them. Browsers keep syncing with each other over WebRTC, so a
// browser's frames go to bridges only, while a bridge's frames go to everyone.

export type RelayRole = 'bridge' | 'peer';

/**
 * Relay sockets one room accepts, per role. Every bridge frame fans out to every relay socket, so the
 * caps bound what one frame costs (the runtime already caps a frame at 32 MiB).
 */
export const MAX_RELAY: Record<RelayRole, number> = { bridge: 4, peer: 64 };

export function relayRole(url: URL): RelayRole | null {
  const r = url.searchParams.get('relay');
  return r === 'bridge' || r === 'peer' ? r : null;
}

/** Who receives a relay frame from `from` (never the sender itself). */
export function relayRecipients<C>(from: { conn: C; role: RelayRole }, all: Iterable<{ conn: C; role: RelayRole }>): C[] {
  const out: C[] = [];
  for (const o of all) {
    if (o.conn === from.conn) continue;
    if (from.role === 'peer' && o.role !== 'bridge') continue;
    out.push(o.conn);
  }
  return out;
}

/** y-websocket "query awareness" frame (message type 3): the receiver answers with its presence. */
export const QUERY_AWARENESS = new Uint8Array([3]);
