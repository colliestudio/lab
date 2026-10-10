import './style.css';
import { App, emptyDoc, openFile, parse, resetFileHandle, saveFile, autosave, type CanvasNode } from './core';
import { cardsPlugin } from './plugins/cards';

const AUTOSAVE_KEY = 'canvas-poc:v1';

const app = new App(document.getElementById('table')!);
app.use(cardsPlugin);

const HELP = `Card table

Drag cards • double-click or F to flip
Drag empty space / Space+drag to pan • wheel or pinch to zoom
Shift+drag: box select • Shift+click: add to selection
Drop a card on a card or deck to stack it
Deck: S shuffle • D draw (⇧D face down) • E spread • Alt+drag pull top card
G gather selection into a deck • right-click for more
⌘S save .canvas • ⌘O open`;

function newTable() {
  resetFileHandle();
  app.store.setDoc(emptyDoc());
  const help: CanvasNode = { id: 'help', type: 'text', x: -40, y: -360, width: 520, height: 230, text: HELP };
  app.dispatch('core.put', { nodes: [help] });
  app.dispatch('cards.setup', { x: 0, y: 0 });
  app.store.select([]);
  app.view.fit();
}

// toolbar
const bar = document.getElementById('toolbar')!;
const status = document.createElement('span');
status.className = 'status';
const flash = (msg: string) => {
  status.textContent = msg;
  clearTimeout((flash as any).t);
  (flash as any).t = setTimeout(() => (status.textContent = ''), 2500);
};
const button = (label: string, title: string, run: () => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', run);
  bar.append(b);
};

async function doSave(saveAs = false) {
  try {
    const name = await saveFile(app.doc, { saveAs });
    if (name) flash(`Saved ${name}`);
  } catch (e) {
    flash(`Save failed: ${(e as Error).message}`);
  }
}
async function doOpen() {
  try {
    const res = await openFile();
    if (!res) return;
    app.store.setDoc(res.doc);
    app.view.fit();
    flash(`Opened ${res.name}`);
  } catch (e) {
    flash(`Open failed: ${(e as Error).message}`);
  }
}

button('New table', 'Reset to a fresh deck', () => {
  if (confirm('Start a new table? Unsaved changes are lost.')) newTable();
});
button('Open…', 'Open a .canvas file (⌘O)', doOpen);
button('Save', 'Save as .canvas (⌘S)', () => doSave());
button('Fit', 'Show everything (1)', () => app.view.fit());
bar.append(status);

app.registerKey({ key: 'mod+s', run: () => doSave() });
app.registerKey({ key: 'mod+shift+s', run: () => doSave(true) });
app.registerKey({ key: 'mod+o', run: doOpen });
app.registerKey({ key: '1', run: () => app.view.fit() });

// drop a .canvas file anywhere to open it
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  try {
    app.store.setDoc(parse(await file.text()));
    resetFileHandle();
    app.view.fit();
    flash(`Opened ${file.name}`);
  } catch (err) {
    flash(`Open failed: ${(err as Error).message}`);
  }
});

const saved = autosave(app, AUTOSAVE_KEY);
if (saved && saved.doc.nodes.length) {
  app.store.setDoc(saved.doc);
  if (saved.view) app.viewport.set(saved.view.x, saved.view.y, saved.view.zoom);
  else app.view.fit();
} else {
  newTable();
}

// for poking at it from the console
(window as any).app = app;
