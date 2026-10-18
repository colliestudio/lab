import { describe, expect, it } from 'vitest';
import { Store } from './core/store';
import { GROUPS, removeHelpNote } from './help';

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

describe('help sheet', () => {
  const text = GROUPS.flatMap(([, rows]) => rows.flat()).join('\n');
  it('describes the screen: menu, dock, top right, bottom right', () => {
    const screen = GROUPS.find(([t]) => t === 'Screen')!;
    expect(screen[1].map(([k]) => k).join()).toMatch(/Menu.*Dock.*People.*Zoom/);
  });
  it('does not send people to buttons that no longer exist', () => {
    expect(text).not.toMatch(/toolbar|Add…|▶ Play|\(toolbar\)/);
  });
  it('says where New hand and Play live', () => {
    expect(text).toMatch(/Menu ▸ Game ▸ New hand/);
    expect(text).toMatch(/Menu ▸ Game ▸ Play prototype/);
  });
});
