import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { strFromU8, unzipSync } from "fflate";
import RrwebPlayer from "rrweb-player";
import playerCss from "rrweb-player/dist/style.css?text";
import { getEvidence } from "./registry.ts";
import { cx } from "./util.ts";
import { Heavy } from "./layout.tsx";

interface Step { t: number; text: string; kind?: string }
interface Rec {
  manifest: { viewport?: { width: number; height: number }; startedAt?: string };
  events: { timestamp: number }[]; steps: Step[]; t0: number;
}

function load(b64: string): Rec {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const files = unzipSync(bytes, { filter: (f) => f.name !== "trace.zip" });
  const read = <T,>(n: string, d: T): T => (files[n] ? JSON.parse(strFromU8(files[n])) : d);
  const manifest = read<Rec["manifest"]>("manifest.json", {});
  const events = read<Rec["events"]>("rrweb.json", []);
  const steps = read<Step[]>("steps.json", []);
  return { manifest, events, steps, t0: events[0]?.timestamp ?? (manifest.startedAt ? Date.parse(manifest.startedAt) : steps[0]?.t ?? 0) };
}

let cssIn = false;
const injectCss = () => { if (cssIn) return; cssIn = true; const st = document.createElement("style"); st.textContent = playerCss as string; document.head.appendChild(st); };

type Player = InstanceType<typeof RrwebPlayer>;
const LIST_W = 240, GAP = 12, SIDE = 560, MAX_H = 440;
const fmt = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)}s`;

/** A Collie Demo recording (evidence/*.replay) with its steps; click a step to seek. `steps={[2,3]}` (1-based) limits list and playback. */
export function Replay({ src, steps: only, caption, id, collapsed }: { src: string; steps?: number[]; caption?: ReactNode; id?: string; collapsed?: boolean }) {
  const box = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), player = useRef<Player>(undefined);
  const rec = useMemo(() => load(getEvidence(src, "replay").b64), [src]);
  const [now, setNow] = useState(0);
  const [listMax, setListMax] = useState(420);
  const shown = useMemo(() => {
    const all = rec.steps.map((s, i) => ({ ...s, n: i + 1, rel: s.t - rec.t0 }));
    return only?.length ? all.filter((s) => only.includes(s.n)) : all;
  }, [rec, only]);
  const stopAt = useMemo(() => {
    if (!only?.length || !shown.length) return Infinity;
    const next = rec.steps[shown[shown.length - 1].n];
    return next ? next.t - rec.t0 : Infinity;
  }, [rec, shown, only]);
  const stop = useRef(stopAt); stop.current = stopAt;
  const hasScreen = rec.events.length > 0;

  useEffect(() => {
    if (!hasScreen || !stage.current || !box.current) return;
    const vp = rec.manifest.viewport ?? { width: 1280, height: 800 };
    const w = box.current.clientWidth || 720;
    const pw = Math.min(Math.round((MAX_H * vp.width) / vp.height), Math.max(240, w >= SIDE ? w - LIST_W - GAP : w) - 8);
    injectCss();
    stage.current.innerHTML = "";
    const Ctor = (RrwebPlayer as unknown as { default?: typeof RrwebPlayer }).default ?? RrwebPlayer;
    const p = new Ctor({ target: stage.current, props: { events: rec.events as never, width: pw, height: Math.round((pw * vp.height) / vp.width), autoPlay: false, showController: true, tags: { step: "#f59e0b" } } });
    setListMax(Math.max(200, stage.current.offsetHeight));
    player.current = p;
    p.addEventListener("ui-update-current-time", ({ payload }: { payload: number }) => { setNow(payload); if (payload >= stop.current) p.pause(); });
    if (shown[0] && only?.length) p.goto(Math.max(0, shown[0].rel - 50), false);
    return () => { (p as unknown as { $destroy?: () => void }).$destroy?.(); player.current = undefined; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, hasScreen]);

  const seek = (rel: number) => { setNow(Math.max(0, rel - 50)); player.current?.goto(Math.max(0, rel - 50), true); };
  const active = shown.reduce<number>((a, s, i) => (s.rel <= now + 60 ? i : a), -1);
  const side = hasScreen && (box.current?.clientWidth ?? 720) >= SIDE;
  return (
    <Heavy collapsed={collapsed} label={`Recording: ${src.split("/").pop()}`}>
    <figure className="a-replay" data-c="replay" data-aid={id}>
      {caption && <figcaption>{caption}</figcaption>}
      <div ref={box} style={{ display: "flex", gap: GAP, alignItems: "flex-start", flexDirection: side ? "row" : "column" }}>
        {hasScreen ? <div ref={stage} style={{ flex: "0 1 auto", minWidth: 0 }} /> : <div className="a-muted a-pad">Backend recording (no screen): the steps are what happened.</div>}
        <ol className="a-replay-steps" style={{ width: side ? LIST_W : "auto", maxHeight: listMax } as CSSProperties} aria-label="Recording steps">
          {shown.map((s, i) => (
            <li key={s.n}>
              <button type="button" disabled={!hasScreen} onClick={() => seek(s.rel)} aria-current={i === active ? "step" : undefined}
                className={cx(i === active && "on", s.kind === "offstage" && "off")} title={s.text}>
                <span className="n">{s.n}</span><span>{s.text}</span><span className="t">{fmt(s.rel)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </figure>
    </Heavy>
  );
}
