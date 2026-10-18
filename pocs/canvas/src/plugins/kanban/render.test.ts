import { beforeEach, describe, expect, it } from 'vitest';
import { clock } from './model';
import { boardHtml, cardHtml, esc, filterChips, labelColor, rowHtml, seatKey, stateChip } from './render';
import { NOW, addBoard, addTask, kanbanStore, resetCounter, stampDaysAgo, taskField } from './testkit';

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});

describe('cards', () => {
  const s = kanbanStore();
  addBoard(s);
  addTask(s, 'b1', { title: 'Fix <b>this</b> & "that"', taskId: 'TASK-3.48', priority: 'high', assignee: ['@claude'], ac: [{ text: 'a', done: true }, { text: 'b', done: false }] }, 't');
  const t = taskField(s, 't');

  it('shows id, title, priority, AC progress and the assignee, all escaped', () => {
    const h = cardHtml(t);
    expect(h).toContain('TASK-3.48');
    expect(h).toContain('Fix &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;');
    expect(h).toContain('kb-prio-high');
    expect(h).toContain('AC 1/2');
    expect(h).toContain('@claude');
    expect(h).not.toContain('kb-seated');
    expect(h).not.toContain('<b>this');
  });

  it('a seated assignee gets a dot in the seat color; the key changes with the seat (C50)', () => {
    const seats = [{ id: 'agent:claude', name: 'Claude · task-3.48', color: '#d97757' }];
    expect(cardHtml(t, seats)).toMatch(/kb-seated" style="--c:#d97757" title="Claude · task-3.48 is at the table"><i class="kb-dot">/);
    expect(seatKey(t, seats)).toBe('Claude · task-3.48|#d97757');
    expect(seatKey(t, [])).toBe('');
  });

  it('a task not written yet says so; a conflict note shows on the card', () => {
    expect(cardHtml({ ...t, pending: true })).toContain('kb-new');
    expect(cardHtml({ ...t, note: 'title: the file changed it' })).toContain('kb-conflict');
    expect(cardHtml({ ...t, ac: [], priority: undefined, assignee: [] })).not.toContain('kb-foot-row');
  });

  it('a Done row is one line with the short id', () => {
    expect(rowHtml(t)).toContain('<span class="kb-id">3.48</span> Fix &lt;b&gt;');
  });

  it('label colors are stable', () => {
    expect(labelColor('canvas')).toBe(labelColor('canvas'));
    expect(labelColor('canvas')).not.toBe(labelColor('ui'));
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('the board node', () => {
  const build = () => {
    const s = kanbanStore();
    addBoard(s, { filter: { labels: ['canvas'], parent: 'TASK-3' } });
    s.apply([{ op: 'set', id: 'b1', key: 'height', value: 500 }]);
    addTask(s, 'b1', { title: 'a', labels: ['canvas'], parent: 'TASK-3' }, 'a');
    addTask(s, 'b1', { title: 'old', status: 'Done', labels: ['canvas'], parent: 'TASK-3', updated: stampDaysAgo(30) }, 'o');
    return s;
  };

  it('live: columns with counts and plus buttons, the state chip, filter chips, the menu button, the +N older toggle', () => {
    const s = build();
    const h = boardHtml(s.doc.get('b1')!, s.doc, { served: true, seats: [] }, NOW);
    expect(h).toContain('▦ demo');
    expect(h).toContain('kb-live');
    expect(h).toContain('live · demo');
    expect(h).toContain('label: canvas');
    expect(h).toContain('parent: TASK-3');
    expect(h).toContain('data-action="add:0"');
    expect(h).toContain('data-action="add:1"');
    expect(h).not.toContain('data-action="add:2"'); // Done takes no quick add
    expect(h).toContain('data-action="menu"');
    expect(h).toContain('+1 older');
    expect(h).toContain('data-action="more:2"');
    expect(h.match(/class="kb-col[ "]/g)).toHaveLength(3);
  });

  it('a quick-add field replaces the column header, with its text kept', () => {
    const s = build();
    const h = boardHtml(s.doc.get('b1')!, s.doc, { served: true, quick: { col: 1, text: 'half typed <x>' }, seats: [] }, NOW);
    expect(h).toContain('data-quick');
    expect(h).toContain('half typed &lt;x&gt;');
    expect(h).toContain('New task in In Progress');
    expect(h.match(/data-quick/g)).toHaveLength(1);
  });

  it('not live here (a page that is not a serve board): read-only, no plus buttons, says why (C79)', () => {
    const s = build();
    const h = boardHtml(s.doc.get('b1')!, s.doc, { served: false, quick: { col: 0, text: '' }, seats: [] }, NOW);
    expect(h).toContain('not live here');
    expect(h).not.toContain('data-action="add:');
    expect(h).not.toContain('data-quick');
    expect(h).toContain('canvas serve');
    expect(h).not.toMatch(/showDirectoryPicker|Open folder/);
  });

  it('state chip: the serve\'s problem, connecting, live', () => {
    const s = build();
    const b = () => s.doc.get('b1')!;
    expect(stateChip(b(), { served: true })).toMatchObject({ live: true, text: 'live · demo' });
    s.apply([{ op: 'set', id: 'b1', key: 'x-kanban.state', value: { error: 'the tasks folder is missing' } }]);
    expect(stateChip(b(), { served: true })).toMatchObject({ live: false, cls: 'kb-bad', text: 'the tasks folder is missing' });
    s.apply([{ op: 'set', id: 'b1', key: 'x-kanban.state', value: undefined }]);
    expect(stateChip(b(), { served: true }).text).toBe('connecting…');
    expect(filterChips(b())).toContain('label: canvas');
  });
});
