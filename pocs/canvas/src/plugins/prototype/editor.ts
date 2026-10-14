import { pageFrame } from './bridge';
import { DEVICES } from './model';

// The page editor: title, device, HTML on the left, the live sandboxed page on the right.
// Resolves with the edit, or null on Cancel / Esc. Keys typed here never reach the canvas.

export interface PageEdit {
  title: string;
  html: string;
  vw: number;
}

let open: HTMLElement | null = null;

function modal(cls: string, inner: string, onKey: (e: KeyboardEvent) => void) {
  open?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'pg-overlay';
  overlay.innerHTML = `<div class="${cls}" role="dialog" aria-modal="true">${inner}</div>`;
  const keys = (e: KeyboardEvent) => {
    onKey(e);
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', keys, true);
  document.body.append(overlay);
  open = overlay;
  return {
    overlay,
    close() {
      window.removeEventListener('keydown', keys, true);
      overlay.remove();
      if (open === overlay) open = null;
    },
  };
}

export function editPage(init: PageEdit, vh: (vw: number) => number): Promise<PageEdit | null> {
  return new Promise((resolve) => {
    const opts = DEVICES.map((d) => `<option value="${d.vw}">${d.label}</option>`).join('');
    let done = (_v: PageEdit | null) => {};
    const m = modal(
      'pg-editor',
      `<header><input class="pg-ed-title" maxlength="80" spellcheck="false" placeholder="Page title"><select class="pg-ed-device">${opts}</select>
      <span class="pg-ed-hint">Links: <code>data-goto="Page or action"</code>, <code>data-back</code>; fields: <code>data-store="key"</code>, <code>data-show="key"</code></span>
      <button class="pg-ed-cancel">Cancel</button><button class="pg-ed-save">Save ⌘↵</button></header>
      <div class="pg-ed-main"><textarea class="pg-ed-html" spellcheck="false"></textarea><div class="pg-ed-preview"></div></div>`,
      (e) => {
        if (e.key === 'Escape') done(null);
        else if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) {
          e.preventDefault();
          done(read());
        } else if (e.key === 'Tab' && e.target === html) {
          e.preventDefault();
          html.setRangeText('  ', html.selectionStart, html.selectionEnd, 'end');
          preview();
        }
      },
    );
    const q = <T extends Element>(s: string) => m.overlay.querySelector<T & HTMLElement>(s)! as T;
    const title = q<HTMLInputElement>('.pg-ed-title');
    const device = q<HTMLSelectElement>('.pg-ed-device');
    const html = q<HTMLTextAreaElement>('.pg-ed-html');
    const box = q<HTMLDivElement>('.pg-ed-preview');
    title.value = init.title;
    device.value = String(init.vw);
    html.value = init.html;
    const read = (): PageEdit => ({ title: title.value.trim() || init.title, html: html.value, vw: Number(device.value) });
    let t: ReturnType<typeof setTimeout> | undefined;
    const preview = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const vw = Number(device.value);
        const h = vh(vw);
        const s = Math.min(1, (box.clientWidth - 16) / vw, (box.clientHeight - 16) / h);
        const f = pageFrame(html.value, vw, h, s);
        f.style.pointerEvents = 'auto';
        const wrap = document.createElement('div');
        wrap.className = 'pg-ed-device-frame';
        wrap.style.width = `${vw * s}px`;
        wrap.style.height = `${h * s}px`;
        wrap.append(f);
        box.replaceChildren(wrap);
      }, 200);
    };
    html.addEventListener('input', preview);
    device.addEventListener('change', preview);
    done = (v) => {
      clearTimeout(t);
      m.close();
      resolve(v);
    };
    q<HTMLButtonElement>('.pg-ed-cancel').addEventListener('click', () => done(null));
    q<HTMLButtonElement>('.pg-ed-save').addEventListener('click', () => done(read()));
    requestAnimationFrame(preview);
    html.focus();
  });
}

/** Edit a sticky note's text (multi-line). */
export function editNote(text: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = (_v: string | null) => {};
    const m = modal('pg-note-editor', `<textarea maxlength="2000"></textarea><div><button class="pg-ed-save">Save ⌘↵</button></div>`, (e) => {
      if (e.key === 'Escape') done(null);
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') done(ta.value);
    });
    const ta = m.overlay.querySelector('textarea')!;
    ta.value = text;
    done = (v) => {
      m.close();
      resolve(v);
    };
    m.overlay.querySelector('button')!.addEventListener('click', () => done(ta.value));
    m.overlay.addEventListener('pointerdown', (e) => e.target === m.overlay && done(null));
    ta.focus();
    ta.select();
  });
}
