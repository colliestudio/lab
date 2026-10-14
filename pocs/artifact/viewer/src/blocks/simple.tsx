import { Fragment, useMemo, useState } from "react";
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
  if (compact) return <QuestionRows questions={questions} />;
  return (
    <div className="questions">
      {questions.map((q, i) => (
        <div key={i} className="question">
          <div className="q-text"><span className="q-num">{i + 1}</span><Markdown md={q.q} inline /></div>
          <QuestionDetail q={q} />
        </div>
      ))}
    </div>
  );
}

function QuestionDetail({ q }: { q: Question }) {
  return (
    <>
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
    </>
  );
}

/** The headline's ask: one row per decision (question → recommendation); click a row for the options and why. */
function QuestionRows({ questions }: { questions: Question[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <div className="qrows">
      {questions.map((q, i) => {
        const on = open.has(i);
        const has = !!(q.options?.length || q.why);
        return (
          <div key={i} className={cx("qrow", on && "open")}>
            <button className="qrow-head" disabled={!has} aria-expanded={on}
              onClick={() => setOpen((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })}>
              <span className="q-num">{i + 1}</span>
              <span className="qrow-q"><Markdown md={q.q} inline /></span>
              {q.recommend && <span className="qrow-rec" title="Recommended"><Icon name="check" size={12} /><span>{q.recommend}</span></span>}
              {has && <Icon name={on ? "chevronDown" : "chevron"} size={14} className="qrow-chev" />}
            </button>
            {on && <div className="qrow-body"><QuestionDetail q={q} /></div>}
          </div>
        );
      })}
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
                  <td className="f-mark">{{ added: "+", removed: "−", changed: "~", unchanged: "", planned: "◇", deferred: "…" }[f.change]}</td>
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
  if (block.omitted) return <OmittedCode block={block} />;
  return <CodeBody block={block} />;
}

function OmittedCode({ block }: { block: B<"code"> }) {
  const { doc } = useViewer();
  const url = block.file ? doc.files.find((f) => f.path === block.file)?.url : undefined;
  return (
    <figure className="codeblock">
      <figcaption className="code-head">
        <Icon name="file" size={13} /><span className="code-file">{block.file ?? "code"}</span><span className="tag">not included</span>
      </figcaption>
      <div className="diff-empty omitted">
        {block.range ? <>Lines {block.range[0]}–{block.range[1]}: code</> : "Code"} not included in this file.
        {url && <> <a href={url} target="_blank" rel="noreferrer">View on GitHub <Icon name="ext" size={11} /></a></>}
        {!!block.notes?.length && (
          <ul className="omitted-notes">
            {[...block.notes].sort((a, b) => a.line - b.line).map((n, i) => <li key={i}><span className="muted">L{n.line}</span> <Markdown md={n.note} inline /></li>)}
          </ul>
        )}
      </div>
    </figure>
  );
}

function CodeBody({ block }: { block: B<"code"> }) {
  const lang = block.lang ?? langOf(block.file);
  const start = block.start ?? 1;
  const lines = useMemo(() => highlightLines(block.code.replace(/\n$/, "").split("\n"), lang), [block.code, lang]);
  // Notes numbered in line order, rendered under their line like diff notes.
  const notes = useMemo(() => {
    const m = new Map<number, { n: number; note: string }[]>();
    [...(block.notes ?? [])].sort((a, b) => a.line - b.line).forEach((x, i) => m.set(x.line, [...(m.get(x.line) ?? []), { n: i + 1, note: x.note }]));
    return m;
  }, [block.notes]);
  return (
    <figure className="codeblock">
      {(block.file || lang) && (
        <figcaption className="code-head">
          <Icon name="file" size={13} />
          <span className="code-file">{block.file ?? ""}</span>
          {start > 1 && <span className="code-lang">from line {start}</span>}
          {notes.size > 0 && <span className="tag note-count"><Icon name="comment" size={11} /> {block.notes!.length}</span>}
          {lang && <span className="code-lang">{lang}</span>}
        </figcaption>
      )}
      <div className="code-body">
        <table className="code-table">
          <tbody>
            {lines.map((l, i) => {
              const no = start + i;
              const ns = notes.get(no);
              return (
                <Fragment key={i}>
                  <tr className={cx(ns && "has-note")}>
                    <td className="ln">{no}</td>
                    <td className="code-line hljs">
                      <span dangerouslySetInnerHTML={{ __html: l || " " }} />
                      {ns && <span className="note-marker">{ns[0].n}</span>}
                    </td>
                  </tr>
                  {ns?.map((x) => (
                    <tr key={`n${x.n}`} className="dnote">
                      <td className="ln" />
                      <td><div className="dnote-box"><span className="note-marker">{x.n}</span><Markdown md={x.note} inline /></div></td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
