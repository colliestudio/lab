/// <reference types="vite/client" />
// `demo` block: a Collie Demo recording (.replay = replay/0 zip of JSON streams) played with rrweb-player,
// steps listed beside it; click a step = seek. `block.steps` (1-based) limits the list and playback range.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { strFromU8, unzipSync } from "fflate";
import RrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import type { Block } from "../../../src/model.ts";
import { Markdown } from "../components/Markdown.tsx";

type DemoBlockData = Extract<Block, { type: "demo" }>;
export interface DemoBlockProps { block: DemoBlockData; getFile: (path: string) => Promise<Uint8Array> }

export interface ReplayStep { t: number; text: string; kind?: string }
export interface Replay {
  manifest: { name?: string; stage?: string; startedAt?: string; durationMs?: number; viewport?: { width: number; height: number } };
  events: { timestamp: number }[];
  steps: ReplayStep[];
  t0: number; // replay clock origin: first rrweb event (ui stage) or manifest.startedAt (http stage)
}

/** Unzips a .replay (skipping trace.zip) and reads the streams the player needs. */
export function loadReplay(bytes: Uint8Array): Replay {
  const files = unzipSync(bytes, { filter: (f) => f.name !== "trace.zip" });
  const read = <T,>(name: string, fallback: T): T => (files[name] ? JSON.parse(strFromU8(files[name])) : fallback);
  const manifest = read<Replay["manifest"]>("manifest.json", {});
  const events = read<Replay["events"]>("rrweb.json", []);
  const steps = read<ReplayStep[]>("steps.json", []);
  const t0 = events[0]?.timestamp ?? (manifest.startedAt ? Date.parse(manifest.startedAt) : steps[0]?.t ?? 0);
  return { manifest, events, steps, t0 };
}

const fmt = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)}s`;
const LIST_W = 240, GAP = 12, MIN_SIDE_BY_SIDE = 560, MAX_FRAME_H = 440;

type Player = InstanceType<typeof RrwebPlayer>;
const mountPlayer = (target: HTMLElement, r: Replay, width: number, showController: boolean): Player => {
  const vp = r.manifest.viewport ?? { width: 1280, height: 800 };
  const Ctor = ((RrwebPlayer as unknown as { default?: typeof RrwebPlayer }).default ?? RrwebPlayer);
  return new Ctor({
    target,
    props: { events: r.events as never, width, height: Math.round((width * vp.height) / vp.width), autoPlay: false, showController, tags: { step: "#f59e0b" } },
  });
};
const destroy = (p: Player | undefined) => (p as unknown as { $destroy?: () => void } | undefined)?.$destroy?.();

export function DemoBlock({ block, getFile }: DemoBlockProps) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<Player>(undefined);
  const [replay, setReplay] = useState<Replay>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(0);
  const [listMax, setListMax] = useState(420); // follows the player's height (frame + controller)

  useEffect(() => {
    let live = true;
    setReplay(undefined); setError(undefined);
    getFile(block.src).then((b) => live && setReplay(loadReplay(b))).catch((e) => live && setError(String(e?.message ?? e)));
    return () => { live = false; };
  }, [block.src, getFile]);

  // Steps shown: all, or the 1-based subset from the block; `n` keeps the recording's numbering.
  const shown = useMemo(() => {
    if (!replay) return [];
    const all = replay.steps.map((s, i) => ({ ...s, n: i + 1, rel: s.t - replay.t0 }));
    return block.steps?.length ? all.filter((s) => block.steps!.includes(s.n)) : all;
  }, [replay, block.steps]);
  // With a subset, playback stops where the step after the last shown one begins.
  const stopAt = useMemo(() => {
    if (!replay || !block.steps?.length || !shown.length) return Infinity;
    const next = replay.steps[shown[shown.length - 1].n]; // n is 1-based → index of the following step
    return next ? next.t - replay.t0 : Infinity;
  }, [replay, shown, block.steps]);
  const stopRef = useRef(stopAt);
  stopRef.current = stopAt;

  const hasScreen = !!replay?.events.length;
  useEffect(() => {
    if (!replay || !hasScreen || !stage.current || !box.current) return;
    const w = box.current.clientWidth || 720;
    const vp = replay.manifest.viewport ?? { width: 1280, height: 800 };
    const maxW = Math.round((MAX_FRAME_H * vp.width) / vp.height); // keep the frame within one screen
    const playerW = Math.min(maxW, Math.max(240, w >= MIN_SIDE_BY_SIDE ? w - LIST_W - GAP : w) - 8); // rr-player adds a small frame
    stage.current.innerHTML = "";
    const p = mountPlayer(stage.current, replay, playerW, true);
    setListMax(Math.max(200, stage.current.offsetHeight));
    player.current = p;
    p.addEventListener("ui-update-current-time", ({ payload }: { payload: number }) => {
      setNow(payload);
      if (payload >= stopRef.current) p.pause();
    });
    if (shown[0] && block.steps?.length) p.goto(Math.max(0, shown[0].rel - 50), false);
    return () => { destroy(p); player.current = undefined; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount only when the recording changes
  }, [replay, hasScreen]);

  const seek = (rel: number) => {
    setNow(Math.max(0, rel - 50));
    player.current?.goto(Math.max(0, rel - 50), true);
  };
  const active = shown.reduce<number>((a, s, i) => (s.rel <= now + 60 ? i : a), -1);

  const sideBySide = hasScreen && (box.current?.clientWidth ?? 720) >= MIN_SIDE_BY_SIDE;
  return (
    <figure className="recap-demo" style={S.figure} data-src={block.src}>
      {block.caption && <figcaption style={S.caption}><Markdown md={block.caption} inline /></figcaption>}
      <div ref={box} style={{ ...S.row, flexDirection: sideBySide ? "row" : "column" }}>
        {error ? <div style={S.note}>Couldn't load {block.src}: {error}</div>
          : !replay ? <div style={S.note}>Loading demo…</div>
          : hasScreen ? <div ref={stage} style={S.stage} />
          : <div style={S.note}>Backend demo (no screen recording): the steps below are what happened.</div>}
        {replay && (
          <ol style={{ ...S.list, width: sideBySide ? LIST_W : "auto", maxHeight: listMax }} aria-label="Demo steps">
            {shown.map((s, i) => (
              <li key={s.n} style={S.li}>
                <button type="button" onClick={() => seek(s.rel)} disabled={!hasScreen}
                  aria-current={i === active ? "step" : undefined}
                  style={{ ...S.step, ...(i === active ? S.stepOn : null), ...(s.kind === "offstage" ? S.offstage : null) }}
                  title={s.text}>
                  <span style={S.num}>{s.n}</span>
                  <span style={S.text}>{s.text}</span>
                  <span style={S.time}>{fmt(s.rel)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </figure>
  );
}
export default DemoBlock;

/** A still frame of a replay at a step (1-based), for before/after shots: a paused player without controls. */
export function DemoFrame({ src, step, getFile, width = 340 }: { src: string; step?: number; getFile: DemoBlockProps["getFile"]; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let p: Player | undefined, live = true;
    getFile(src).then((b) => {
      if (!live || !ref.current) return;
      const r = loadReplay(b);
      if (!r.events.length) return setError("no screen recording");
      const s = r.steps[(step ?? 1) - 1];
      ref.current.innerHTML = "";
      p = mountPlayer(ref.current, r, width, false);
      // A beat after the step starts, so the frame shows the step's effect.
      p.goto(s ? Math.max(0, s.t - r.t0 + 900) : 0, false);
    }).catch((e) => live && setError(String(e?.message ?? e)));
    return () => { live = false; destroy(p); };
  }, [src, step, getFile, width]);
  return error ? <div style={S.note}>{error}</div> : <div ref={ref} className="recap-demo-frame" />;
}

const S: Record<string, CSSProperties> = {
  figure: { margin: 0 },
  caption: { margin: "0 0 10px", fontSize: 13, lineHeight: 1.5, color: "var(--muted, #666)" },
  row: { display: "flex", gap: GAP, alignItems: "flex-start" },
  stage: { flex: "0 1 auto", minWidth: 0 },
  note: { flex: "1 1 auto", padding: 12, border: "1px dashed var(--collie-color-border, #bbb)", borderRadius: 8, color: "var(--muted, #666)", fontSize: 13 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, flex: "1 0 auto", minWidth: 200, maxWidth: 360, overflowY: "auto" },
  li: { margin: 0 },
  step: {
    display: "grid", gridTemplateColumns: "20px 1fr auto", gap: 6, width: "100%", textAlign: "left", alignItems: "start",
    padding: "6px 8px", borderWidth: 1, borderStyle: "solid", borderColor: "var(--line, #e2e2e2)", borderRadius: 8, background: "var(--card, #fff)", cursor: "pointer", font: "inherit", fontSize: 12.5, lineHeight: 1.35, color: "inherit",
  },
  stepOn: { borderColor: "var(--collie-color-border-warning, #f59e0b)", background: "var(--collie-color-warning-subtle, #fff7e6)" },
  offstage: { opacity: 0.6, fontStyle: "italic" },
  num: { fontWeight: 700, color: "var(--collie-color-fg-warning, #b45309)" },
  text: { minWidth: 0 },
  time: { color: "var(--muted, #888)", fontVariantNumeric: "tabular-nums", fontSize: 11 },
};
