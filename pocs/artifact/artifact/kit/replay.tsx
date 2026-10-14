import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { unzipSync } from "fflate";
import RrwebPlayer from "rrweb-player";
import playerCss from "rrweb-player/dist/style.css?text";
import { getEvidence } from "./registry.ts";
import { cx } from "./util.ts";
import { Heavy } from "./layout.tsx";
import { usePresentSteps } from "./present.ts";

type Player = InstanceType<typeof RrwebPlayer> & { $set?: (p: object) => void; triggerResize?: () => void; $destroy?: () => void; getReplayer?: () => { pause(): void } };

// The zip is decoded only when the reader gets near the recording, and kept so a page revisit does not decode again.
const decoded = new Map<string, unknown[]>();
function events(src: string, b64: string): unknown[] {
  let ev = decoded.get(src);
  if (!ev) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = unzipSync(bytes, { filter: (x) => x.name === "rrweb.json" })["rrweb.json"];
    ev = f ? JSON.parse(new TextDecoder().decode(f)) : [];
    decoded.set(src, ev!);
  }
  return ev!;
}

let cssIn = false;
const injectCss = () => { if (cssIn) return; cssIn = true; const st = document.createElement("style"); st.textContent = playerCss as string; document.head.appendChild(st); };

const LIST_W = 232, GAP = 14, SIDE = 640, MAX_VH = 0.62;
const fmt = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)}s`;
const CONTROLLER = 78; // rrweb-player's controller bar under the frame

/**
 * A recording (`evidence/*.replay`, from `artifact record`) with its chapters. It shows the first frame until played;
 * click a chapter to seek. `steps={[2,3]}` (1-based) limits chapters and playback to those. `loop` plays a short clip
 * on its own while it is on screen (silent, no controls, click to pause). In present mode the recording is one step:
 * the slide shows the first frame, the next step plays it.
 */
export function Replay({ src, steps: only, caption, id, collapsed, loop, chapters = true }: { src: string; steps?: number[]; caption?: ReactNode; id?: string; collapsed?: boolean; loop?: boolean; chapters?: boolean }) {
  const ev = getEvidence(src, "replay");
  const { meta } = ev;
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), player = useRef<Player | undefined>(undefined);
  const [near, setNear] = useState(false);
  const [box, setBox] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState("");
  const [ready, setReady] = useState(false), [started, setStarted] = useState(false);
  const present = usePresentSteps(1, 1);

  const shown = useMemo(() => {
    const all = meta.steps.map((s, i) => ({ ...s, n: i + 1 }));
    return only?.length ? all.filter((s) => only.includes(s.n)) : all;
  }, [meta, only]);
  const startAt = only?.length && shown[0] ? Math.max(0, shown[0].rel - 50) : 0;
  const stopAt = useMemo(() => {
    if (!only?.length || !shown.length) return Infinity;
    const next = meta.steps[shown[shown.length - 1].n];
    return next ? next.rel : Infinity;
  }, [meta, shown, only]);
  const stop = useRef(stopAt); stop.current = stopAt;
  const list = chapters && shown.length > 1 && !loop;
  const side = list && box >= SIDE;
  // the frame: as wide as the room allows, never taller than a share of the window
  const frame = useMemo(() => {
    const { width: vw, height: vh } = meta.viewport;
    const room = Math.max(220, side ? box - LIST_W - GAP : box || 640);
    const ctl = loop ? 0 : CONTROLLER;
    const w = Math.floor(Math.min(room, ((typeof innerHeight === "number" ? innerHeight : 900) * MAX_VH - ctl) * (vw / vh), 1100));
    return { w, h: Math.round((w * vh) / vw) };
  }, [meta, box, side, loop]);

  // measure the column the recording sits in; load when it is near the screen
  useEffect(() => {
    const el = root.current; if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el); setBox(el.clientWidth);
    const io = new IntersectionObserver((e) => { const vis = e.some((x) => x.isIntersecting); setNear((n) => n || vis); if (!vis) player.current?.pause(); else if (loop && player.current) player.current.play(); }, { rootMargin: "300px" });
    io.observe(el);
    return () => { ro.disconnect(); io.disconnect(); };
  }, [loop]);

  useEffect(() => {
    if (!meta.screen || !near || !stage.current || !box) return;
    let p: Player;
    try {
      injectCss();
      stage.current.innerHTML = "";
      const Ctor = (RrwebPlayer as unknown as { default?: typeof RrwebPlayer }).default ?? RrwebPlayer;
      p = new Ctor({ target: stage.current, props: { events: events(src, ev.b64) as never, width: frame.w, height: frame.h, autoPlay: false, showController: !loop, skipInactive: false, tags: { step: "#f59e0b" } } }) as Player;
    } catch (e) { setFailed(String((e as Error).message ?? e)); return; }
    player.current = p; setReady(true);
    p.addEventListener("ui-update-current-time", ({ payload }: { payload: number }) => { setNow(payload); if (payload >= stop.current) { if (loop) p.goto(startAt, true); else p.pause(); } });
    p.addEventListener("ui-update-player-state", ({ payload }: { payload: string }) => { const on = payload === "playing"; setPlaying(on); if (on) setStarted(true); });
    if (loop) {
      p.addEventListener("finish", () => { p.goto(startAt, true); });
      p.goto(startAt, true);
    } else {
      // the first frame of the story stands in for a poster: after the page's first step began, before anything moved
      p.goto(shown[0] ? Math.min(shown[0].rel + 250, meta.duration) : 0, false);
    }
    return () => { p.$destroy?.(); player.current = undefined; setReady(false); setStarted(false); };
    // the player is built once per recording; resizing is handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, near, meta.screen, !!box]);

  useEffect(() => {
    const p = player.current; if (!p) return;
    p.$set?.({ width: frame.w, height: frame.h }); p.triggerResize?.();
  }, [frame.w, frame.h]);

  // present mode: the slide shows the first frame; the next step plays, going back pauses
  useEffect(() => {
    const p = player.current; if (!p || !present.active || loop) return;
    if (present.current && present.step >= 1) p.play(); else p.pause();
  }, [present.active, present.step, present.current, loop, near]);

  const seek = (rel: number) => { const t = Math.max(0, rel - 50); setNow(t); player.current?.goto(t, true); };
  const toggle = () => { const p = player.current; if (p) (playing ? p.pause() : p.play()); };
  const active = shown.reduce<number>((a, s, i) => (s.rel - 50 <= now + 60 ? i : a), -1);
  const first = shown[0]?.text;

  return (
    <Heavy collapsed={collapsed} label={`Recording: ${src.split("/").pop()} (${fmt(meta.duration)})`}>
    <figure className="a-replay" data-c="replay" data-aid={id}>
      {caption && <figcaption>{caption}</figcaption>}
      <div ref={root} className={cx("a-replay-body", side && "side")}>
        {meta.screen ? (
          <div className="a-replay-stage" style={{ width: frame.w, maxWidth: "100%", ...(loop ? { cursor: "pointer" } : {}) }} onClick={loop ? toggle : undefined}>
            <div ref={stage} style={{ width: frame.w, height: frame.h + (loop ? 0 : CONTROLLER) }} />
            {(!ready || failed) && <div className="a-replay-ph" style={{ width: frame.w, height: frame.h }}>{failed ? `Recording failed to load: ${failed}` : first}</div>}
            {ready && !playing && (loop || !started) && (
              <button type="button" className="a-replay-play" aria-label={loop ? "Play" : `Play recording${first ? `: ${first}` : ""}`} onClick={(e) => { e.stopPropagation(); player.current?.play(); }} style={{ height: frame.h }}>
                <span aria-hidden>▶</span>
              </button>
            )}
          </div>
        ) : <div className="a-muted a-pad">Backend recording (no screen): the steps are what happened.</div>}
        {list && (
          <ol className="a-replay-steps" aria-label="Chapters" style={{ maxHeight: side ? frame.h + CONTROLLER : undefined }}>
            {shown.map((s, i) => (
              <li key={s.n}>
                <button type="button" disabled={!meta.screen} onClick={() => seek(s.rel)} aria-current={i === active ? "step" : undefined}
                  className={cx(i === active && "on", s.kind === "offstage" && "off")} title={s.text}>
                  <span className="n">{s.n}</span><span>{s.text}</span><span className="t">{fmt(s.rel)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {present.markers}
    </figure>
    </Heavy>
  );
}
