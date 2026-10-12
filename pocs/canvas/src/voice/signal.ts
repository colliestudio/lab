import type { Awareness } from 'y-protocols/awareness';

// Voice signaling over Yjs Awareness (DOM-free). WebRTC needs offers, answers and ICE candidates
// carried between two peers; the table already has a channel to every peer (the Yjs provider's
// awareness: WebRTC data channels in a room, the bridge's WebSocket in bridge mode), so voice adds
// no server and no endpoint of its own.
//
// Awareness only keeps each peer's latest state, not a message stream. So messages ride in an
// outbox list in my state, each with a sequence number; the receiver reads the ones it hasn't seen,
// in order, and acknowledges the highest sequence number in its own state; I drop what's acknowledged.

export type SigKind = 'offer' | 'answer' | 'ice';

export interface SigMsg {
  to: number;
  seq: number;
  kind: SigKind;
  /** Connection attempt id: lets both sides drop messages of an attempt that was replaced. */
  cid: string;
  data: unknown;
}

export interface VoiceField {
  on: boolean;
  muted: boolean;
  /** Changes on every join, so a rejoin restarts sequence numbers. */
  epoch: string;
  out: SigMsg[];
  /** Highest sequence number I processed, per sender client id. */
  ack: Record<string, { e: string; s: number }>;
}

export interface VoiceEvents {
  /** Someone in voice appeared (or rejoined). `initiator`: I make the offer (the higher client id does). */
  peer(id: number, initiator: boolean): void;
  gone(id: number): void;
  signal(from: number, msg: SigMsg): void;
}

const MAX_OUT = 60;

type PeerState = { user?: unknown; voice?: unknown };

/**
 * A peer's voice field, or null if it isn't in voice. Awareness states come from other browsers
 * unchecked, so a broken or hostile one must not throw here (that would stop every awareness
 * listener). A voice peer also needs the `user` identity the player chips show: without it they
 * would be a listener nobody sees.
 */
function voiceOf(s: PeerState | undefined): VoiceField | null {
  const v = s?.voice as Partial<VoiceField> | null | undefined;
  if (!s?.user || !v || v.on !== true || typeof v.epoch !== 'string' || !Array.isArray(v.out)) return null;
  const ack = v.ack && typeof v.ack === 'object' ? v.ack : {};
  return { on: true, muted: v.muted === true, epoch: v.epoch, out: v.out, ack };
}

const isMsg = (m: unknown): m is SigMsg => {
  const x = m as SigMsg | null;
  return !!x && Number.isSafeInteger(x.seq) && typeof x.to === 'number' && typeof x.cid === 'string' && (x.kind === 'offer' || x.kind === 'answer' || x.kind === 'ice');
};

export class VoiceSignaling {
  private epoch = '';
  private seq = 0;
  private known = new Map<number, { epoch: string; seen: number }>();
  private _on = false;
  private busy = false;
  private again = false;

  constructor(
    private awareness: Awareness,
    private events: VoiceEvents,
  ) {
    awareness.on('change', () => this.handle());
  }

  get on() {
    return this._on;
  }
  private get me() {
    return this.awareness.clientID;
  }

  private mine(): VoiceField | undefined {
    return (this.awareness.getLocalState() as { voice?: VoiceField | null } | null)?.voice ?? undefined;
  }

  join(muted = false) {
    if (this._on) return;
    this._on = true;
    this.epoch = Math.random().toString(36).slice(2, 10);
    this.seq = 0;
    this.known.clear();
    this.awareness.setLocalStateField('voice', { on: true, muted, epoch: this.epoch, out: [], ack: {} } satisfies VoiceField);
    this.handle();
  }

  leave() {
    if (!this._on) return;
    this._on = false;
    this.awareness.setLocalStateField('voice', null);
    for (const id of [...this.known.keys()]) this.events.gone(id);
    this.known.clear();
  }

  setMuted(muted: boolean) {
    const v = this.mine();
    if (v && v.muted !== muted) this.awareness.setLocalStateField('voice', { ...v, muted });
  }

  send(to: number, kind: SigKind, cid: string, data: unknown) {
    const v = this.mine();
    if (!v) return;
    const out = [...v.out, { to, seq: ++this.seq, kind, cid, data }].slice(-MAX_OUT);
    this.awareness.setLocalStateField('voice', { ...v, out });
  }

  /** Everyone in voice (not me) with their mute flag. */
  peers(): { id: number; muted: boolean }[] {
    const out: { id: number; muted: boolean }[] = [];
    for (const [id, s] of this.awareness.getStates() as Map<number, PeerState>) {
      const v = id === this.me ? null : voiceOf(s);
      if (v) out.push({ id, muted: v.muted });
    }
    return out;
  }

  private handle() {
    // the handler writes my state (acks, pruning), which fires 'change' again; run once, then re-check
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        this.step();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private step() {
    if (!this._on) return;
    const mine = this.mine();
    if (!mine) return;
    const states = this.awareness.getStates() as Map<number, PeerState>;
    const ack = { ...mine.ack };
    let ackChanged = false;
    for (const [id, s] of states) {
      if (id === this.me) continue;
      const v = voiceOf(s);
      if (!v) continue;
      let k = this.known.get(id);
      if (k && k.epoch !== v.epoch) {
        this.events.gone(id);
        k = undefined;
      }
      if (!k) {
        k = { epoch: v.epoch, seen: 0 };
        this.known.set(id, k);
        this.events.peer(id, this.me > id);
      }
      for (const m of v.out.filter(isMsg).sort((a, b) => a.seq - b.seq)) {
        if (m.seq <= k.seen) continue;
        k.seen = m.seq;
        if (m.to === this.me) this.events.signal(id, m);
      }
      const a = ack[id];
      if (!a || a.e !== k.epoch || a.s !== k.seen) {
        if (k.seen > 0) {
          ack[id] = { e: k.epoch, s: k.seen };
          ackChanged = true;
        }
      }
    }
    for (const id of [...this.known.keys()]) {
      if (!voiceOf(states.get(id))) {
        this.known.delete(id);
        delete ack[id];
        ackChanged = true;
        this.events.gone(id);
      }
    }
    // drop what the receiver has acknowledged (or whose receiver left)
    const cur = this.mine() ?? mine;
    const out = cur.out.filter((m) => {
      const r = voiceOf(states.get(m.to));
      if (!r) return false;
      const a = r.ack[String(this.me)];
      return !(a && a.e === this.epoch && a.s >= m.seq);
    });
    if (ackChanged || out.length !== cur.out.length) this.awareness.setLocalStateField('voice', { ...cur, out, ack });
  }
}
