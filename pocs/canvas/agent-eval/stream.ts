// Parses `claude -p --output-format stream-json --verbose` lines into what the harness reports.

export interface Usage {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Call {
  id: string;
  name: string;
  input: unknown;
  /** Has a matching tool_result. */
  done: boolean;
  /** Result had is_error. */
  error: boolean;
  /** Result text, cut to 2 KB. */
  text: string;
  /** The command has no spec yet ("(no description for this command yet"). */
  undescribed: boolean;
  /** Result says nothing changed. */
  noop: boolean;
}

export interface Init {
  model?: string;
  tools: string[];
  mcp: { name: string; status: string }[];
  /** Plugins that are not built into Claude Code (path other than "builtin"). */
  plugins: string[];
  skills: string[];
  slashCommands: string[];
  raw: Record<string, unknown>;
}

export interface Transcript {
  init?: Init;
  calls: Call[];
  /** Assistant text blocks, in order. */
  texts: string[];
  /** Events in order, for the markdown: text and call ids. */
  order: ({ text: string } | { call: string })[];
  result?: { subtype: string; isError: boolean; durationMs?: number; turns?: number; costUsd?: number; text?: string };
  permissionDenials: { tool: string; input: unknown }[];
  usage: Usage;
  parseErrors: number;
}

const MAX = 2048;
const NOOP = /"changed":\s*0\b|\(no change\)/;
const UNDESCRIBED = /\(no description for this command yet/;

const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const names = (v: unknown): string[] => asArr(v).map((x) => (typeof x === 'string' ? x : String(x?.name ?? x?.id ?? ''))).filter(Boolean);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArr(content)
    .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : JSON.stringify(b)))
    .join('\n');
}

function addUsage(into: Usage, u: any) {
  into.in += num(u?.input_tokens);
  into.out += num(u?.output_tokens);
  into.cacheRead += num(u?.cache_read_input_tokens);
  into.cacheWrite += num(u?.cache_creation_input_tokens);
}

export function parseStream(lines: string[]): Transcript {
  const t: Transcript = { calls: [], texts: [], order: [], permissionDenials: [], usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, parseErrors: 0 };
  const byId = new Map<string, Call>();
  // stream-json repeats a message once per content block, with the same id and usage: count each id once
  const counted = new Set<string>();
  const seenBlocks = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      t.parseErrors++;
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'system' && ev.subtype === 'init') {
      t.init = {
        model: ev.model,
        tools: names(ev.tools),
        mcp: asArr(ev.mcp_servers).map((s) => ({ name: String(s?.name ?? ''), status: String(s?.status ?? '') })),
        plugins: asArr(ev.plugins).filter((p) => p?.path !== 'builtin').map((p) => String(p?.name ?? p)),
        skills: names(ev.skills),
        slashCommands: names(ev.slash_commands),
        raw: ev,
      };
    } else if (ev.type === 'assistant' && ev.message) {
      const m = ev.message;
      const mid = String(m.id ?? '');
      if (mid && !counted.has(mid)) {
        counted.add(mid);
        addUsage(t.usage, m.usage);
      }
      for (const b of asArr(m.content)) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const key = `${mid}:t:${b.text}`;
          if (seenBlocks.has(key)) continue;
          seenBlocks.add(key);
          t.texts.push(b.text);
          t.order.push({ text: b.text });
        } else if (b?.type === 'tool_use' && !byId.has(String(b.id))) {
          const c: Call = { id: String(b.id), name: String(b.name), input: b.input, done: false, error: false, text: '', undescribed: false, noop: false };
          byId.set(c.id, c);
          t.calls.push(c);
          t.order.push({ call: c.id });
        }
      }
    } else if (ev.type === 'user' && ev.message) {
      for (const b of asArr(ev.message.content)) {
        if (b?.type !== 'tool_result') continue;
        const c = byId.get(String(b.tool_use_id));
        if (!c) continue;
        const full = resultText(b.content);
        c.done = true;
        c.error = b.is_error === true;
        c.text = full.length > MAX ? full.slice(0, MAX) + '…' : full;
        c.undescribed = UNDESCRIBED.test(full);
        c.noop = !c.error && NOOP.test(full);
      }
    } else if (ev.type === 'result') {
      t.result = { subtype: String(ev.subtype ?? ''), isError: ev.is_error === true, durationMs: ev.duration_ms, turns: ev.num_turns, costUsd: ev.total_cost_usd, text: typeof ev.result === 'string' ? ev.result : undefined };
      t.permissionDenials = asArr(ev.permission_denials).map((d) => ({ tool: String(d?.tool_name ?? d?.tool ?? '?'), input: d?.tool_input ?? d?.input }));
      // the final usage is the authoritative total when present
      if (ev.usage) {
        const u: Usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
        addUsage(u, ev.usage);
        if (u.in + u.out + u.cacheRead + u.cacheWrite > 0) t.usage = u;
      }
    }
  }
  return t;
}

/** Why a transcript is not a clean agent run (init guard). Empty = isolated as intended. */
export function initProblems(init: Init | undefined, userSkills: string[] = []): string[] {
  if (!init) return ['no init event'];
  const out: string[] = [];
  const foreign = init.tools.filter((x) => !x.startsWith('mcp__canvas__'));
  if (foreign.length) out.push(`non-canvas tools: ${foreign.join(', ')}`);
  if (!init.tools.length) out.push('no tools at all');
  const canvas = init.mcp.find((s) => s.name === 'canvas');
  if (!canvas || canvas.status !== 'connected') out.push(`canvas MCP server not connected (${canvas?.status ?? 'missing'})`);
  const others = init.mcp.filter((s) => s.name !== 'canvas');
  if (others.length) out.push(`other MCP servers: ${others.map((s) => s.name).join(', ')}`);
  if (init.plugins.length) out.push(`plugins: ${init.plugins.join(', ')}`);
  const mine = init.skills.filter((s) => userSkills.includes(s));
  if (mine.length) out.push(`user skills: ${mine.join(', ')}`);
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export function transcriptMarkdown(t: Transcript): string {
  const byId = new Map(t.calls.map((c) => [c.id, c]));
  const out: string[] = ['# Transcript', ''];
  for (const e of t.order) {
    if ('text' in e) out.push(e.text.trim(), '');
    else {
      const c = byId.get(e.call)!;
      out.push(`**${c.name}** \`${clip(JSON.stringify(c.input ?? {}), 600)}\``, '');
      out.push(c.done ? `> ${c.error ? 'ERROR ' : ''}${clip(c.text, 500).replace(/\n/g, '\n> ')}` : '> (no result: cut off)', '');
    }
  }
  if (t.permissionDenials.length) out.push('## Permission denials', '', ...t.permissionDenials.map((d) => `- ${d.tool} ${clip(JSON.stringify(d.input ?? {}), 200)}`), '');
  if (t.result) out.push('## Result', '', `${t.result.subtype}${t.result.isError ? ' (error)' : ''}`, '');
  return out.join('\n');
}
