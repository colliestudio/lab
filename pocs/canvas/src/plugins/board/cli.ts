import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { CliExtra } from '../../core/agent';
import { parseBacklog } from './backlog';

// Node-only: the command line verb that feeds board.sync from Backlog.md.

export const syncBacklog: CliExtra = {
  verb: 'sync-backlog',
  usage: 'sync-backlog [--dir PATH] [-- backlog filters…]   Backlog.md tasks → columns (re-runnable)',
  as: 'Backlog.md',
  kind: 'tool',
  async run(api, { flags, rest, say }) {
    const dir = (flags.dir ?? `${homedir()}/workspaces/cs`).replace(/^~/, homedir());
    const text = execFileSync('backlog', ['task', 'list', '--plain', ...rest], { cwd: dir, encoding: 'utf8' });
    const input = parseBacklog(text);
    if (!input.items.length) throw new Error(`no tasks parsed from \`backlog task list --plain\` in ${dir}`);
    const at = flags.x !== undefined ? { x: Number(flags.x), y: Number(flags.y ?? 0) } : undefined;
    const r = await api.run('board.sync', { ...input, at });
    const changed = (r.result as { changed?: number }).changed;
    say(changed ? ((await api.log(1))[0]?.text ?? 'synced') : `backlog: ${input.items.length} tasks, board already up to date`);
  },
};
