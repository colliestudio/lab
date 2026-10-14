import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Shot } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { mimeOf } from "../boot.ts";
import { cx } from "../util.ts";
import type { B } from "./simple.tsx";
import { DemoFrame, unionCrop, type Crop } from "./demo.tsx";

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

function ShotView({ shot, label, crop, onContent }: {
  shot: Shot; label: string; crop?: Crop | null; onContent?: (c: Crop | null) => void;
}) {
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
          w > 0 ? <DemoFrame src={shot.demo} step={shot.step} getFile={getFile} width={w} crop={crop} onContent={onContent} /> : null
        ) : (
          <div className="shot-empty">no image</div>
        )}
      </div>
      {shot.caption && <figcaption>{shot.caption}</figcaption>}
    </figure>
  );
}

export function BeforeAfterBlock({ block }: { block: B<"before-after"> }) {
  // Two frames of the same recording share one crop (the union of their content boxes) so they line up.
  const same = !!block.before.demo && !block.before.src && !block.after.src && block.before.demo === block.after.demo;
  const [boxes, setBoxes] = useState<{ before?: Crop | null; after?: Crop | null }>({});
  const shared = same && boxes.before !== undefined && boxes.after !== undefined
    ? (boxes.before && boxes.after ? unionCrop(boxes.before, boxes.after) : null) : undefined;
  return (
    <div className="before-after">
      <div className="ba-grid">
        <ShotView shot={block.before} label="Before" crop={same ? shared ?? null : undefined}
          onContent={same ? (c) => setBoxes((b) => ({ ...b, before: c })) : undefined} />
        <ShotView shot={block.after} label="After" crop={same ? shared ?? null : undefined}
          onContent={same ? (c) => setBoxes((b) => ({ ...b, after: c })) : undefined} />
      </div>
      {block.caption && <div className="ba-caption">{block.caption}</div>}
    </div>
  );
}
