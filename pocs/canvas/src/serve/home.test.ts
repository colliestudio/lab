// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountHome } from './home';

type Entry = { name: string; loaded: boolean; browsers: number; modified?: number; error?: string };
let entries: Entry[];
let calls: { url: string; body?: string }[];
let refuse: Record<string, { status: number; error: string }>;

const fake = (async (url: string, init?: RequestInit) => {
  calls.push({ url, body: init?.body as string | undefined });
  const no = refuse[url];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (no) return reply(no.status, { error: no.error });
  if (url === '/api/boards' && !init) return reply(200, entries);
  if (url === '/api/boards') {
    entries.push({ name: JSON.parse(init!.body as string).name, loaded: false, browsers: 0 });
    return reply(201, { name: JSON.parse(init!.body as string).name });
  }
  return reply(200, {});
}) as unknown as typeof fetch;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

let root: HTMLElement;
let home: ReturnType<typeof mountHome>;
beforeEach(async () => {
  entries = [{ name: 'alpha', loaded: false, browsers: 0 }, { name: 'my board', loaded: true, browsers: 2, error: 'format 99' }];
  calls = [];
  refuse = {};
  document.body.innerHTML = '<div id="home"></div>';
  root = document.getElementById('home')!;
  home = mountHome(root, fake);
  await flush();
});
afterEach(() => {
  home.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('board list page', () => {
  it('lists boards as real links that open in a new tab, with state and error', () => {
    const links = [...root.querySelectorAll<HTMLAnchorElement>('td.name a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel])).toEqual([
      ['alpha', '/b/alpha', '_blank', 'noopener'],
      ['my board', '/b/my%20board', '_blank', 'noopener'],
    ]);
    expect(root.textContent).toContain('open · 2 browsers');
    expect(root.textContent).toContain('format 99');
  });

  it('New creates, refreshes and highlights the new row without opening anything', async () => {
    const open = vi.spyOn(window, 'open');
    (root.querySelector('.home-new input') as HTMLInputElement).value = ' fresh ';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(calls.find((c) => c.body)).toMatchObject({ url: '/api/boards', body: '{"name":"fresh"}' });
    expect(root.querySelector('tr.fresh')?.getAttribute('data-name')).toBe('fresh');
    expect(open).not.toHaveBeenCalled();
  });

  it('a refused New shows the service text and leaves the list', async () => {
    refuse['/api/boards'] = { status: 409, error: 'a board named "x" exists' };
    const before = root.querySelectorAll('tbody tr').length;
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // the POST is refused; the GET for the list is refused too in this fake, so only check the message
    expect(root.querySelector('.home-new + .home-error')!.textContent).toBe('a board named "x" exists');
    expect(root.querySelectorAll('tbody tr').length).toBe(before);
  });

  it('a refused rename keeps the row and shows the text inline', async () => {
    refuse['/api/boards/alpha/rename'] = { status: 409, error: 'alpha is open (1 browser); close it first' };
    root.querySelector<HTMLButtonElement>('tr[data-name="alpha"] .home-btn')!.click();
    const field = root.querySelector<HTMLInputElement>('.home-rename')!;
    field.value = 'beta';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(root.querySelector('tr[data-name="alpha"] .home-error')!.textContent).toBe('alpha is open (1 browser); close it first');
    expect(root.querySelector('tr[data-name="alpha"]')).not.toBeNull();
  });

  it('rename to the same name sends nothing; Esc cancels', async () => {
    root.querySelector<HTMLButtonElement>('tr[data-name="alpha"] .home-btn')!.click();
    const field = root.querySelector<HTMLInputElement>('.home-rename')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(root.querySelector('.home-rename')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/rename'))).toBe(false);
  });

  it('delete asks first, mentioning the trash; cancel sends nothing', async () => {
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const del = () => [...root.querySelectorAll<HTMLButtonElement>('tr[data-name="alpha"] .home-btn')].find((b) => b.textContent === 'Delete')!;
    del().click();
    await flush();
    expect(ask).toHaveBeenCalledWith(expect.stringContaining('trash'));
    expect(calls.some((c) => c.url.endsWith('/delete'))).toBe(false);
    ask.mockReturnValue(true as never);
    del().click();
    await flush();
    expect(calls.some((c) => c.url === '/api/boards/alpha/delete')).toBe(true);
  });

  it('a failing list shows a banner and recovers', async () => {
    refuse['/api/boards'] = { status: 502, error: 'bad gateway' };
    await home.refresh();
    expect(root.querySelector<HTMLElement>('.home-banner')!.hidden).toBe(false);
    expect(root.querySelector('.home-banner')!.textContent).toContain('Can’t reach the canvas service: bad gateway');
    expect(root.querySelectorAll('tbody tr').length).toBe(2); // the last list stays
    refuse = {};
    await home.refresh();
    expect(root.querySelector<HTMLElement>('.home-banner')!.hidden).toBe(true);
  });

  it('a row error survives the next refresh', async () => {
    refuse['/api/boards/my%20board/delete'] = { status: 409, error: 'my board is open (2 browsers); close it first' };
    vi.stubGlobal('confirm', () => true);
    [...root.querySelectorAll<HTMLButtonElement>('tr[data-name="my board"] .home-btn')].find((b) => b.textContent === 'Delete')!.click();
    await flush();
    delete refuse['/api/boards/my%20board/delete'];
    await home.refresh();
    expect([...root.querySelectorAll('tr[data-name="my board"] .home-error')].map((e) => e.textContent).join(' ')).toContain('is open (2 browsers)');
  });

  it('leaving a rename field cancels it, and the list then takes New and Delete', async () => {
    root.querySelector<HTMLButtonElement>('tr[data-name="alpha"] .home-btn')!.click();
    expect(root.querySelectorAll('.home-rename')).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('tr[data-name="my board"] .home-btn')!.click(); // a second Rename: the first closes
    expect(root.querySelectorAll('.home-rename')).toHaveLength(1);
    root.querySelector<HTMLInputElement>('.home-rename')!.blur();
    expect(root.querySelectorAll('.home-rename')).toHaveLength(0);
    entries.push({ name: 'added', loaded: false, browsers: 0 });
    await home.refresh();
    expect([...root.querySelectorAll('td.name a')].map((a) => a.textContent)).toContain('added');
  });

  it('a rename that succeeds while another row is being edited leaves that field alone', async () => {
    const renameReply: { done?: () => void } = {};
    const slow = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/rename')) {
        await new Promise<void>((r) => (renameReply.done = r));
        entries[0].name = 'renamed';
        return new Response('{"name":"renamed"}', { headers: { 'content-type': 'application/json' } });
      }
      return fake(url, init);
    }) as unknown as typeof fetch;
    home.stop();
    root = document.getElementById('home')!;
    home = mountHome(root, slow);
    await flush();
    root.querySelector<HTMLButtonElement>('tr[data-name="alpha"] .home-btn')!.click();
    const first = root.querySelector<HTMLInputElement>('.home-rename')!;
    first.value = 'renamed';
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    root.querySelector<HTMLButtonElement>('tr[data-name="my board"] .home-btn')!.click(); // while the first is in flight
    renameReply.done!();
    await flush();
    expect(root.querySelectorAll('.home-rename')).toHaveLength(1);
    expect(root.querySelector<HTMLInputElement>('.home-rename')!.getAttribute('aria-label')).toContain('my board');
    const link = root.querySelector('tr[data-name="alpha"] td.name a')!;
    expect([link.textContent, link.getAttribute('href')]).toEqual(['renamed', '/b/renamed']);
  });

  it('an older list reply that arrives late is dropped', async () => {
    const waits: ((v: Response) => void)[] = [];
    const lagging = (async () => new Promise<Response>((r) => waits.push(r))) as unknown as typeof fetch;
    home.stop();
    root = document.getElementById('home')!;
    home = mountHome(root, lagging); // request 1 pending
    const second = home.refresh(); // request 2
    const body = (list: Entry[]) => new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } });
    waits[1](body([{ name: 'new', loaded: false, browsers: 0 }]));
    await second;
    waits[0](body([{ name: 'old', loaded: false, browsers: 0 }]));
    await flush();
    expect([...root.querySelectorAll('td.name a')].map((a) => a.textContent)).toEqual(['new']);
  });
});
