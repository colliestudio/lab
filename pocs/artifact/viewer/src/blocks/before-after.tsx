import { useEffect, useState } from "react";
import type { Shot } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { mimeOf } from "../boot.ts";
import { Icon } from "../components/icons.tsx";
import type { B } from "./simple.tsx";

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
  const { url, err } = useBlobUrl(shot.src);
  return (
    <figure className="shot">
      <div className="shot-label">{label}</div>
      <div className="shot-frame">
        {shot.src ? (
          url ? <img src={url} alt={shot.caption ?? label} /> : <div className="shot-empty">{err ?? "loading…"}</div>
        ) : shot.demo ? (
          <div className="shot-empty"><Icon name="play" size={16} /> {shot.demo}{shot.step != null && ` · step ${shot.step}`}</div>
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
