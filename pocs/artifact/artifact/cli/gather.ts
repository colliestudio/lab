// Collectors: facts as JSON in <artifact>/data/, so a page reads real numbers and the agent writes only the verdicts.
// Read-only: `gh pr list`, `backlog task list --plain`, `git log`. Rerun and rebuild to refresh.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Run = (cmd: string, args: string[], cwd?: string) => string;
export const run: Run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });

export interface PrRow {
  repo: string; n: number; title: string; state: "open" | "draft" | "merged"; review?: string; checks?: "pass" | "fail" | "pending";
  conflict: boolean; base: string; head: string; updatedAt: string; href: string; author?: string;
}
const checksOf = (roll: { conclusion?: string; status?: string; state?: string }[] | undefined): PrRow["checks"] => {
  const cs = (roll ?? []).map((c) => (c.conclusion || c.state || c.status || "").toLowerCase());
  if (!cs.length) return undefined;
  if (cs.some((c) => ["failure", "error", "timed_out", "cancelled", "startup_failure"].includes(c))) return "fail";
  if (cs.some((c) => ["", "pending", "queued", "in_progress", "expected"].includes(c))) return "pending";
  return "pass";
};

/** Open PRs (and those merged since `since`, an ISO time) for each `owner/repo`. */
export function ghPrs(repos: string[], opts: { since?: string; limit?: number; exec?: Run } = {}): { prs: PrRow[]; merged: Record<string, number>; gatheredAt: string } {
  const exec = opts.exec ?? run;
  const prs: PrRow[] = [], merged: Record<string, number> = {};
  for (const repo of repos) {
    const open = JSON.parse(exec("gh", ["pr", "list", "-R", repo, "--state", "open", "--limit", String(opts.limit ?? 50), "--json", "number,title,isDraft,reviewDecision,baseRefName,headRefName,updatedAt,mergeable,url,statusCheckRollup,author"]) || "[]") as Record<string, any>[];
    for (const p of open) {
      prs.push({
        repo, n: p.number, title: p.title, state: p.isDraft ? "draft" : "open", review: p.reviewDecision ? String(p.reviewDecision).toLowerCase().replace("changes_requested", "changes") : undefined,
        checks: checksOf(p.statusCheckRollup), conflict: p.mergeable === "CONFLICTING", base: p.baseRefName, head: p.headRefName, updatedAt: p.updatedAt, href: p.url, author: p.author?.login,
      });
    }
    if (opts.since) {
      const m = JSON.parse(exec("gh", ["pr", "list", "-R", repo, "--state", "merged", "--limit", "100", "--search", `merged:>=${opts.since}`, "--json", "number"]) || "[]") as unknown[];
      merged[repo] = m.length;
    }
  }
  return { prs, merged, gatheredAt: new Date().toISOString() };
}

export interface BoardTask { id: string; title: string; priority: string | null; ac?: [number, number] }
/** Parse `backlog task list --plain` (grouped text: "To Do:", "  [HIGH] TASK-3 - title (ac: 1/2)"). */
export function parseBoard(text: string): { todo: BoardTask[]; doing: BoardTask[]; done: BoardTask[]; doneCount: number } {
  const b = { todo: [] as BoardTask[], doing: [] as BoardTask[], done: [] as BoardTask[], doneCount: 0 };
  let cur: "todo" | "doing" | "done" | null = null;
  for (const line of text.split("\n")) {
    if (/^To Do:/.test(line)) cur = "todo"; else if (/^In Progress:/.test(line)) cur = "doing"; else if (/^Done:/.test(line)) cur = "done";
    else {
      const m = line.match(/^\s+(?:\[(\w+)\] )?(TASK-[\d.]+) - (.*?)(?: \(ac: (\d+)\/(\d+)\))?$/i);
      if (m && cur) b[cur].push({ id: m[2].toLowerCase(), title: m[3], priority: m[1] ?? null, ...(m[4] ? { ac: [Number(m[4]), Number(m[5])] as [number, number] } : {}) });
    }
  }
  b.doneCount = b.done.length;
  b.done = b.done.slice(0, 10); // the tail of Done is history, not status
  return b;
}
/** Boards of Backlog.md workspaces (directories): `{ "<dir name>": {todo, doing, done, doneCount} }`. */
export function board(dirs: string[], exec: Run = run) {
  const out: Record<string, ReturnType<typeof parseBoard>> = {};
  for (const d of dirs) out[d.replace(/\/+$/, "").split("/").pop()!] = parseBoard(exec("backlog", ["task", "list", "--plain"], resolve(d)));
  return out;
}

export interface Commit { sha: string; at: string; author: string; subject: string }
/** Commits since a date. Bare clones: pass a ref with --ref origin/main (a bare repo's own `main` can be stale). */
export function gitLog(repo: string, opts: { since?: string; ref?: string; limit?: number; exec?: Run } = {}): { repo: string; ref: string; commits: Commit[] } {
  const exec = opts.exec ?? run;
  const ref = opts.ref ?? "HEAD";
  const args = ["-C", resolve(repo), "log", ref, `--max-count=${opts.limit ?? 100}`, "--format=%h%x1f%cI%x1f%an%x1f%s"];
  if (opts.since) args.push(`--since=${opts.since}`);
  const commits = exec("git", args).split("\n").filter(Boolean).map((l) => { const [sha, at, author, subject] = l.split("\x1f"); return { sha, at, author, subject }; });
  return { repo, ref, commits };
}

const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** `artifact gather <kind> <artifact-dir> [--repos a/b,c/d] [--since ISO|"24 hours ago"] [--workspaces dir,dir] [--repo path] [--ref r] [--name file]` */
export function gatherCmd(kind: string, dir: string, v: Record<string, string | boolean | undefined>): number {
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  let data: unknown;
  switch (kind) {
    case "gh-prs": {
      const repos = list(s("repos"));
      if (!repos.length) { console.error("gh-prs needs --repos owner/repo,owner/repo"); return 2; }
      data = ghPrs(repos, { since: s("since"), limit: s("limit") ? Number(s("limit")) : undefined });
      break;
    }
    case "board": {
      const ws = list(s("workspaces"));
      if (!ws.length) { console.error("board needs --workspaces dir,dir (workspaces with a Backlog.md board)"); return 2; }
      data = board(ws);
      break;
    }
    case "git-log": {
      if (!s("repo")) { console.error("git-log needs --repo path"); return 2; }
      data = gitLog(s("repo")!, { since: s("since"), ref: s("ref"), limit: s("limit") ? Number(s("limit")) : undefined });
      break;
    }
    default: console.error(`unknown collector ${kind} (gh-prs, board, git-log)`); return 2;
  }
  const out = join(resolve(dir), "data", `${s("name") ?? kind}.json`);
  mkdirSync(join(resolve(dir), "data"), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
  console.log(out);
  return 0;
}
