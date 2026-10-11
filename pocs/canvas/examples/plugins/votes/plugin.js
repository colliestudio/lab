// Sticky votes: an external canvas plugin. A note holds its text and who voted for it
// (x-votes.by = { playerId: true }); one vote per player, toggled by the ▲ button.

const COLORS = ['#ffe680', '#ffb3c1', '#b3e5ff', '#c2f0c2'];

const noteNode = (id, at, text, z, n) => ({
  id,
  type: 'text',
  x: Math.round(at.x),
  y: Math.round(at.y),
  width: 180,
  height: 120,
  z,
  text,
  'x-votes': { kind: 'note', bg: COLORS[n % COLORS.length], by: {} },
});

const notes = (doc) => doc.nodes.filter((n) => n['x-votes']?.kind === 'note');
const count = (n) => Object.keys(n['x-votes'].by || {}).length;
const short = (t) => (t.length > 30 ? t.slice(0, 29) + '…' : t);

export default {
  types: {
    note: {
      actions: { vote: 'vote' },
      render(node, ctx) {
        const v = node['x-votes'];
        const mine = !!v.by?.[ctx.viewer];
        const n = Object.keys(v.by || {}).length;
        return {
          style: { width: '100%', height: '100%', background: v.bg, color: '#333', padding: '10px', 'border-radius': '4px', 'box-shadow': '0 3px 8px rgba(0,0,0,0.35)', display: 'flex', 'flex-direction': 'column', 'justify-content': 'space-between', overflow: 'hidden' },
          children: [
            { style: { 'font-size': '15px', 'line-height': '1.3', 'white-space': 'pre-wrap' }, text: node.text },
            {
              tag: 'button',
              action: 'vote',
              title: mine ? 'Take your vote back' : 'Vote for this note',
              style: { 'align-items': 'center', border: '0', 'border-radius': '12px', padding: '2px 10px', background: mine ? '#333' : 'rgba(0,0,0,0.12)', color: mine ? '#fff' : '#333', 'font-size': '13px', cursor: 'pointer' },
              text: `▲ ${n}`,
            },
          ],
        };
      },
    },
  },

  commands: {
    create(doc, at, ctx) {
      const p = at?.at ?? at ?? { x: 0, y: 0 };
      const text = typeof at?.input === 'string' && at.input.trim() ? at.input.trim().slice(0, 300) : 'New idea';
      return { changes: [{ op: 'add', node: noteNode(ctx.newId(), { x: p.x - 90, y: p.y - 60 }, text, doc.topZ + 1, notes(doc).length) }] };
    },
    vote(doc, a, ctx) {
      const n = doc.get(a?.ids?.[0]);
      if (!n?.['x-votes']) return [];
      const me = ctx.actor.id;
      const had = !!n['x-votes'].by?.[me];
      return {
        changes: [{ op: 'set', id: n.id, key: 'x-votes.by', value: { ...n['x-votes'].by, [me]: had ? undefined : true } }],
        events: [{ type: had ? 'votes.unvote' : 'votes.vote', text: `${had ? 'took back a vote for' : 'voted for'} "${short(n.text)}"`, targets: [n.id], key: `vote:${n.id}` }],
      };
    },
    edit(doc, a) {
      const n = doc.get(a?.ids?.[0]);
      if (!n || typeof a?.input !== 'string') return [];
      return [{ op: 'set', id: n.id, key: 'text', value: a.input.slice(0, 300) }];
    },
    clear(doc, a) {
      const ids = a?.ids?.length ? a.ids : notes(doc).map((n) => n.id);
      return {
        changes: ids.filter((id) => doc.get(id)?.['x-votes']).map((id) => ({ op: 'set', id, key: 'x-votes.by', value: {} })),
        events: [{ type: 'votes.clear', text: 'cleared the votes' }],
      };
    },
    /** Line the notes up by votes, most first, starting where the top-voted one is. */
    sort(doc) {
      const all = notes(doc);
      if (!all.length) return [];
      const sorted = [...all].sort((a, b) => count(b) - count(a));
      const x0 = Math.min(...all.map((n) => n.x));
      const y0 = Math.min(...all.map((n) => n.y));
      const changes = sorted.flatMap((n, i) => [
        { op: 'set', id: n.id, key: 'x', value: x0 + (i % 4) * 200 },
        { op: 'set', id: n.id, key: 'y', value: y0 + Math.floor(i / 4) * 140 },
      ]);
      return { changes, events: [{ type: 'votes.sort', text: `sorted ${all.length} notes by votes (top: "${short(sorted[0].text)}", ${count(sorted[0])})` }] };
    },
  },

  kits: [{ id: 'note', label: 'Sticky note · Votes plugin', command: 'create' }],

  menu: [
    { label: 'Edit text…', type: 'note', min: 1, max: 1, command: 'edit', prompt: 'Note text' },
    { label: 'Clear votes', type: 'note', min: 1, command: 'clear' },
    { label: 'Add sticky note…', max: 0, command: 'create', prompt: 'Note text' },
    { label: 'Sort notes by votes', max: 0, command: 'sort' },
  ],
};
