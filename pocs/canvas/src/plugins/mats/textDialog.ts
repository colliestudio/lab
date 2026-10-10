let open: HTMLElement | null = null;

/**
 * Ask for a short text in-app (no window.prompt: in-app browsers block it), styled like the name
 * dialog. Resolves with the trimmed text, or null on Esc / click outside / empty.
 */
export function askText(title: string, value: string, action = 'Save', max = 40): Promise<string | null> {
  open?.remove();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'name-overlay';
    overlay.innerHTML = `
      <form class="name-dialog" role="dialog" aria-modal="true">
        <h2></h2>
        <label class="name-field"><span>Name</span><input name="text" spellcheck="false" /></label>
        <div class="name-actions" style="margin-top:14px"><button type="submit" class="name-ok" style="background:#2f6b45"></button></div>
      </form>`;
    overlay.querySelector('h2')!.textContent = title;
    const input = overlay.querySelector('input')!;
    input.value = value;
    input.maxLength = max;
    overlay.querySelector<HTMLButtonElement>('.name-ok')!.textContent = action;
    const done = (v: string | null) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (open === overlay) open = null;
      resolve(v && v.trim() ? v.trim() : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
      } else if (!(e.target instanceof Node && overlay.contains(e.target))) e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    overlay.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      done(input.value);
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
