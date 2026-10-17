import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardHref } from '../../src/serve/route';
import { listBoards } from '../../src/serve/api';
import { createUnique, fileStem } from '../../src/serve/newBoard';
import { classify, normalizeBackend, pushRecent, sanitizeState, type Bounds, type State } from './logic';
import { APP_NAME, DEFAULT_BACKEND, userDataDir } from './paths';

// Collie Canvas desktop: a window shell over a canvas serve (the "backend", default the always-on one on
// the Mini). One window per board, a Boards window for the serve's home page, a quick switcher, the
// state kept between launches. The boards live on the serve; this app has no writer of its own.

app.setName(APP_NAME);
app.setPath('userData', resolve(userDataDir()));
const USER = app.getPath('userData');
mkdirSync(join(USER, 'logs'), { recursive: true });
const LOG_FILE = join(USER, 'logs', 'main.log');
const STATE_FILE = join(USER, 'state.json');
const UI_HTML = join(__dirname, 'ui.html');
const UI_URL = pathToFileURL(UI_HTML).href;

function log(...m: unknown[]) {
  const line = `${new Date().toISOString()} ${m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.enableSandbox();

// ---------------------------------------------------------------- state

const envBackend = normalizeBackend(process.env.CANVAS_BACKEND ?? '');
let state: State = (() => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  const s = sanitizeState(raw, DEFAULT_BACKEND);
  return envBackend ? { ...s, backend: envBackend } : s;
})();
const backend = () => state.backend;

function persist() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    log('state: could not save', (e as Error).message);
  }
}

// ---------------------------------------------------------------- windows

const HOME = '\0boards';
/** Board name (or HOME) -> its window. */
const wins = new Map<string, BrowserWindow>();
/** The page a window should be showing (the error screen comes back to it). */
const targets = new WeakMap<BrowserWindow, string>();
const pollers = new WeakMap<BrowserWindow, NodeJS.Timeout>();
let quitting = false;
let ready = false;
const hidden = process.env.CANVAS_HIDE_WINDOWS === '1';

let saveTimer: NodeJS.Timeout | undefined;
function snapshot() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  state.windows = [...wins].filter(([, w]) => !w.isDestroyed()).map(([k, w]) => ({ board: k === HOME ? null : k, bounds: w.getNormalBounds() as Bounds }));
  persist();
}
const snapshotSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(snapshot, 400);
};

const urlFor = (key: string) => (key === HOME ? `${backend()}/` : `${backend()}${boardHref(key)}`);

function createWindow(key: string, bounds?: Bounds): BrowserWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? (key === HOME ? 960 : 1280),
    height: bounds?.height ?? (key === HOME ? 680 : 820),
    ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    title: key === HOME ? 'Boards' : key,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') },
  });
  wins.set(key, win);
  win.on('page-title-updated', (e) => e.preventDefault()); // the title is the board's name
  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });
  win.on('move', snapshotSoon);
  win.on('resize', snapshotSoon);
  win.on('focus', buildMenu);
  win.on('closed', () => {
    clearInterval(pollers.get(win));
    if (wins.get(key) === win) wins.delete(key);
    if (!quitting) snapshot();
    buildMenu();
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    route(win, url);
    return { action: 'deny' };
  });
  const guard = (e: Electron.Event, url: string) => {
    if (url.startsWith(UI_URL)) return;
    const t = classify(backend(), url);
    if (t.kind === 'internal') return;
    if (t.kind === 'board' && key === t.name) return;
    if (t.kind === 'home' && key === HOME) return;
    e.preventDefault();
    route(win, url);
  };
  wc.on('will-navigate', (e) => guard(e, e.url));
  wc.on('will-redirect', (e) => guard(e, e.url));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || url.startsWith(UI_URL)) return; // -3: aborted by a newer navigation
    log(`load failed: ${url} ${code} ${desc}`);
    showError(win, desc);
  });
  wc.on('console-message', (e) => {
    if (e.level === 'error') log(`renderer ${key === HOME ? 'boards' : key}: ${e.message}`);
  });
  load(win, urlFor(key));
  buildMenu();
  return win;
}

function load(win: BrowserWindow, url: string) {
  targets.set(win, url);
  clearInterval(pollers.get(win));
  void win.loadURL(url).catch(() => {}); // failure arrives as did-fail-load
}

function showError(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return;
  const url = targets.get(win) ?? backend();
  void win.loadFile(UI_HTML, { query: { mode: 'error', url: backend(), msg: reason.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase() } }).catch(() => {});
  clearInterval(pollers.get(win));
  pollers.set(
    win,
    setInterval(async () => {
      if (win.isDestroyed()) return;
      if (await reachable(backend())) load(win, url);
    }, 3000),
  );
}

async function reachable(origin: string): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** A link that left a window: a board of this backend opens (or focuses) its window, anything else the browser. */
function route(from: BrowserWindow | null, url: string) {
  const t = classify(backend(), url);
  if (t.kind === 'board') return void openBoard(t.name);
  if (t.kind === 'home') return openHome();
  if (t.kind === 'external') return openExternal(url);
  if (t.kind === 'internal' && from && !from.isDestroyed()) return load(from, url);
}

function openExternal(url: string) {
  if (process.env.CANVAS_TEST === '1') ((globalThis as any).__opened ??= []).push(url); // the e2e test must not open a browser
  else void shell.openExternal(url);
}

function focusWin(w: BrowserWindow) {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function openBoard(name: string, bounds?: Bounds, restoring = false): BrowserWindow {
  if (!restoring) state.recent = pushRecent(state.recent, name);
  const existing = wins.get(name);
  if (existing && !existing.isDestroyed()) {
    focusWin(existing);
    return existing;
  }
  const win = createWindow(name, bounds);
  snapshot();
  return win;
}

function openHome(bounds?: Bounds): BrowserWindow {
  const existing = wins.get(HOME);
  if (existing && !existing.isDestroyed()) {
    focusWin(existing);
    return existing;
  }
  const win = createWindow(HOME, bounds);
  snapshot();
  return win;
}

/** A fetch that talks to the backend: the board API calls use paths relative to the page. */
const backendFetch = ((path: string, init?: RequestInit) => fetch(backend() + path, { signal: AbortSignal.timeout(8000), ...init })) as unknown as typeof fetch;

async function newBoard(base = 'Untitled', text?: string): Promise<string | null> {
  try {
    const name = await createUnique(base, text, backendFetch);
    openBoard(name);
    return name;
  } catch (e) {
    dialog.showErrorBox('Could not create the board', `${(e as Error).message}\n\nBackend: ${backend()}`);
    return null;
  }
}

async function importFile(file: string) {
  try {
    await newBoard(fileStem(basename(file)), readFileSync(file, 'utf8'));
  } catch (e) {
    dialog.showErrorBox('Could not import the file', (e as Error).message);
  }
}

async function importDialog() {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'JSON Canvas', extensions: ['canvas', 'json'] }] });
  for (const f of r.filePaths) await importFile(f);
}

// ---------------------------------------------------------------- the app's own windows

function uiWindow(mode: 'switcher' | 'backend', size: { width: number; height: number }) {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const win = new BrowserWindow({
    ...size,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    frame: mode === 'backend',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: mode === 'backend' ? 'Backend' : 'Open board',
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') },
  });
  win.once('ready-to-show', () => (hidden ? undefined : win.show()));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadFile(UI_HTML, { query: hidden ? { mode, keep: '1' } : { mode } }); // keep: tests run hidden windows, which are never focused
  return win;
}

let switcher: BrowserWindow | undefined;
function openSwitcher() {
  if (switcher && !switcher.isDestroyed()) return switcher.focus();
  switcher = uiWindow('switcher', { width: 520, height: 380 });
  switcher.on('closed', () => (switcher = undefined));
}

let backendWin: BrowserWindow | undefined;
function openBackendDialog() {
  if (backendWin && !backendWin.isDestroyed()) return backendWin.focus();
  backendWin = uiWindow('backend', { width: 520, height: 280 });
  backendWin.on('closed', () => (backendWin = undefined));
}

/** Only the app's own pages (never a page from the backend) may call the shell. */
const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => e.senderFrame?.url.startsWith(UI_URL) === true;

ipcMain.handle('ui:boards', async (e) => {
  if (!trusted(e)) return { names: [] };
  try {
    return { names: (await listBoards(backendFetch)).map((b) => b.name).sort((a, b) => a.localeCompare(b)) };
  } catch (err) {
    return { names: [], error: `Can't list boards: ${(err as Error).message}` };
  }
});
ipcMain.handle('ui:open', (e, name: unknown) => {
  if (trusted(e) && typeof name === 'string' && name) openBoard(name);
});
ipcMain.handle('ui:create', async (e, name: unknown) => {
  if (!trusted(e) || typeof name !== 'string') return { error: 'refused' };
  try {
    openBoard(await createUnique(name, undefined, backendFetch));
    return {};
  } catch (err) {
    return { error: (err as Error).message };
  }
});
ipcMain.handle('ui:backend', (e) => (trusted(e) ? backend() : ''));
ipcMain.handle('ui:set-backend', async (e, value: unknown, force: unknown) => {
  if (!trusted(e) || typeof value !== 'string') return { error: 'refused' };
  const origin = normalizeBackend(value);
  if (!origin) return { error: 'Not a web address (http://host:port).' };
  if (!force) {
    let ok = false;
    try {
      const r = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(4000) });
      ok = r.ok && (await r.json()).service === 'canvas-serve';
    } catch {}
    if (!ok) return { error: `No canvas serve answers at ${origin}.`, canForce: true };
  }
  state = { ...state, backend: origin, windows: [], recent: origin === state.backend ? state.recent : [] };
  persist();
  log(`backend: ${origin}`);
  setImmediate(() => {
    for (const w of [...wins.values()]) w.destroy();
    wins.clear();
    openHome();
    buildMenu();
  });
  return { ok: true };
});
ipcMain.on('ui:retry', (e) => {
  if (!trusted(e)) return;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && targets.has(w)) load(w, targets.get(w)!);
});
ipcMain.on('ui:close', (e) => {
  if (trusted(e)) BrowserWindow.fromWebContents(e.sender)?.close();
});

// ---------------------------------------------------------------- agents

const MCP_COMMAND = () => `claude mcp add --transport http canvas ${backend()}/mcp`;

async function connectClaude() {
  const r = await dialog.showMessageBox({
    type: 'info',
    message: 'Connect Claude Code',
    detail: `Agents reach the boards through the backend's own MCP endpoint, not through this app. Run once in a terminal:\n\n${MCP_COMMAND()}`,
    buttons: ['Copy command', 'Close'],
    defaultId: 0,
  });
  if (r.response === 0) clipboard.writeText(MCP_COMMAND());
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const focused = BrowserWindow.getFocusedWindow();
  const open = [...wins].filter(([, w]) => !w.isDestroyed()).sort(([a], [b]) => (a === HOME ? -1 : b === HOME ? 1 : a.localeCompare(b)));
  const recents = state.recent;
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Backend…', click: openBackendDialog },
        { label: 'Connect Claude Code…', click: () => void connectClaude() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Board', accelerator: 'CmdOrCtrl+N', click: () => void newBoard() },
        { label: 'Open Board…', accelerator: 'CmdOrCtrl+O', click: openSwitcher },
        { label: 'Quick Switcher…', accelerator: 'CmdOrCtrl+K', click: openSwitcher },
        { label: 'Boards', accelerator: 'CmdOrCtrl+Shift+B', click: () => openHome() },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? [...recents.map((n) => ({ label: n, click: () => void openBoard(n) })), { type: 'separator' as const }, { label: 'Clear Menu', click: () => ((state.recent = []), persist(), buildMenu()) }]
            : [{ label: 'No recent boards', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Import .canvas File…', click: () => void importDialog() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...(open.length
          ? open.map(([k, w]): MenuItemConstructorOptions => ({ label: k === HOME ? 'Boards' : k, type: 'checkbox', checked: w === focused, click: () => focusWin(w) }))
          : [{ label: 'No windows', enabled: false } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- security

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

// ---------------------------------------------------------------- files from the OS

const pending: string[] = [];
const isCanvasFile = (f: string) => /\.canvas$/i.test(f);
pending.push(...process.argv.slice(1).filter(isCanvasFile).map((f) => resolve(f)));
app.on('open-file', (e, path) => {
  // Finder double-click / drop on the Dock icon: imported as a new board on the backend
  e.preventDefault();
  if (ready) void importFile(path);
  else pending.push(path);
});
app.on('second-instance', (_e, argv, cwd) => {
  const files = argv.slice(1).filter(isCanvasFile);
  for (const f of files) void importFile(resolve(cwd, f));
  const w = [...wins.values()][0];
  if (!files.length && w) focusWin(w);
  else if (!files.length) openHome();
});

// ---------------------------------------------------------------- start

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)));
  log(`ready: backend ${backend()}, electron ${process.versions.electron}`);
  ready = true;
  const saved = state.windows;
  for (const w of saved) w.board === null ? openHome(w.bounds) : openBoard(w.board, w.bounds, true);
  if (!wins.size) openHome();
  for (const f of pending.splice(0)) void importFile(f);
  buildMenu();
  if (process.env.CANVAS_TEST === '1') {
    // hooks for the Electron e2e test (test/desktop.e2e.mjs); never set in a real run
    (globalThis as any).__shell = { openBoard, openHome, newBoard, openSwitcher, openBackendDialog, wins, state: () => state, menu: () => Menu.getApplicationMenu() };
  }
});

// macOS: the app stays running with no window; the Dock icon opens the Boards window again
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (ready && !BrowserWindow.getAllWindows().length) openHome();
});
app.on('before-quit', () => {
  // the windows open now are the ones to bring back
  snapshot();
  quitting = true;
});
