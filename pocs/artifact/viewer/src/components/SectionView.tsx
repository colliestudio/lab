import { useEffect, useMemo, useState } from "react";
import type { Doc, Level, Section } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { BlockView } from "../blocks/index.tsx";
import { FileDiff } from "../blocks/diff.tsx";
import { FileTree } from "../blocks/files.tsx";
import { Markdown } from "./Markdown.tsx";
import { Commentable } from "./Comments.tsx";
import { ChangeBadge } from "./bits.tsx";
import { Icon } from "./icons.tsx";
import { renderMarkdown } from "../../../src/md.ts";
import { cx, fileSections, nodeForSection, plural, sectionDomId } from "../util.ts";

/** Files already shown by an explicit `diff` block (or a `code` block naming the file) somewhere. */
export function explicitDiffFiles(doc: Doc) {
  return new Set(doc.sections.flatMap((s) => s.blocks).flatMap((b) => (b.type === "diff" || (b.type === "code" && b.file) ? [b.file!] : [])));
}

/** Files attached to this section through its map node's globs, minus ones with explicit diff blocks. */
export function autoFiles(doc: Doc, sectionId: string) {
  const fs = fileSections(doc);
  const explicit = explicitDiffFiles(doc);
  return doc.files.filter((f) => fs.get(f.path) === sectionId && !explicit.has(f.path));
}

export function SectionView({ section, level, focused }: { section: Section; level: Level; focused?: boolean }) {
  const { doc, setFocus, focus, setLevel, copy } = useViewer();
  const node = nodeForSection(doc, section.id);
  const [open, setOpen] = useState(!section.mechanical || !!focused);
  const blocks = section.blocks.filter((b) => b.level <= level);
  const hidden = section.blocks.length - blocks.length;
  // --code none: level 4 is the file list only (no per-file diffs to open)
  const extra = useMemo(() => (level >= 4 && doc.codeLevel !== "none" ? autoFiles(doc, section.id) : []), [doc, section.id, level]);
  const sectionFiles = useMemo(() => {
    const fs = fileSections(doc);
    return doc.files.filter((f) => fs.get(f.path) === section.id);
  }, [doc, section.id]);

  // A file-tree click anywhere can target a diff inside a collapsed mechanical section.
  useEffect(() => {
    if (open) return;
    const mine = new Set([...sectionFiles.map((f) => f.path), ...section.blocks.flatMap((b) => (b.type === "diff" ? [b.file] : []))]);
    const on = (e: Event) => { if (mine.has((e as CustomEvent).detail)) setOpen(true); };
    window.addEventListener("recap:reveal", on);
    return () => window.removeEventListener("recap:reveal", on);
  }, [open, sectionFiles, section.blocks]);

  return (
    <section className={cx("section", section.mechanical && "mechanical", !open && "closed", focused && "focused")}
      id={sectionDomId(section.id)} data-section={section.id}>
      <Commentable anchor={{ section: section.id }} className="sec-headwrap">
        <div className="sec-head">
          {node ? <span className={cx("sec-icon", `ch-${node.change}`)}><Icon name={node.kind ?? "module"} size={15} /></span> : null}
          <h2 className="sec-title">
            {section.mechanical && !focused ? (
              <button className="linklike" onClick={() => setOpen(!open)}>
                <Icon name={open ? "chevronDown" : "chevron"} size={14} /> {section.title}
              </button>
            ) : section.title}
          </h2>
          {node && <ChangeBadge change={node.change} />}
          {section.mechanical && <span className="tag">mechanical</span>}
          <span className="sec-spacer" />
          {sectionFiles.length > 0 && <span className="sec-meta muted">{plural(sectionFiles.length, "file")}</span>}
          <button className="btn small ghost sec-copy" onClick={() => copy(renderMarkdown(doc, { section: section.id }), "Section")}
            title="Copy this section as Markdown" aria-label={`Copy ${section.title} as Markdown`}>
            <Icon name="copy" size={13} />
          </button>
          {!focused && focus !== section.id && (
            <button className="btn small ghost sec-focus" onClick={() => setFocus(section.id)} title="Focus this area">
              <Icon name="target" size={13} /> Focus
            </button>
          )}
        </div>
        {section.summary && <Markdown md={section.summary} className="sec-summary prose" />}
      </Commentable>

      {open && (
        <div className="sec-body">
          {blocks.map((b) => (
            <Commentable key={b.id} anchor={{ section: section.id, block: b.id }}
              className={cx("blk", `blk-${b.type}`, b.level >= 4 && "l4")}>
              <BlockView block={b} />
            </Commentable>
          ))}
          {extra.length > 0 && (
            <div className="blk l4 auto-files">
              <div className="blk-label">Files in this area</div>
              <FileTree entries={extra.map((f) => ({ path: f.path, file: f }))} />
              {extra.map((f) => <FileDiff key={f.path} file={f} defaultOpen={!f.mechanical && extra.length <= 4} />)}
            </div>
          )}
          {hidden > 0 && level < 4 && (
            <button className="sec-more" onClick={() => setLevel(4)}>
              <Icon name="plus" size={12} /> {plural(hidden, "code block")} · zoom to Code <span className="kbd">4</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
