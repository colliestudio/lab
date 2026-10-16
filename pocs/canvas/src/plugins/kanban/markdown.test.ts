import { describe, expect, it } from 'vitest';
import { ID_RE, commentProblem, markerProblem, newTaskFile, nextTaskId, parseConfig, parseTask, patchTask, stamp, stampTime, taskFileName, yamlScalar } from './markdown';
import { CLI_CHILD, CLI_PLAIN, CLI_TASK } from './fixtures';

// Fixtures are files written by `backlog` 1.53.0 (fixtures.ts); src/plugins/kanban/node/markdown.cli.test.ts
// compares the patcher with the CLI itself when it is installed.
const NOW = new Date(Date.UTC(2026, 9, 16, 15, 30, 59));
const lines = (s: string) => s.split('\n');
const diff = (a: string, b: string) => {
  const x = lines(a);
  const y = lines(b);
  return y.filter((l) => !x.includes(l)).concat(x.filter((l) => !y.includes(l)).map((l) => `-${l}`));
};

describe('parseTask', () => {
  it('reads a CLI-written file: fields, sections, AC, no comments', () => {
    const t = parseTask(CLI_TASK)!;
    expect(t).toMatchObject({ taskId: 'TASK-1', title: 'First task', status: 'To Do', assignee: ['@dev'], labels: ['canvas', 'ui'], priority: 'high', ordinal: 1000, created: '2026-10-16 14:53', description: 'Does the thing', plan: 'step 1', notes: 'n1' });
    expect(t.ac).toEqual([{ text: 'one', done: false }, { text: 'two', done: false }]);
    expect(t.comments).toEqual([]);
    expect(t.updated).toBeUndefined();
  });
  it('reads a subtask (parent), a file with no sections, and an unquoted title', () => {
    expect(parseTask(CLI_CHILD)).toMatchObject({ taskId: 'TASK-1.1', parent: 'TASK-1', status: 'In Progress', description: '', ac: [], priority: undefined });
    expect(parseTask(CLI_PLAIN)!.title).toBe("Plain: with 'quote' #1 é");
    expect(parseTask('no frontmatter')).toBeNull();
    expect(parseTask('---\ntitle: x\n---\n')).toBeNull();
  });
  it('reads quoted, folded, flow-list and block-list values', () => {
    const t = parseTask(`---\nid: task-5\ntitle: >-\n  long title that\n  folds\nstatus: 'To Do'\nassignee: [alex, '@bob, jr']\nlabels: []\nordinal: 12.5\n---\n`)!;
    expect(t).toMatchObject({ taskId: 'TASK-5', title: 'long title that folds', status: 'To Do', assignee: ['alex', '@bob, jr'], labels: [], ordinal: 12.5 });
  });
  it('reads comments with and without author, multi-line text', () => {
    const text = patchTask(patchTask(CLI_TASK, { comment: { author: '@bob', text: 'line1\nline2\n\nline4' } }, NOW), { comment: { text: 'second' } }, NOW);
    expect(parseTask(text)!.comments).toEqual([
      { author: '@bob', created: '2026-10-16 15:30', text: 'line1\nline2\n\nline4' },
      { created: '2026-10-16 15:30', text: 'second' },
    ]);
  });
  it('a half-written file reads as null or partial, never throws', () => {
    expect(parseTask('---\nid: TASK-2\ntitle: half')).toBeNull();
    expect(() => parseTask('---\nid: TASK-2\n---\n')).not.toThrow();
  });
});

describe('patchTask: frontmatter', () => {
  it('status changes the status line and adds updated_date after created_date (UTC), nothing else', () => {
    const out = patchTask(CLI_TASK, { status: 'In Progress' }, NOW);
    expect(diff(CLI_TASK, out)).toEqual(['status: In Progress', "updated_date: '2026-10-16 15:30'", '-status: To Do']);
    expect(lines(out).indexOf("updated_date: '2026-10-16 15:30'")).toBe(lines(out).indexOf("created_date: '2026-10-16 14:53'") + 1);
    // a second change replaces the stamp in place
    const again = patchTask(out, { status: 'Done' }, new Date(NOW.getTime() + 120_000));
    expect(again.match(/updated_date/g)).toHaveLength(1);
    expect(again).toContain("updated_date: '2026-10-16 15:32'");
  });
  it('ordinal alone does not bump updated_date; with another change it does', () => {
    expect(diff(CLI_TASK, patchTask(CLI_TASK, { ordinal: 1500 }, NOW))).toEqual(['ordinal: 1500', '-ordinal: 1000']);
    expect(patchTask(CLI_TASK, { ordinal: 1500, status: 'Done' }, NOW)).toContain('updated_date');
  });
  it('a patch that changes nothing returns the file untouched', () => {
    expect(patchTask(CLI_TASK, { status: 'To Do', labels: ['canvas', 'ui'], sections: { plan: 'step 1' }, ac: [{ text: 'one', done: false }, { text: 'two', done: false }] }, NOW)).toBe(CLI_TASK);
  });
  it('priority goes before ordinal when new, in place when there; null removes', () => {
    const out = patchTask(CLI_PLAIN, { priority: 'low' }, NOW);
    expect(lines(out)).toContain('priority: low');
    expect(lines(out).indexOf('priority: low')).toBe(lines(out).indexOf('ordinal: 3000') - 1);
    expect(patchTask(out, { priority: null }, NOW)).not.toContain('priority');
    expect(patchTask(CLI_TASK, { priority: 'low' }, NOW)).toContain('priority: low\nordinal: 1000');
  });
  it('lists are written block style, @x quoted, empty as []', () => {
    const out = patchTask(CLI_PLAIN, { labels: ['a', 'b c'], assignee: ['@x'] }, NOW);
    expect(out).toContain("assignee:\n  - '@x'\n");
    expect(out).toContain('labels:\n  - a\n  - b c\n');
    expect(patchTask(out, { labels: [], assignee: [] }, NOW)).toContain('assignee: []\ncreated_date');
  });
  it('keeps CRLF files CRLF', () => {
    const crlf = CLI_TASK.replace(/\n/g, '\r\n');
    expect(patchTask(crlf, {}, NOW)).toBe(crlf);
    expect(patchTask(crlf, { status: 'Done', sections: { plan: 'p2\nmore' } }, NOW)).toBe(patchTask(CLI_TASK, { status: 'Done', sections: { plan: 'p2\nmore' } }, NOW).replace(/\n/g, '\r\n'));
  });
  it('refuses a file without frontmatter', () => {
    expect(() => patchTask('hello', { status: 'x' })).toThrow(/frontmatter/);
  });
});

describe('patchTask: sections', () => {
  it('edits one section inside its markers; the rest is byte-identical', () => {
    const out = patchTask(CLI_TASK, { sections: { plan: 'new plan\nsecond line' } }, NOW);
    expect(diff(CLI_TASK, out)).toEqual(["updated_date: '2026-10-16 15:30'", 'new plan', 'second line', '-step 1']);
    expect(out.replace(/new plan\nsecond line/, 'step 1').replace(/updated_date: .*\n/, '')).toBe(CLI_TASK);
  });
  it('an empty value removes the section with a blank line, like the CLI', () => {
    const noPlan = patchTask(CLI_TASK, { sections: { plan: '' } }, NOW);
    expect(noPlan).not.toContain('Implementation Plan');
    expect(noPlan).toContain('<!-- AC:END -->\n\n## Implementation Notes');
    const noNotes = patchTask(CLI_TASK, { sections: { notes: '' } }, NOW);
    expect(noNotes.endsWith('<!-- SECTION:PLAN:END -->\n')).toBe(true);
  });
  it('a new section lands in canonical order', () => {
    const base = CLI_TASK.replace(/## Implementation Plan[\s\S]*?PLAN:END -->\n\n/, '');
    const out = patchTask(base, { sections: { plan: 'p' } }, NOW);
    expect(out.indexOf('Acceptance Criteria')).toBeLessThan(out.indexOf('Implementation Plan'));
    expect(out.indexOf('Implementation Plan')).toBeLessThan(out.indexOf('Implementation Notes'));
    expect(out).toContain('<!-- AC:END -->\n\n## Implementation Plan\n\n<!-- SECTION:PLAN:BEGIN -->\np\n<!-- SECTION:PLAN:END -->\n\n## Implementation Notes');
  });
  it('sections into a body that has none: on top, own content kept', () => {
    const custom = CLI_PLAIN.replace(/\n\n$/, '\n\nHand body.\n\n## My heading\n\nstuff\n');
    const out = patchTask(custom, { sections: { description: 'dd' } }, NOW);
    expect(out).toContain('---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\ndd\n<!-- SECTION:DESCRIPTION:END -->\n\nHand body.\n\n## My heading\n\nstuff\n');
    const empty = patchTask(CLI_PLAIN, { sections: { description: 'dd' }, ac: [{ text: 'a1', done: false }] }, NOW);
    expect(empty.endsWith('<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 a1\n<!-- AC:END -->\n')).toBe(true);
  });
  it('unknown content around sections is never touched', () => {
    const custom = CLI_TASK.replace('## Implementation Notes', '## Extra\n\nmine\n\n## Implementation Notes');
    const out = patchTask(custom, { sections: { notes: 'n2' }, ac: [{ text: 'one', done: true }, { text: 'two', done: false }] }, NOW);
    expect(out).toContain('## Extra\n\nmine\n\n## Implementation Notes');
    expect(out).toContain('n2');
  });
});

describe('patchTask: acceptance criteria and comments', () => {
  const ac = (...a: [string, boolean][]) => a.map(([text, done]) => ({ text, done }));
  it('checking one item changes that one line', () => {
    const out = patchTask(CLI_TASK, { ac: ac(['one', true], ['two', false]) }, NOW);
    expect(diff(CLI_TASK, out)).toEqual(["updated_date: '2026-10-16 15:30'", '- [x] #1 one', '-- [ ] #1 one']);
    expect(parseTask(out)!.ac).toEqual(ac(['one', true], ['two', false]));
    // and back: only the stamp differs from the original
    expect(patchTask(out, { ac: ac(['one', false], ['two', false]) }, NOW).replace(/updated_date: .*\n/, '')).toBe(CLI_TASK);
  });
  it('adding appends the next number; removing renumbers; clearing removes the block', () => {
    expect(patchTask(CLI_TASK, { ac: ac(['one', false], ['two', false], ['three', false]) }, NOW)).toContain('- [ ] #2 two\n- [ ] #3 three\n<!-- AC:END -->');
    const removed = patchTask(CLI_TASK, { ac: ac(['two', false]) }, NOW);
    expect(removed).toContain('<!-- AC:BEGIN -->\n- [ ] #1 two\n<!-- AC:END -->');
    const none = patchTask(CLI_TASK, { ac: [] }, NOW);
    expect(none).not.toContain('Acceptance');
    expect(none).toContain('<!-- SECTION:DESCRIPTION:END -->\n\n## Implementation Plan');
  });
  it('a comment makes the Comments section at the end, then appends with a blank line between', () => {
    const one = patchTask(CLI_TASK, { comment: { author: '@bob', text: 'hello' } }, NOW);
    expect(one.endsWith('<!-- SECTION:NOTES:END -->\n\n## Comments\n\n<!-- COMMENTS:BEGIN -->\nauthor: @bob\ncreated: 2026-10-16 15:30\n---\nhello\n---\n<!-- COMMENTS:END -->\n')).toBe(true);
    const two = patchTask(one, { comment: { author: '@amy', text: 'second' } }, NOW);
    expect(two).toContain('hello\n---\n\nauthor: @amy\ncreated: 2026-10-16 15:30\n---\nsecond\n---\n<!-- COMMENTS:END -->');
    expect(two).toContain("updated_date: '2026-10-16 15:30'");
  });
});

describe('names, ids, new files', () => {
  it('quotes scalars like the CLI wrote them (probed on 1.53.0)', () => {
    const plain = ['it\'s', 'Ünïcode', 'back\\slash', 'with / slash', 'Fix "this" thing', '2026-10-16 x', 'a-b', 'x?y'];
    for (const p of plain) expect(yamlScalar(p)).toBe(p);
    const quoted: Record<string, string> = {
      'trailing:': "'trailing:'", 'null': "'null'", '~': "'~'", yes: "'yes'", true: "'true'", '100': "'100'", '1.5': "'1.5'", 'key: value': "'key: value'", '* star': "'* star'", '& amp': "'& amp'", '! bang': "'! bang'",
      '% pct': "'% pct'", '`tick`': "'`tick`'", '{curly}': "'{curly}'", 'a, b': "'a, b'", '?question': "'?question'", '>fold': "'>fold'", '|pipe': "'|pipe'", '[wip] foo': "'[wip] foo'", '@mention': "'@mention'", 'a # b': "'a # b'",
      "Plain: with 'quote' #1 é": "'Plain: with ''quote'' #1 é'", '- dash': "'- dash'", '2026-10-16': "'2026-10-16'",
    };
    for (const [v, q] of Object.entries(quoted)) expect(yamlScalar(v)).toBe(q);
    expect(yamlScalar('emoji 🎉')).toBe('"emoji \\U0001F389"');
  });
  it('folds a long title like the CLI (>- at 80 columns)', () => {
    const title = Array(30).fill('word').join(' ');
    const text = newTaskFile('TASK-7', { title, status: 'To Do' }, NOW);
    expect(text).toContain('title: >-\n  word word word word word word word word word word word word word word word\n  word word word word word word word word word word word word word word word\nstatus');
    expect(parseTask(text)!.title).toBe(title);
  });
  it('names files like the CLI', () => {
    const cases: [string, string][] = [
      ['Fix: the thing!', 'task-12 - Fix-the-thing.md'], ['a/b\\c', 'task-12 - a-b-c.md'], ["it's", 'task-12 - its.md'], ['[wip] foo', 'task-12 - wip-foo.md'], ['a, b', 'task-12 - a-b.md'], ['key: value', 'task-12 - key-value.md'],
      ['trailing:', 'task-12 - trailing.md'], ['???', 'task-12 - untitled.md'], ['emoji 🎉', 'task-12 - emoji-🎉.md'], ['a  --  b __ c', 'task-12 - a-b-__-c.md'], ['Trailing dot.', 'task-12 - Trailing-dot..md'], ['../../etc/passwd', 'task-12 - ..-..-etc-passwd.md'],
    ];
    for (const [t, f] of cases) expect(taskFileName('TASK-12', t)).toBe(f);
    expect(taskFileName('TASK-12', 'x'.repeat(300)).length).toBeLessThan(200);
    expect(taskFileName('TASK-3.48', 'Sub')).toBe('task-3.48 - Sub.md');
    expect(taskFileName('TASK-12', '../x')).not.toContain('/');
  });
  it('picks the next id past everything, per parent for subtasks', () => {
    expect(nextTaskId(['TASK-3', 'TASK-17.2', 'task-20 - x.md'])).toBe('TASK-21');
    expect(nextTaskId([])).toBe('TASK-1');
    expect(nextTaskId(['TASK-3', 'TASK-3.1', 'TASK-3.9', 'TASK-4.2'], 'task', 'TASK-3')).toBe('TASK-3.10');
    expect(nextTaskId(['TASK-3'], 'task', 'TASK-3')).toBe('TASK-3.1');
    expect(nextTaskId(['TASK-3.48'], 'task', 'task-3')).toBe('TASK-3.49');
  });
  it('validates ids', () => {
    for (const ok of ['TASK-1', 'task-3.48', 'TASK-3.4.5']) expect(ID_RE.test(ok)).toBe(true);
    for (const bad of ['', '../x', 'task-1/../../etc', 'TASK-1\u0000', 'TASK-', 'x'.repeat(200), 'TASK-1.', 'TASK 1', '-1']) expect(ID_RE.test(bad)).toBe(false);
  });
  it('writes a new file in the CLI layout (equal to `backlog task create`)', () => {
    const text = newTaskFile('TASK-1', { title: 'First task', status: 'To Do', assignee: ['@dev'], labels: ['canvas', 'ui'], priority: 'high', ordinal: 1000, description: 'Does the thing', ac: [{ text: 'one', done: false }, { text: 'two', done: false }], plan: 'step 1', notes: 'n1' }, new Date(Date.UTC(2026, 9, 16, 14, 53)));
    expect(text).toBe(CLI_TASK);
    expect(newTaskFile('TASK-1.1', { title: 'Child', status: 'In Progress', parent: 'TASK-1', ordinal: 2000 }, new Date(Date.UTC(2026, 9, 16, 14, 53)))).toBe(CLI_CHILD);
    expect(newTaskFile('TASK-2', { title: "Plain: with 'quote' #1 é", status: 'To Do', ordinal: 3000 }, new Date(Date.UTC(2026, 9, 16, 14, 53)))).toBe(CLI_PLAIN);
  });
  it('stamps in UTC and reads them back', () => {
    expect(stamp(new Date(Date.UTC(2026, 0, 2, 3, 4)))).toBe('2026-01-02 03:04');
    expect(stampTime('2026-01-02 03:04')).toBe(Date.UTC(2026, 0, 2, 3, 4));
    expect(stampTime('2026-01-02')).toBe(Date.UTC(2026, 0, 2));
    expect(stampTime('nope')).toBeUndefined();
  });
});

describe('parseConfig', () => {
  const CONFIG = 'project_name: "demo"\ndefault_status: "To Do"\nstatuses: ["To Do", "In Progress", "Done"]\nlabels: ["re", "infra"]\ntask_prefix: "task"\nbacklog_directory: "backlog"\n';
  it('reads statuses in order, labels, default, prefix, directory', () => {
    expect(parseConfig(CONFIG)).toEqual({ name: 'demo', statuses: ['To Do', 'In Progress', 'Done'], labels: ['re', 'infra'], defaultStatus: 'To Do', prefix: 'task', directory: 'backlog' });
    expect(parseConfig('statuses:\n  - Todo\n  - Doing\n  - Shipped\n').statuses).toEqual(['Todo', 'Doing', 'Shipped']);
    expect(parseConfig('project_name: x\n').statuses).toEqual(['To Do', 'In Progress', 'Done']);
  });
  it('errors clearly on odd configs instead of making an empty board', () => {
    expect(() => parseConfig('')).toThrow(/no settings/);
    expect(() => parseConfig('statuses: []\nproject_name: x\n')).toThrow(/no usable statuses/);
    expect(() => parseConfig('# just a comment\n')).toThrow(/no settings/);
  });
});

const HAND_AC = `---
id: TASK-5
title: Hand
status: To Do
assignee: []
created_date: '2026-10-16 14:53'
labels: []
dependencies: []
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] first thing
- [ ] #2 second thing
  continuation note
- [x] #3 third
<!-- AC:END -->
`;
const LEGACY = `---
id: TASK-6
title: Old
status: To Do
assignee: []
created_date: '2026-10-16 14:53'
labels: []
dependencies: []
---

## Description

Old style text
second line

## Acceptance Criteria

- [ ] #1 legacy ac

## Implementation Plan

old plan
`;

describe('hand-written bodies', () => {
  it('reads AC lines with or without #N', () => {
    expect(parseTask(HAND_AC)!.ac).toEqual([{ text: 'first thing', done: false }, { text: 'second thing', done: false }, { text: 'third', done: true }]);
  });
  it('ticking one item keeps the unnumbered line and the continuation line; only item lines are renumbered', () => {
    const t = parseTask(HAND_AC)!;
    const out = patchTask(HAND_AC, { ac: t.ac.map((a, i) => (i === 1 ? { ...a, done: true } : a)) }, NOW);
    expect(out).toContain('- [ ] #1 first thing\n- [x] #2 second thing\n  continuation note\n- [x] #3 third\n<!-- AC:END -->');
    const added = patchTask(HAND_AC, { ac: [...t.ac, { text: 'fourth', done: false }] }, NOW);
    expect(added).toContain('  continuation note\n- [x] #3 third\n- [ ] #4 fourth\n<!-- AC:END -->');
    const removed = patchTask(HAND_AC, { ac: t.ac.slice(1) }, NOW);
    expect(removed).toContain('- [ ] #1 second thing\n- [x] #2 third\n  continuation note');
    const middle = patchTask(HAND_AC, { ac: [t.ac[0], t.ac[2]] }, NOW);
    expect(middle).toContain('- [ ] #1 first thing');
    expect(middle).toContain('- [x] #2 third');
    expect(middle).not.toContain('second thing');
  });
  it('a comment with a line of only --- is refused; *** is fine', () => {
    expect(commentProblem('a\n---\nb')).toMatch(/only '---'/);
    expect(commentProblem('a\r\n---  \r\nb')).toBeTruthy();
    expect(() => patchTask(CLI_TASK, { comment: { author: '@x', text: 'a\n---\nauthor: evil' } }, NOW)).toThrow(/only '---'/);
    expect(commentProblem('a\n***\nb')).toBeUndefined();
    expect(commentProblem('a --- b\n----')).toBeUndefined();
  });
  it('old-style sections without markers are read, and an edit replaces them in place (no second heading)', () => {
    const t = parseTask(LEGACY)!;
    expect(t).toMatchObject({ description: 'Old style text\nsecond line', plan: 'old plan', ac: [{ text: 'legacy ac', done: false }] });
    const out = patchTask(LEGACY, { sections: { description: 'New text' } }, NOW);
    expect(out.match(/## Description/g)).toHaveLength(1);
    expect(out).toContain('## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nNew text\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria');
    expect(out).toContain('old plan');
    const ac = patchTask(LEGACY, { ac: [{ text: 'legacy ac', done: true }] }, NOW);
    expect(ac.match(/## Acceptance Criteria/g)).toHaveLength(1);
    expect(parseTask(ac)!.ac).toEqual([{ text: 'legacy ac', done: true }]);
    expect(patchTask(LEGACY, { sections: { plan: '' } }, NOW)).not.toContain('Implementation Plan');
  });
  it('a Definition of Done block is kept and a new AC block goes before it', () => {
    const dod = CLI_TASK.replace('## Implementation Plan', '## Definition of Done\n<!-- DOD:BEGIN -->\n- [ ] #1 d\n<!-- DOD:END -->\n\n## Implementation Plan').replace(/## Acceptance Criteria[\s\S]*?AC:END -->\n\n/, '');
    const out = patchTask(dod, { ac: [{ text: 'x', done: false }] }, NOW);
    expect(out.indexOf('AC:BEGIN')).toBeLessThan(out.indexOf('DOD:BEGIN'));
    expect(out).toContain('<!-- DOD:END -->');
  });
});

describe('headings inside a marked block', () => {
  const QUOTED = CLI_TASK.replace('Does the thing', 'Does the thing\n\n## Implementation Notes\nQuoted from the old doc.');
  it('are the block\'s text, not sections: nothing is nested by an AC edit', () => {
    const t = parseTask(QUOTED)!;
    expect(t.description).toContain('Quoted from the old doc.');
    expect(t.notes).toBe('n1');
    const out = patchTask(QUOTED, { ac: [{ text: 'one', done: true }, { text: 'two', done: false }] }, NOW);
    expect(out.match(/NOTES:BEGIN/g)).toHaveLength(1);
    expect(out.replace(/updated_date: .*\n/, '').replace('- [x] #1 one', '- [ ] #1 one')).toBe(QUOTED);
  });
});

describe('marker lines quoted in a section', () => {
  const NOTES_QUOTE = CLI_TASK.replace(/\n## Acceptance Criteria[\s\S]*?AC:END -->\n/, '').replace('n1', 'format:\n<!-- AC:BEGIN -->\n- [ ] #1 example item\n<!-- AC:END -->');
  it('are text of the block they sit in: the quoted AC is not the AC list', () => {
    const t = parseTask(NOTES_QUOTE)!;
    expect(t.ac).toEqual([]);
    expect(t.notes).toContain('example item');
    const out = patchTask(NOTES_QUOTE, { ac: [{ text: 'real item', done: false }] }, NOW);
    expect(parseTask(out)!.ac).toEqual([{ text: 'real item', done: false }]);
    expect(parseTask(out)!.notes).toContain('- [ ] #1 example item');
    expect(out.indexOf('real item')).toBeLessThan(out.indexOf('SECTION:NOTES:BEGIN'));
  });
  it('a block\'s own text is refused if it is a marker line', () => {
    expect(markerProblem('a\n<!-- SECTION:DESCRIPTION:END -->\nb')).toBeTruthy();
    expect(markerProblem('<!-- AC:BEGIN -->')).toBeTruthy();
    expect(markerProblem('see <!-- AC:BEGIN --> inline')).toBeUndefined();
    expect(() => patchTask(CLI_TASK, { sections: { notes: 'x\n<!-- AC:END -->' } }, NOW)).toThrow(/block markers/);
    expect(() => patchTask(CLI_TASK, { comment: { text: '<!-- COMMENTS:END -->' } }, NOW)).toThrow(/block markers/);
    expect(() => newTaskFile('TASK-9', { title: 'x', status: 'To Do', description: 'a\n<!-- SECTION:DESCRIPTION:END -->' }, NOW)).toThrow(/block markers/);
  });
});
