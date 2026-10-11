import { describe, expect, it } from 'vitest';
import { bindsLoopback, localHostHeader } from './vite-kanban';

describe('kanban dev endpoints: who may reach them', () => {
  it('loopback binds', () => {
    for (const h of [undefined, false, 'localhost', '127.0.0.1', '::1']) expect(bindsLoopback(h)).toBe(true);
    for (const h of [true, '0.0.0.0', '192.168.1.5', '::']) expect(bindsLoopback(h)).toBe(false);
  });
  it('local Host headers only', () => {
    for (const h of ['localhost', 'localhost:5216', '127.0.0.1:5216', '[::1]:5216', 'canvas.localhost', 'kanban.canvas.localhost:80', 'LOCALHOST'])
      expect(localHostHeader(h), h).toBe(true);
    for (const h of [undefined, '', '192.168.1.5:5216', 'mini.internal:5190', 'localhost.evil.com', 'notlocalhost', '[::2]:5216'])
      expect(localHostHeader(h), h).toBe(false);
  });
});
