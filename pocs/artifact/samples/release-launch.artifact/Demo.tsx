import { useEffect, useRef } from "react";
import { Callout, Code, Img, Map, More, NoSteps as KitNoSteps, Scorecard, Section, Stages, Stats, TimeAxis, Walkthrough, imageSrc } from "artifact";
import type { Feature } from "./model.ts";

const KIT: Record<string, (p: any) => React.ReactNode> = { Stats, Scorecard, Map, TimeAxis, Walkthrough, Stages };

/** The feature's live demo: real kit components with the props from release.json. */
export function LiveDemo({ f }: { f: Feature }) {
  const p = f.demo.props ?? {};
  if (f.id === "artifact-dir")
    return (
      <Section {...p.Section}>
        <p>A Section is an outline entry and a slide; click its heading to fold it.</p>
        <Callout {...p.Callout}>The agent picks the structure. <code>kind</code> is shown as written, never checked against a list.</Callout>
      </Section>
    );
  if (f.id === "folding-more")
    return (
      <Section {...p.Section}>
        <p>Click the heading above to fold this section. Skippable detail goes in a quiet disclosure:</p>
        <More {...p.More}><p>Closed until the reader asks for it; present mode and search still see it.</p></More>
      </Section>
    );
  const name = f.demo.components?.[0] ?? "";
  const C = KIT[name];
  return C ? <C {...p[name]} /> : null;
}

/** A screenshot in a minimal window frame. */
export function Window({ src, alt, className, crop }: { src: string; alt: string; className?: string; crop?: [number, number, number] }) {
  const [z, x, y] = crop ?? [1, 0, 0];
  return (
    <div className={`l-win ${className ?? ""}`}>
      <div className="l-win-bar" aria-hidden><i /><i /><i /></div>
      <div className="l-win-view">
        <img src={imageSrc(src)} alt={alt} decoding="async" style={{ width: `${z * 100}%`, transform: `translate(${-x * 100}%, ${-y * 100}%)` }} />
      </div>
    </div>
  );
}

/** A terminal-styled snippet for CLI features. */
export function Terminal({ text, compact }: { text: string; compact?: boolean }) {
  const lines = text.split("\n");
  return (
    <div className="l-term" data-compact={compact ? "" : undefined}>
      <div className="l-win-bar" aria-hidden><i /><i /><i /></div>
      <pre>
        {lines.map((l, i) => {
          const [cmd, comment] = l.split(/\s{2,}#\s?/);
          return (
            <div key={i} className="l-term-line">
              <span className="l-term-ps" aria-hidden>$</span>
              <span>{cmd}</span>
              {comment && <span className="l-term-c">  # {comment}</span>}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

const langFor = (f: Feature) => (f.theme === "cli" ? "bash" : f.how.trimStart().startsWith("x.artifact/") ? undefined : "typescript");

export function Snippet({ f }: { f: Feature }) {
  if (f.theme === "cli" && !f.how.includes("<")) return <Terminal text={f.how} />;
  return <Code code={f.how} lang={langFor(f)} />;
}

/** The big stage inside a sheet: the live component, the screenshot, or (for features without a demo) the snippet. */
export function Stage({ f, onAnswer }: { f: Feature; onAnswer: () => void }) {
  const d = f.demo;
  if (f.id === "decision-walk")
    return (
      <div className="l-stage" data-kind="shot">
        <div className="l-stage-tag">Screenshot · {d.shotFrom}</div>
        <Img src={d.shot!} alt="A Decision answered on the page" />
        <button className="l-btn l-btn-primary l-stage-cta" onClick={onAnswer}>Answer the real one at the end of this page <span aria-hidden>↓</span></button>
      </div>
    );
  if (d.kind === "live")
    return (
      <div className="l-stage" data-kind="live">
        <div className="l-stage-tag"><span className="l-live-dot" aria-hidden /> Live: the real component, try it</div>
        <NoSteps className="l-stage-live"><LiveDemo f={f} /></NoSteps>
        {d.shot && (
          <div className="l-stage-seen">
            <Img src={d.shot} alt={`${f.title} in ${d.shotFrom}`} fit="cover" height={72} />
            <span>Seen in a real page: <code>{d.shotFrom}</code>. Click to enlarge.</span>
          </div>
        )}
      </div>
    );
  if (d.kind === "shot")
    return (
      <div className="l-stage" data-kind="shot">
        <div className="l-stage-tag">Screenshot · {d.shotFrom}</div>
        <Img src={d.shot!} alt={`${f.title}: ${d.shotFrom}`} />
        {d.moreShots?.map((s) => <Img key={s} src={s} alt={`${f.title}, another view`} />)}
      </div>
    );
  return (
    <div className="l-stage" data-kind="none">
      <div className="l-stage-tag">{f.theme === "cli" ? "In the terminal" : "In the artifact"}</div>
      <Snippet f={f} />
    </div>
  );
}

/** Inline `code` spans from backticks. */
export function Ticks({ text }: { text: string }) {
  return <>{text.split("`").map((s, i) => (i % 2 ? <code key={i}>{s}</code> : s))}</>;
}

/** Renders kit components without registering their present steps (a Walkthrough in a card preview or a sheet must not join the slide's steps). */
export function NoSteps({ children, className, inert }: { children: React.ReactNode; className?: string; inert?: boolean }) {
  return <KitNoSteps><div className={className} inert={inert}>{children}</div></KitNoSteps>;
}
