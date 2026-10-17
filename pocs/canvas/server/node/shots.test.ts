import { describe, expect, it } from 'vitest';
import { makeActor } from '../core/host';
import { ShotError, type ShotRequest } from '../core/shots';
import { HeadlessShots, type ShotBrowser, type ShotPage } from './shots';

// HeadlessShots with a fake browser: how views are kept, serialized and closed.

const req = (over: Partial<ShotRequest> = {}): ShotRequest => ({ target: { kind: 'all' }, width: 1000, height: 750, padding: 40, labels: false, stateVector: 'AA==', ...over });
const claude = makeActor('Claude');
const codex = makeActor('Codex');

function fake(opts: { status?: number; frame?: (expr: string) => Promise<unknown> } = {}) {
  const f = {
    launches: 0,
    pages: [] as { url: string; closed: boolean; viewports: { width: number; height: number }[]; active: number; maxActive: number }[],
    disconnect: () => {},
    closedBrowser: false,
    launch: async (): Promise<ShotBrowser> => {
      f.launches++;
      await new Promise((r) => setTimeout(r, 5));
      let onDisc = () => {};
      f.disconnect = () => onDisc();
      return {
        on: (_e, fn) => void (onDisc = fn),
        close: async () => void (f.closedBrowser = true),
        newContext: async ({ viewport }) => {
          const rec = { url: '', closed: false, viewports: [viewport], active: 0, maxActive: 0 };
          f.pages.push(rec);
          return {
            close: async () => void (rec.closed = true),
            newPage: async (): Promise<ShotPage> => ({
              goto: async (url) => ((rec.url = url), { status: () => opts.status ?? 200 }),
              evaluate: async (expr) => {
                if (!expr.includes('canvasShot.frame')) return true;
                rec.active++;
                rec.maxActive = Math.max(rec.maxActive, rec.active);
                try {
                  return opts.frame ? await opts.frame(expr) : (await new Promise((r) => setTimeout(r, 10)), { nodes: [{ id: 'a', type: 'text', box: [0, 0, 1, 1] }] });
                } finally {
                  rec.active--;
                }
              },
              setViewportSize: async (s) => void rec.viewports.push(s),
              screenshot: async () => new Uint8Array([137, 80]),
              close: async () => {},
            }),
          };
        },
      };
    },
  };
  return f;
}
const make = (f: ReturnType<typeof fake>, o: Partial<ConstructorParameters<typeof HeadlessShots>[0]> = {}) =>
  new HeadlessShots({ pageUrl: (b, id) => `http://x/b/${b}?agentView=${id}`, log: () => {}, launch: f.launch, ...o });

describe('HeadlessShots', () => {
  it('concurrent first calls launch the browser once; one view per (board, seat)', async () => {
    const f = fake();
    const s = make(f);
    const [a, b] = await Promise.all([s.shoot('demo', claude, req()), s.shoot('demo', claude, req())]);
    expect(f.launches).toBe(1);
    expect(f.pages).toHaveLength(1);
    expect(f.pages[0].url).toBe('http://x/b/demo?agentView=agent:claude');
    expect(a.png).toEqual(new Uint8Array([137, 80]));
    expect(b.nodes[0].id).toBe('a');
    await s.shoot('demo', codex, req());
    await s.shoot('other', claude, req());
    expect(f.pages.map((p) => p.url)).toEqual(['http://x/b/demo?agentView=agent:claude', 'http://x/b/demo?agentView=agent:codex', 'http://x/b/other?agentView=agent:claude']);
    await s.close();
  });

  it('shots on one view run one at a time; the viewport changes only when the size does', async () => {
    const f = fake();
    const s = make(f);
    await Promise.all([1, 2, 3].map(() => s.shoot('demo', claude, req())));
    expect(f.pages[0].maxActive).toBe(1);
    expect(f.pages[0].viewports).toHaveLength(1); // set at context creation only
    await s.shoot('demo', claude, req({ width: 500, height: 400 }));
    await s.shoot('demo', claude, req({ width: 500, height: 400 }));
    expect(f.pages[0].viewports).toEqual([{ width: 1000, height: 750 }, { width: 500, height: 400 }]);
    await s.close();
  });

  it('a launch failure is a 503 with the no-browser text, and the next call tries again', async () => {
    let n = 0;
    const f = fake();
    const s = make(f, { launch: async () => (n++ ? f.launch() : Promise.reject(new Error('Executable doesn’t exist'))) });
    const e = await s.shoot('demo', claude, req()).catch((x) => x);
    expect(e).toBeInstanceOf(ShotError);
    expect(e).toMatchObject({ status: 503, message: expect.stringContaining('no browser for screenshots') });
    expect((await s.shoot('demo', claude, req())).png.length).toBe(2);
    await s.close();
  });

  it('a build-less app (503 on the page) says to run pnpm build', async () => {
    const s = make(fake({ status: 503 }));
    await expect(s.shoot('demo', claude, req())).rejects.toMatchObject({ status: 503, message: expect.stringContaining('pnpm build') });
  });

  it('a node the seat can not see is a 400 and the view stays; other page errors drop the view', async () => {
    let fail = '';
    const f = fake({ frame: async () => (fail ? Promise.reject(new Error(fail)) : { nodes: [] }) });
    const s = make(f);
    fail = 'page.evaluate: Error: node c0 is not shown to agent:claude\n    at ...';
    await expect(s.shoot('demo', claude, req())).rejects.toMatchObject({ status: 400, message: 'node c0 is not shown to agent:claude' });
    fail = '';
    await s.shoot('demo', claude, req());
    expect(f.pages).toHaveLength(1);
    fail = 'Target page crashed';
    await expect(s.shoot('demo', claude, req())).rejects.toThrow('screenshot failed');
    expect(f.pages[0].closed).toBe(true);
    fail = '';
    await s.shoot('demo', claude, req());
    expect(f.pages).toHaveLength(2);
    await s.close();
  });

  it('a browser that disconnects is relaunched by the next call', async () => {
    const f = fake();
    const s = make(f);
    await s.shoot('demo', claude, req());
    f.disconnect();
    await s.shoot('demo', claude, req());
    expect(f.launches).toBe(2);
    expect(f.pages).toHaveLength(2);
    await s.close();
  });

  it('the sweep closes idle views, then the idle browser', async () => {
    const f = fake();
    const s = make(f, { idleMs: 1000, browserIdleMs: 5000 });
    await s.shoot('demo', claude, req());
    const t = Date.now();
    await s.sweep(t + 500);
    expect(f.pages[0].closed).toBe(false);
    await s.sweep(t + 1500);
    expect(f.pages[0].closed).toBe(true);
    expect(f.closedBrowser).toBe(false);
    await s.sweep(t + 1500 + 4000);
    expect(f.closedBrowser).toBe(false);
    await s.sweep(t + 1500 + 5000);
    expect(f.closedBrowser).toBe(true);
    await s.shoot('demo', claude, req());
    expect(f.launches).toBe(2);
    await s.close();
  });

  it('drop(board) closes only that board’s views and says how many; close() closes everything', async () => {
    const f = fake();
    const s = make(f);
    await s.shoot('a', claude, req());
    await s.shoot('a', codex, req());
    await s.shoot('b', claude, req());
    expect(await s.drop('a')).toBe(2);
    expect(f.pages.map((p) => p.closed)).toEqual([true, true, false]);
    expect(await s.drop('a')).toBe(0);
    await s.close();
    expect(f.pages.every((p) => p.closed)).toBe(true);
    expect(f.closedBrowser).toBe(true);
  });

  it('keeps at most maxViews warm: the least recently used goes first', async () => {
    const f = fake();
    const s = make(f, { maxViews: 2 });
    await s.shoot('a', claude, req());
    await new Promise((r) => setTimeout(r, 3));
    await s.shoot('b', claude, req());
    await new Promise((r) => setTimeout(r, 3));
    await s.shoot('c', claude, req());
    expect(f.pages.map((p) => p.closed)).toEqual([true, false, false]);
    await s.close();
  });

  it('the cap counts pending opens: extra seats fail fast with a 503 and no view is torn down mid-shot', async () => {
    const f = fake();
    const s = make(f, { maxViews: 3 });
    const seats = Array.from({ length: 10 }, (_, i) => makeActor(`Seat ${i}`));
    const results = await Promise.allSettled(seats.map((a) => s.shoot('demo', a, req())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 503, message: expect.stringContaining('too many screenshot views') });
    expect(f.pages).toHaveLength(3);
    expect(f.pages.every((p) => !p.closed)).toBe(true);
    // all idle again: a new seat takes the place of the oldest
    await s.shoot('demo', makeActor('Late'), req());
    expect(f.pages.filter((p) => !p.closed)).toHaveLength(3);
    await s.close();
  });

  it('a view with a shot in flight is never evicted to make room', async () => {
    let release = () => {};
    let first = true;
    const f = fake({ frame: (_e) => (first ? ((first = false), new Promise((r) => (release = () => r({ nodes: [] })))) : Promise.resolve({ nodes: [] })) });
    const s = make(f, { maxViews: 1 });
    const slow = s.shoot('demo', claude, req());
    await new Promise((r) => setTimeout(r, 20));
    await expect(s.shoot('demo', codex, req())).rejects.toMatchObject({ status: 503 });
    release();
    await slow;
    expect(f.pages[0].closed).toBe(false);
    await s.close();
  });

  it('a warm view is not evicted by another seat asking in the same tick', async () => {
    const f = fake();
    const s = make(f, { maxViews: 1 });
    await s.shoot('demo', claude, req());
    const [a, b] = await Promise.allSettled([s.shoot('demo', claude, req()), s.shoot('demo', codex, req())]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { status: 503 } });
    expect(f.pages[0].closed).toBe(false);
    await s.close();
  });

  it('a stale shot that fails after its view was closed does not drop the seat’s newer view', async () => {
    let fail = () => {};
    let first = true;
    const f = fake({ frame: (_e) => (first ? ((first = false), new Promise((_r, no) => (fail = () => no(new Error('Target page closed'))))) : Promise.resolve({ nodes: [] })) });
    const s = make(f);
    const stale = s.shoot('demo', claude, req()).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.drop('demo')).toBe(1);
    await s.shoot('demo', claude, req()); // opens a new view for the same seat
    fail();
    expect(await stale).toBeInstanceOf(Error);
    expect(f.pages).toHaveLength(2);
    expect(f.pages[1].closed).toBe(false);
    expect(await s.drop('demo')).toBe(1); // the new view is still tracked
    expect(f.pages[1].closed).toBe(true);
    await s.close();
  });

  it('a board that is gone says so as a 400', async () => {
    const f = fake();
    const s = make(f, { launch: async () => {
      const b = await f.launch();
      const nc = b.newContext;
      b.newContext = async (o) => {
        const c = await nc(o);
        const np = c.newPage;
        c.newPage = async () => ({ ...(await np()), evaluate: async () => { throw new Error('page.evaluate: Error: board not found: no board "x"\n  at'); } });
        return c;
      };
      return b;
    } });
    await expect(s.shoot('x', claude, req())).rejects.toMatchObject({ status: 400, message: 'board not found: no board "x"' });
    await s.close();
  });
});
