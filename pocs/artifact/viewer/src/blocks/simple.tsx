import { useMemo, useState } from "react";
import type { Block, Question } from "../../../src/model.ts";
import { Markdown } from "../components/Markdown.tsx";
import { ChangeBadge } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { highlightLines } from "../highlight.ts";
import { useViewer } from "../ctx.tsx";
import { cx, langOf } from "../util.ts";

export type B<T extends Block["type"]> = Extract<Block, { type: T }>;

export function MarkdownBlock({ block }: { block: B<"markdown"> }) {
  return <Markdown md={block.md} className="prose" />;
}

const TONE = {
  info: { icon: "info", label: "Note" },
  warn: { icon: "alert", label: "Warning" },
  risk: { icon: "flag", label: "Risk" },
  decision: { icon: "diamond", label: "Decision" },
} as const;

export function CalloutBlock({ block }: { block: B<"callout"> }) {
  const t = TONE[block.tone] ?? TONE.info;
  return (
    <div className={cx("callout", `tone-${block.tone}`)}>
      <div className="callout-head"><Icon name={t.icon} size={15} /> {t.label}</div>
      <Markdown md={block.md} className="prose" />
    </div>
  );
}

export function StepsBlock({ block }: { block: B<"steps"> }) {
  const { doc, setFocus } = useViewer();
  return (
    <ol className="steps">
      {block.steps.map((s, i) => {
        const st = s.status ?? "todo";
        const area = s.area && doc.sections.find((x) => x.id === s.area);
        return (
          <li key={i} className={cx("step", `st-${st}`)}>
            <span className="step-mark" title={st}>
              {st === "done" ? <Icon name="check" size={13} /> : st === "doing" ? <Icon name="half" size={13} /> : i + 1}
            </span>
            <div className="step-body">
              <div className="step-title">
                {s.title}
                {area && (
                  <button className="tag link" onClick={() => setFocus(area.id)}>{area.title}</button>
                )}
                {!area && s.area && <span className="tag">{s.area}</span>}
              </div>
              {s.detail && <Markdown md={s.detail} className="step-detail" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function QuestionList({ questions, compact }: { questions: Question[]; compact?: boolean }) {
  return (
    <div className={cx("questions", compact && "compact")}>
      {questions.map((q, i) => (
        <div key={i} className="question">
          <div className="q-text"><span className="q-num">{i + 1}</span><Markdown md={q.q} inline /></div>
          {q.options && q.options.length > 0 && (
            <div className="q-options">
              {q.options.map((o) => (
                <span key={o} className={cx("q-opt", o === q.recommend && "rec")}>
                  {o === q.recommend && <Icon name="check" size={12} />}
                  {o}
                </span>
              ))}
            </div>
          )}
          {(q.recommend && !q.options?.includes(q.recommend)) && (
            <div className="q-rec"><b>Recommend:</b> {q.recommend}</div>
          )}
          {q.why && <div className="q-why"><Markdown md={q.why} inline /></div>}
        </div>
      ))}
    </div>
  );
}

export function QuestionsBlock({ block }: { block: B<"questions"> }) {
  return <QuestionList questions={block.questions} />;
}

export function ChecklistBlock({ block }: { block: B<"checklist"> }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  return (
    <ul className="checklist">
      {block.items.map((it, i) => (
        <li key={i}>
          <label className={cx(done.has(i) && "done")}>
            <input type="checkbox" checked={done.has(i)} onChange={() => {
              const n = new Set(done); n.has(i) ? n.delete(i) : n.add(i); setDone(n);
            }} />
            <Markdown md={it} inline />
          </label>
        </li>
      ))}
    </ul>
  );
}

export function DataModelBlock({ block }: { block: B<"data-model"> }) {
  return (
    <div className="entities">
      {block.entities.map((e) => (
        <div key={e.name} className={cx("entity", `ch-${e.change}`)}>
          <div className="entity-head">
            <Icon name="db" size={14} />
            <span className="entity-name">{e.name}</span>
            <ChangeBadge change={e.change} />
          </div>
          {e.note && <div className="entity-note">{e.note}</div>}
          <table className="fields">
            <tbody>
              {e.fields.map((f) => (
                <tr key={f.name} className={`fch-${f.change}`}>
                  <td className="f-mark">{{ added: "+", removed: "−", changed: "~", unchanged: "", planned: "◇" }[f.change]}</td>
                  <td className="f-name">{f.name}</td>
                  <td className="f-type">{f.type}</td>
                  <td className="f-note">{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export function ApiBlock({ block }: { block: B<"api"> }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <div className="endpoints">
      {block.endpoints.map((ep, i) => {
        const has = !!(ep.request || ep.response);
        const isOpen = open.has(i);
        return (
          <div key={i} className={cx("endpoint", isOpen && "open", `ch-${ep.change}`)}>
            <button className="ep-row" disabled={!has} onClick={() => {
              const n = new Set(open); n.has(i) ? n.delete(i) : n.add(i); setOpen(n);
            }}>
              <span className={cx("method", `m-${ep.method.toLowerCase()}`)}>{ep.method.toUpperCase()}</span>
              <code className="ep-path">{ep.path}</code>
              <span className="ep-summary">{ep.summary}</span>
              <ChangeBadge change={ep.change} />
              {has && <Icon name={isOpen ? "chevronDown" : "chevron"} size={14} className="ep-chev" />}
            </button>
            {isOpen && (
              <div className="ep-body">
                {ep.request && <Snippet title="Request" code={ep.request} />}
                {ep.response && <Snippet title="Response" code={ep.response} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  const lang = /^\s*[{[]/.test(code) ? "json" : "typescript";
  const html = useMemo(() => highlightLines(code.replace(/\n$/, "").split("\n"), lang).join("\n"), [code, lang]);
  return (
    <div className="snippet">
      <div className="snippet-title">{title}</div>
      <pre className="code-pre"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

export function CodeBlock({ block }: { block: B<"code"> }) {
  const lang = block.lang ?? langOf(block.file);
  const lines = useMemo(() => highlightLines(block.code.replace(/\n$/, "").split("\n"), lang), [block.code, lang]);
  return (
    <figure className="codeblock">
      {(block.file || lang) && (
        <figcaption className="code-head">
          <Icon name="file" size={13} />
          <span className="code-file">{block.file ?? ""}</span>
          {lang && <span className="code-lang">{lang}</span>}
        </figcaption>
      )}
      <div className="code-body">
        <table className="code-table">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="ln">{i + 1}</td>
                <td className="code-line hljs" dangerouslySetInnerHTML={{ __html: l || " " }} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
