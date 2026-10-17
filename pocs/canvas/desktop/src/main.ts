import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardHref } from '../../src/serve/route';
import { listBoards } from '../../src/serve/api';
import { createUnique, fileStem } from '../../src/serve/newBoard';
import { classify, iconSpec, normalizeBackend, pageTitle, parseArgs, popoutId, pushRecent, sanitizeState, type Bounds, type State } from './logic';
import { listen, listInstances, livePopout, livePopouts, mainSocket, pidAlive, popoutDir, popoutSocket, readInstance, send, writeInstance, type InstanceInfo, type Message, type Reply } from './instances';
import { APP_NAME, DEFAULT_BACKEND, userDataDir } from './paths';

// Collie Canvas desktop: a window shell over a canvas serve (the "backend", default the always-on one on
// the Mini). Two roles of one binary:
//  - the main app: one window that shows the canvas list or one canvas, navigated in place (back/forward,
//    quick switcher). Any canvas can be popped out;
//  - a pop-out (`--canvas=<name>`): a separate process with its own Dock icon and one window on that canvas.
// The canvases live on the serve; this app has no writer of its own.

const MAIN_DATA = resolve(userDataDir());
const launchArgs = parseArgs(process.argv);
const POPOUT = launchArgs.popout;
const isPopout = POPOUT !== undefined;
const USER = isPopout ? popoutDir(MAIN_DATA, POPOUT) : MAIN_DATA;
app.setName(APP_NAME);
app.setPath('userData', USER);
mkdirSync(join(USER, 'logs'), { recursive: true });
const LOG_FILE = join(USER, 'logs', 'main.log');
const STATE_FILE = join(MAIN_DATA, 'state.json');
const UI_HTML = join(__dirname, 'ui.html');
const UI_URL = pathToFileURL(UI_HTML).href;

function log(...m: unknown[]) {
  const line = `${new Date().toISOString()} ${isPopout ? `[${POPOUT}] ` : ''}${m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
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

// ---------------------------------------------------------------- state (the main app writes it; a pop-out only reads the backend)

const envBackend = normalizeBackend(process.env.CANVAS_BACKEND ?? '');
// CANVAS_BACKEND on the installed app's own data (no CANVAS_USER_DATA) is for this run only: nothing is read from or written to state.json
const sessionOnly = !!envBackend && !process.env.CANVAS_USER_DATA;
let state: State = (() => {
  let raw: unknown;
  if (!sessionOnly)
    try {
      raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {}
  const s = sanitizeState(raw, DEFAULT_BACKEND);
  return envBackend ? { ...s, backend: envBackend } : s;
})();
const backend = () => state.backend;

function persist() {
  if (sessionOnly || isPopout) return;
  try {
    // temp file + rename: a crash mid-write must not lose the saved backend
    writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2) + '\n');
    renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) {
    log('state: could not save', (e as Error).message);
  }
}

// ---------------------------------------------------------------- the window

/** The one window of this process: the main window, or the pop-out's. */
let win: BrowserWindow | undefined;
/** The canvas the window shows (null = the list). */
let shown: string | null = isPopout ? POPOUT : state.main.canvas;
/** The page the window should be showing (the error screen comes back to it). */
let target = '';
let poller: NodeJS.Timeout | undefined;
let quitting = false;
let ready = false;
const hidden = process.env.CANVAS_HIDE_WINDOWS === '1';
const alive = () => (win && !win.isDestroyed() ? win : undefined);

const urlFor = (canvas: string | null) => (canvas === null ? `${backend()}/` : `${backend()}${boardHref(canvas)}`);
const canvasOf = (url: string): string | null => {
  const t = classify(backend(), url);
  return t.kind === 'canvas' ? t.name : null;
};

let instance: InstanceInfo | undefined;
const saveInstance = (patch: Partial<InstanceInfo> = {}) => {
  if (!instance) return;
  instance = { ...instance, ...patch };
  try {
    writeInstance(MAIN_DATA, instance);
  } catch (e) {
    log('instance: could not save', (e as Error).message);
  }
};

let saveTimer: NodeJS.Timeout | undefined;
function snapshot() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const w = alive();
  if (!w) return;
  const bounds = w.getNormalBounds() as Bounds;
  if (isPopout) return saveInstance({ bounds, title: w.getTitle(), url: w.webContents.getURL() });
  state.main = { canvas: shown, bounds };
  persist();
}
const snapshotSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(snapshot, 400);
};

function createWindow(bounds?: Bounds): BrowserWindow {
  const w = new BrowserWindow({
    width: bounds?.width ?? (shown === null ? 960 : 1280),
    height: bounds?.height ?? (shown === null ? 680 : 820),
    ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    title: pageTitle(shown),
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') },
  });
  win = w;
  w.on('page-title-updated', (e) => e.preventDefault()); // the title is the canvas' name
  w.once('ready-to-show', () => {
    if (!hidden) w.show();
  });
  w.on('move', snapshotSoon);
  w.on('resize', snapshotSoon);
  w.on('focus', buildMenu);
  w.on('close', () => {
    // a pop-out closed by the user is not brought back on the next launch (quitting the app keeps it)
    if (isPopout && !quitting) saveInstance({ keep: false });
  });
  w.on('closed', () => {
    clearInterval(poller);
    if (win === w) win = undefined;
    if (!quitting && !isPopout) snapshot();
    buildMenu();
  });
  const wc = w.webContents;
  // The app's shortcuts win over the canvas page's own (the page binds Cmd+O to its file import; File > Import covers it here)
  wc.on('before-input-event', (e, i) => {
    const mod = process.platform === 'darwin' ? i.meta : i.control;
    if (i.type !== 'keyDown' || !mod || i.alt) return;
    const k = i.key.toLowerCase();
    if (k === 'o' && !i.shift) (e.preventDefault(), openSwitcher());
    else if (k === 'k' && !i.shift) (e.preventDefault(), openSwitcher());
    else if (k === 'o' && i.shift && !isPopout) (e.preventDefault(), popOutShown());
    else if ((k === '[' || k === ']') && !i.shift && !isPopout) (e.preventDefault(), k === '[' ? goBack() : goForward());
  });
  wc.setWindowOpenHandler(({ url }) => {
    route(url);
    return { action: 'deny' };
  });
  const guard = (e: Electron.Event, url: string) => {
    if (url.startsWith(UI_URL)) return;
    const t = classify(backend(), url);
    if (t.kind === 'internal') return;
    if (t.kind === 'home' && !isPopout) return;
    if (t.kind === 'canvas' && (isPopout ? t.name === POPOUT : !isPoppedOut(t.name))) return;
    e.preventDefault();
    route(url);
  };
  wc.on('will-navigate', (e) => guard(e, e.url));
  wc.on('will-redirect', (e) => guard(e, e.url));
  const navigated = (_e: unknown, url: string) => {
    if (url.startsWith(UI_URL)) return;
    const name = canvasOf(url);
    if (!isPopout && name !== null && isPoppedOut(name)) {
      // back/forward landed on a canvas that has its own window: show that one instead
      return void focusPopout(name).then((ok) => ok && !w.isDestroyed() && load(w, urlFor(null)));
    }
    if (classify(backend(), url).kind === 'internal') return;
    shown = isPopout ? POPOUT : name;
    if (!isPopout) w.setTitle(pageTitle(shown));
    snapshot();
    buildMenu();
  };
  wc.on('did-navigate', navigated);
  wc.on('did-navigate-in-page', (_e, url, isMain) => isMain && navigated(_e, url));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || url.startsWith(UI_URL)) return; // -3: aborted by a newer navigation
    log(`load failed: ${url} ${code} ${desc}`);
    showError(w, desc);
  });
  wc.on('console-message', (e) => {
    if (e.level === 'error') log(`renderer ${shown ?? 'canvases'}: ${e.message}`);
  });
  load(w, urlFor(shown));
  buildMenu();
  return w;
}

function load(w: BrowserWindow, url: string) {
  target = url;
  clearInterval(poller);
  void w.loadURL(url).catch(() => {}); // failure arrives as did-fail-load
}

function showError(w: BrowserWindow, reason: string) {
  if (w.isDestroyed()) return;
  const url = target || backend();
  void w.loadFile(UI_HTML, { query: { mode: 'error', url: backend(), msg: reason.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase() } }).catch(() => {});
  clearInterval(poller);
  poller = setInterval(async () => {
    if (w.isDestroyed()) return;
    if (await reachable(backend())) load(w, url);
  }, 3000);
}

async function reachable(origin: string): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

function focusWin(w: BrowserWindow) {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// ---------------------------------------------------------------- opening canvases

/** A link that left the window: a canvas of this backend opens (or focuses) where it belongs, anything else the browser. */
function route(url: string) {
  const t = classify(backend(), url);
  if (t.kind === 'canvas') return void openCanvas(t.name);
  if (t.kind === 'home') return void openCanvas(null);
  if (t.kind === 'external') return openExternal(url);
  const w = alive();
  if (t.kind === 'internal' && w) return load(w, url);
}

function openExternal(url: string) {
  if (process.env.CANVAS_TEST === '1') ((globalThis as any).__opened ??= []).push(url); // the e2e test must not open a browser
  else void shell.openExternal(url);
}

/** Is `name` open in a pop-out process right now? Synchronous (a will-navigate guard needs that): the registry file and the process; a stale entry is caught when focusing fails. */
function isPoppedOut(name: string): boolean {
  if (isPopout && name === POPOUT) return false;
  const i = readInstance(MAIN_DATA, name);
  return !!i && pidAlive(i.pid) && i.pid !== process.pid;
}

const focusPopout = async (name: string): Promise<boolean> => !!(await send(popoutSocket(MAIN_DATA, name), { cmd: 'focus' }));

/** The main app's executable (a pop-out runs from a renamed copy, but starts the main app from the real one). */
const MAIN_EXEC = process.env.COLLIE_CANVAS_MAIN_EXEC ?? process.execPath;

/**
 * What a pop-out runs: a clone of the app bundle that macOS lists under the canvas' name (Cmd+Tab, Dock
 * label, Activity Monitor) instead of "Collie Canvas". An APFS clone costs no disk and ~0.6 s the first
 * time (edit Info.plist, ad-hoc sign); it is rebuilt when the app changes. Anything wrong: the plain app.
 */
function popoutExecutable(name: string): string {
  if (!app.isPackaged || process.platform !== 'darwin') return MAIN_EXEC;
  try {
    const bundle = resolve(MAIN_EXEC, '../../..');
    const shim = join(MAIN_DATA, 'shims', `${popoutId(name)}.app`);
    const exe = join(shim, 'Contents', 'MacOS', basename(MAIN_EXEC));
    const stamp = `${bundle}|${statSync(join(bundle, 'Contents', 'Info.plist')).mtimeMs}|${name}`;
    let have = '';
    try {
      have = readFileSync(shim + '.stamp', 'utf8');
    } catch {}
    if (have !== stamp) {
      rmSync(shim, { recursive: true, force: true });
      mkdirSync(dirname(shim), { recursive: true });
      execFileSync('/bin/cp', ['-cR', bundle, shim]);
      const plist = join(shim, 'Contents', 'Info.plist');
      const set = (k: string, v: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${k} ${v.replace(/[\r\n]+/g, ' ')}`, plist]);
      set('CFBundleDisplayName', name);
      set('CFBundleIdentifier', `studio.collie.canvas.${popoutId(name)}`);
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', shim]);
      writeFileSync(shim + '.stamp', stamp);
    }
    return exe;
  } catch (e) {
    log('pop-out copy failed, using the app itself:', (e as Error).message);
    return MAIN_EXEC;
  }
}

/** Launch another instance of this app (the same binary: a packaged app, or electron with the app path in a dev run). */
function launch(args: string[], popoutOf?: string) {
  const exe = popoutOf !== undefined ? popoutExecutable(popoutOf) : MAIN_EXEC;
  const child = spawn(exe, [...(app.isPackaged ? [] : [app.getAppPath()]), ...args], { detached: true, stdio: 'ignore', env: { ...process.env, COLLIE_CANVAS_MAIN_EXEC: MAIN_EXEC } });
  child.on('error', (e) => log('launch failed:', e.message));
  child.unref();
}

/**
 * Show a canvas (null = the list): in its own window when it has one, else in the main window. From a
 * pop-out the main app does it (started when it isn't running).
 */
async function openCanvas(name: string | null, opts: { popout?: boolean } = {}): Promise<void> {
  if (name !== null && !opts.popout && (await focusPopout(name))) return;
  if (isPopout) {
    if (name === POPOUT) return void (alive() && focusWin(alive()!));
    if (name !== null && opts.popout) return void (await popOut(name));
    if (await send(mainSocket(MAIN_DATA), { cmd: 'open', canvas: name ?? undefined })) return;
    return launch(name === null ? [] : [`--open-canvas=${name}`]);
  }
  if (name !== null) state.recent = pushRecent(state.recent, name);
  if (name !== null && opts.popout) return void (await popOut(name));
  navigateMain(name);
}

function navigateMain(name: string | null) {
  const w = alive();
  shown = name;
  if (!w) {
    createWindow(state.main.bounds);
    return;
  }
  focusWin(w);
  if (w.webContents.getURL() !== urlFor(name)) load(w, urlFor(name));
}

async function popOut(name: string) {
  if (await focusPopout(name)) return;
  launch([`--canvas=${name}`], name);
  if (!isPopout && shown === name) navigateMain(null); // the canvas has its own window now; the main one goes to the list
}

const popOutShown = () => void (shown !== null && openCanvas(shown, { popout: true }));
const goBack = () => void (alive()?.webContents.navigationHistory.canGoBack() && alive()!.webContents.navigationHistory.goBack());
const goForward = () => void (alive()?.webContents.navigationHistory.canGoForward() && alive()!.webContents.navigationHistory.goForward());

/** A fetch that talks to the backend: the canvas API calls use paths relative to the page. */
const backendFetch = ((path: string, init?: RequestInit) => fetch(backend() + path, { signal: AbortSignal.timeout(8000), ...init })) as unknown as typeof fetch;

async function newCanvas(base = 'Untitled', text?: string, opts: { popout?: boolean } = {}): Promise<string | null> {
  try {
    const name = await createUnique(base, text, backendFetch);
    await openCanvas(name, opts);
    return name;
  } catch (e) {
    dialog.showErrorBox('Could not create the canvas', `${(e as Error).message}\n\nBackend: ${backend()}`);
    return null;
  }
}

async function importFile(file: string) {
  try {
    await newCanvas(fileStem(basename(file)), readFileSync(file, 'utf8'));
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
  const w = new BrowserWindow({
    ...size,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    frame: mode === 'backend',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: mode === 'backend' ? 'Backend' : 'Open canvas',
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(__dirname, 'preload.cjs') },
  });
  w.once('ready-to-show', () => (hidden ? undefined : w.show()));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void w.loadFile(UI_HTML, { query: hidden ? { mode, keep: '1' } : { mode } }); // keep: tests run hidden windows, which are never focused
  return w;
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

/** The Dock icon of a pop-out: its first letter on a color of its own, drawn by the app's page. */
async function setPopoutIcon(name: string) {
  const spec = iconSpec(name);
  const w = new BrowserWindow({ show: false, width: 256, height: 256, webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, 'preload.cjs') } });
  try {
    await w.loadFile(UI_HTML, { query: { mode: 'icon', letter: spec.letter, hue: String(spec.hue) } });
    const url: string = await w.webContents.executeJavaScript('window.drawIcon()');
    app.dock?.setIcon(nativeImage.createFromDataURL(url));
    saveInstance({ icon: spec });
  } catch (e) {
    log('icon failed:', (e as Error).message);
  } finally {
    w.destroy();
  }
}

/** Only the app's own pages (never a page from the backend) may call the shell. */
const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => e.senderFrame?.url.startsWith(UI_URL) === true;

ipcMain.handle('ui:canvases', async (e) => {
  if (!trusted(e)) return { names: [], popped: [] };
  const popped = listInstances(MAIN_DATA).filter((i) => pidAlive(i.pid)).map((i) => i.canvas);
  try {
    return { names: (await listBoards(backendFetch)).map((b) => b.name).sort((a, b) => a.localeCompare(b)), popped };
  } catch (err) {
    return { names: [], popped, error: `Can't list canvases: ${(err as Error).message}` };
  }
});
ipcMain.handle('ui:open', (e, name: unknown, popout: unknown) => {
  if (trusted(e) && typeof name === 'string' && name) void openCanvas(name, { popout: popout === true });
});
ipcMain.handle('ui:create', async (e, name: unknown, popout: unknown) => {
  if (!trusted(e) || typeof name !== 'string') return { error: 'refused' };
  try {
    await openCanvas(await createUnique(name, undefined, backendFetch), { popout: popout === true });
    return {};
  } catch (err) {
    return { error: (err as Error).message };
  }
});
ipcMain.handle('ui:backend', (e) => (trusted(e) ? backend() : ''));
ipcMain.handle('ui:set-backend', async (e, value: unknown, force: unknown) => {
  if (!trusted(e) || typeof value !== 'string' || isPopout) return { error: 'refused' };
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
  state = { ...state, backend: origin, main: { canvas: null }, recent: origin === state.backend ? state.recent : [] };
  persist();
  log(`backend: ${origin}`);
  // the pop-outs show canvases of the old backend: they close and are not brought back
  for (const i of await livePopouts(MAIN_DATA)) await send(popoutSocket(MAIN_DATA, i.canvas), { cmd: 'quit', forget: true });
  setImmediate(() => {
    alive()?.destroy();
    win = undefined;
    shown = null;
    createWindow();
  });
  return { ok: true };
});
ipcMain.on('ui:retry', (e) => {
  if (!trusted(e)) return;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w === win && target) load(w, target);
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
    detail: `Agents reach the canvases through the backend's own MCP endpoint, not through this app. Run once in a terminal:\n\n${MCP_COMMAND()}`,
    buttons: ['Copy command', 'Close'],
    defaultId: 0,
  });
  if (r.response === 0) clipboard.writeText(MCP_COMMAND());
}

// ---------------------------------------------------------------- menu

let poppedNames: string[] = [];
const showMain = () => void openCanvas(null);

function buildMenu() {
  const w = alive();
  const focused = BrowserWindow.getFocusedWindow();
  const hist = w?.webContents.navigationHistory;
  const recents = state.recent;
  const popped = poppedNames.filter((n) => n !== POPOUT);
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...(isPopout
          ? []
          : [{ label: 'Backend…', click: openBackendDialog }, { label: 'Connect Claude Code…', click: () => void connectClaude() }, { type: 'separator' } as MenuItemConstructorOptions]),
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Canvas', accelerator: 'CmdOrCtrl+N', click: () => void newCanvas() },
        { label: 'Open Canvas…', accelerator: 'CmdOrCtrl+O', click: openSwitcher },
        { label: 'Quick Switcher…', accelerator: 'CmdOrCtrl+K', click: openSwitcher },
        { label: 'Canvases', accelerator: 'CmdOrCtrl+Shift+B', click: showMain },
        ...(isPopout
          ? []
          : [
              { label: 'Open in Own Window', accelerator: 'CmdOrCtrl+Shift+O', enabled: shown !== null, click: popOutShown } as MenuItemConstructorOptions,
              {
                label: 'Open Recent',
                submenu: recents.length
                  ? [...recents.map((n) => ({ label: n, click: () => void openCanvas(n) })), { type: 'separator' as const }, { label: 'Clear Menu', click: () => ((state.recent = []), persist(), buildMenu()) }]
                  : [{ label: 'No recent canvases', enabled: false }],
              } as MenuItemConstructorOptions,
            ]),
        { type: 'separator' },
        { label: 'Import .canvas File…', click: () => void importDialog() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    ...(isPopout
      ? []
      : [
          {
            label: 'Go',
            submenu: [
              { label: 'Back', accelerator: 'CmdOrCtrl+[', enabled: !!hist?.canGoBack(), click: goBack },
              { label: 'Forward', accelerator: 'CmdOrCtrl+]', enabled: !!hist?.canGoForward(), click: goForward },
            ],
          } as MenuItemConstructorOptions,
        ]),
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...(w ? [{ label: w.getTitle(), type: 'checkbox', checked: w === focused, click: () => focusWin(w) } as MenuItemConstructorOptions] : []),
        ...popped.map((n): MenuItemConstructorOptions => ({ label: `${n} (own window)`, click: () => void focusPopout(n) })),
        ...(isPopout ? [{ label: 'Canvases', click: showMain } as MenuItemConstructorOptions] : []),
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
  // Finder double-click / drop on the Dock icon: imported as a new canvas on the backend
  e.preventDefault();
  if (ready) void importFile(path);
  else pending.push(path);
});
app.on('second-instance', (_e, argv, cwd) => {
  const files = argv.slice(1).filter(isCanvasFile);
  for (const f of files) void importFile(resolve(cwd, f));
  const open = parseArgs(argv).open;
  if (open && !isPopout) return void openCanvas(open);
  const w = alive();
  if (!files.length && w) focusWin(w);
  else if (!files.length && !isPopout) navigateMain(shown);
});

// ---------------------------------------------------------------- start

/** What other processes may ask of this one. */
function answer(m: Message): Reply {
  if (m.cmd === 'ping') return { ok: true, canvas: POPOUT ?? null, pid: process.pid };
  if (m.cmd === 'focus') {
    const w = alive();
    if (w) focusWin(w);
    saveInstance({ focused: (instance?.focused ?? 0) + 1 });
    return { ok: !!w };
  }
  if (m.cmd === 'quit') {
    if (m.forget) saveInstance({ keep: false });
    setImmediate(() => app.quit());
    return { ok: true };
  }
  if (m.cmd === 'open' && !isPopout) {
    void openCanvas(m.canvas ?? null);
    return { ok: true };
  }
  return { ok: false, error: `unknown command ${m.cmd}` };
}

/** Bring back the pop-outs that were open when the app (or the machine) went down. */
async function restorePopouts() {
  for (const i of listInstances(MAIN_DATA)) {
    if (i.keep && !(await livePopout(MAIN_DATA, i.canvas))) launch([`--canvas=${i.canvas}`], i.canvas);
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    let own = false;
    try {
      own = new URL(details.requestingUrl).origin === backend();
    } catch {}
    cb(own && ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  log(`ready: backend ${backend()}, electron ${process.versions.electron}${isPopout ? ', pop-out' : ''}`);
  const ttl = Number(process.env.CANVAS_TEST_TTL); // tests: instances end by themselves
  if (process.env.CANVAS_TEST === '1' && ttl > 0) setTimeout(() => app.exit(0), ttl * 1000).unref();
  try {
    const sock = isPopout ? popoutSocket(MAIN_DATA, POPOUT) : mainSocket(MAIN_DATA);
    const server = await listen(sock, answer);
    app.on('will-quit', () => server.close());
  } catch (e) {
    log('socket:', (e as Error).message);
    if (isPopout) return app.quit(); // another process already is this canvas' pop-out
  }
  ready = true;
  if (isPopout) {
    const prior = readInstance(MAIN_DATA, POPOUT);
    instance = { canvas: POPOUT, pid: process.pid, keep: true, bounds: prior?.bounds, sock: popoutSocket(MAIN_DATA, POPOUT) };
    saveInstance();
    createWindow(prior?.bounds);
    void setPopoutIcon(POPOUT);
  } else {
    if (launchArgs.open) shown = launchArgs.open;
    if (shown !== null) state.recent = pushRecent(state.recent, shown);
    createWindow(state.main.bounds);
    void restorePopouts();
    for (const f of pending.splice(0)) void importFile(f);
    // keep the Window menu's list of pop-outs current
    setInterval(() => {
      const names = listInstances(MAIN_DATA).filter((i) => pidAlive(i.pid)).map((i) => i.canvas).sort();
      if (names.join('\0') !== poppedNames.join('\0')) {
        poppedNames = names;
        buildMenu();
      }
    }, 2000).unref();
  }
  buildMenu();
  if (process.env.CANVAS_TEST === '1') {
    // hooks for the Electron e2e test (test/desktop.e2e.mjs); never set in a real run
    (globalThis as any).__shell = {
      openCanvas,
      popOut,
      newCanvas,
      openSwitcher,
      openBackendDialog,
      goBack,
      goForward,
      win: alive,
      shown: () => shown,
      state: () => state,
      menu: () => Menu.getApplicationMenu(),
      mainData: MAIN_DATA,
      popoutId,
    };
  }
});

// macOS: the main app stays running with no window (the Dock icon opens it again); a pop-out ends with its window
app.on('window-all-closed', () => {
  if (isPopout || process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!ready) return;
  const w = alive();
  if (w) focusWin(w);
  else if (!isPopout) navigateMain(shown);
});
app.on('before-quit', () => {
  // the window open now is the one to bring back
  snapshot();
  quitting = true;
});
