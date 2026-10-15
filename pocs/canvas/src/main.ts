import './style.css';
import { App, type Room, chromeButton, joinBridge, joinRoom, loadPlayer, mountChat, mountChrome, mountLog, mountZoomControl, savePlayer, openFile, parse, persistLocally, persistViewport, resetFileHandle, roomDbName, saveFile, type CanvasDoc } from './core';
import { copyText, createRoomFrom, mountRoomStatus, roomFromUrl, roomLink } from './share';
import { openBridgeDialog } from './bridgeDialog';
import { bridgeFromLocation, bridgeHref, rememberBridge } from './bridges';
import { askName } from './nameDialog';
import { cardsPlugin } from './plugins/cards';
import { chessPlugin } from './plugins/chess';
import { clockPlugin } from './plugins/clock';
import { battleLinePlugin } from './plugins/battleline';
import { matsPlugin } from './plugins/mats';
import { boardPlugin } from './plugins/board';
import { stormPlugin } from './plugins/eventstorm';
import { prototypePlugin } from './plugins/prototype';
import { registerPluginLogic } from './plugins/logic';
import { mountHelp, removeHelpNote } from './help';
import { attachFollow, createFramesPlugin, portalsEnabled, enterUrl, mountBreadcrumb, trailFromUrl } from './plugins/frames';

const BRIDGE_ADDR = bridgeFromLocation(location);
const BRIDGE = BRIDGE_ADDR?.url ?? null;
const ROOM = BRIDGE ? null : roomFromUrl();
const DB_NAME = ROOM ? roomDbName(ROOM) : 'canvas-poc';
// per room: a room entered through a portal must not open at the camera of the table you came from
const VIEW_KEY = ROOM ? `canvas-poc:view:${ROOM}` : 'canvas-poc:view';

const app = new App(document.getElementById('table')!);
// this browser's player id (also in solo play) = who "my hand" belongs to and who views the table
{
  const p = loadPlayer();
  app.viewer = p.id;
  app.player = { id: p.id, name: p.name, color: p.color };
}
const chrome = mountChrome(app);
const flash = chrome.toast;
// every plugin's data side from the shared list (the bridge registers the same list); `use` below adds the DOM side
registerPluginLogic(app.store);
app.use(cardsPlugin);
app.use(chessPlugin);
app.use(clockPlugin);
app.use(battleLinePlugin);
app.use(matsPlugin);
app.use(boardPlugin);
app.use(stormPlugin);
app.use(prototypePlugin);
// frames' logic is last in PLUGIN_LOGIC (src/plugins/logic.ts): its rider rule must come after the others, so it is registered there
const TRAIL = trailFromUrl();
const frames = createFramesPlugin({ room: ROOM, portals: portalsEnabled(), enter: (room) => (location.href = enterUrl(room, ROOM, TRAIL)) });
app.use(frames);
app.store.migrations.push(removeHelpNote);


function newTable() {
  resetFileHandle();
  app.store.load({ nodes: [], edges: [] });
  app.startTable();
  app.store.undoManager.clear();
  app.store.select([]);
  app.view.fit();
}

function openDoc(doc: CanvasDoc & { skipped?: string[] }, name: string) {
  app.store.load(doc);
  app.view.fit();
  flash(doc.skipped?.length ? `Opened ${name} (skipped ${doc.skipped.length} bad entries)` : `Opened ${name}`);
}

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

// the main menu: File / Edit / Room / Add / plugin groups / Bridge… / Help (core and plugins add their own rows)
app.registerMainMenuItem({
  id: 'file.new',
  group: 'File',
  order: 0,
  entry: () => ({
    label: 'New table',
    run: () => {
      if (confirm(ROOM ? 'Start a new table for everyone in this room?' : 'Start a new table? Unsaved changes are lost.')) newTable();
    },
  }),
});
app.registerMainMenuItem({ id: 'file.open', group: 'File', order: 1, entry: () => ({ label: 'Open…', hint: '⌘O', run: doOpen }) });
app.registerMainMenuItem({ id: 'file.save', group: 'File', order: 2, entry: () => ({ label: 'Save', hint: '⌘S', run: () => doSave() }) });
app.registerMainMenuItem({ id: 'file.saveAs', group: 'File', order: 3, entry: () => ({ label: 'Save as…', hint: '⇧⌘S', run: () => doSave(true) }) });
app.registerMainMenuItem({
  id: 'edit.reset',
  group: 'Edit',
  order: 10,
  entry: () => ({
    label: 'Reset table…',
    run: () => {
      if (confirm(ROOM ? 'Reset the table for everyone in this room? (Undo brings it back)' : 'Reset the table to its starting state? (Undo brings it back)')) app.dispatch('core.reset', {});
    },
  }),
});
// Bridge…: connect to a bridge, see the one this tab is on, bring agents into a room (bridgeDialog.ts)
app.registerMainMenuItem({ id: 'app.bridge', order: 0, entry: () => ({ label: 'Bridge…', run: () => openBridge() }) });
app.registerMainMenuItem({ id: 'app.help', order: 1, entry: () => ({ label: 'Help and shortcuts', hint: '?', run: () => helpBtn.click() }) });

if (!ROOM && !BRIDGE) {
  const share = document.createElement('button');
  share.type = 'button';
  share.textContent = 'Share';
  share.dataset.tip = 'Play together: copy this table into a new room and its link';
  share.className = 'share-btn';
  share.addEventListener('click', async () => {
    const id = await createRoomFrom(app);
    const link = roomLink(id);
    const copied = await copyText(link);
    sessionStorage.setItem('canvas-poc:shared', copied ? 'copied' : 'show');
    location.href = link;
  });
  chrome.topRight.append(share);
}
const helpBtn = chromeButton('circle-help', 'Help', '?');
helpBtn.classList.add('help-btn');
mountBreadcrumb(chrome.topLeft, ROOM, TRAIL);
mountZoomControl(app, chrome.bottomRight);
chrome.bottomRight.append(helpBtn);
mountHelp(app, helpBtn);
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

let bridgeRoom: Room | undefined;
function openBridge() {
  const room = bridgeRoom;
  openBridgeDialog({
    notify: flash,
    connect: (addr) => (location.href = bridgeHref(addr)),
    active: BRIDGE && room ? { url: BRIDGE, online: () => room.signalingConnected(), players: () => room.presence.peers().length, disconnect: () => (room.leave(), (location.href = location.pathname)) } : undefined,
    room:
      ROOM && room
        ? { id: ROOM, link: roomLink(ROOM), bridge: () => room.bridge?.() ?? 'none', agents: () => room.presence.peers().filter((p) => /^(agent|tool):/.test(p.id)).map((p) => p.name) }
        : undefined,
  });
}

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
  bridgeRoom = room;
  attachFollow(app, room.presence, frames.presenter!);
  const rename = async (first = false) => {
    const choice = await askName(room.presence.me, first ? { title: 'Join the table', action: 'Join' } : { title: 'Your name and color', action: 'Save' });
    if (!choice) return;
    const me = info(savePlayer(choice));
    room.presence.setMe(me);
    app.playerRenamed(me);
  };
  mountRoomStatus(
    app,
    room,
    chrome.topRight,
    () => {
      room.leave();
      location.href = location.pathname;
    },
    () => void rename(),
  );
  mountChat(app, chrome.topRight, ROOM);
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
  const room = joinBridge(app, url, { id: stored.id, name: stored.name, color: stored.color }, BRIDGE_ADDR?.token);
  (window as any).room = room;
  bridgeRoom = room;
  // the token came in the link's fragment: keep it with the address (for next time) and take it out of the URL
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  // pasting a link with a token into a tab already on this bridge only changes the #fragment: connect again with it
  window.addEventListener('hashchange', () => /token=/.test(location.hash) && location.reload());
  mountRoomStatus(
    app,
    room,
    chrome.topRight,
    () => {
      room.leave();
      location.href = location.pathname;
    },
    async () => {
      const choice = await askName(room.presence.me, { title: 'Your name and color', action: 'Save' });
      if (!choice) return;
      const me = savePlayer(choice);
      room.presence.setMe(me);
      app.playerRenamed({ id: me.id, name: me.name, color: me.color });
    },
  );
  mountChat(app, chrome.topRight, url);
  flash(`Connecting to the bridge at ${url}…`);
  room.synced.then(() => {
    rememberBridge({ url, token: BRIDGE_ADDR?.token });
    app.store.undoManager.clear();
    app.view.fit();
    flash('Connected: this table is the bridge’s .canvas file');
  });
}

// for poking at it from the console
(window as any).app = app;
