import { MAX_NAME, PALETTE, type PlayerInfo } from './core';

let open: HTMLElement | null = null;

/**
 * In-app name dialog (no window.prompt: in-app browsers block it). Resolves with the choice, or
 * null on Esc / click outside (the caller keeps the current name).
 */
export function askName(current: PlayerInfo, opts: { title?: string; action?: string } = {}): Promise<{ name: string; color: string } | null> {
  open?.remove();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'name-overlay';
    overlay.innerHTML = `
      <form class="name-dialog" role="dialog" aria-modal="true" aria-labelledby="name-title">
        <h2 id="name-title"></h2>
        <label class="name-field"><span>Name</span><input name="name" autocomplete="nickname" spellcheck="false" /></label>
        <div class="name-colors" role="radiogroup" aria-label="Color"></div>
        <div class="name-actions"><button type="submit" class="name-ok"></button></div>
      </form>`;
    const form = overlay.querySelector('form')!;
    overlay.querySelector('h2')!.textContent = opts.title ?? 'Your name at the table';
    const input = overlay.querySelector('input')!;
    input.value = current.name;
    input.maxLength = MAX_NAME;
    const ok = overlay.querySelector<HTMLButtonElement>('.name-ok')!;
    ok.textContent = opts.action ?? 'Join';
    let color = PALETTE.includes(current.color) ? current.color : PALETTE[0];
    const swatches = overlay.querySelector('.name-colors')!;
    const paint = () => {
      for (const b of swatches.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.color === color));
      ok.style.background = color;
    };
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.color = c;
      b.style.background = c;
      b.setAttribute('role', 'radio');
      b.title = c;
      b.addEventListener('click', () => {
        color = c;
        paint();
        input.focus();
      });
      swatches.append(b);
    }
    paint();

    const done = (v: { name: string; color: string } | null) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (open === overlay) open = null;
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
      } else if (!(e.target instanceof Node && overlay.contains(e.target))) {
        e.stopImmediatePropagation(); // table shortcuts stay off while the dialog is up
      }
    };
    window.addEventListener('keydown', onKey, true);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done({ name: input.value, color });
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) done(null);
    });
    document.body.append(overlay);
    open = overlay;
    input.focus();
    input.select();
  });
}
