import type { Awareness } from 'y-protocols/awareness';
import { VoiceSignaling, type SigMsg } from './signal';
import { SpeakingDetector, proximityGain } from './speaking';

// Voice chat: a WebRTC audio mesh among the players who clicked "Join voice". Signaling is in
// signal.ts (over Awareness); this file owns the browser parts: the microphone, one
// RTCPeerConnection per other voice player, playback, and audio levels for the speaking indicators.

interface Link {
  id: number;
  pc: RTCPeerConnection;
  cid: string;
  initiator: boolean;
  audio?: HTMLAudioElement;
  stream?: MediaStream;
  analyser?: AnalyserNode;
  detector: SpeakingDetector;
  /** Serializes remote descriptions and candidates: they must be applied in order. */
  queue: Promise<unknown>;
  retry?: ReturnType<typeof setTimeout>;
}

export interface VoiceOptions {
  iceServers: RTCIceServer[];
  /** Where I am on the table (world coordinates), for proximity audio; null = unknown. */
  position?: () => { x: number; y: number } | null;
  /** Where another player is (world coordinates). */
  positionOf?: (clientId: number) => { x: number; y: number } | null;
}

const rid = () => Math.random().toString(36).slice(2, 10);

export class VoiceChat {
  readonly sig: VoiceSignaling;
  private links = new Map<number, Link>();
  private mic?: MediaStream;
  private ctx?: AudioContext;
  private selfAnalyser?: AnalyserNode;
  private selfDetector = new SpeakingDetector();
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<() => void>();
  private _muted = false;
  spatial = false;
  error = '';
  private _speaking = new Set<number>();

  constructor(
    private awareness: Awareness,
    private opts: VoiceOptions,
  ) {
    this.sig = new VoiceSignaling(awareness, {
      peer: (id, initiator) => this.onPeer(id, initiator),
      gone: (id) => this.drop(id),
      signal: (from, msg) => this.onSignal(from, msg),
    });
    awareness.on('change', () => this.emit());
  }

  get joined() {
    return this.sig.on;
  }
  get muted() {
    return this._muted;
  }
  /** Client ids (me included) whose voice is above the speaking threshold right now. */
  speaking(): ReadonlySet<number> {
    return this._speaking;
  }
  /** Peers in voice, and whether a media connection to them is up. */
  members(): { id: number; muted: boolean; connected: boolean }[] {
    return this.sig.peers().map((p) => ({ ...p, connected: this.links.get(p.id)?.pc.connectionState === 'connected' }));
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Ask for the microphone (this is where the browser prompts) and enter voice. */
  async join(): Promise<boolean> {
    if (this.joined) return true;
    this.error = '';
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = window.isSecureContext
        ? 'This browser has no microphone access'
        : 'The microphone needs https or localhost: this page is plain http';
      this.emit();
      return false;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.error = (e as DOMException).name === 'NotAllowedError' ? 'Microphone blocked: allow it in the browser and try again' : `No microphone: ${(e as Error).message}`;
      this.emit();
      return false;
    }
    this.ctx = new AudioContext();
    void this.ctx.resume();
    this.selfAnalyser = this.analyse(this.mic);
    this._muted = false;
    this.mic.getAudioTracks().forEach((t) => (t.enabled = true));
    this.sig.join(false);
    this.timer = setInterval(() => this.tick(), 100);
    this.emit();
    return true;
  }

  leave() {
    if (!this.joined) return;
    this.sig.leave(); // fires gone() for every link
    clearInterval(this.timer);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = undefined;
    void this.ctx?.close();
    this.ctx = undefined;
    this.selfAnalyser = undefined;
    this._speaking = new Set();
    this.emit();
  }

  setMuted(m: boolean) {
    this._muted = m;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !m));
    this.sig.setMuted(m);
    this.emit();
  }

  setSpatial(on: boolean) {
    this.spatial = on;
    if (!on) for (const l of this.links.values()) if (l.audio) l.audio.volume = 1;
    this.emit();
  }

  /** Packet and level stats per peer, for checks that can't listen. */
  async stats() {
    const out: Record<string, { state: string; inbound: number; level: number; energy: number }> = {};
    for (const l of this.links.values()) {
      let inbound = 0,
        level = 0,
        energy = 0;
      for (const r of (await l.pc.getStats()).values()) {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          inbound += r.packetsReceived ?? 0;
          energy += r.totalAudioEnergy ?? 0;
        }
        if (r.type === 'media-source' || (r.type === 'inbound-rtp' && r.kind === 'audio')) level = Math.max(level, r.audioLevel ?? 0);
      }
      out[l.id] = { state: l.pc.connectionState, inbound, level, energy };
    }
    return out;
  }

  // ---- peers ----

  private makePc(id: number, cid: string, initiator: boolean): Link {
    const old = this.links.get(id);
    if (old) this.close(old);
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers });
    const link: Link = { id, pc, cid, initiator, detector: new SpeakingDetector(), queue: Promise.resolve() };
    this.links.set(id, link);
    for (const t of this.mic?.getTracks() ?? []) pc.addTrack(t, this.mic!);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.send(id, 'ice', cid, e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      link.stream = stream;
      // a media element has to consume the stream for the audio to play (and for Chrome to feed the analyser)
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = stream;
      document.body.append(audio);
      link.audio?.remove();
      link.audio = audio;
      void audio.play().catch(() => {});
      if (this.ctx) link.analyser = this.analyse(stream);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      this.emit();
      if (pc.connectionState === 'failed' && this.links.get(id) === link && initiator) {
        // a fresh attempt (new cid) from the same side; the answerer replaces its end when the offer arrives
        clearTimeout(link.retry);
        link.retry = setTimeout(() => {
          if (this.links.get(id) === link && this.joined) this.offer(id).catch(() => {});
        }, 1500);
      }
    };
    return link;
  }

  private async offer(id: number) {
    const link = this.makePc(id, rid(), true);
    const { pc, cid } = link;
    const desc = await pc.createOffer();
    await pc.setLocalDescription(desc);
    this.sig.send(id, 'offer', cid, { type: desc.type, sdp: desc.sdp });
  }

  private onPeer(id: number, initiator: boolean) {
    if (initiator) this.offer(id).catch(() => {}); // the peer left (link closed) while the offer was being made
    // the other side waits for the offer
  }

  private onSignal(from: number, m: SigMsg) {
    if (m.kind === 'offer') {
      let link = this.links.get(from);
      if (!link || link.cid !== m.cid) link = this.makePc(from, m.cid, false);
      const l = link;
      l.queue = l.queue.then(async () => {
        await l.pc.setRemoteDescription(m.data as RTCSessionDescriptionInit);
        const ans = await l.pc.createAnswer();
        await l.pc.setLocalDescription(ans);
        this.sig.send(from, 'answer', m.cid, { type: ans.type, sdp: ans.sdp });
      }).catch(() => {}); // a bad offer, or the link closed meanwhile; a rejected queue would also drop every later candidate
      return;
    }
    const link = this.links.get(from);
    if (!link || link.cid !== m.cid) return; // a replaced attempt
    link.queue = link.queue.then(async () => {
      if (m.kind === 'answer') await link.pc.setRemoteDescription(m.data as RTCSessionDescriptionInit);
      else await link.pc.addIceCandidate(m.data as RTCIceCandidateInit);
    }).catch(() => {});
  }

  private close(l: Link) {
    clearTimeout(l.retry);
    l.pc.onconnectionstatechange = null;
    l.pc.close();
    l.audio?.remove();
  }

  private drop(id: number) {
    const l = this.links.get(id);
    if (!l) return;
    this.close(l);
    this.links.delete(id);
    this._speaking.delete(id);
    this.emit();
  }

  // ---- levels ----

  private analyse(stream: MediaStream): AnalyserNode {
    const a = this.ctx!.createAnalyser();
    a.fftSize = 512;
    this.ctx!.createMediaStreamSource(stream).connect(a); // not connected to the speakers: playback is the <audio> element
    return a;
  }

  private level(a: AnalyserNode): number {
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    return Math.sqrt(s / buf.length);
  }

  private tick() {
    const now = performance.now();
    const next = new Set<number>();
    if (this.selfAnalyser && !this._muted && this.selfDetector.update(this.level(this.selfAnalyser), now)) next.add(this.awareness.clientID);
    else this.selfDetector.update(0, now);
    const me = this.spatial ? this.opts.position?.() : null;
    for (const l of this.links.values()) {
      if (l.analyser && l.detector.update(this.level(l.analyser), now)) next.add(l.id);
      if (l.audio) {
        const them = me && this.opts.positionOf?.(l.id);
        l.audio.volume = this.spatial && me && them ? proximityGain(Math.hypot(me.x - them.x, me.y - them.y)) : 1;
      }
    }
    const changed = next.size !== this._speaking.size || [...next].some((i) => !this._speaking.has(i));
    this._speaking = next;
    if (changed) this.emit();
  }
}
