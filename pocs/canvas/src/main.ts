import './style.css';
import { App, joinRoom, localPlayer, mountZoomControl, openFile, parse, persistLocally, persistViewport, resetFileHandle, roomDbName, saveFile, type CanvasDoc } from './core';
import { copyText, createRoomFrom, mountRoomStatus, roomFromUrl, roomLink } from './share';
import { cardsPlugin } from './plugins/cards';
import { mountHelp, removeHelpNote } from './help';

const ROOM = roomFromUrl();
const DB_NAME = ROOM ? roomDbName(ROOM) : 'canvas-poc';
const VIEW_KEY = 'canvas-poc:view';

const app = new App(document.getElementById('table')!);
app.use(cardsPlugin);
app.store.migrations.push(removeHelpNote);


function newTable() {
  resetFileHandle();
  app.store.load({ nodes: [], edges: [] });
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

button('New table', ROOM ? 'Reset to a fresh deck (for everyone in the room)' : 'Reset to a fresh deck', () => {
  if (confirm(ROOM ? 'Start a new table for everyone in this room?' : 'Start a new table? Unsaved changes are lost.')) newTable();
});
button('Open…', 'Open a .canvas file (⌘O)', doOpen);
button('Save', 'Save as .canvas (⌘S)', () => doSave());
button('Undo', 'Undo (⌘Z)', () => app.store.undo());
button('Redo', 'Redo (⇧⌘Z)', () => app.store.redo());
// tools: select (V) / hand (H)
const tools = document.createElement('span');
tools.className = 'tools';
const toolBtn = (tool: 'select' | 'hand', label: string, title: string) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.dataset.tool = tool;
  b.addEventListener('click', () => app.view.setTool(tool));
  tools.append(b);
  return b;
};
const toolBtns = [toolBtn('select', '↖', 'Select (V)'), toolBtn('hand', '✋\uFE0E', 'Hand: drag to pan (H, or hold Space)')];
const syncTools = () => toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === app.view.tool));
app.view.onToolChange(syncTools);
syncTools();
bar.prepend(tools);

const helpBtn = document.createElement('button');
helpBtn.textContent = '?';
helpBtn.title = 'Controls (?)';
helpBtn.className = 'help-btn';
if (!ROOM) {
  const share = document.createElement('button');
  share.textContent = 'Share';
  share.title = 'Play together: copy this table into a new room and copy its link';
  share.className = 'share-btn';
  share.addEventListener('click', async () => {
    const id = await createRoomFrom(app);
    const link = roomLink(id);
    const copied = await copyText(link);
    sessionStorage.setItem('canvas-poc:shared', copied ? 'copied' : 'show');
    location.href = link;
  });
  bar.append(share);
}
bar.append(helpBtn, status);
app.onNotify(flash);
mountHelp(app, helpBtn);
mountZoomControl(app);

app.registerKey({ key: 'mod+s', run: () => doSave() });
app.registerKey({ key: 'mod+shift+s', run: () => doSave(true) });
app.registerKey({ key: 'mod+o', run: doOpen });
app.registerKey({ key: '0', run: () => app.view.fit() });

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
  if (!ROOM) {
    if (empty) newTable();
    else if (view) app.viewport.set(view.x, view.y, view.zoom);
    else app.view.fit();
    return;
  }
  // Room: the table comes from this device (if it was here before) and from the other players.
  const me = localPlayer();
  const room = joinRoom(app, ROOM, me);
  (window as any).room = room;
  mountRoomStatus(app, room, bar, () => {
    room.leave();
    location.href = location.pathname;
  });
  const shared = sessionStorage.getItem('canvas-poc:shared');
  sessionStorage.removeItem('canvas-poc:shared');
  if (shared === 'copied') flash('Room created, link copied: send it to the other players');
  else if (shared === 'show') flash(`Room created: send this link: ${roomLink(ROOM)}`);
  if (!empty) {
    if (view) app.viewport.set(view.x, view.y, view.zoom);
    else app.view.fit();
    return;
  }
  // joined late with nothing local: wait for the table from the others, then fit it
  flash('Joining… waiting for the table from the other players');
  const off = app.store.subscribe(() => {
    if (!app.store.doc.nodes.length) return;
    off();
    app.view.fit();
    flash('Joined the table');
  });
});

// for poking at it from the console
(window as any).app = app;
