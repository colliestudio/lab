import type { SyncArgs, SyncItem } from './logic';

// Backlog.md → board: parse `backlog task list --plain` (read only) into a board.sync input.
// Status sections become columns, tasks become notes; re-running refreshes them.

const PRIORITY_COLOR: Record<string, string> = { HIGH: '1', MEDIUM: '2', LOW: '5' };

export function parseBacklog(text: string): SyncArgs {
  const columns: SyncArgs['columns'] = [];
  const items: SyncItem[] = [];
  let col: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const head = /^(\S.*):$/.exec(line);
    if (head) {
      col = head[1].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      columns.push({ key: col, label: head[1] });
      continue;
    }
    const m = /^\s+(?:\[(\w+)\]\s+)?(TASK-[\d.]+)\s+-\s+(.*?)(?:\s+\(ac: (\d+)\/(\d+)\))?$/.exec(line);
    if (!m || !col) continue;
    const [, priority, id, title, acDone, acAll] = m;
    const meta = [priority && priority.toLowerCase(), acAll && `ac ${acDone}/${acAll}`].filter(Boolean).join(' · ');
    items.push({
      key: id,
      column: col,
      text: `**${id}** ${title}${meta ? `\n${meta}` : ''}`,
      ...(priority && PRIORITY_COLOR[priority] ? { color: PRIORITY_COLOR[priority] } : {}),
      data: { ...(priority ? { priority } : {}), ...(acAll ? { ac: `${acDone}/${acAll}` } : {}) },
    });
  }
  return { source: 'backlog', columns, items };
}
