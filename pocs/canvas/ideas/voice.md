# voice

**Idea.** People at the table can talk. A "Join voice" button on the toolbar opens the microphone (only on click), connects you to everyone else in voice, and the table shows who is talking: a green ring on their toolbar chip and on their cursor label. Mute, leave, and an optional "Near" mode that makes people louder when their cursor is close to yours.

Branch `idea/voice` (from `idea/agent-player`), worktree `~/code/canvas-wt/voice`.

## How it works

```
 Join voice ─ getUserMedia ─ awareness.voice = {on, muted, epoch, out[], ack{}}
                                  │  (the same Yjs awareness that carries cursors)
   room mode:   WebRTC data channels between browsers (y-webrtc)
   bridge mode: the bridge's WebSocket (y-websocket)
                                  │
 offer / answer / ICE candidates ─┴─> one RTCPeerConnection per other voice player (full mesh)
 remote track ─> <audio autoplay> (playback) + AnalyserNode (level) ─> speaking flag
```

- **Signaling over Awareness.** A voice player publishes `voice` in their awareness state. Awareness holds only each peer's latest state, not a message stream, so messages go in an outbox list (`out`: `{to, seq, kind, cid, data}`); the receiver processes unseen sequence numbers in order and acknowledges the highest in its own state (`ack[from]`); the sender then drops them. A rejoin gets a new `epoch`, so sequence numbers restart cleanly. All DOM-free in `src/voice/signal.ts` (tested with two wired Awareness instances).
- **Who offers.** Both sides see each other in voice; the higher client id makes the offer, so there is never glare and no perfect-negotiation logic. An attempt has a connection id (`cid`); a retry after `failed` starts a new `cid` and the answerer replaces its end.
- **Mesh.** One audio-only peer connection per pair. Fine for ~2-6 (each person uploads N-1 copies of a ~30 kbps Opus stream). Tested with 3.
- **Speaking.** Local RMS from an `AnalyserNode` (mine and each remote stream) through a hysteresis + 300 ms hold detector (`speaking.ts`), polled at 10 Hz. Each person computes it locally for what they hear, so nothing extra goes over awareness. Mute is `track.enabled = false` plus a `muted` flag in awareness (the chip shows 🔇).
- **Near mode** (stretch, built because it was ~15 lines): `audio.volume = proximityGain(distance between my cursor and theirs)`: 1 within 600 world units, linear down to 0.15 at 3000. My cursor, or the view center if I have none on the table.
- **Wiring.** `src/voice/ui.ts` (toolbar buttons + chip/cursor decoration; chips and cursors carry `data-client`), mounted from `main.ts` for rooms and bridge mode. Core changes: `ICE` exported from `sync.ts`, `data-client` on cursors.

## What's built

- `src/voice/signal.ts` (state machine), `speaking.ts` (detector, proximity), `chat.ts` (peer connections, mic, levels, `stats()`), `ui.ts`.
- Tests: +7 (signaling: initiator choice, ordered delivery + ack, addressing, mute/leave/rejoin, timeout; speaking; proximity). 270 total; typecheck green.
- Headless Chrome (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`), real Worker signaling on 5288, both modes:
  - 3 pages in a room: every pair `connected`, ~300 audio packets received in 6 s, `audioLevel` > 0, `totalAudioEnergy` rising. Same in bridge mode.
  - Mute: Ann's received energy from Bob rises 0.47 per 2 s unmuted and 0.0000 muted; Ann's chip shows Bob 🔇.
  - Speaking class lands on chips and on the cursor element; leave removes the link and the `<audio>`; rejoin reconnects; Near: volume 0.82 at ~1100 units, 1.0 when close; blocked mic shows "Microphone blocked…" and the Join button stays.
  - Not checked: anything audible (the fake device is a beep), echo cancellation quality, real networks behind NAT, mobile Safari.
- Check scripts (not in the repo): `/tmp/canvas-demos/voice/keep/check.mjs` (`node check.mjs room|bridge`) and `check2.mjs`.

## Demo

The mic needs a secure context: `http://localhost` works, `http://mini.internal:<port>` does not (the Join button says so). Servers bind localhost, so the other device reaches them through an SSH tunnel and uses `localhost` too.

On the Mini (detached):
```
cd ~/code/canvas-wt/voice
nohup pnpm exec vite --port 5282 --strictPort --host localhost > /tmp/canvas-demos/voice/app.log 2>&1 &
nohup pnpm exec wrangler dev --config signaling/wrangler.toml --port 5288 --ip 127.0.0.1 > /tmp/canvas-demos/voice/signal.log 2>&1 &
nohup pnpm bridge /tmp/canvas-demos/voice/bridge/t.canvas --port 5285 > /tmp/canvas-demos/voice/bridge.log 2>&1 &   # only for bridge mode
```

Two devices (laptop + Mini, or laptop + phone-on-the-same-tunnel is not possible; use two laptops/browsers):
1. On the laptop: `ssh -L 5282:localhost:5282 -L 5288:localhost:5288 -L 5285:localhost:5285 <mini>`.
2. Mini browser: `http://localhost:5282/?room=demo1&signal=ws://localhost:5288`. Laptop browser: the same URL (its localhost is the tunnel). Pick names.
3. Click **Join voice** on both, allow the microphone. Chips get 🎙; talk: the speaker's chip and cursor label get a green ring. **Mute** turns it to 🔇 on the other side. **Near** + moving cursors apart makes the other person quieter. **Leave voice** ends it.
4. Bridge mode: `?bridge=ws://localhost:5285` on both (no signaling server needed beyond the bridge). Wear headphones when both devices are in one room (feedback).
5. Without a second device: two windows of one machine (second in a private window) and a headset; or run `node /tmp/canvas-demos/voice/keep/check.mjs room`.

Real remote players over plain http: Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the page origin, or the deployed https app (not deployed with this branch).

## What it says about the core / plugin API

- **Awareness is a usable side channel.** Voice needs no server of its own and works identically in both transports, because Presence already owns an Awareness per provider. The cost: awareness is broadcast to everyone (SDP and candidates are visible to all table members, including IPs; fine among friends), and it needs a reliable-message layer (outbox + ack) on top. A generic `room.signal(to, kind, data)` / `room.onSignal` (the same outbox) would serve voice, file transfer and any peer-to-peer feature; today it lives in `voice/signal.ts`.
- **Voice is a room feature, not a plugin.** It attaches to the room (awareness, toolbar chips, cursors), not to a node type. The plugin API has no way to add toolbar controls or decorate presence chips and cursors; `ui.ts` reaches into the DOM by `data-client`. A `presence decoration` hook (peer → badge/class) and a toolbar contribution point would make this a plugin (and let games show "whose turn" the same way).
- **Presence needs a stable per-connection id on chips and cursors** (added: `data-client`). Awareness client ids change on reload; player ids (`PlayerInfo.id`) are stable per browser. Voice keys by client id because that is what awareness/signaling address.
- **Tables with a host (bridge or a deployed host)** could instead run an SFU or relay audio; mesh keeps "no server" true. The host model does not change the mesh unless it needs recording.

## Agents in voice (not built; the shape)

An agent hears and speaks through the bridge, not WebRTC:
- **Speak**: a bridge client calls TTS (any provider) and publishes the audio as a track. In Node there is no browser WebRTC; options are `werift`/`node-datachannel`/`wrtc` (more dependencies, fragile) or the bridge relaying PCM over its WebSocket to browsers, which play it as a local `<audio>` (then it is a table sound, not a peer, and it is not heard by people who join later). The simplest first version: agent says something → the browser of whoever is "voice host" plays TTS locally (a command `voice.say {text}` in the doc log: everyone's browser speaks it with `speechSynthesis`, free, no audio transport at all).
- **Listen**: STT needs the audio. Cheapest: each browser runs Web Speech / a WASM Whisper on its own mic and writes finished utterances to the doc as `say` log entries ("Alex: pass me the king"); the agent reads them through its normal `view` / `wait` (the agent-player loop) and no audio leaves the browser. Better quality and consistent transcripts: stream the mic to the bridge (WebSocket PCM) and transcribe there.
- Either way the agent shows as a chip with its own speaking indicator (driven by the `say` events), and humans get a transcript in the log for free (also useful for people who cannot listen).

## Is proximity audio worth it?

Cheap to build (done), tricky to make good. Falls out well when the table is big and groups form at different corners (card game here, chess there), and it reuses the cursor, so it needs no extra UI. But: a person who is not moving their cursor sits at the view center, so "near" depends on where each person is looking, which is not stable; with only 2-6 people at one game, everyone is near everyone, and a conversation that fades because someone panned away is annoying. Verdict: keep as a toggle (default off); revisit when tables hold several simultaneous groups. Next step would be "table zones" (talk to the zone you are in) rather than raw distance, using mats as the zone.

## TURN (strict NATs)

STUN (Google and Cloudflare, as for the doc mesh) works for most home networks; symmetric NATs, many corporate and some mobile networks need a TURN relay (roughly 10-20% of pairs). What it takes: a TURN service (Cloudflare Calls TURN, Metered free tier, or coturn on a VPS), short-lived credentials minted per session (a Worker endpoint next to the signaling Worker, `iceServers` returned with username/credential, TTL ~1 h), then `ICE` becomes fetched config instead of a constant (also for the y-webrtc doc mesh, which has the same limit: if the doc cannot connect, neither can voice, because voice signals over the doc's awareness). Relayed audio costs bandwidth on the TURN account: ~30-50 kbps per direction per pair. Not built.

## Open questions

- Join/leave sounds, push-to-talk (key `T`?), and "deafen"; per-person volume sliders.
- Auto-reconnect when a peer's network changes (`disconnected` is only waited out; `failed` is retried by the initiator, tested only by code reading, not by breaking a network).
- Voice state persisting across reload: now you rejoin by hand (a mic prompt on page load would be wrong).
- Awareness client ids are per page load: two tabs of one person are two voice players (echo). Detect by player id and ask.
- Bridge mode with agents as voice participants: do agent chips show a mic?
- 6+ players: switch to an SFU/relay at some count? Not measured.

## Known gaps

- Mesh scale not measured past 3 peers; CPU/bandwidth for 6 not tested.
- Safari/iOS and Firefox untested (the code uses standard APIs only; autoplay policy on iOS may need a tap after joining).
- No TURN. A pair that cannot connect shows a dimmed mic on the chip (`data-link='connecting'`) and no error.
- Awareness-borne signaling publishes every SDP/candidate to all peers and relies on the awareness 30 s liveness; a peer that is silent for >30 s drops out of voice and back in.
- `window.__voiceStats()` is left in for checks.

## Effort to make it real

- Reliability pass (reconnect, ICE restart, TURN config via Worker, device picker, push-to-talk, join sounds, per-person volume): ~3-4 days.
- Generic `room.signal` + presence decoration + toolbar contribution API (so voice becomes a plugin): ~2-3 days.
- Agent voice (`voice.say` via speechSynthesis + client-side STT to the log): ~2 days; server-side STT/TTS streaming through the bridge: ~1 week.
- Zones for proximity: with mats, ~2 days.
