import { describe, expect, it } from 'vitest';
import { parseBacklog } from './backlog';

describe('parseBacklog', () => {
  it('statuses → columns, tasks → items', () => {
    const r = parseBacklog(`To Do:\n  [MEDIUM] TASK-28 - RE books: tax package (ac: 0/4)\n  TASK-4 - G8 hygiene\n\nIn Progress:\n  TASK-35.4 - Canvas: merge round (ac: 0/3)\n`);
    expect(r.columns).toEqual([
      { key: 'to-do', label: 'To Do' },
      { key: 'in-progress', label: 'In Progress' },
    ]);
    expect(r.items).toEqual([
      { key: 'TASK-28', column: 'to-do', text: '**TASK-28** RE books: tax package\nmedium · ac 0/4', color: '2', data: { priority: 'MEDIUM', ac: '0/4' } },
      { key: 'TASK-4', column: 'to-do', text: '**TASK-4** G8 hygiene', data: {} },
      { key: 'TASK-35.4', column: 'in-progress', text: '**TASK-35.4** Canvas: merge round\nac 0/3', data: { ac: '0/3' } },
    ]);
  });
});
