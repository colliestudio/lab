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

export interface BranchRow { branch: string; ahead: number; at: string; subject: string }
/** Unique commits per branch vs a base: `branches` is a ref glob (`idea/*`), the count is `base..branch`. */
export function gitBranches(repo: string, glob: string, base: string, exec: Run = run): { repo: string; base: string; branches: BranchRow[] } {
  const r = resolve(repo);
  const refs = exec("git", ["-C", r, "for-each-ref", "--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(contents:subject)", `refs/heads/${glob}`, `refs/remotes/origin/${glob}`]).split("\n").filter(Boolean);
  const seen = new Set<string>(), branches: BranchRow[] = [];
  for (const l of refs) {
    const [name, at, subject] = l.split("\x1f");
    const branch = name.replace(/^origin\//, "");
    if (seen.has(branch)) continue;
    seen.add(branch);
    const n = Number(exec("git", ["-C", r, "rev-list", "--count", `${base}..${name}`]).trim());
    branches.push({ branch, ahead: n, at, subject });
  }
  return { repo, base, branches: branches.sort((a, b) => b.at.localeCompare(a.at)) };
}

export interface PrData {
  repo: string; n: number; title: string; body: string; author?: string; viewer?: string; viewerIsAuthor: boolean; state: string; draft: boolean; base: string; head: string; href: string; url: string;
  /** commit SHAs the links point at: the PR head and the base it was compared with */
  headSha?: string; baseSha?: string; changedFiles: number; commitCount: number; checks?: ChecksSummary;
  additions: number; deletions: number; files: { path: string; additions: number; deletions: number }[]; commits: { sha: string; oid: string; subject: string }[];
  /** inline review comments already on the PR (so a review can mark repeats) */
  comments: { id: string; author?: string; path: string; line?: number; body: string; at?: string; replyTo?: string; url?: string }[];
  reviews: { author?: string; state: string; body: string }[]; gatheredAt: string;
}
export interface ChecksSummary { state: "pass" | "fail" | "pending" | "none"; passed: number; failed: number; pending: number; total: number; failing: string[] }
/** Fold gh's statusCheckRollup (check runs and commit statuses) into one state and counts. */
export function summarizeChecks(rollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] | undefined): ChecksSummary {
  const out: ChecksSummary = { state: "none", passed: 0, failed: 0, pending: 0, total: 0, failing: [] };
  for (const c of rollup ?? []) {
    const v = String(c.conclusion || c.state || c.status || "").toUpperCase();
    out.total++;
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) out.passed++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) { out.failed++; out.failing.push(c.name ?? c.context ?? "check"); }
    else out.pending++;
  }
  out.state = !out.total ? "none" : out.failed ? "fail" : out.pending ? "pending" : "pass";
  return out;
}
/** `owner/repo#12` or a PR URL. */
export function parsePrRef(ref: string): { repo: string; n: number } {
  const m = ref.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) ?? ref.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a PR reference: ${ref} (use owner/repo#12 or the PR URL)`);
  return { repo: m[1], n: Number(m[2]) };
}
/** A PR in one step (read-only gh calls): metadata, files, commits, existing review comments, and the unified patch. */
export function ghPr(ref: string, exec: Run = run): { data: PrData; patch: string } {
  const { repo, n } = parsePrRef(ref);
  const v = JSON.parse(exec("gh", ["pr", "view", String(n), "-R", repo, "--json", "title,body,author,state,baseRefName,headRefName,url,isDraft,headRefOid,baseRefOid,changedFiles,statusCheckRollup,additions,deletions,files,commits,reviews"]));
  const raw = JSON.parse(exec("gh", ["api", `repos/${repo}/pulls/${n}/comments`, "--paginate"]) || "[]") as { id: number; user?: { login: string }; path: string; line?: number; original_line?: number; body: string; created_at?: string; in_reply_to_id?: number; html_url?: string }[];
  let viewer: string | undefined;
  try { viewer = exec("gh", ["api", "user", "--jq", ".login"]).trim() || undefined; } catch { /* not logged in as a user */ }
  const patch = exec("gh", ["pr", "diff", String(n), "-R", repo]);
  const data: PrData = {
    repo, n, title: v.title, body: v.body ?? "", author: v.author?.login, viewer, viewerIsAuthor: !!viewer && viewer === v.author?.login, state: String(v.state).toLowerCase(), draft: !!v.isDraft,
    base: v.baseRefName, head: v.headRefName, href: v.url, url: v.url, headSha: v.headRefOid, baseSha: v.baseRefOid, changedFiles: v.changedFiles ?? (v.files ?? []).length, commitCount: (v.commits ?? []).length,
    checks: summarizeChecks(v.statusCheckRollup), additions: v.additions, deletions: v.deletions,
    files: (v.files ?? []).map((f: { path: string; additions: number; deletions: number }) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    commits: (v.commits ?? []).map((c: { oid: string; messageHeadline: string }) => ({ sha: c.oid.slice(0, 7), oid: c.oid, subject: c.messageHeadline })),
    comments: raw.map((c) => ({ id: String(c.id), author: c.user?.login, path: c.path, line: c.line ?? c.original_line, body: c.body, at: c.created_at, ...(c.html_url ? { url: c.html_url } : {}), ...(c.in_reply_to_id ? { replyTo: String(c.in_reply_to_id) } : {}) })),
    reviews: (v.reviews ?? []).map((r: { author?: { login: string }; state: string; body: string }) => ({ author: r.author?.login, state: r.state.toLowerCase(), body: r.body })),
    gatheredAt: new Date().toISOString(),
  };
  return { data, patch };
}

/** `--fields a,b` keeps only those keys of every object in a list; `--count` replaces every list of objects by its length. */
export function trim(v: unknown, o: { fields?: string[]; count?: boolean }): unknown {
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === "object" && v[0] !== null) {
      if (o.count) return v.length;
      return v.map((x) => (o.fields?.length ? Object.fromEntries(Object.entries(x as object).filter(([k]) => o.fields!.includes(k))) : trim(x, o)));
    }
    return o.count ? v.length : v;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, o)]));
  return v;
}

const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** `artifact gather <kind> <artifact-dir> [--pr owner/repo#12] [--branches 'idea/*' --base main] [--repos a/b,c/d] [--since ISO|"24 hours ago"] [--workspaces dir,dir] [--repo path] [--ref r] [--name file]` */
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
      if (s("branches")) {
        data = gitBranches(s("repo")!, s("branches")!, s("base") ?? "main");
        if (!s("name")) v = { ...v, name: "git-branches" };
      } else data = gitLog(s("repo")!, { since: s("since"), ref: s("ref"), limit: s("limit") ? Number(s("limit")) : undefined });
      break;
    }
    case "gh-pr": {
      if (!s("pr")) { console.error("gh-pr needs --pr owner/repo#12 (or the PR URL)"); return 2; }
      const { data: pr, patch } = ghPr(s("pr")!);
      const root = resolve(dir);
      mkdirSync(join(root, "data"), { recursive: true }); mkdirSync(join(root, "evidence"), { recursive: true });
      writeFileSync(join(root, "data", "pr.json"), JSON.stringify(pr, null, 1) + "\n");
      writeFileSync(join(root, "evidence", "pr.patch"), patch);
      console.log(`${join(root, "data/pr.json")}\n${join(root, "evidence/pr.patch")}  (${pr.files.length} files, ${pr.comments.length} existing comments, author ${pr.author}${pr.viewerIsAuthor ? " = you: requester mode" : ""})`);
      return 0;
    }
    default: console.error(`unknown collector ${kind} (gh-prs, gh-pr, board, git-log)`); return 2;
  }
  if (s("fields") || v.count) data = trim(data, { fields: list(s("fields")), count: !!v.count });
  const out = join(resolve(dir), "data", `${s("name") ?? kind}.json`);
  mkdirSync(join(resolve(dir), "data"), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
  console.log(out);
  return 0;
}
