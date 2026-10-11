// Backlog.md task files: YAML frontmatter + markdown body. A tiny reader for the frontmatter subset
// Backlog.md writes, and a line-preserving patcher: changing one field rewrites only that field's
// lines (plus `updated_date`, like Backlog.md itself), so git diffs stay as small as the CLI's.

export interface TaskFields {
  title: string;
  status: string;
  labels: string[];
  assignee: string[];
  /** Order inside a column (Backlog.md `ordinal`); undefined = after the ordered ones, by id. */
  ordinal?: number;
  /** Markdown after the frontmatter (Description, Plan, Notes, Comments sections). */
  body: string;
}

export const FIELDS = ['title', 'status', 'labels', 'assignee', 'ordinal', 'body'] as const;
export type FieldName = (typeof FIELDS)[number];

export interface ParsedTask extends TaskFields {
  /** Backlog.md id, e.g. "TASK-12" (from the `id:` line). */
  taskId: string;
}

export interface BoardConfig {
  name: string;
  statuses: string[];
  labels: string[];
  defaultStatus: string;
  /** Lowercase prefix of task ids and file names ("task"). */
  prefix: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split into frontmatter lines and body. No frontmatter = everything is body. */
export function splitFrontmatter(text: string): { lines: string[]; body: string } | null {
  const m = FM.exec(text);
  if (!m) return null;
  return { lines: m[1].split(/\r?\n/), body: text.slice(m[0].length) };
}

/** Line range [start, end) of `key` in frontmatter lines (the key line plus its indented continuation). */
function keyRange(lines: string[], key: string): [number, number] | undefined {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return;
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^\s*-\s/.test(lines[end]) && !/^\S+:/.test(lines[end]))) end++;
  return [start, end];
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
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
    return inner ? inner.split(',').map(unquote).filter(Boolean) : [];
  }
  if (!first && rest.some((l) => /^\s*-\s/.test(l))) return rest.filter((l) => /^\s*-\s/.test(l)).map((l) => unquote(l.replace(/^\s*-\s/, '')));
  // plain scalar, maybe continued on indented lines
  return [first, ...rest.map((l) => l.trim())].filter(Boolean).map(unquote).join(' ');
}

const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));

export function parseTask(text: string): ParsedTask | null {
  const fm = splitFrontmatter(text);
  if (!fm) return null;
  const id = str(readKey(fm.lines, 'id'));
  if (!id) return null;
  const ord = Number(str(readKey(fm.lines, 'ordinal')));
  return {
    taskId: id.toUpperCase(),
    title: str(readKey(fm.lines, 'title')),
    status: str(readKey(fm.lines, 'status')),
    labels: list(readKey(fm.lines, 'labels')),
    assignee: list(readKey(fm.lines, 'assignee')),
    ordinal: readKey(fm.lines, 'ordinal') !== undefined && Number.isFinite(ord) ? ord : undefined,
    body: fm.body,
  };
}

/** Quote a scalar the way js-yaml (Backlog.md's writer) does when it has to. */
export function yamlScalar(v: string): string {
  const plain =
    v.length > 0 &&
    v === v.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/: |:$| #|\n|\t/.test(v) &&
    !/^(true|false|yes|no|on|off|null|~|y|n)$/i.test(v) &&
    !/^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?$/.test(v) &&
    !/^\d{4}-\d\d-\d\d/.test(v);
  return plain ? v : `'${v.replace(/'/g, "''")}'`;
}

function yamlLines(key: string, v: string | string[] | number): string[] {
  if (typeof v === 'number') return [`${key}: ${v}`];
  if (Array.isArray(v)) return v.length ? [`${key}:`, ...v.map((x) => `  - ${yamlScalar(x)}`)] : [`${key}: []`];
  return [`${key}: ${yamlScalar(v)}`];
}

/** Backlog.md's timestamp format: 'YYYY-MM-DD HH:mm' (local time). */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Rewrite only the given fields of a task file. Untouched lines (other keys, their order, quoting,
 * comments in the body) stay byte for byte. `now` set = bump `updated_date` like Backlog.md does.
 */
export function patchTask(text: string, patch: Partial<TaskFields>, now?: Date): string {
  const fm = splitFrontmatter(text);
  if (!fm) throw new Error('not a task file (no frontmatter)');
  let lines = fm.lines.slice();
  const put = (key: string, v: string | string[] | number | undefined) => {
    const r = keyRange(lines, key);
    const next = v === undefined ? [] : yamlLines(key, v);
    if (r) lines = [...lines.slice(0, r[0]), ...next, ...lines.slice(r[1])];
    else lines = [...lines, ...next];
  };
  for (const k of FIELDS) {
    if (!(k in patch) || k === 'body') continue;
    const v = patch[k];
    if (k === 'ordinal') put(k, typeof v === 'number' ? v : undefined);
    else put(k, v as string | string[]);
  }
  if (now) put('updated_date', stamp(now));
  const body = patch.body !== undefined ? patch.body : fm.body;
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** File name Backlog.md would pick: "task-12 - Some-title.md". */
export function taskFileName(taskId: string, title: string): string {
  const slug = title
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${taskId.toLowerCase()} - ${slug || 'untitled'}.md`;
}

/** A fresh task file in Backlog.md's layout. */
export function newTaskFile(taskId: string, f: TaskFields, now: Date): string {
  const lines = [
    `id: ${taskId}`,
    ...yamlLines('title', f.title),
    ...yamlLines('status', f.status),
    ...yamlLines('assignee', f.assignee),
    `created_date: '${stamp(now)}'`,
    ...yamlLines('labels', f.labels),
    'dependencies: []',
    ...(f.ordinal !== undefined ? yamlLines('ordinal', f.ordinal) : []),
  ];
  const body = f.body || '\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n';
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Next free id: one past the highest number among `ids` (top-level numbers only: TASK-17.2 counts as 17). */
export function nextTaskId(ids: string[], prefix = 'task'): string {
  let max = 0;
  for (const id of ids) {
    const m = /-(\d+)/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix.toUpperCase()}-${max + 1}`;
}

/** backlog.config.yml (or backlog/config.yml). Only the keys the board needs. */
export function parseConfig(text: string): BoardConfig {
  const lines = text.split(/\r?\n/);
  const statuses = list(readKey(lines, 'statuses'));
  return {
    name: str(readKey(lines, 'project_name')) || 'Backlog',
    statuses: statuses.length ? statuses : ['To Do', 'In Progress', 'Done'],
    labels: list(readKey(lines, 'labels')),
    defaultStatus: str(readKey(lines, 'default_status')) || statuses[0] || 'To Do',
    prefix: (str(readKey(lines, 'task_prefix')) || 'task').toLowerCase(),
  };
}

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

export function hashFields(f: Partial<TaskFields>): Partial<Record<FieldName, string>> {
  const out: Partial<Record<FieldName, string>> = {};
  for (const k of FIELDS) if (k in f) out[k] = hashOf(f[k]);
  return out;
}
