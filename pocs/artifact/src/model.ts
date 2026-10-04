// The JSON model: contract between parser (src/parse), viewer (viewer/) and server (src/server).
// Source format and semantics: SPEC.md.

export const FORMAT = "collie-doc/0";

export type Kind = "review" | "plan";
export type Level = 0 | 1 | 2 | 3;
export type Change = "added" | "changed" | "removed" | "unchanged" | "planned" | "deferred"; // deferred: plan work explicitly left for later
export type NodeKind =
  | "service" | "module" | "ui" | "db" | "api" | "queue" | "job" | "external" | "config" | "doc";

export interface Doc {
  format: typeof FORMAT;
  kind: Kind;
  title: string;
  tldr: string;              // frontmatter tldr; falls back to goal when absent
  goal?: string;             // frontmatter goal (plans), kept as written
  status?: string;
  risk?: { level: "low" | "medium" | "high"; why?: string };
  ask?: string;
  meta: {
    repo?: string; base?: string; head?: string; pr?: string;
    plan?: string; author?: string; date?: string;
  };
  stats?: { files: number; additions: number; deletions: number };
  map: DocMap;
  overview: string;          // markdown under the map (level 1), all overview text joined
  overviewBlocks: Block[];   // everything between the map and the first section, in source order (markdown blocks included)
  sections: Section[];       // level 2+
  files: FileChange[];       // from changes.patch; [] when absent
  questions: Question[];     // collected from all `questions` blocks (shown at level 0)
  planLink?: PlanLink;       // review with `plan:` resolved (parser fills it when the plan is a local path)
  warnings: string[];        // non-fatal parse issues
}

export interface DocMap {
  groups: { id: string; label: string }[];
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface MapNode {
  id: string;
  label: string;
  kind?: NodeKind;
  change: Change;
  group?: string;
  section?: string;          // Section.id this node opens
  mechanical?: boolean;
  note?: string;
  files?: string[];          // globs
}

export interface MapEdge { from: string; to: string; label?: string; change?: Change }

export interface Section {
  id: string;
  title: string;
  summary: string;           // first paragraph, markdown
  mechanical: boolean;
  blocks: Block[];           // in source order, summary paragraph excluded
}

interface BlockBase { id: string; level: Level }

export type Block =
  | (BlockBase & { type: "markdown"; md: string })
  | (BlockBase & { type: "callout"; tone: "info" | "warn" | "risk" | "decision"; md: string })
  | (BlockBase & { type: "flow"; mermaid: string; caption?: string })
  | (BlockBase & { type: "demo"; src: string; steps?: number[]; caption?: string })
  | (BlockBase & { type: "before-after"; before: Shot; after: Shot; caption?: string })
  | (BlockBase & { type: "data-model"; entities: Entity[] })
  | (BlockBase & { type: "api"; endpoints: Endpoint[] })
  | (BlockBase & { type: "steps"; steps: Step[] })
  | (BlockBase & { type: "questions"; questions: Question[] })
  | (BlockBase & { type: "checklist"; items: string[] })
  | (BlockBase & { type: "files"; notes: Record<string, string>; paths?: string[] }) // paths: subset; default all doc.files
  | (BlockBase & { type: "diff"; file: string; hunks: Hunk[]; notes: DiffNote[]; change: Change })
  | (BlockBase & { type: "code"; lang?: string; file?: string; code: string; start?: number; notes?: DiffNote[] }); // start: number of the first line

export interface Shot {
  src?: string;              // bundle path of an image
  demo?: string;             // or a replay + step: viewer renders that frame
  step?: number;
  caption?: string;
}

export interface Entity {
  name: string; change: Change; note?: string;
  fields: { name: string; type?: string; change: Change; note?: string }[];
}

export interface Endpoint {
  method: string; path: string; change: Change; summary?: string;
  request?: string; response?: string;   // short JSON/TS snippets
}

export interface Step { title: string; detail?: string; status?: "todo" | "doing" | "done"; area?: string }

export interface Question { q: string; options?: string[]; recommend?: string; why?: string }

export interface FileChange {
  path: string;
  oldPath?: string;          // renames
  change: Change;            // added | changed | removed
  additions: number;
  deletions: number;
  binary: boolean;
  mechanical: boolean;       // lockfiles, generated, pure renames, formatting-only (heuristics)
  hunks: Hunk[];
}

export interface Hunk {
  header: string;            // "@@ -10,7 +10,9 @@ fn name"
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  lines: { t: " " | "+" | "-"; s: string; old?: number; new?: number }[];
}

export interface DiffNote { line: number; note: string }   // line = new-side line number (code blocks: file line number)

export interface PlanLink {
  src: string;
  title: string;
  // map node ids of the plan, matched to review nodes by id
  done: string[];            // in plan and changed in review
  notDone: string[];         // in plan (planned/changed) but unchanged/missing in review
  deferred: string[];        // deferred in the plan (or in the review) and not changed in the review
  unplanned: string[];       // changed in review, absent from plan
}

export interface Comment {
  id: string;
  anchor: { section?: string; block?: string; file?: string; line?: number };
  author: string;
  body: string;
  created: string;
  resolved?: boolean;
}

// What the viewer boots from: window.__RECAP__
export interface ViewerBoot {
  doc: Doc;
  files?: Record<string, string>;  // bundle path → base64 (single-file mode)
  api?: string;                    // API base, e.g. "/api" (serve) or "/d/<id>/api" (server); absent = read-only
}
// API under `${api}`: GET doc, GET files/<path>, GET comments, POST comments (Comment without id/created)
