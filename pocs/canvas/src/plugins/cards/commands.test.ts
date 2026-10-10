import { describe, expect, it } from 'vitest';
import { applyChanges, emptyDoc, parse, runCommand, serialize, type CanvasDoc, type CommandCtx } from '../../core';
import { draw, flip, gather, setup, shuffle, spread } from './commands';
import { cardNode, cardsOf, isCard, isStack, stackNode, standardDeck, type CardData } from './deck';

function ctx(seed = 1): CommandCtx {
  let n = 0;
  let s = seed;
  return {
    newId: () => `id${++n}`,
    random: () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646,
  };
}
const run = <A>(cmd: Parameters<typeof runCommand<A>>[0], d: CanvasDoc, args: A, c = ctx()) => {
  const r = runCommand(cmd, d, args, c);
  return { doc: applyChanges(d, r.changes), select: r.select };
};
const deck = (n: number, faceUp = false): CardData[] => standardDeck().slice(0, n).map((face) => ({ face, faceUp }));
const docOf = (...nodes: CanvasDoc['nodes']): CanvasDoc => ({ nodes, edges: [] });

describe('cards commands', () => {
  it('setup lays out all 52 cards with readable text labels', () => {
    const { doc } = run(setup, emptyDoc(), {});
    const all = doc.nodes.flatMap(cardsOf).map((c) => c.face);
    expect(all.sort()).toEqual(standardDeck().sort());
    const card = doc.nodes.find(isCard)!;
    expect(card.type).toBe('text');
    expect(card.text).toMatch(/^(10|[2-9AJQK])[♠♥♦♣]$/);
    expect(card['x-cards']).toMatchObject({ pack: 'standard-52' });
  });

  it('flip toggles a card and turns a stack over', () => {
    const d = docOf(cardNode('c', 0, 0, { face: 'AS', faceUp: false }), stackNode('s', 0, 0, deck(3)));
    const { doc } = run(flip, d, { ids: ['c', 's'] });
    expect(doc.nodes[0]['x-cards']).toEqual({ pack: 'standard-52', face: 'AS', faceUp: true });
    expect(cardsOf(doc.nodes[1])).toEqual([
      { face: '3S', faceUp: true },
      { face: '2S', faceUp: true },
      { face: 'AS', faceUp: true },
    ]);
  });

  it('shuffle permutes a stack deterministically for a given rng', () => {
    const d = docOf(stackNode('s', 0, 0, deck(52)));
    const a = run(shuffle, d, { ids: ['s'] }, ctx(7)).doc;
    const b = run(shuffle, d, { ids: ['s'] }, ctx(7)).doc;
    const faces = (x: CanvasDoc) => cardsOf(x.nodes[0]).map((c) => c.face);
    expect(faces(a)).toEqual(faces(b));
    expect(faces(a)).not.toEqual(faces(d));
    expect([...faces(a)].sort()).toEqual([...faces(d)].sort());
  });

  it('draw takes the top card; the last card turns the stack into a card', () => {
    let d = docOf(stackNode('s', 0, 0, deck(2)));
    let r = run(draw, d, { id: 's', faceUp: true });
    d = r.doc;
    expect(r.select).toEqual(['id1']);
    const drawn = d.nodes.find((n) => n.id === 'id1')!;
    expect(drawn['x-cards']).toMatchObject({ face: '2S', faceUp: true });
    expect(drawn.x).toBeGreaterThan(0);
    const s = d.nodes.find((n) => n.id === 's')!;
    expect(isCard(s)).toBe(true);
    expect(s['x-cards']).toMatchObject({ face: 'AS' });
    // a card isn't a stack: nothing to draw
    expect(runCommand(draw, d, { id: 's' }, ctx()).changes).toEqual([]);
  });

  it('draw places repeated draws in the next free slot', () => {
    let d = docOf(stackNode('s', 0, 0, deck(5)));
    d = run(draw, d, { id: 's' }, ctx()).doc;
    d = applyChanges(d, runCommand(draw, d, { id: 's' }, { ...ctx(), newId: () => 'second' }).changes);
    const xs = d.nodes.filter((n) => n.id !== 's').map((n) => n.x);
    expect(new Set(xs).size).toBe(2);
  });

  it('gather stacks cards at the first node, first on the bottom', () => {
    const d = docOf(
      cardNode('a', 10, 20, { face: 'AS', faceUp: true }),
      stackNode('s', 100, 100, deck(2)),
      cardNode('b', 50, 50, { face: 'KH', faceUp: false }),
    );
    const { doc, select } = run(gather, d, { ids: ['b', 's', 'a'] });
    expect(doc.nodes).toHaveLength(1);
    const st = doc.nodes[0];
    expect(isStack(st)).toBe(true);
    expect([st.x, st.y]).toEqual([50, 50]);
    expect(select).toEqual([st.id]);
    expect(cardsOf(st).map((c) => c.face)).toEqual(['KH', 'AS', '2S', 'AS']);
    // dropping onto a stack keeps the stack's id
    const onStack = run(gather, d, { ids: ['s', 'a'] }).doc;
    expect(onStack.nodes.find((n) => n.id === 's') && cardsOf(onStack.nodes.at(-1)!).length).toBe(3);
  });

  it('spread turns a stack into a row of cards', () => {
    const { doc, select } = run(spread, docOf(stackNode('s', 0, 0, deck(4))), { id: 's' });
    expect(doc.nodes.every(isCard)).toBe(true);
    expect(doc.nodes.map((n) => n.x)).toEqual([0, 30, 60, 90]);
    expect(select).toHaveLength(4);
  });

  it('a set-up table survives a .canvas round trip', () => {
    const { doc } = run(setup, emptyDoc(), {});
    expect(parse(serialize(doc))).toEqual(doc);
  });
});
