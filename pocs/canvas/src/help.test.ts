import { describe, expect, it } from 'vitest';
import { Store } from './core/store';
import { removeHelpNote } from './help';

describe('help note removal', () => {
  it('drops the old on-table help note on load, keeps other notes; idempotent', () => {
    const s = new Store();
    s.migrations.push(removeHelpNote);
    const note = (id: string, text: string) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text });
    s.load({
      nodes: [
        note('help', 'Card table\n\nDrag cards • double-click or F to flip\n...'),
        note('h2', 'Card table\n\nDrag cards • older wording'),
        note('mine', 'Card table rules for Friday'),
        note('other', 'Drag cards here'),
      ],
      edges: [],
    });
    expect(s.doc.nodes.map((n) => n.id).sort()).toEqual(['mine', 'other']);
    s.migrate();
    expect(s.doc.nodes).toHaveLength(2);
  });
});
