import { afterEach, describe, expect, it } from 'vitest';
import type { Card, TrackerSource } from './source';
import { SourceError } from './source';

// One contract, run against every adapter (MemSource here, BacklogMdSource in kanban/node): what the
// sync, the commands and the panel may rely on. A new adapter (Trello, Linear, ...) passes it too.

export interface Harness {
  source: TrackerSource;
  /** Seeded cards: `a` has a description, two unchecked checklist items, labels ['x']; `b` is plain; both in "To Do". */
  ids: { a: string; b: string };
  /** Change card `id` behind the adapter's back (a file edit, a webhook) so `watch` has something to report. */
  outsideEdit(id: string): Promise<void>;
  cleanup(): Promise<void> | void;
}

const NOW = new Date(Date.UTC(2026, 9, 16, 12, 0));
const opts = { now: NOW };
const waitFor = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

export function sourceContract(name: string, make: () => Promise<Harness>) {
  describe(`TrackerSource contract: ${name}`, () => {
    const open: Harness[] = [];
    afterEach(async () => {
      for (const h of open.splice(0)) await h.cleanup();
    });
    const harness = async () => {
      const h = await make();
      open.push(h);
      return h;
    };

    it('lists the columns, the default and the cards', async () => {
      const { source, ids } = await harness();
      const { info, cards } = await source.list();
      expect(info.columns.length).toBeGreaterThan(0);
      expect(info.columns).toContain(info.defaultColumn);
      expect(info.doneColumn).toBe(info.columns.at(-1));
      expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
      expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([ids.a, ids.b]));
      const a = cards.find((c) => c.id === ids.a)!;
      expect(a).toMatchObject({ column: 'To Do', labels: ['x'] });
      expect(a.checklist).toHaveLength(2);
      expect(a.sections.description).toBeTruthy();
    });

    it('reads one card; unknown and hostile ids give null', async () => {
      const { source, ids } = await harness();
      const { cards } = await source.list();
      expect(await source.read(ids.a)).toEqual(cards.find((c) => c.id === ids.a));
      for (const bad of ['TASK-9999', '', '../x', 'TASK-1/../../etc/passwd', 'a\u0000b', 'x'.repeat(300), '/etc/passwd', '..\\x']) expect(await source.read(bad)).toBeNull();
    });

    it('writes fields and returns the card as stored; other fields stay', async () => {
      const { source, ids } = await harness();
      const before = (await source.read(ids.a))!;
      const after = await source.write(ids.a, { title: 'New: title', column: 'In Progress', labels: ['y', 'z'], assignee: ['@dev'], priority: 'high', order: 2500 }, opts);
      expect(after).toMatchObject({ id: ids.a, title: 'New: title', column: 'In Progress', labels: ['y', 'z'], assignee: ['@dev'], priority: 'high', order: 2500 });
      expect(after.sections).toEqual(before.sections);
      expect(after.checklist).toEqual(before.checklist);
      expect(await source.read(ids.a)).toEqual(after);
      expect((await source.read(ids.b))!.title).toBe((await source.list()).cards.find((c) => c.id === ids.b)!.title);
      const cleared = await source.write(ids.a, { priority: null, order: null, assignee: [], labels: [] }, opts);
      expect(cleared).toMatchObject({ priority: undefined, order: undefined, assignee: [], labels: [] });
    });

    it('writes sections one at a time; an empty value clears one', async () => {
      const { source, ids } = await harness();
      const w = await source.write(ids.b, { sections: { plan: 'step 1\nstep 2', notes: 'a note' } }, opts);
      expect(w.sections).toMatchObject({ plan: 'step 1\nstep 2', notes: 'a note' });
      const w2 = await source.write(ids.b, { sections: { plan: '' } }, opts);
      expect(w2.sections.plan ?? '').toBe('');
      expect(w2.sections.notes).toBe('a note');
      const w3 = await source.write(ids.b, { sections: { description: 'now described' } }, opts);
      expect(w3.sections).toMatchObject({ description: 'now described', notes: 'a note' });
    });

    it('writes the checklist whole: check, add, remove', async () => {
      const { source, ids } = await harness();
      const a = (await source.read(ids.a))!;
      const checked = await source.write(ids.a, { checklist: [{ ...a.checklist[0], done: true }, a.checklist[1]] }, opts);
      expect(checked.checklist.map((c) => c.done)).toEqual([true, false]);
      const added = await source.write(ids.a, { checklist: [...checked.checklist, { text: 'third', done: false }] }, opts);
      expect(added.checklist.map((c) => c.text)).toEqual([a.checklist[0].text, a.checklist[1].text, 'third']);
      const removed = await source.write(ids.a, { checklist: added.checklist.slice(1) }, opts);
      expect(removed.checklist.map((c) => c.text)).toEqual([a.checklist[1].text, 'third']);
    });

    it('appends comments', async () => {
      const { source, ids } = await harness();
      const one = await source.write(ids.b, { comment: { author: '@bob', text: 'first' } }, opts);
      const two = await source.write(ids.b, { comment: { text: 'line1\nline2' } }, opts);
      expect(one.comments).toHaveLength(1);
      expect(two.comments.map((c) => c.text)).toEqual(['first', 'line1\nline2']);
      expect(two.comments[0].author).toBe('@bob');
    });

    it('refuses a write to nothing or to a column that does not exist, without writing', async () => {
      const { source, ids } = await harness();
      const rejects = async (p: Promise<unknown>, code: string) => {
        const e = await p.then(() => undefined, (x: unknown) => x);
        expect(e).toBeInstanceOf(SourceError);
        expect((e as SourceError).code).toBe(code);
      };
      await rejects(source.write('TASK-9999', { title: 'x' }, opts), 'not-found');
      await rejects(source.write('../../etc/passwd', { title: 'x' }, opts), 'not-found');
      await rejects(source.write(ids.a, { column: 'Nowhere' }, opts), 'invalid');
      await rejects(source.create({ title: 'x', column: 'Nowhere' }, opts), 'invalid');
      expect((await source.read(ids.a))!.column).toBe('To Do');
    });

    it('creates a card; the preferred id when it is free, else another', async () => {
      const { source, ids } = await harness();
      const { info } = await source.list();
      const id = info.caps.nextId ? await source.nextId!() : undefined;
      const made = await source.create({ title: 'Fresh: card', column: 'In Progress', labels: ['x'], assignee: ['@a'], priority: 'low', order: 9000, sections: { description: 'hello' }, preferId: id }, opts);
      expect(made).toMatchObject({ title: 'Fresh: card', column: 'In Progress', labels: ['x'], assignee: ['@a'], priority: 'low', order: 9000 });
      expect(made.sections.description).toBe('hello');
      if (id) expect(made.id).toBe(id);
      expect((await source.list()).cards.map((c) => c.id)).toContain(made.id);
      expect(await source.read(made.id)).toEqual(made);
      // the same preferred id again: taken, so another comes back and nothing is overwritten
      const again = await source.create({ title: 'Second', column: 'To Do', preferId: made.id }, opts);
      expect(again.id).not.toBe(made.id);
      expect((await source.read(made.id))!.title).toBe('Fresh: card');
      expect((await source.read(ids.a))!.title).toBeTruthy();
      // hostile preferred ids are ignored
      const hostile = await source.create({ title: 'Hostile', column: 'To Do', preferId: '../../evil' }, opts);
      expect(hostile.id).toMatch(/^[A-Za-z]+-\d+/);
    });

    it('numbers subcards under their parent and new cards past every id', async () => {
      const { source, ids } = await harness();
      if (!source.nextId) return;
      const sub = await source.create({ title: 'Sub', column: 'To Do', parent: ids.a }, opts);
      expect(sub.id.startsWith(`${ids.a}.`)).toBe(true);
      expect(sub.parent).toBe(ids.a);
      expect(await source.nextId(ids.a)).toBe(`${ids.a}.2`);
      const next = await source.nextId();
      expect((await source.list()).cards.map((c) => c.id)).not.toContain(next);
    });

    it('tells a watcher about outside changes and about our own writes, until it stops', async () => {
      const { source, ids, outsideEdit } = await harness();
      let n = 0;
      const stop = source.watch(() => n++);
      let m = 0;
      const stop2 = source.watch(() => m++);
      await outsideEdit(ids.b);
      expect(await waitFor(() => n > 0 && m > 0)).toBe(true);
      const seen = n;
      await source.write(ids.a, { title: 'by us' }, opts);
      expect(await waitFor(() => n > seen)).toBe(true);
      stop();
      await new Promise((r) => setTimeout(r, 300)); // anything in flight
      const frozen = n;
      const other = m;
      await outsideEdit(ids.b);
      expect(await waitFor(() => m > other)).toBe(true);
      expect(n).toBe(frozen);
      stop2();
    });

    it('lists the same cards after a re-list (no state leaks between calls)', async () => {
      const { source } = await harness();
      const one = (await source.list()).cards as Card[];
      one[0].title = 'mutated by the caller';
      expect((await source.list()).cards[0].title).not.toBe('mutated by the caller');
    });
  });
}
