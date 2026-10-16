import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { toolList } from './tools';

// The 27 tools agents had before commands described themselves, and the size of the tool list then.
const TODAYS = ['canvas_list', 'canvas_add_node', 'canvas_update_node', 'canvas_connect', 'canvas_remove', 'canvas_undo', 'canvas_log', 'canvas_add_shape', 'canvas_style_shape', 'canvas_arrow', 'canvas_edit_arrow', 'canvas_remove_arrow', 'chess_state', 'chess_sit', 'chess_new_game', 'chess_move', 'chess_wait_for_turn', 'chess_takeback', 'chess_resign', 'chat_send', 'chat_read', 'chat_wait', 'canvas_draw_new', 'canvas_draw_shapes', 'canvas_draw_add', 'canvas_draw_remove', 'canvas_draw_frame'];
const GENERIC = ['canvas_look', 'canvas_do', 'canvas_help', 'canvas_wait'];
const WAS_BYTES = 17493; // JSON of tools/list with the old hand-written tools (poc bff2717)
const tools = toolList(catalog());

describe('generated tools', () => {
  it('keep every name agents had, and add the four generic ones', () => {
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
});
