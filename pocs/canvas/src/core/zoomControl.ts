import type { App } from './app';

/** Bottom-right zoom control: − / zoom % (click = 100%) / + / Fit. Follows every viewport change. */
export function mountZoomControl(app: App, parent: HTMLElement = document.body) {
  const box = document.createElement('div');
  box.className = 'cv-zoom';
  const btn = (text: string, title: string, run: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', run);
    box.append(b);
    return b;
  };
  btn('−', 'Zoom out (⌘−)', () => app.view.zoomCenter('out'));
  const pct = btn('100%', 'Reset to 100% (⌘0)', () => app.view.zoomCenter(1));
  pct.className = 'cv-zoom-pct';
  btn('+', 'Zoom in (⌘+)', () => app.view.zoomCenter('in'));
  btn('Fit', 'Show everything (0)', () => app.view.fit());
  const sync = () => (pct.textContent = `${Math.round(app.viewport.zoom * 100)}%`);
  app.viewport.onChange(sync);
  sync();
  parent.append(box);
  return box;
}
