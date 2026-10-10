import './style.css';
import { App, openFile, parse, persistLocally, persistViewport, resetFileHandle, saveFile, type CanvasDoc, type CanvasNode } from './core';
import { cardsPlugin } from './plugins/cards';

const DB_NAME = 'canvas-poc';
const VIEW_KEY = 'canvas-poc:view';

const app = new App(document.getElementById('table')!);
app.use(cardsPlugin);

const HELP = `Card table

Drag cards • double-click or F to flip
Drag empty space / Space+drag to pan • wheel or pinch to zoom
Shift+drag: box select • Shift+click: add to selection
Drop a card squarely onto a card or deck to stack it (it lights up)
Deck: S shuffle • D draw (⇧D face down) • E spread • Alt+drag pull top card
G gather selection into a deck • right-click for more
⌘Z undo • ⇧⌘Z redo • ⌘S save .canvas • ⌘O open`;

function newTable() {
  resetFileHandle();
  const help: CanvasNode = { id: 'help', type: 'text', x: -40, y: -380, width: 560, height: 250, text: HELP, z: 1 };
  app.store.load({ nodes: [help], edges: [] });
  app.dispatch('cards.setup', { x: 0, y: 0 });
  app.store.undoManager.clear();
  app.store.select([]);
  app.view.fit();
}

function openDoc(doc: CanvasDoc & { skipped?: string[] }, name: string) {
  app.store.load(doc);
  app.view.fit();
  flash(doc.skipped?.length ? `Opened ${name} (skipped ${doc.skipped.length} bad entries)` : `Opened ${name}`);
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
    const name = await saveFile(app.store.exportDoc(), { saveAs });
    if (name) flash(`Saved ${name}`);
  } catch (e) {
    flash(`Save failed: ${(e as Error).message}`);
  }
}
async function doOpen() {
  try {
    const res = await openFile();
    if (!res) return;
    openDoc(res.doc, res.name);
  } catch (e) {
    flash(`Open failed: ${(e as Error).message}`);
  }
}

button('New table', 'Reset to a fresh deck', () => {
  if (confirm('Start a new table? Unsaved changes are lost.')) newTable();
});
button('Open…', 'Open a .canvas file (⌘O)', doOpen);
button('Save', 'Save as .canvas (⌘S)', () => doSave());
button('Undo', 'Undo (⌘Z)', () => app.store.undo());
button('Redo', 'Redo (⇧⌘Z)', () => app.store.redo());
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
    resetFileHandle();
    openDoc(parse(await file.text()), file.name);
  } catch (err) {
    flash(`Open failed: ${(err as Error).message}`);
  }
});

const view = persistViewport(app, VIEW_KEY);
persistLocally(app, DB_NAME).then(({ empty }) => {
  if (empty) newTable();
  else if (view) app.viewport.set(view.x, view.y, view.zoom);
  else app.view.fit();
});

// for poking at it from the console
(window as any).app = app;
