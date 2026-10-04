import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Shot } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { mimeOf } from "../boot.ts";
import { cx } from "../util.ts";
import type { B } from "./simple.tsx";
import { DemoFrame } from "./demo.tsx";

function useBlobUrl(path?: string) {
  const { getFile } = useViewer();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let u: string | null = null;
    getFile(path).then(
      (bytes) => { u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) })); setUrl(u); },
      (e) => setErr(String(e?.message ?? e)),
    );
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [path, getFile]);
  return { url, err };
}

function ShotView({ shot, label }: { shot: Shot; label: string }) {
  const { getFile } = useViewer();
  const { url, err } = useBlobUrl(shot.src);
  const frame = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => { if (frame.current) setW(Math.floor(frame.current.clientWidth)); }, []);
  return (
    <figure className="shot">
      <div className="shot-label">{label}{shot.demo && shot.step != null && <span className="shot-step">step {shot.step}</span>}</div>
      <div className={cx("shot-frame", shot.demo && !shot.src && "replay")} ref={frame}>
        {shot.src ? (
          url ? <img src={url} alt={shot.caption ?? label} /> : <div className="shot-empty">{err ?? "loading…"}</div>
        ) : shot.demo ? (
          w > 0 ? <DemoFrame src={shot.demo} step={shot.step} getFile={getFile} width={w} /> : null
        ) : (
          <div className="shot-empty">no image</div>
        )}
      </div>
      {shot.caption && <figcaption>{shot.caption}</figcaption>}
    </figure>
  );
}

export function BeforeAfterBlock({ block }: { block: B<"before-after"> }) {
  return (
    <div className="before-after">
      <div className="ba-grid">
        <ShotView shot={block.before} label="Before" />
        <ShotView shot={block.after} label="After" />
      </div>
      {block.caption && <div className="ba-caption">{block.caption}</div>}
    </div>
  );
}
