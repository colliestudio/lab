import { useEffect, useId, useState } from "react";
import { useTheme } from "./theme.ts";

let mermaidP: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => (mermaidP ??= import("mermaid").then((m) => m.default));
let queue: Promise<unknown> = Promise.resolve(); // mermaid has one global config: serialize renders

function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(`--collie-color-${n}`).trim();
  return {
    darkMode: document.documentElement.dataset.theme === "midnight", background: v("canvas"),
    fontFamily: cs.getPropertyValue("--collie-font-sans").trim(), fontSize: "13px",
    primaryColor: v("accent-subtle"), primaryBorderColor: v("border-accent"), primaryTextColor: v("fg"),
    secondaryColor: v("neutral-subtle"), secondaryBorderColor: v("border"), secondaryTextColor: v("fg"),
    tertiaryColor: v("surface"), tertiaryBorderColor: v("border-subtle"), tertiaryTextColor: v("fg"),
    lineColor: v("fg-muted"), textColor: v("fg"), mainBkg: v("accent-subtle"), nodeBorder: v("border-accent"),
    clusterBkg: v("surface"), clusterBorder: v("border-subtle"), edgeLabelBackground: v("canvas"),
    actorBkg: v("accent-subtle"), actorBorder: v("border-accent"), actorTextColor: v("fg"), actorLineColor: v("border"),
    signalColor: v("fg-muted"), signalTextColor: v("fg"), labelBoxBkgColor: v("neutral-subtle"), labelBoxBorderColor: v("border"),
    labelTextColor: v("fg"), loopTextColor: v("fg-muted"), noteBkgColor: v("warning-subtle"), noteBorderColor: v("border-warning"),
    noteTextColor: v("fg"), activationBkgColor: v("neutral-subtle"), activationBorderColor: v("border"), sequenceNumberColor: v("fg-on-accent"),
    stateBkg: v("accent-subtle"), stateLabelColor: v("fg"), compositeBackground: v("surface"), altBackground: v("surface"),
  };
}

/** A Mermaid diagram (flowchart, sequence, state, ER…): `<Flow chart={"graph LR; A-->B"} />` or the text as a child. Loads mermaid lazily. */
export function Flow({ chart, children, caption, id }: { chart?: string; children?: string; caption?: string; id?: string }) {
  const src = (chart ?? children ?? "").trim();
  const theme = useTheme();
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
          sequence: { mirrorActors: false, useMaxWidth: false, actorFontSize: 12.5, messageFontSize: 12, noteFontSize: 12 },
          state: { useMaxWidth: false }, er: { useMaxWidth: false } });
        const r = await mermaid.render(rid + theme, src);
        if (live) { setSvg(r.svg); setErr(null); }
      } catch (e) {
        if (live) setErr(String((e as Error)?.message ?? e));
        document.getElementById("d" + rid + theme)?.remove();
      }
    });
    return () => { live = false; };
  }, [src, theme, rid]);
  return (
    <figure className="a-flow" data-c="flow" data-aid={id}>
      {err ? <div className="a-map-err"><b>Diagram error</b><pre>{err}</pre><pre>{src}</pre></div>
        : svg ? <div className="a-flow-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="a-muted">Rendering diagram…</div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
