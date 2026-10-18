// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showBoardScreen } from './boardScreen';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('board screen', () => {
  it('says why, links back to the list, and offers Retry only for a failure', () => {
    showBoardScreen({ kind: 'newer', error: 'this board is format 2' }, 'x');
    expect(document.querySelector('.serve-card')!.textContent).toContain('Made by a newer version of Canvas');
    expect(document.querySelector('.serve-card a')!.getAttribute('href')).toBe('/');
    expect(document.querySelector('.serve-card button')).toBeNull();
    document.body.innerHTML = '';
    showBoardScreen({ kind: 'failed', error: 'boom' }, 'x');
    expect(document.querySelector('.serve-card')!.textContent).toContain('boom');
    expect(document.querySelector('.serve-card button')!.textContent).toBe('Retry');
  });

  it('files dropped on it and keys typed under it never reach the table', () => {
    const drop = vi.fn();
    const key = vi.fn();
    window.addEventListener('drop', drop);
    window.addEventListener('keydown', key);
    showBoardScreen({ kind: 'missing', error: 'no board' }, 'x');
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    document.querySelector('.serve-screen')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(drop).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    document.querySelector('.serve-card a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(key).not.toHaveBeenCalled();
    window.removeEventListener('drop', drop);
    window.removeEventListener('keydown', key);
  });
});
