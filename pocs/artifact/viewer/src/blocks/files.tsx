import { useMemo, useState, type ReactNode } from "react";
import type { FileChange } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { AddDel, ChurnBar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { changeLetter, cx, plural } from "../util.ts";
import type { B } from "./simple.tsx";

interface Entry { path: string; file?: FileChange; note?: string }
interface Dir { name: string; path: string; dirs: Dir[]; files: Entry[] }

function buildTree(entries: Entry[]): Dir {
  const root: Dir = { name: "", path: "", dirs: [], files: [] };
  for (const e of entries) {
    const parts = e.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let nx = d.dirs.find((x) => x.name === p);
      if (!nx) { nx = { name: p, path: d.path ? `${d.path}/${p}` : p, dirs: [], files: [] }; d.dirs.push(nx); }
      d = nx;
    }
    d.files.push(e);
  }
  // compress chains of single-dir folders: a/b/c
  const squash = (d: Dir): Dir => {
    d.dirs = d.dirs.map(squash);
    if (d.name && d.files.length === 0 && d.dirs.length === 1) {
      const c = d.dirs[0];
      return { ...c, name: `${d.name}/${c.name}` };
    }
    return d;
  };
  const sort = (d: Dir) => { d.dirs.sort((a, b) => a.name.localeCompare(b.name)); d.files.sort((a, b) => a.path.localeCompare(b.path)); d.dirs.forEach(sort); };
  const r = squash(root);
  sort(r);
  return r;
}

export function FileTree({ entries, title }: { entries: Entry[]; title?: string }) {
  const { revealFile } = useViewer();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(entries), [entries]);
  const real = entries.filter((e) => e.file);
  const add = real.reduce((a, e) => a + e.file!.additions, 0);
  const del = real.reduce((a, e) => a + e.file!.deletions, 0);
  const mech = real.filter((e) => e.file!.mechanical).length;

  const renderDir = (d: Dir, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const sub of d.dirs) {
      const isClosed = closed.has(sub.path);
      out.push(
        <button key={"d" + sub.path} className="ft-row ft-dir" style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => setClosed((s) => { const n = new Set(s); n.has(sub.path) ? n.delete(sub.path) : n.add(sub.path); return n; })}>
          <Icon name={isClosed ? "chevron" : "chevronDown"} size={12} className="ft-chev" />
          <Icon name="folder" size={14} className="ft-icon" />
          <span className="ft-name">{sub.name}</span>
        </button>,
      );
      if (!isClosed) out.push(...renderDir(sub, depth + 1));
    }
    for (const e of d.files) {
      const f = e.file;
      const letter = f ? changeLetter(f) : "P";
      const name = e.path.split("/").pop();
      out.push(
        <button key={"f" + e.path} className={cx("ft-row ft-file", f?.mechanical && "mech", !f && "planned")}
          style={{ paddingLeft: 12 + depth * 16 + 20 }} disabled={!f} onClick={() => f && revealFile(e.path)}
          title={f ? `Jump to diff: ${e.path}` : e.path}>
          <span className={cx("fletter", `fl-${letter}`)}>{letter}</span>
          <span className="ft-name">{name}</span>
          {f?.oldPath && f.oldPath !== f.path && <span className="ft-from">← {f.oldPath.split("/").pop()}</span>}
          {f?.mechanical && <span className="tag">mechanical</span>}
          {e.note && <span className="ft-note">{e.note}</span>}
          {f && <span className="ft-stats"><AddDel add={f.additions} del={f.deletions} /><ChurnBar add={f.additions} del={f.deletions} /></span>}
        </button>,
      );
    }
    return out;
  };

  return (
    <div className="filetree">
      <div className="ft-summary">
        {title && <b>{title}</b>}
        <span>{plural(entries.length, "file")}</span>
        {real.length > 0 && <AddDel add={add} del={del} />}
        {mech > 0 && <span className="muted">{mech} mechanical</span>}
      </div>
      <div className="ft-body">{renderDir(tree, 0)}</div>
    </div>
  );
}

export function FilesBlock({ block }: { block: B<"files"> }) {
  const { doc } = useViewer();
  const entries = useMemo(() => {
    // {path: note} form lists exactly those files; an empty block lists every changed file.
    const noted = Object.keys(block.notes ?? {});
    const paths = block.paths ?? (noted.length ? noted : doc.files.map((f) => f.path));
    return paths.map((p) => ({ path: p, file: doc.files.find((f) => f.path === p), note: block.notes?.[p] }));
  }, [block, doc.files]);
  return <FileTree entries={entries} />;
}
