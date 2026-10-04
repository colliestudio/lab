// Placeholder demo block. The serve/build dev replaces this file with a real rrweb player.
// Keep the interface: export function DemoBlock({ block, getFile }), getFile(path): Promise<Uint8Array>.
import { useEffect, useState } from "react";
import type { Block } from "../../../src/model.ts";
import { Icon } from "../components/icons.tsx";

type DemoB = Extract<Block, { type: "demo" }>;

export function DemoBlock({ block, getFile }: { block: DemoB; getFile: (path: string) => Promise<Uint8Array> }) {
  const [size, setSize] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getFile(block.src).then((b) => setSize(b.byteLength), (e) => setErr(String(e?.message ?? e)));
  }, [block.src, getFile]);
  return (
    <figure className="demo">
      <div className="demo-stage">
        <div className="demo-play"><Icon name="play" size={22} /></div>
        <div className="demo-meta">
          <code>{block.src}</code>
          <span>{err ? `unavailable: ${err}` : size == null ? "loading…" : `${(size / 1024).toFixed(1)} KB recording`}</span>
          {block.steps && <span>steps {block.steps.join(", ")}</span>}
        </div>
      </div>
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}
