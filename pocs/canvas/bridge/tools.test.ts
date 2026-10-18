import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import type { Client, ShotReply } from './client';
import { toolList } from './tools';

// The 27 tools agents had before commands described themselves, and the size of the tool list then.
const TODAYS = ['canvas_list', 'canvas_add_node', 'canvas_update_node', 'canvas_connect', 'canvas_remove', 'canvas_undo', 'canvas_log', 'canvas_add_shape', 'canvas_style_shape', 'canvas_arrow', 'canvas_edit_arrow', 'canvas_remove_arrow', 'chess_state', 'chess_sit', 'chess_new_game', 'chess_move', 'chess_wait_for_turn', 'chess_takeback', 'chess_resign', 'chat_send', 'chat_read', 'chat_wait', 'canvas_draw_new', 'canvas_draw_shapes', 'canvas_draw_add', 'canvas_draw_remove', 'canvas_draw_frame'];
const GENERIC = ['canvas_look', 'canvas_do', 'canvas_help', 'canvas_wait', 'canvas_screenshot'];
const WAS_BYTES = 17493; // JSON of tools/list with the old hand-written tools (poc bff2717)
const tools = toolList(catalog());

describe('generated tools', () => {
  it('keep every name agents had, and add the generic ones (the four and the screenshot)', () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...TODAYS, ...GENERIC]));
    expect([...names].sort()).toEqual([...TODAYS, ...GENERIC].sort());
  });

  it('have JSON Schema objects as input, without the bridge-internal node marker', () => {
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(JSON.stringify(t.inputSchema), t.name).not.toContain('canvas-node');
      expect(t.description.length, t.name).toBeGreaterThan(10);
    }
  });

  it('keep their argument names', () => {
    const props = (n: string) => Object.keys(tools.find((t) => t.name === n)!.inputSchema.properties).sort();
    expect(props('canvas_add_node')).toEqual(['color', 'column', 'near', 'text', 'type', 'url', 'x', 'y']);
    expect(props('canvas_update_node')).toEqual(['color', 'column', 'dx', 'dy', 'label', 'node', 'text', 'x', 'y']);
    expect(props('canvas_remove')).toEqual(['nodes']);
    expect(props('canvas_arrow')).toEqual(['color', 'curve', 'dashed', 'end', 'from', 'from_side', 'label', 'start', 'to', 'to_side']);
    expect(props('canvas_remove_arrow')).toEqual(['arrows']);
    expect(props('chess_wait_for_turn')).toEqual(['board', 'timeout_s']);
    expect(props('chess_sit')).toEqual(['board', 'color', 'leave']);
    expect(tools.find((t) => t.name === 'canvas_add_node')!.inputSchema.required).toEqual(['text']);
  });

  it('stay within 20% of the size the hand-written list had', () => {
    const bytes = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
    expect(bytes).toBeLessThan(WAS_BYTES * 1.2);
  });

  it('canvas_screenshot points at canvas_look, and answers with an image block and the ids in view', async () => {
    const t = tools.find((x) => x.name === 'canvas_screenshot')!;
    expect(t.description).toContain('canvas_look');
    expect(tools.find((x) => x.name === 'canvas_look')!.description).toContain('canvas_screenshot');
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(['height', 'labels', 'node', 'padding', 'region', 'width']);
    const asked: unknown[] = [];
    const reply: ShotReply = { png: 'iVBO', mime: 'image/png', seat: 'agent:claude', target: 'node n1', width: 1000, height: 750, ms: 321, nodes: [{ id: 'n1', type: 'text', box: [10, 20, 300, 100] }] };
    const c = { shot: async (a: unknown) => (asked.push(a), reply) } as unknown as Client;
    const out = await t.call(c, { node: 'Plan', labels: true });
    expect(asked).toEqual([{ node: 'Plan', region: undefined, labels: true, width: undefined, height: undefined, padding: undefined }]);
    expect(out).toEqual([
      { type: 'image', data: 'iVBO', mimeType: 'image/png' },
      { type: 'text', text: expect.stringContaining('n1 text [10,20,300,100]') },
    ]);
    expect((out as { text: string }[])[1].text).toContain('agent:claude');
    const many = { ...reply, nodes: Array.from({ length: 70 }, (_, i) => ({ id: `n${i}`, type: 'text', box: [0, 0, 1, 1] as [number, number, number, number] })) };
    const capped = (await t.call({ shot: async () => many } as unknown as Client, {})) as { text: string }[];
    expect(capped[1].text).toContain('… and 10 more');
  });
});
