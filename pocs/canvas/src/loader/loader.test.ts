// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../core';
import { cardsPlugin } from '../plugins/cards';
import { cardNode, standardDeck } from '../plugins/cards/deck';
import diceSrc from '../../examples/plugins/dice/plugin.js?raw';
import diceManifest from '../../examples/plugins/dice/manifest.json?raw';
import votesSrc from '../../examples/plugins/votes/plugin.js?raw';
import votesManifest from '../../examples/plugins/votes/manifest.json?raw';
import { createRuntime } from './runtime.js';
import { approvalKey, inProcessTransport, META_KEY, PluginHost, memoryApprovals, type RoomPlugin } from './host';
import { hashSource, parseManifest } from './manifest';
import { checkResult, readableDoc } from './policy';
import { treeToHtml } from './tree';

const DICE = { manifest: JSON.parse(diceManifest), source: diceSrc };
const VOTES = { manifest: JSON.parse(votesManifest), source: votesSrc };
// the example modules themselves (a variable path: plain JS, no types)
const path = (name: string) => `../../examples/plugins/${name}/plugin.js`;
const modules = new Map<string, unknown>([
  [DICE.source, (await import(/* @vite-ignore */ path('dice'))).default],
  [VOTES.source, (await import(/* @vite-ignore */ path('votes'))).default],
]);
const transport = inProcessTransport((src) => modules.get(src), createRuntime as never);
const tick = () => new Promise((r) => setTimeout(r, 10));

let roots: HTMLElement[] = [];
let hosts: PluginHost[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  for (const h of hosts) h.destroy();
  roots = [];
  hosts = [];
});

function setup(viewer = 'alice') {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.viewer = viewer;
  app.player = { id: viewer, name: viewer, color: '#888' };
  app.use(cardsPlugin);
  const host = new PluginHost(app, transport, memoryApprovals());
  hosts.push(host);
  return { app, host };
}

describe('manifest', () => {
  it('accepts the examples and rejects bad ones', () => {
    expect(parseManifest(DICE.manifest).capabilities).toContain('network:none');
    expect(() => parseManifest({ ...DICE.manifest, id: 'cards' })).toThrow(/reserved/);
    expect(() => parseManifest({ ...DICE.manifest, capabilities: ['root'] })).toThrow(/unknown capability/);
    expect(() => parseManifest({ ...DICE.manifest, capabilities: ['network:http://x.com'] })).toThrow();
    expect(parseManifest({ ...DICE.manifest, capabilities: ['network:https://api.x.com'] }).capabilities).toEqual(['network:https://api.x.com']);
  });
  it('hashes source', async () => {
    expect(await hashSource('a')).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(await hashSource('a')).not.toBe(await hashSource('b'));
  });
});

describe('policy', () => {
  const m = parseManifest(DICE.manifest);
  const { app } = setup();
  app.store.load({
    nodes: [
      { id: 'd', type: 'text', x: 0, y: 0, width: 1, height: 1, 'x-dice': { kind: 'die' } },
      { id: 'c', type: 'text', x: 0, y: 0, width: 1, height: 1, 'x-cards': { face: 'AS' } },
    ],
    edges: [],
  });
  it('lets a plugin read only its own nodes, others redacted when hidden', () => {
    expect(readableDoc(m, app.doc, () => false).nodes.map((n) => n.id)).toEqual(['d']);
    const all = { ...m, capabilities: [...m.capabilities, 'nodes:read:all' as const] };
    const r = readableDoc(all, app.doc, (n) => n.id === 'c').nodes;
    expect(r.map((n) => n.id).slice(0, 2)).toEqual(['d', 'c']); // (a cards migration may add a hand)
    expect(r[1]['x-cards']).toBeUndefined();
  });
  it('allows own namespace and geometry, denies other namespaces and nodes', () => {
    expect(checkResult(m, app.doc, { changes: [{ op: 'set', id: 'd', key: 'x-dice.value', value: 3 }] }).denied).toEqual([]);
    expect(checkResult(m, app.doc, { changes: [{ op: 'set', id: 'd', key: 'x', value: 3 }] }).denied).toEqual([]);
    const bad = checkResult(m, app.doc, {
      changes: [
        { op: 'set', id: 'd', key: 'x-dice.value', value: 3 },
        { op: 'set', id: 'c', key: 'x-cards.faceUp', value: true },
      ],
    });
    expect(bad.changes).toEqual([]); // all or nothing
    expect(bad.denied[0]).toMatch(/not this plugin's node/);
    expect(checkResult(m, app.doc, { changes: [{ op: 'set', id: 'd', key: 'owner', value: 'x' }] }).denied[0]).toMatch(/not writable/);
    expect(checkResult(m, app.doc, { changes: [{ op: 'del', id: 'c' }] }).denied).toHaveLength(1);
    expect(checkResult(m, app.doc, { changes: [{ op: 'add', node: { id: 'n', type: 'text', x: 0, y: 0, width: 1, height: 1 } }] }).denied[0]).toMatch(/must carry x-dice/);
    expect(checkResult(m, app.doc, { events: [{ type: 'cards.draw', text: 'x' }] }).denied[0]).toMatch(/must start with "dice."/);
    const noLog = { ...m, capabilities: m.capabilities.filter((c) => c !== 'log:write') };
    expect(checkResult(noLog, app.doc, { events: [{ type: 'dice.x', text: 'x' }] }).denied[0]).toMatch(/log:write/);
    expect(checkResult(m, app.doc, { events: [{ type: 'dice.x', text: 'x', actor: { id: 'z', name: 'Z', color: '' } }] }).events[0].actor).toBeUndefined();
  });
});

describe('render trees', () => {
  it('nodes without a tag are divs; classes get the plugin prefix', () => {
    expect(treeToHtml({ class: 'face', children: [1, null, 'x'] }, 'dice')).toBe('<div class="px-dice-face">1x</div>');
  });
  it('sanitizes tags, styles, classes and text', () => {
    const html = treeToHtml(
      {
        tag: 'script',
        class: 'ok bad"x',
        style: { color: 'red', background: 'url(https://evil)', position: 'fixed' },
        action: 'roll',
        children: ['<img src=x onerror=alert(1)>', { tag: 'button', text: 'go' }],
      },
      'dice',
    );
    expect(html).toBe('<span class="px-dice-ok" style="color:red" data-action="roll">&#60;img src=x onerror=alert(1)&#62;<button type="button">go</button></span>');
  });
});

describe('plugin host (in-process sandbox)', () => {
  it('installs into the room, renders through the bridge, runs commands as undo steps', async () => {
    const { app, host } = setup();
    app.store.load({ nodes: [], edges: [] });
    await host.install(DICE.manifest, DICE.source, 'examples/plugins/dice/manifest.json');
    expect(host.status('dice')).toBe('running');
    expect((app.store.meta.get(META_KEY) as RoomPlugin[]).map((p) => p.manifest.id)).toEqual(['dice']);
    expect(app.kits.map((k) => k.id)).toContain('dice.d6');
    app.kits.find((k) => k.id === 'dice.d6')!.create(app, { x: 0, y: 0 });
    await tick();
    const die = app.doc.nodes.find((n) => n['x-dice'])!;
    expect(die).toBeTruthy();
    await tick();
    const box = app.view.boxOf(die.id)!;
    expect(box.querySelector('[data-action="roll"]')).toBeTruthy();
    const r = await host.run('dice', 'roll', { ids: [die.id] });
    expect(r.ok).toBe(true);
    expect((app.node(die.id)!['x-dice'] as { rolls: number }).rolls).toBe(1);
    expect(app.store.log.toArray().at(-1)!.text).toMatch(/^rolled \d+$/);
    app.store.undo();
    expect((app.node(die.id)!['x-dice'] as { rolls: number }).rolls).toBe(0);
  });

  it('denies writes to another plugin and leaves the doc alone', async () => {
    const { app, host } = setup();
    app.store.load({ nodes: [cardNode('c', 300, 0, { face: standardDeck()[0], faceUp: false }, 1)], edges: [] });
    await host.install(DICE.manifest, DICE.source);
    await host.run('dice', 'create', { x: 0, y: 0 });
    const r = await host.run('dice', 'flipCards', { ids: ['c'] });
    expect(r.ok).toBe(false);
    expect(r.denied[0]).toMatch(/not this plugin's node/);
    expect((app.node('c')!['x-cards'] as { faceUp: boolean }).faceUp).toBe(false);
    // it can't even see the card
    await host.run('dice', 'look', {});
    expect(app.store.log.toArray().at(-1)!.text).toMatch(/can see 1 node/);
    // and can't speak for another player
    await host.run('dice', 'impersonate', {});
    expect(app.store.log.toArray().at(-1)!.actor?.name).toBe('alice');
  });

  it('a peer loads the room plugins only after approving them', async () => {
    const a = setup('alice');
    await a.host.install(VOTES.manifest, VOTES.source);
    await a.host.run('votes', 'create', { at: { x: 0, y: 0 }, input: 'Ship it' });
    // bob gets the same doc (as sync would deliver it)
    const b = setup('bob');
    const Y = await import('yjs');
    Y.applyUpdate(b.app.store.ydoc, Y.encodeStateAsUpdate(a.app.store.ydoc));
    await b.host.sync();
    expect(b.host.status('votes')).toBe('awaiting approval');
    expect(b.app.kits.some((k) => k.id.startsWith('votes.'))).toBe(false);
    await b.host.approve(b.host.roomPlugins()[0]);
    expect(b.host.status('votes')).toBe('running');
    const note = b.app.doc.nodes.find((n) => n['x-votes'])!;
    await b.host.run('votes', 'vote', { ids: [note.id] });
    expect(Object.keys((b.app.node(note.id)!['x-votes'] as { by: object }).by)).toEqual(['bob']);
  });

  it('asks again when a peer changes the capabilities of approved code', async () => {
    const a = setup('alice');
    await a.host.install(DICE.manifest, DICE.source);
    const b = setup('bob');
    const Y = await import('yjs');
    Y.applyUpdate(b.app.store.ydoc, Y.encodeStateAsUpdate(a.app.store.ydoc));
    await b.host.approve(b.host.roomPlugins()[0]);
    expect(b.host.status('dice')).toBe('running');
    const [e] = a.host.roomPlugins();
    a.app.store.meta.set(META_KEY, [{ ...e, manifest: { ...e.manifest, capabilities: [...e.manifest.capabilities.filter((c) => c !== 'network:none'), 'network:https://evil.example'] } }]);
    Y.applyUpdate(b.app.store.ydoc, Y.encodeStateAsUpdate(a.app.store.ydoc));
    await b.host.sync();
    expect(b.host.loaded.has('dice')).toBe(false);
    expect(b.host.status('dice')).toBe('awaiting approval');
  });

  it('refuses code that does not match the pinned hash', async () => {
    const { app, host } = setup();
    const entry: RoomPlugin = { manifest: parseManifest(DICE.manifest), hash: await hashSource(DICE.source), source: DICE.source + '\n// tampered' };
    host.approvals.add(approvalKey(entry));
    app.store.meta.set(META_KEY, [entry]);
    await host.sync();
    expect(host.loaded.has('dice')).toBe(false);
    expect(host.notices.at(-1)!.text).toMatch(/does not match its hash/);
  });

  it('ignores room entries a peer wrote with an invalid manifest', async () => {
    const { app, host } = setup();
    const hash = await hashSource(DICE.source);
    const bad = (m: object): RoomPlugin => ({ manifest: { ...DICE.manifest, ...m }, hash, source: DICE.source });
    app.store.meta.set(META_KEY, [bad({ id: 'cards' }), bad({ id: 'a" onclick="x' }), bad({ capabilities: ['root'] }), bad({})]);
    expect(host.roomPlugins().map((p) => p.manifest.id)).toEqual(['dice']);
  });

  it('uninstall unregisters kits and types', async () => {
    const { app, host } = setup();
    await host.install(DICE.manifest, DICE.source);
    const n = app.types.length;
    host.uninstall('dice');
    await host.sync();
    expect(app.types.length).toBe(n - 1);
    expect(app.kits.some((k) => k.id.startsWith('dice.'))).toBe(false);
  });
});
