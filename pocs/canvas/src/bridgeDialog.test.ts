// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { agentCommand } from './bridgeDialog';

describe('agentCommand', () => {
  it('one file per room', () => {
    expect(agentCommand('https://canvas.lab.collie.studio/?room=k3m', 'k3m')).toBe("pnpm bridge join 'https://canvas.lab.collie.studio/?room=k3m' /tmp/canvas-room-k3m.canvas");
  });
  it('is shell-safe whatever the page URL holds', () => {
    expect(agentCommand("https://x/a'b?room=r", "r';touch pwned;'")).toBe(`pnpm bridge join 'https://x/a'\\''b?room=r' /tmp/canvas-room-r__touch_pwned__.canvas`);
  });
});
