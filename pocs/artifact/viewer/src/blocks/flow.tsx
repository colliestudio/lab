import { useEffect, useId, useState } from "react";
import { useViewer } from "../ctx.tsx";
import type { B } from "./simple.tsx";

let mermaidP: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => (mermaidP ??= import("mermaid").then((m) => m.default));

// Mermaid keeps one global config; serialize renders so theme switches don't interleave.
let queue: Promise<unknown> = Promise.resolve();

function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(`--collie-color-${n}`).trim();
  return {
    darkMode: document.documentElement.dataset.theme === "midnight",
    background: v("canvas"),
    fontFamily: cs.getPropertyValue("--collie-font-sans").trim(),
    fontSize: "13px",
    primaryColor: v("accent-subtle"),
    primaryBorderColor: v("border-accent"),
    primaryTextColor: v("fg"),
    secondaryColor: v("neutral-subtle"),
    secondaryBorderColor: v("border"),
    secondaryTextColor: v("fg"),
    tertiaryColor: v("surface"),
    tertiaryBorderColor: v("border-subtle"),
    tertiaryTextColor: v("fg"),
    lineColor: v("fg-muted"),
    textColor: v("fg"),
    mainBkg: v("accent-subtle"),
    nodeBorder: v("border-accent"),
    clusterBkg: v("surface"),
    clusterBorder: v("border-subtle"),
    edgeLabelBackground: v("canvas"),
    actorBkg: v("accent-subtle"),
    actorBorder: v("border-accent"),
    actorTextColor: v("fg"),
    actorLineColor: v("border"),
    signalColor: v("fg-muted"),
    signalTextColor: v("fg"),
    labelBoxBkgColor: v("neutral-subtle"),
    labelBoxBorderColor: v("border"),
    labelTextColor: v("fg"),
    loopTextColor: v("fg-muted"),
    noteBkgColor: v("warning-subtle"),
    noteBorderColor: v("border-warning"),
    noteTextColor: v("fg"),
    activationBkgColor: v("neutral-subtle"),
    activationBorderColor: v("border"),
    sequenceNumberColor: v("fg-on-accent"),
    // state diagrams
    stateBkg: v("accent-subtle"),
    stateLabelColor: v("fg"),
    compositeBackground: v("surface"),
    altBackground: v("surface"),
    // ER
    attributeBackgroundColorOdd: v("canvas"),
    attributeBackgroundColorEven: v("surface"),
  };
}

export function FlowBlock({ block }: { block: B<"flow"> }) {
  const { theme } = useViewer();
  const rid = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    queue = queue.then(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: themeVars(), securityLevel: "strict",
          flowchart: { curve: "basis", padding: 10, useMaxWidth: false, nodeSpacing: 30, rankSpacing: 36 },
          sequence: { mirrorActors: false, useMaxWidth: false, actorFontSize: 12.5, messageFontSize: 12, noteFontSize: 12,
            boxMargin: 6, boxTextMargin: 4, noteMargin: 6, messageMargin: 26, actorMargin: 36, height: 30, width: 110,
            diagramMarginX: 8, diagramMarginY: 4, bottomMarginAdj: 0 },
          state: { useMaxWidth: false, padding: 6, nodeSpacing: 36, rankSpacing: 28 }, er: { useMaxWidth: false } });
        const { svg } = await mermaid.render(rid + theme, block.mermaid);
        if (live) { setSvg(svg); setErr(null); }
      } catch (e) {
        if (live) setErr(String((e as Error)?.message ?? e));
        document.getElementById("d" + rid + theme)?.remove();
      }
    });
    return () => { live = false; };
  }, [block.mermaid, theme, rid]);

  return (
    <figure className="flow">
      {err ? (
        <div className="flow-err"><b>Diagram error</b><pre>{err}</pre><pre className="flow-src">{block.mermaid}</pre></div>
      ) : svg ? (
        <div className="flow-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="flow-loading">Rendering diagram…</div>
      )}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}
