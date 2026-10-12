import './style.css';
import { App, joinBridge, joinRoom, loadPlayer, mountChat, mountLog, mountZoomControl, savePlayer, openFile, parse, persistLocally, persistViewport, resetFileHandle, roomDbName, saveFile, type CanvasDoc } from './core';
import { copyText, createRoomFrom, mountRoomStatus, roomFromUrl, roomLink } from './share';
import { askName } from './nameDialog';
import { cardsPlugin, handLabelOf, newHandEntries, newHandFor } from './plugins/cards';
import { chessPlugin } from './plugins/chess';
import { clockPlugin } from './plugins/clock';
import { battleLinePlugin } from './plugins/battleline';
import { matsPlugin } from './plugins/mats';
import { boardPlugin } from './plugins/board';
import { mountHelp, removeHelpNote } from './help';

const BRIDGE = new URLSearchParams(location.search).get('bridge');
const ROOM = BRIDGE ? null : roomFromUrl();
const DB_NAME = ROOM ? roomDbName(ROOM) : 'canvas-poc';
const VIEW_KEY = 'canvas-poc:view';

const app = new App(document.getElementById('table')!);
// this browser's player id (also in solo play) = who "my hand" belongs to and who views the table
{
  const p = loadPlayer();
  app.viewer = p.id;
  app.player = { id: p.id, name: p.name, color: p.color };
}
app.use(cardsPlugin);
app.use(chessPlugin);
app.use(clockPlugin);
app.use(battleLinePlugin);
app.use(matsPlugin);
app.use(boardPlugin);
app.store.migrations.push(removeHelpNote);


function newTable() {
  resetFileHandle();
  app.store.load({ nodes: [], edges: [] });
  // the starter table: a shuffled deck, a wave of spades and three cards to flip (setup lays out about 940 x 400)
  app.dispatch('cards.setup', { x: -470, y: -120 });
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
  return b;
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

button('New table', ROOM ? 'Clear the table and deal a fresh deck (for everyone in the room)' : 'Clear the table and deal a fresh deck', () => {
  if (confirm(ROOM ? 'Start a new table for everyone in this room?' : 'Start a new table? Unsaved changes are lost.')) newTable();
});
button('Reset', 'Put everything back to its starting state (keeps what is on the table)', () => {
  if (confirm(ROOM ? 'Reset the table for everyone in this room? (Undo brings it back)' : 'Reset the table to its starting state? (Undo brings it back)'))
    app.dispatch('core.reset', {});
});
const addBtn = button('Add…', 'Put something on the table: a deck of cards, a chess set, a game clock…', () =>
  app.view.openMenu(
    app.kits.map((k) => ({ label: k.label, run: () => k.create(app, app.viewCenter()) })),
    addBtn,
    'Add to the table',
  ),
);
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
if (!ROOM && !BRIDGE) {
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
// Hand: a new private group (others see backs), in free space near the bottom of the view. In a room:
// New hand ▸ players (me first); solo: mine right away.
const handBtn = document.createElement('button');
handBtn.textContent = 'New hand';
handBtn.title = 'New hand: a private group for cards someone holds (others see them face down)';
handBtn.addEventListener('click', () => {
  if (!app.presence) return newHandFor(app, { ...loadPlayer() });
  app.view.openMenu(newHandEntries(app), handBtn, 'New hand for');
});
bar.append(handBtn, helpBtn, status);
app.onNotify(flash);
mountHelp(app, helpBtn);
mountZoomControl(app);
mountLog(app);

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
if (BRIDGE) startBridge(BRIDGE);
else persistLocally(app, DB_NAME).then(({ empty }) => {
  if (!ROOM) {
    if (empty) newTable();
    else if (view) app.viewport.set(view.x, view.y, view.zoom);
    else app.view.fit();
    return;
  }
  // Room: the table comes from this device (if it was here before) and from the other players.
  // Join right away (the table loads meanwhile); ask for a name in-app if none was chosen yet.
  const stored = loadPlayer();
  const info = ({ id, name, color }: { id: string; name: string; color: string }) => ({ id, name, color });
  const room = joinRoom(app, ROOM, info(stored));
  (window as any).room = room;
  const rename = async (first = false) => {
    const choice = await askName(room.presence.me, first ? { title: 'Join the table', action: 'Join' } : { title: 'Your name and color', action: 'Save' });
    if (!choice) return;
    const me = info(savePlayer(choice));
    room.presence.setMe(me);
    app.dispatch('cards.handLabel', { owner: me.id, label: handLabelOf(me.name), color: me.color });
  };
  mountRoomStatus(
    app,
    room,
    bar,
    () => {
      room.leave();
      location.href = location.pathname;
    },
    () => void rename(),
  );
  mountChat(app, bar, ROOM);
  if (!stored.named) void rename(true);
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

/** Bridge mode (?bridge=ws://host:5222): the table is a .canvas file a bridge process hosts; agents join it. */
function startBridge(url: string) {
  const stored = loadPlayer();
  const room = joinBridge(app, url, { id: stored.id, name: stored.name, color: stored.color });
  (window as any).room = room;
  mountRoomStatus(
    app,
    room,
    bar,
    () => {
      room.leave();
      location.href = location.pathname;
    },
    async () => {
      const choice = await askName(room.presence.me, { title: 'Your name and color', action: 'Save' });
      if (choice) room.presence.setMe(savePlayer(choice));
    },
  );
  mountChat(app, bar, url);
  flash(`Connecting to the bridge at ${url}…`);
  room.synced.then(() => {
    app.store.undoManager.clear();
    app.view.fit();
    flash('Connected: this table is the bridge’s .canvas file');
  });
}

// for poking at it from the console
(window as any).app = app;
