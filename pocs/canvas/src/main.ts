import './style.css';
import { App, type Room, chromeButton, joinBridge, mountAgentView, joinRoom, loadPlayer, mountChat, mountChrome, mountLog, mountTheme, mountZoomControl, savePlayer, openFile, parse, serialize, persistLocally, persistViewport, resetFileHandle, roomDbName, saveFile, type CanvasDoc } from './core';
import { copyText, createRoomFrom, mountRoomStatus, roomFromUrl, roomLink } from './share';
import { openBridgeDialog } from './bridgeDialog';
import { bridgeFromLocation, bridgeHref, rememberBridge } from './bridges';
import { askName } from './nameDialog';
import { probeBoard } from './serve/probe';
import { boardWsUrl, servedBoardName } from './serve/route';
import { createUnique, fileStem, openServedBoard } from './serve/newBoard';
import { showBoardScreen } from './serve/boardScreen';
import { cardsPlugin } from './plugins/cards';
import { chessPlugin } from './plugins/chess';
import { clockPlugin } from './plugins/clock';
import { battleLinePlugin } from './plugins/battleline';
import { matsPlugin } from './plugins/mats';
import { boardPlugin } from './plugins/board';
import { stormPlugin } from './plugins/eventstorm';
import { prototypePlugin } from './plugins/prototype';
import { diagramPlugin } from './plugins/diagram';
import { excalidrawPlugin } from './plugins/excalidraw';
import { registerPluginLogic } from './plugins/logic';
import { mountHelp, removeHelpNote } from './help';
import { attachFollow, createFramesPlugin, portalsEnabled, enterUrl, mountBreadcrumb, trailFromUrl } from './plugins/frames';

const BRIDGE_ADDR = bridgeFromLocation(location);
const BRIDGE = BRIDGE_ADDR?.url ?? null;
// on a canvas service, /b/<name> is a board it hosts (a ?bridge= address still wins; ?room= is ignored there)
const SERVED = BRIDGE ? null : servedBoardName(location.pathname);
// ?agentView=<actor id>: the page a screenshot provider keeps open (core/agentView.ts); only on a hosted board
const AGENT_VIEW = BRIDGE || SERVED !== null ? new URLSearchParams(location.search).get('agentView') : null;
const ROOM = BRIDGE || SERVED !== null ? null : roomFromUrl();
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
if (AGENT_VIEW) app.readOnly = true;
const chrome = mountChrome(app);
mountTheme(app, { forceLight: !!AGENT_VIEW });
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
app.use(diagramPlugin);
app.use(excalidrawPlugin);
// frames' logic is last in PLUGIN_LOGIC (src/plugins/logic.ts): its rider rule must come after the others, so it is registered there
const TRAIL = trailFromUrl();
const frames = createFramesPlugin({ room: ROOM, portals: portalsEnabled(), enter: (room) => (location.href = enterUrl(room, ROOM, TRAIL)) });
app.use(frames);
app.store.migrations.push(removeHelpNote);


/** An empty board: nothing is put on it (everything is in the Add menu). */
function newBoard() {
  resetFileHandle();
  app.store.load({ nodes: [], edges: [] });
  app.tableReplaced();
  app.store.undoManager.clear();
  app.store.select([]);
  app.view.fit();
}

function openDoc(doc: CanvasDoc & { skipped?: string[] }, name: string) {
  app.store.load(doc);
  app.tableReplaced();
  app.view.fit();
  flash(doc.skipped?.length ? `Opened ${name} (skipped ${doc.skipped.length} bad entries)` : `Opened ${name}`);
}

/**
 * What this page's board is: 'served' / 'bridge' once connected (the store refuses `load` for both), 'pending' on a served
 * page until the service answers (replaces are refused meanwhile), null for a local board.
 * Runtime state, not the URL: on a static host `/b/x` boots local and behaves locally.
 */
let hosted: 'served' | 'bridge' | 'pending' | null = SERVED !== null ? 'pending' : null;
/** New board / Open / drop while the board is not ours to replace: a bridge's file, or a served page still waiting for the service to answer. */
const refuse = () => flash(hosted === 'pending' ? 'Opening the board…' : REFUSE);
const REFUSE = 'This board is the bridge’s file: New board and Open would overwrite it';
const failed = (what: string, e: unknown) => flash(`${what} failed: ${(e as Error).message}`);

/** A served board is a file the service keeps: New board makes another board and opens it. */
async function servedNew() {
  try {
    const { name, sameTab } = await openServedBoard(() => createUnique('Untitled', undefined));
    flash(`Made ${name}${sameTab ? '' : ': opened in a new tab'}`);
  } catch (e) {
    failed('New board', e);
  }
}
/** Open / drop on a served board: the file becomes a new served board. */
async function servedImport(fileName: string, text: string) {
  try {
    const { name } = await openServedBoard(() => createUnique(fileStem(fileName), text));
    flash(`Imported ${fileName} as ${name}`);
  } catch (e) {
    failed('Open', e);
  }
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
  if (hosted === 'bridge' || hosted === 'pending') return refuse();
  try {
    const res = await openFile();
    if (!res) return;
    if (hosted === 'served') {
      resetFileHandle(); // the picked file must not become the save target of the served board, whatever the import does
      return void (await servedImport(res.name, serialize(res.doc)));
    }
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
    label: 'New board',
    run: () => {
      if (hosted === 'served') return void servedNew();
      if (hosted === 'bridge' || hosted === 'pending') return refuse();
      if (confirm(ROOM ? 'Start a new board for everyone in this room?' : 'Start a new board? Unsaved changes are lost.')) newBoard();
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

if (!ROOM && !BRIDGE && SERVED === null) {
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
  if (hosted === 'bridge' || hosted === 'pending') return refuse();
  try {
    const doc = parse(await file.text()); // a file that is no canvas fails here, before a board is made for it
    if (hosted === 'served') return void (await servedImport(file.name, serialize(doc)));
    resetFileHandle();
    openDoc(doc, file.name);
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

const view = AGENT_VIEW ? null : persistViewport(app, VIEW_KEY);
if (BRIDGE) startBridge(BRIDGE);
else if (SERVED !== null) void probeBoard(SERVED).then((p) => {
    if (p.kind === 'ok') return startBridge(boardWsUrl(location, SERVED), { name: p.name });
    // the screenshot page has no board screen to show: it says why it has nothing to shoot, at once
    if (AGENT_VIEW) return agentViewFailed(p.kind === 'missing' ? `board not found: ${p.error}` : `board not available: ${p.kind === 'none' ? 'the service did not answer' : p.error}`);
    return p.kind === 'none' ? ((hosted = null), startLocal()) : showBoardScreen(p, SERVED);
  });
else startLocal();

/** No service: the board of this browser (IndexedDB), or a room. */
function startLocal() {
  persistLocally(app, DB_NAME).then(({ empty }) => {
  if (!ROOM) {
    if (empty) newBoard();
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
}

/** Bridge mode (?bridge=ws://host:5222): the table is a .canvas file a bridge process hosts; agents join it. A board of a canvas service (`served`) is the same, on this origin. */
function startBridge(url: string, served?: { name: string }) {
  hosted = served ? 'served' : 'bridge';
  const stored = loadPlayer();
  const room = joinBridge(app, url, { id: stored.id, name: stored.name, color: stored.color }, BRIDGE_ADDR?.token, { observer: !!AGENT_VIEW });
  (window as any).room = room;
  bridgeRoom = room;
  if (AGENT_VIEW) return startAgentView(room, AGENT_VIEW);
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
      location.href = served ? '/' : location.pathname;
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
  if (served) {
    document.title = `${served.name} · Canvas`;
    const back = document.createElement('a');
    back.href = '/';
    back.className = 'share-btn';
    back.textContent = 'All boards';
    chrome.topLeft.prepend(back);
  }
  flash(served ? `Opening ${served.name}…` : `Connecting to the bridge at ${url}…`);
  room.synced.then(() => {
    // a served board is on this very origin: remembering it would fill the saved bridges
    if (!served) rememberBridge({ url, token: BRIDGE_ADDR?.token });
    app.store.undoManager.clear();
    app.view.fit();
    flash(served ? `Opened ${served.name}` : 'Connected: this table is the bridge’s .canvas file');
  });
}

function agentViewFailed(why: string) {
  const failed = Promise.reject(new Error(why));
  failed.catch(() => {});
  (window as any).canvasSynced = failed;
}

/** The screenshot page: the seat's view of the board, read-only, no status pill, chat, toasts or remembered bridge. */
function startAgentView(room: Room & { synced: Promise<void> }, seat: string) {
  app.viewer = seat;
  document.body.classList.add('agent-view');
  mountAgentView(app);
  (window as any).canvasSynced = room.synced.then(() => {
    app.store.undoManager.clear();
    app.view.fit();
  });
}

// for poking at it from the console
(window as any).app = app;
