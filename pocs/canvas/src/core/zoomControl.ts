import type { App } from './app';
import { chromeButton } from './chromeView';

/** Zoom control (bottom-right): − / zoom % (click = 100%) / + / fit. Follows every viewport change. */
export function mountZoomControl(app: App, parent: HTMLElement = document.body) {
  const box = document.createElement('div');
  box.className = 'cv-zoom';
  const btn = (name: string, label: string, shortcut: string, run: () => void) => {
    const b = chromeButton(name, label, shortcut);
    b.addEventListener('click', run);
    box.append(b);
    return b;
  };
  btn('minus', 'Zoom out', '⌘−', () => app.view.zoomCenter('out'));
  const pct = chromeButton('', 'Reset to 100%', '⌘0');
  pct.replaceChildren();
  pct.classList.add('cv-zoom-pct');
  pct.addEventListener('click', () => app.view.zoomCenter(1));
  box.append(pct);
  btn('plus', 'Zoom in', '⌘+', () => app.view.zoomCenter('in'));
  btn('scan', 'Zoom to fit', '0 · ⇧1', () => app.view.fit());
  const sync = () => (pct.textContent = `${Math.round(app.viewport.zoom * 100)}%`);
  app.viewport.onChange(sync);
  sync();
  parent.append(box);
  return box;
}
