// Backlog.md task files: YAML frontmatter + markdown body. A reader for the subset Backlog.md writes and
// a patcher that rewrites only what changed, the way `backlog task edit` does (frontmatter keys in
// place, a section's inside between its markers), so a git diff of a board edit is as small as the CLI's.
// Format checked against backlog 1.53.0. Node- and browser-safe (no I/O).

export type SectionKey = 'description' | 'plan' | 'notes';
export const SECTION_KEYS: readonly SectionKey[] = ['description', 'plan', 'notes'];

export interface AcItem {
  text: string;
  done: boolean;
}
export interface CommentItem {
  author?: string;
  created?: string;
  text: string;
}

export interface TaskFields {
  title: string;
  status: string;
  labels: string[];
  assignee: string[];
  priority?: string;
  /** Order inside a column (Backlog.md `ordinal`); undefined = after the ordered ones, by id. */
  ordinal?: number;
  description: string;
  plan: string;
  notes: string;
  ac: AcItem[];
}

export interface ParsedTask extends TaskFields {
  /** Backlog.md id, e.g. "TASK-12" or "TASK-3.48" (from the `id:` line). */
  taskId: string;
  parent?: string;
  created?: string;
  updated?: string;
  comments: CommentItem[];
}

export interface BoardConfig {
  name: string;
  /** Statuses in column order; the last one is "Done". */
  statuses: string[];
  labels: string[];
  defaultStatus: string;
  /** Lowercase prefix of task ids and file names ("task"). */
  prefix: string;
  /** Folder of the backlog inside the project root (default "backlog"). */
  directory: string;
}

/** What a patch may change. `null` removes (priority, ordinal). */
export interface TaskPatch {
  title?: string;
  status?: string;
  labels?: string[];
  assignee?: string[];
  priority?: string | null;
  ordinal?: number | null;
  sections?: Partial<Record<SectionKey, string>>;
  /** The whole list; unchanged lines stay byte for byte. */
  ac?: AcItem[];
  /** Appended to the Comments section. */
  comment?: { author?: string; text: string };
}

export const FIELDS = ['title', 'status', 'labels', 'assignee', 'priority', 'ordinal', 'description', 'plan', 'notes', 'ac'] as const;
export type FieldName = (typeof FIELDS)[number];

// ------------------------------------------------------------ frontmatter

const FM = /^---(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/** Split into frontmatter lines and body. `eol` and `close` (the closing `---` line as written) let a patch keep the file's line endings byte for byte. */
export function splitFrontmatter(text: string): { lines: string[]; body: string; eol: string; close: string } | null {
  const m = FM.exec(text);
  if (!m) return null;
  return { lines: m[2].split(/\r?\n/), body: text.slice(m[0].length), eol: m[1], close: m[3] };
}

/** Line range [start, end) of `key` in frontmatter lines (the key line plus its indented continuation). */
function keyRange(lines: string[], key: string): [number, number] | undefined {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return;
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || (/^\s*-\s/.test(lines[end]) && !/^\S+:/.test(lines[end])))) end++;
  return [start, end];
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1).replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
    }
  }
  return s;
}

/** Split a flow list ("a, 'b, c', d") on commas outside quotes. */
function flowItems(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (const c of inner) {
    if (q) {
      cur += c;
      if (c === q) q = '';
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}

/** Raw YAML value of `key`: a string, a string list, or undefined when absent. */
export function readKey(lines: string[], key: string): string | string[] | undefined {
  const r = keyRange(lines, key);
  if (!r) return;
  const [start, end] = r;
  const first = lines[start].slice(lines[start].indexOf(':') + 1).trim();
  const rest = lines.slice(start + 1, end);
  if (/^[>|][-+]?$/.test(first)) {
    // block scalar: > folds lines with spaces, | keeps newlines
    const parts = rest.map((l) => l.trim());
    return first.startsWith('>') ? parts.join(' ').trim() : parts.join('\n');
  }
  if (first.startsWith('[')) {
    const inner = first.replace(/^\[/, '').replace(/\]$/, '').trim();
    return inner ? flowItems(inner) : [];
  }
  if (!first && rest.some((l) => /^\s*-\s/.test(l))) return rest.filter((l) => /^\s*-\s/.test(l)).map((l) => unquote(l.replace(/^\s*-\s/, '')));
  // plain scalar, maybe continued on indented lines
  return [first, ...rest.map((l) => l.trim())].filter(Boolean).map(unquote).join(' ');
}

const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));

// ------------------------------------------------------------ YAML scalars the way Backlog.md's writer prints them

const INDICATOR_FIRST = /^[-?:,[\]{}#&*!|>'"%@`]/;
const RESOLVES_AS_OTHER = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMBER = /^[-+]?(?:0|[1-9][\d_]*)(?:\.\d*)?(?:[eE][-+]?\d+)?$|^[-+]?\.\d+$|^0x[0-9a-f]+$|^0o?[0-7]+$|^[-+]?\.(?:inf|nan)$/i;
const TIMESTAMP = /^\d{4}-\d\d?-\d\d?(?:(?:[Tt]|\s+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:\s*(?:Z|[-+]\d\d?(?::\d\d)?))?)?$/;

/** Can `v` be written without quotes (js-yaml / YAML 1.2 plain scalar rules, as the CLI's output shows)? */
function plainOk(v: string): boolean {
  if (!v || v !== v.trim()) return false;
  if (INDICATOR_FIRST.test(v)) return false;
  if (/[,[\]{}]/.test(v) || /: |:$| #|\t/.test(v)) return false;
  if (RESOLVES_AS_OTHER.test(v) || NUMBER.test(v) || TIMESTAMP.test(v)) return false;
  return true;
}

const hasAstral = (v: string) => /[\u{10000}-\u{10FFFF}]/u.test(v);

function doubleQuoted(v: string): string {
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).toUpperCase().padStart(2, '0')}`;
    else if (c > 0xffff) out += `\\U${c.toString(16).toUpperCase().padStart(8, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

/** js-yaml's foldLine: break at spaces so no line is longer than `width` (a single long word stays whole). */
function foldLine(line: string, width: number): string {
  if (line === '' || line[0] === ' ') return line;
  const breakRe = / [^ ]/g;
  let start = 0;
  let curr = 0;
  let next = 0;
  let result = '';
  let m: RegExpExecArray | null;
  while ((m = breakRe.exec(line))) {
    next = m.index;
    if (next - start > width) {
      const end = curr > start ? curr : next;
      result += `\n${line.slice(start, end)}`;
      start = end + 1;
    }
    curr = next;
  }
  result += '\n';
  if (line.length - start > width && curr > start) result += `${line.slice(start, curr)}\n${line.slice(curr + 1)}`;
  else result += line.slice(start);
  return result.slice(1);
}

/** A value as YAML text lines (after `key:` or `- `): one line, or `>-` folded lines for a long string. `indent` = the continuation indent. */
function scalarLines(v: string, indent: number): { head: string; cont: string[] } {
  v = v.replace(/\r?\n/g, ' ');
  if (hasAstral(v)) return { head: doubleQuoted(v), cont: [] };
  if (v.length > 80 && v === v.trim() && !/\s{2}/.test(v)) {
    const pad = ' '.repeat(indent);
    const folded = foldLine(v, Math.max(80 - indent, 40)).split('\n');
    return { head: '>-', cont: folded.map((l) => pad + l) };
  }
  return { head: plainOk(v) ? v : `'${v.replace(/'/g, "''")}'`, cont: [] };
}

/** Quote a scalar the way Backlog.md's writer does (single line). */
export function yamlScalar(v: string): string {
  return scalarLines(v, 2).head;
}

function yamlLines(key: string, v: string | string[] | number): string[] {
  if (typeof v === 'number') return [`${key}: ${v}`];
  if (Array.isArray(v)) {
    if (!v.length) return [`${key}: []`];
    return [
      `${key}:`,
      ...v.flatMap((x) => {
        const s = scalarLines(x, 4);
        return [`  - ${s.head}`, ...s.cont];
      }),
    ];
  }
  const s = scalarLines(v, 2);
  return [`${key}: ${s.head}`, ...s.cont];
}

/** Backlog.md's timestamp format: 'YYYY-MM-DD HH:mm' in UTC. */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Epoch ms of a Backlog.md timestamp ('YYYY-MM-DD HH:mm' or a bare date, UTC); undefined if it is neither. */
export function stampTime(s: string | undefined): number | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(s ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) : undefined;
}

// ------------------------------------------------------------ body: sections between markers

interface SectionDef {
  key: 'description' | 'ac' | 'dod' | 'plan' | 'notes' | 'comments';
  title: string;
  mark: string;
  /** A blank line between the header and the BEGIN marker (the AC block has none). */
  gap: boolean;
}
/** Canonical order, as the CLI writes them. */
const DEFS: SectionDef[] = [
  { key: 'description', title: 'Description', mark: 'DESCRIPTION', gap: true },
  { key: 'ac', title: 'Acceptance Criteria', mark: 'AC', gap: false },
  { key: 'dod', title: 'Definition of Done', mark: 'DOD', gap: false },
  { key: 'plan', title: 'Implementation Plan', mark: 'PLAN', gap: true },
  { key: 'notes', title: 'Implementation Notes', mark: 'NOTES', gap: true },
  { key: 'comments', title: 'Comments', mark: 'COMMENTS', gap: true },
];
const def = (key: SectionDef['key']) => DEFS.find((d) => d.key === key)!;
const begin = (d: SectionDef) => (d.mark === 'AC' ? '<!-- AC:BEGIN -->' : d.mark === 'DOD' ? '<!-- DOD:BEGIN -->' : d.mark === 'COMMENTS' ? '<!-- COMMENTS:BEGIN -->' : `<!-- SECTION:${d.mark}:BEGIN -->`);
const endMark = (d: SectionDef) => begin(d).replace(':BEGIN', ':END');

interface Block {
  /** The whole block: header line through the END marker line (with its newline). */
  start: number;
  end: number;
  /** The inside: after the BEGIN marker line, before the END marker line. */
  inStart: number;
  inEnd: number;
  inner: string;
  /** An old-style section: a bare `## Title` heading with no markers. */
  legacy?: true;
}

/**
 * The marked blocks of a body, as the CLI reads them: scanning from the top, a BEGIN marker line opens the
 * block of its kind, which runs to the first END marker of that kind; marker lines inside a block are its text.
 */
function scanBlocks(b: string): Map<SectionDef['key'], { bi: number; ei: number }> {
  const found = new Map<SectionDef['key'], { bi: number; ei: number }>();
  const lineStart = (i: number) => i === 0 || b[i - 1] === '\n';
  let at = 0;
  while (at < b.length) {
    let next = -1;
    let hit: SectionDef | undefined;
    for (const d of DEFS) {
      if (found.has(d.key)) continue;
      for (let from = at; ; ) {
        const i = b.indexOf(begin(d), from);
        if (i < 0) break;
        if (lineStart(i) && (next < 0 || i < next)) {
          next = i;
          hit = d;
          break;
        }
        from = i + 1;
      }
    }
    if (!hit) break;
    const ei = b.indexOf(endMark(hit), next);
    if (ei < 0) {
      at = next + 1; // an unclosed marker: text
      continue;
    }
    found.set(hit.key, { bi: next, ei });
    at = ei + endMark(hit).length;
  }
  return found;
}

/** A section from before the markers: the heading and its text up to the next `## ` heading. */
function legacyBlock(b: string, d: SectionDef): Block | undefined {
  if (d.key === 'comments' || d.key === 'dod') return;
  // headings inside a marked block are that block's text (a quoted doc), not sections
  let masked = b;
  for (const { bi, ei } of scanBlocks(b).values()) masked = masked.slice(0, bi) + masked.slice(bi, ei).replace(/[^\n]/g, ' ') + masked.slice(ei);
  const m = new RegExp(`^## ${d.title}[ \\t]*$`, 'm').exec(masked);
  if (!m) return;
  const next = /^## /m.exec(masked.slice(m.index + m[0].length + 1));
  const end = next ? m.index + m[0].length + 1 + next.index : b.length;
  const inStart = Math.min(b.length, m.index + m[0].length + 1);
  return { start: m.index, end, inStart, inEnd: end, inner: b.slice(inStart, end).replace(/^\n+/, '').replace(/\s+$/, ''), legacy: true };
}

function findBlock(b: string, d: SectionDef): Block | undefined {
  const hit = scanBlocks(b).get(d.key);
  if (!hit) return legacyBlock(b, d);
  const { bi, ei } = hit;
  const em = endMark(d);
  const inStart = Math.min(b.length, b.indexOf('\n', bi) + 1 || b.length);
  const inEnd = ei;
  let end = ei + em.length;
  if (b[end] === '\n') end++;
  // the header line right above (optionally a blank line between)
  let start = bi;
  const head = `## ${d.title}\n`;
  const above = b.slice(0, bi);
  if (above.endsWith(`${head}\n`) && (above.length === head.length + 1 || above[above.length - head.length - 2] === '\n')) start = bi - head.length - 1;
  else if (above.endsWith(head) && (above.length === head.length || above[above.length - head.length - 1] === '\n')) start = bi - head.length;
  return { start, end, inStart, inEnd, inner: b.slice(inStart, inEnd).replace(/\n$/, '') };
}

const blockText = (d: SectionDef, inner: string) => `## ${d.title}\n${d.gap ? '\n' : ''}${begin(d)}\n${inner}${inner ? '\n' : ''}${endMark(d)}\n`;

/** Put a new block at its place among the existing ones (before the first later one), else at the end; a body with none gets it on top. */
function insertBlock(b: string, d: SectionDef, text: string): string {
  const order = DEFS.indexOf(d);
  const later = DEFS.slice(order + 1)
    .map((x) => findBlock(b, x))
    .filter((x): x is Block => !!x)
    .sort((x, y) => x.start - y.start)[0];
  if (later) return `${b.slice(0, later.start)}${text}\n${b.slice(later.start)}`;
  const any = DEFS.some((x) => findBlock(b, x));
  if (any) return `${b}${b.endsWith('\n') ? '' : '\n'}\n${text}`;
  const rest = b.replace(/^\n+/, '');
  return `\n${text}${rest.trim() ? `\n${rest}` : ''}`;
}

function removeBlock(b: string, blk: Block): string {
  if (b[blk.end] === '\n') return b.slice(0, blk.start) + b.slice(blk.end + 1);
  // the last block: the blank line before it goes
  const cut = blk.start > 0 && b[blk.start - 1] === '\n' && b[blk.start - 2] === '\n' ? blk.start - 1 : blk.start;
  return b.slice(0, cut) + b.slice(blk.end);
}

/** Put `inner` into the block: between its markers, or (an old-style section) as a marked block in its place. */
function fillBlock(b: string, blk: Block, d: SectionDef, inner: string): string {
  if (!blk.legacy) return b.slice(0, blk.inStart) + inner + '\n' + b.slice(blk.inEnd);
  return b.slice(0, blk.start) + blockText(d, inner) + (blk.end < b.length ? '\n' : '') + b.slice(blk.end);
}

const tidy = (s: string) => s.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');

const AC_LINE = /^- \[( |x|X)\] (?:#\d+ ?)?(.*)$/;
function parseAc(inner: string): AcItem[] {
  return inner
    .split('\n')
    .flatMap((l) => {
      const m = AC_LINE.exec(l.trimEnd());
      return m ? [{ done: m[1] !== ' ', text: m[2] }] : [];
    });
}
const acLine = (a: AcItem, i: number) => `- [${a.done ? 'x' : ' '}] #${i + 1} ${a.text}`;

function parseComments(inner: string): CommentItem[] {
  const out: CommentItem[] = [];
  const lines = inner.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!/^(author|created):/.test(lines[i])) {
      i++;
      continue;
    }
    const c: CommentItem = { text: '' };
    for (; i < lines.length && lines[i] !== '---'; i++) {
      const m = /^(author|created): ?(.*)$/.exec(lines[i]);
      if (m) c[m[1] as 'author' | 'created'] = m[2];
    }
    i++; // the --- that opens the text
    const body: string[] = [];
    for (; i < lines.length; i++) {
      // the closing --- is followed by the end or by the next entry's header
      if (lines[i] === '---') {
        let j = i + 1;
        while (j < lines.length && lines[j] === '') j++;
        if (j >= lines.length || /^(author|created):/.test(lines[j])) break;
      }
      body.push(lines[i]);
    }
    i++;
    c.text = body.join('\n');
    out.push(c);
  }
  return out;
}

/** Why a comment text can not be written (the CLI refuses it too): a standalone `---` line would end the entry. */
export function commentProblem(text: string): string | undefined {
  return /^---[ \t]*$/m.test(text.replace(/\r\n/g, '\n')) ? "a comment can not contain a line that is only '---' (it would end the entry); use '***' for a rule" : undefined;
}

/** Why a section, comment or similar text can not be written: a line that is one of the block markers would end or open a block. */
export function markerProblem(text: string): string | undefined {
  return /^<!-- (?:SECTION:[A-Z]+|AC|DOD|COMMENTS):(?:BEGIN|END) -->[ \t]*$/m.test(text.replace(/\r\n/g, '\n')) ? 'the text has a line that is one of the task file\'s block markers (<!-- …:BEGIN/END -->); it would break the file' : undefined;
}

export function parseSections(text: string): { sections: Record<SectionKey, string>; ac: AcItem[]; comments: CommentItem[] } {
  const body = (splitFrontmatter(text)?.body ?? text).replace(/\r\n/g, '\n');
  const inner = (k: SectionDef['key']) => findBlock(body, def(k))?.inner ?? '';
  return {
    sections: { description: tidy(inner('description')), plan: tidy(inner('plan')), notes: tidy(inner('notes')) },
    ac: parseAc(inner('ac')),
    comments: parseComments(inner('comments')),
  };
}

export function parseTask(text: string): ParsedTask | null {
  const fm = splitFrontmatter(text);
  if (!fm) return null;
  const id = str(readKey(fm.lines, 'id'));
  if (!id) return null;
  const ordRaw = readKey(fm.lines, 'ordinal');
  const ord = Number(str(ordRaw));
  const { sections, ac, comments } = parseSections(text);
  const parent = str(readKey(fm.lines, 'parent_task_id'));
  return {
    taskId: id.toUpperCase(),
    title: str(readKey(fm.lines, 'title')),
    status: str(readKey(fm.lines, 'status')),
    labels: list(readKey(fm.lines, 'labels')),
    assignee: list(readKey(fm.lines, 'assignee')),
    priority: str(readKey(fm.lines, 'priority')) || undefined,
    ordinal: ordRaw !== undefined && str(ordRaw) !== '' && Number.isFinite(ord) ? ord : undefined,
    parent: parent ? parent.toUpperCase() : undefined,
    created: str(readKey(fm.lines, 'created_date')) || undefined,
    updated: str(readKey(fm.lines, 'updated_date')) || undefined,
    description: sections.description,
    plan: sections.plan,
    notes: sections.notes,
    ac,
    comments,
  };
}

// ------------------------------------------------------------ patching

/** Where a new frontmatter key goes: before the first of `before` that exists, else after the last of `after`, else at the end. */
const PLACE: Record<string, { before?: string[]; after?: string[] }> = {
  updated_date: { after: ['created_date'] },
  priority: { before: ['ordinal'], after: ['dependencies', 'parent_task_id'] },
};

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Rewrite only the given fields of a task file. Untouched lines (other keys, their order, quoting,
 * unknown body content) stay byte for byte. Fields already equal to the file are skipped. `now` set
 * and something other than `ordinal` changed = bump `updated_date`, as `backlog task edit` does.
 */
export function patchTask(text: string, patch: TaskPatch, now?: Date): string {
  const fm = splitFrontmatter(text);
  if (!fm) throw new Error('not a task file (no frontmatter)');
  const cur = parseTask(text)!;
  const crlf = fm.eol === '\r\n';
  let lines = fm.lines.slice();
  let body = fm.body.replace(/\r\n/g, '\n');
  let changedMeta = false;
  let changedOrdinal = false;
  let changedBody = false;

  const put = (key: string, v: string | string[] | number | undefined) => putLines(key, v === undefined ? [] : yamlLines(key, v));
  const putLines = (key: string, next: string[]) => {
    const r = keyRange(lines, key);
    if (r) lines = [...lines.slice(0, r[0]), ...next, ...lines.slice(r[1])];
    else if (next.length) {
      const place = PLACE[key];
      const find = (ks: string[] | undefined, last: boolean) => {
        const hits = (ks ?? []).map((k) => keyRange(lines, k)).filter((x): x is [number, number] => !!x);
        return hits.length ? (last ? Math.max(...hits.map((h) => h[1])) : Math.min(...hits.map((h) => h[0]))) : -1;
      };
      let at = find(place?.before, false);
      if (at < 0) at = find(place?.after, true);
      if (at < 0) at = lines.length;
      lines = [...lines.slice(0, at), ...next, ...lines.slice(at)];
    }
  };

  if (patch.title !== undefined && patch.title !== cur.title) (put('title', patch.title), (changedMeta = true));
  if (patch.status !== undefined && patch.status !== cur.status) (put('status', patch.status), (changedMeta = true));
  if (patch.assignee && !sameJson(patch.assignee, cur.assignee)) (put('assignee', patch.assignee), (changedMeta = true));
  if (patch.labels && !sameJson(patch.labels, cur.labels)) (put('labels', patch.labels), (changedMeta = true));
  if (patch.priority !== undefined && (patch.priority ?? undefined) !== cur.priority) (put('priority', patch.priority ?? undefined), (changedMeta = true));
  if (patch.ordinal !== undefined && (patch.ordinal ?? undefined) !== cur.ordinal) (put('ordinal', patch.ordinal ?? undefined), (changedOrdinal = true));

  // an edit of the sections or the AC list marks every old-style section of the file, as the CLI does
  if (patch.ac || Object.values(patch.sections ?? {}).some((v) => v !== undefined)) {
    for (const d of DEFS) {
      const blk = findBlock(body, d);
      if (blk?.legacy && blk.inner) body = fillBlock(body, blk, d, blk.inner);
    }
  }

  for (const k of SECTION_KEYS) {
    const want = patch.sections?.[k];
    if (want === undefined || tidy(want) === cur[k]) continue;
    const bad = markerProblem(want);
    if (bad) throw new Error(bad);
    const d = def(k);
    const blk = findBlock(body, d);
    const v = tidy(want);
    if (!v) {
      if (blk) body = removeBlock(body, blk);
    } else if (blk) body = fillBlock(body, blk, d, v);
    else body = insertBlock(body, d, blockText(d, v));
    changedBody = true;
  }

  if (patch.ac && !sameJson(patch.ac.map(acLine), cur.ac.map(acLine))) {
    const d = def('ac');
    const blk = findBlock(body, d);
    const want = patch.ac.map(acLine);
    if (!want.length) {
      if (blk) body = removeBlock(body, blk);
    } else if (blk) {
      // item lines are matched to the wanted items by text and kept where they are (renumbered; unchanged ones
      // byte for byte); an edited text replaces its line, a missing one goes, other lines (notes) stay
      const old = blk.inner.split('\n');
      const oldTexts = old.flatMap((l) => (AC_LINE.test(l.trimEnd()) ? [parseAc(l)[0].text] : []));
      const out: string[] = [];
      let kw = 0;
      let seen = 0;
      let lastItem = -1;
      const emit = (idx: number, original?: string) => {
        out.push(original !== undefined && original.trimEnd() === want[idx] ? original : want[idx]);
        lastItem = out.length - 1;
      };
      for (const line of old) {
        if (!AC_LINE.test(line.trimEnd())) {
          out.push(line);
          continue;
        }
        const text = parseAc(line)[0].text;
        seen++;
        const rest = oldTexts.slice(seen);
        const at = patch.ac.findIndex((a, x) => x >= kw && a.text === text);
        if (at >= 0) {
          for (; kw < at; kw++) emit(kw);
          emit(kw++, line);
        } else if (kw < want.length && !rest.includes(patch.ac[kw].text)) emit(kw++);
      }
      for (; kw < want.length; kw++) {
        out.splice(lastItem < 0 ? out.length : lastItem + 1, 0, want[kw]);
        lastItem = lastItem < 0 ? out.length - 1 : lastItem + 1;
      }
      // like the CLI, lines that are not items end up after the items when an item was removed
      const final = want.length < oldTexts.length ? [...out.filter((l) => AC_LINE.test(l.trimEnd())), ...out.filter((l) => !AC_LINE.test(l.trimEnd()))] : out;
      body = fillBlock(body, blk, d, final.join('\n'));
    } else body = insertBlock(body, d, blockText(d, want.join('\n')));
    changedBody = true;
  }

  if (patch.comment && tidy(patch.comment.text)) {
    const bad = commentProblem(patch.comment.text) ?? markerProblem(patch.comment.text);
    if (bad) throw new Error(bad);
    const d = def('comments');
    const entry = `${patch.comment.author ? `author: ${patch.comment.author}\n` : ''}created: ${stamp(now ?? new Date())}\n---\n${tidy(patch.comment.text)}\n---`;
    const blk = findBlock(body, d);
    if (blk) body = body.slice(0, blk.inStart) + (blk.inner ? `${blk.inner}\n\n` : '') + entry + '\n' + body.slice(blk.inEnd);
    else body = insertBlock(body, d, blockText(d, entry));
    changedBody = true;
  }

  if (!changedMeta && !changedOrdinal && !changedBody) return text;
  if (now && (changedMeta || changedBody)) putLines('updated_date', [`updated_date: '${stamp(now)}'`]);
  const eol = fm.eol;
  const outBody = crlf ? body.replace(/\n/g, '\r\n') : body;
  return `---${eol}${lines.join(eol)}${fm.close}${outBody}`;
}

// ------------------------------------------------------------ names, ids, new files

/** File name Backlog.md would pick: "task-12 - Some-title.md". */
export function taskFileName(taskId: string, title: string): string {
  const slug = title
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[[\]{}'!@#$%^&(),;=+]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 150) // the CLI cuts nothing, and fails past the file system's limit
    .replace(/-$/, '');
  return `${taskId.toLowerCase()} - ${slug || 'untitled'}.md`;
}

/** A Backlog.md id: PREFIX-N, with .N subtask levels. Anything else never reaches a path. */
export const ID_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}(?:\.\d{1,9}){0,3}$/;

/**
 * Next free id: one past the highest top-level number among `ids`, or past the highest child of `parent`
 * (TASK-3 → TASK-3.4). Archived, completed and draft ids belong in `ids` so a number is never reused.
 */
export function nextTaskId(ids: string[], prefix = 'task', parent?: string): string {
  const P = prefix.toUpperCase();
  if (parent) {
    const base = parent.toUpperCase();
    let max = 0;
    for (const id of ids) {
      const u = id.toUpperCase();
      if (u.startsWith(`${base}.`)) {
        const n = Number(u.slice(base.length + 1).split('.')[0]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
    return `${base}.${max + 1}`;
  }
  let max = 0;
  for (const id of ids) {
    const m = /-(\d+)/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${P}-${max + 1}`;
}

export interface NewTask {
  title: string;
  status: string;
  labels?: string[];
  assignee?: string[];
  priority?: string;
  parent?: string;
  ordinal?: number;
  description?: string;
  plan?: string;
  notes?: string;
  ac?: AcItem[];
}

/** A fresh task file in the layout `backlog task create` writes. */
export function newTaskFile(taskId: string, f: NewTask, now: Date): string {
  const lines = [
    `id: ${taskId}`,
    ...yamlLines('title', f.title),
    ...yamlLines('status', f.status),
    ...yamlLines('assignee', f.assignee ?? []),
    `created_date: '${stamp(now)}'`,
    ...yamlLines('labels', f.labels ?? []),
    'dependencies: []',
    ...(f.parent ? [`parent_task_id: ${f.parent}`] : []),
    ...(f.priority ? yamlLines('priority', f.priority) : []),
    ...(f.ordinal !== undefined ? yamlLines('ordinal', f.ordinal) : []),
  ];
  let body = '\n\n';
  const put = (d: SectionDef, inner: string | undefined) => {
    const v = inner ? tidy(inner) : '';
    if (!v) return;
    body = body.trim() ? `${body}\n${blockText(d, v)}` : `\n${blockText(d, v)}`;
  };
  put(def('description'), f.description);
  put(def('ac'), (f.ac ?? []).map(acLine).join('\n'));
  put(def('plan'), f.plan);
  put(def('notes'), f.notes);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ------------------------------------------------------------ config

/** backlog.config.yml (or backlog/config.yml). Missing `statuses` = Backlog.md's defaults; present but empty or unreadable = an error. */
export function parseConfig(text: string): BoardConfig {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => /^[A-Za-z_]+:/.test(l))) throw new Error('the Backlog.md config has no settings (is it a backlog.config.yml?)');
  const raw = readKey(lines, 'statuses');
  if (raw !== undefined) {
    const s = list(raw);
    if (!s.length || s.some((x) => !x.trim())) throw new Error('the Backlog.md config lists no usable statuses');
  }
  const statuses = raw !== undefined ? list(raw) : ['To Do', 'In Progress', 'Done'];
  const dir = str(readKey(lines, 'backlog_directory')) || 'backlog';
  return {
    name: str(readKey(lines, 'project_name')) || 'Backlog',
    statuses,
    labels: list(readKey(lines, 'labels')),
    defaultStatus: str(readKey(lines, 'default_status')) || statuses[0],
    prefix: (str(readKey(lines, 'task_prefix')) || 'task').toLowerCase().replace(/[^a-z0-9]/g, '') || 'task',
    directory: dir,
  };
}

// ------------------------------------------------------------ hashes

/** Stable short hash (FNV-1a) of a JSON value: what "same as last sync" compares. */
export function hashOf(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function fieldsOfTask(t: TaskFields): Record<FieldName, unknown> {
  return { title: t.title, status: t.status, labels: t.labels, assignee: t.assignee, priority: t.priority, ordinal: t.ordinal, description: t.description, plan: t.plan, notes: t.notes, ac: t.ac };
}

export function hashFields(t: TaskFields): Partial<Record<FieldName, string>> {
  const f = fieldsOfTask(t);
  const out: Partial<Record<FieldName, string>> = {};
  for (const k of FIELDS) out[k] = hashOf(f[k]);
  return out;
}
