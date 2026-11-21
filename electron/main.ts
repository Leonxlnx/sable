import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, screen, session, shell, webContents, type MenuItemConstructorOptions, type Rectangle, type WebContents } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, type RunningServer } from '../server/serve';
import { fixPathFromLoginShell } from '../server/util/login-env';
import { pickFolder, type ShowFolderDialog } from './folder';

/**
 * Sable desktop shell. Runs the production server (UI + bridge) in this process on a localhost
 * port and shows it in one hardened window. Bundled to dist-electron/main.cjs by
 * scripts/build-electron.mjs; started with `electron .` from the project root, or packaged by
 * electron-builder (`pnpm desktop:dist`, configured in package.json → build).
 *
 * Development flags (verification only):
 *   --screenshot=<file.png>  wait until the app has rendered, capture the window, quit. The window
 *                            is placed far off-screen and kept out of the taskbar, so it never shows
 *   --eval=<js>              run a snippet in the page before the capture
 *   --wait=<ms>              delay between render (and eval) and capture
 *
 * Environment (verification only):
 *   SABLE_USER_DATA=<dir>    the window's own profile and single-instance lock, so a second copy can
 *                            run beside an installed Sable without being sent to it
 *   SABLE_WINDOW_SHOT=1      with --screenshot, also grab the real window (native buttons included)
 *                            to <file>-window.png when the system allows it
 *   SABLE_DIALOG_STUB=<dir>  with --screenshot, the folder dialog answers <dir> without showing
 */

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/** Preferred port: a stable origin keeps the page's local storage and zoom between runs. */
const PREFERRED_PORT = 47_317;
const BG = '#070708';
/** The panel browser's own persistent session: its cookies and storage never mix with the app's. */
const BROWSER_PARTITION = 'persist:sable-browser';

const flag = (name: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};
const screenshotFile = flag('screenshot');
const evalSnippet = flag('eval');
const captureWait = Number(flag('wait') ?? (evalSnippet ? 3000 : 1200));
/**
 * SABLE_PERF=1 (verification only): a measuring run. The page gets its debug helpers
 * (window.sable, frame stats), the window opens without taking focus, and it keeps drawing
 * when covered, so frame timings are real even on a machine someone is using.
 */
const perfRun = process.env.SABLE_PERF === '1';

// Everything Sable keeps lives under SABLE_HOME when it is set (verification runs use a temp folder).
app.setName('Sable');
// The user-data folder also keys the single-instance lock, so it is set before the lock is requested.
app.setPath(
  'userData',
  process.env.SABLE_USER_DATA
    ? path.resolve(process.env.SABLE_USER_DATA)
    : process.env.SABLE_HOME
      ? path.join(process.env.SABLE_HOME, 'desktop')
      : path.join(app.getPath('appData'), 'Sable'),
);
app.enableSandbox();
// The same id as electron-builder's appId, so the taskbar groups the window with the pinned
// shortcut and notifications carry the app's name and icon.
if (isWin) app.setAppUserModelId('io.github.leonxlnx.sable');
if (isMac) {
  // The standard About panel (Sable menu > About Sable): name, version and the copyright line.
  app.setAboutPanelOptions({ applicationName: 'Sable', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 Leonxlnx', website: 'https://github.com/Leonxlnx/sable' });
  // `electron .` shows Electron's own Dock icon; the packaged app carries Sable's (icon.icns).
  if (!app.isPackaged) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon-mac.png'));
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }
}

// The Agent SDK starts the Claude Code binary that ships with the app (an extra resource when
// packaged, the staged copy in dist-resources/ when run from the project); see build-electron.mjs.
if (!process.env.SABLE_CLAUDE_BIN) {
  const exe = isWin ? 'claude.exe' : 'claude';
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'claude', exe) : path.join(app.getAppPath(), 'dist-resources', 'claude', exe);
  if (existsSync(bin)) process.env.SABLE_CLAUDE_BIN = bin;
}
if (screenshotFile || perfRun) {
  // Keep rendering when the window is covered or the display is off, so the capture is never blank.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

let server: RunningServer | undefined;
let win: BrowserWindow | undefined;
let appOrigin = '';

/* ── window state ── */

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1360, height: 860 };
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    if (!(s.width >= 900 && s.height >= 600)) return fallback;
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      // Drop the position when it no longer lands on a connected display.
      const b: Rectangle = { x: s.x, y: s.y, width: s.width, height: s.height };
      const area = screen.getDisplayMatching(b).workArea;
      const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 8 && b.y < area.y + area.height - 80;
      if (!visible) return { width: Math.min(s.width, area.width), height: Math.min(s.height, area.height), maximized: s.maximized };
    }
    return s;
  } catch {
    return fallback;
  }
}

/**
 * With a hidden title bar on Windows (at fractional scale factors) a new window comes out a few
 * pixels larger than requested, so a saved size would creep every run. Measured once per window
 * and subtracted when saving.
 */
let sizeDrift = { width: 0, height: 0 };

function measureDrift(w: BrowserWindow, requested: WindowState) {
  const b = w.getNormalBounds();
  sizeDrift = { width: b.width - requested.width, height: b.height - requested.height };
  if (Math.abs(sizeDrift.width) > 16 || Math.abs(sizeDrift.height) > 16) sizeDrift = { width: 0, height: 0 }; // clamped by a small display
}

function saveWindowState(w: BrowserWindow) {
  try {
    const normal = w.getNormalBounds();
    const state: WindowState = {
      x: normal.x,
      y: normal.y,
      width: normal.width - sizeDrift.width,
      height: normal.height - sizeDrift.height,
      maximized: w.isMaximized(),
    };
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    /* not worth failing a close over */
  }
}

/* ── security ── */

function openOutside(target: string) {
  try {
    const u = new URL(target);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.href);
  } catch {
    /* not a URL: ignore */
  }
}

const isAppUrl = (target: string) => {
  try {
    return new URL(target).origin === appOrigin;
  } catch {
    return false;
  }
};

/** What the panel browser may show: web pages, never the app itself, files or internal pages. */
const isViewable = (target: string) => {
  if (target === 'about:blank') return true;
  try {
    const u = new URL(target);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== appOrigin;
  } catch {
    return false;
  }
};

/** Calls from the app's own page in the main window; anything else (guests, other frames) is refused. */
const fromApp = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => isAppUrl(e.senderFrame?.url ?? '') && e.sender === win?.webContents;

/** What the page's own window controls show: maximised (restore icon), focused (full strength), full screen (hidden). */
const windowState = (w: BrowserWindow) => ({ maximized: w.isMaximized(), focused: w.isFocused(), fullScreen: w.isFullScreen() });

/** Window calls from the page: the native folder dialog and the window controls (Windows, Linux). */
function windowCalls() {
  const stub = screenshotFile ? process.env.SABLE_DIALOG_STUB : undefined;
  ipcMain.handle('sable:pick-folder', async (e, suggested: unknown) => {
    if (!fromApp(e) || !win) throw new Error('Not allowed');
    const owner = win;
    const show: ShowFolderDialog = stub
      ? async (opts) => {
          console.log(`[pick-folder] stubbed dialog, starting in ${opts.defaultPath ?? '(default)'}`);
          return { canceled: false, filePaths: [stub] };
        }
      : (opts) => dialog.showOpenDialog(owner, opts);
    return pickFolder(show, suggested);
  });

  // The page draws minimise, maximise / restore and close itself (macOS keeps its traffic lights).
  ipcMain.on('sable:window', (e, command: unknown) => {
    if (isMac || !fromApp(e) || !win) return;
    if (command === 'minimize') win.minimize();
    else if (command === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (command === 'close') win.close();
  });
  ipcMain.handle('sable:window-state', (e) => {
    if (!fromApp(e) || !win) throw new Error('Not allowed');
    return windowState(win);
  });
}

/** Keeps the page's window controls in step with the window: restore icon while maximised, dimmed while unfocused. */
function reportWindowState(w: BrowserWindow) {
  // On a Mac the page only needs to know about full screen (the traffic lights go away).
  const push = () => {
    if (!w.isDestroyed()) w.webContents.send('sable:window-state', windowState(w));
  };
  for (const ev of ['maximize', 'unmaximize', 'restore', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) w.on(ev as 'focus', push);
}

/*
 * What a panel page tells the app goes out in small batches: a page that logs in a loop, fires
 * thousands of failing requests or hangs must never flood the app's window (or this process, which
 * also runs the bridge) with one message per line. At most EVENT_LINES console lines and
 * EVENT_NET failed requests per page per beat are passed on; the rest are counted.
 */
const EVENT_BEAT = 200;
const EVENT_LINES = 60;
const EVENT_NET = 30;

type BrowserEvent = { type: string; id?: number; [k: string]: unknown };
const outbox: BrowserEvent[] = [];
let outboxTimer: ReturnType<typeof setTimeout> | undefined;
const consoleBuf = new Map<number, { lines: { level: string; text: string; source?: string }[]; dropped: number }>();
const netBuf = new Map<number, { list: BrowserEvent[]; dropped: number }>();

function flushBrowserEvents() {
  outboxTimer = undefined;
  for (const [id, b] of consoleBuf) outbox.push({ type: 'console', id, lines: b.lines, dropped: b.dropped });
  consoleBuf.clear();
  for (const [id, b] of netBuf) {
    outbox.push(...b.list);
    if (b.dropped) outbox.push({ type: 'net-dropped', id, count: b.dropped });
  }
  netBuf.clear();
  const batch = outbox.splice(0);
  if (batch.length && win && !win.isDestroyed()) win.webContents.send('sable:browser-event', batch);
}

/** Queues one event for the app's window; sent with the next beat. */
function toApp(ev: BrowserEvent) {
  outbox.push(ev);
  outboxTimer ??= setTimeout(flushBrowserEvents, EVENT_BEAT);
}

function queueConsole(id: number, line: { level: string; text: string; source?: string }) {
  let b = consoleBuf.get(id);
  if (!b) consoleBuf.set(id, (b = { lines: [], dropped: 0 }));
  if (b.lines.length >= EVENT_LINES) b.dropped++;
  else b.lines.push(line);
  outboxTimer ??= setTimeout(flushBrowserEvents, EVENT_BEAT);
}

function queueNet(ev: BrowserEvent & { id: number }) {
  let b = netBuf.get(ev.id);
  if (!b) netBuf.set(ev.id, (b = { list: [], dropped: 0 }));
  if (b.list.length >= EVENT_NET) b.dropped++;
  else b.list.push(ev);
  outboxTimer ??= setTimeout(flushBrowserEvents, EVENT_BEAT);
}

/** The keys the Browser tab answers while focus is inside its page (keys typed there never reach the app). */
function guestKey(input: Electron.Input): string | undefined {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return undefined;
  const k = input.key.toLowerCase();
  if (input.shift) return k === 't' ? 'shift+t' : undefined;
  return k === 'f' || k === 't' || k === 'w' || k === 'l' ? k : undefined;
}

/** Pages inside the panel browser (<webview> guests): web navigation only, popups stay in the view. */
function guardGuest(contents: WebContents) {
  const guard = (e: { url: string; preventDefault(): void }) => {
    if (!isViewable(e.url)) e.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (e) => e.preventDefault());
  const ours = () => {
    const host = contents.hostWebContents;
    return !!host && host === win?.webContents;
  };
  contents.on('before-input-event', (e, input) => {
    const key = guestKey(input);
    if (!key || !ours()) return;
    e.preventDefault();
    toApp({ type: 'key', id: contents.id, key });
    flushBrowserEvents();
  });
  // A page that stops answering (a busy loop) gets a calm state in its tab; it may come back by itself.
  const hang = (on: boolean) => () => {
    if (ours()) toApp({ type: 'hang', id: contents.id, on });
  };
  (contents as unknown as NodeJS.EventEmitter).on('unresponsive', hang(true));
  (contents as unknown as NodeJS.EventEmitter).on('responsive', hang(false));
  contents.once('destroyed', () => {
    consoleBuf.delete(contents.id);
    netBuf.delete(contents.id);
    hidden.delete(contents.id);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isViewable(url) && url !== 'about:blank') void contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
}

/**
 * The <webview> element forwards every console line of its page to the app's window as a message of
 * its own; a page logging in a loop would bury the app in them. Once the guest is attached (its
 * forwarding is in place), that is replaced by the batched, capped feed.
 */
function batchConsole(guest: WebContents) {
  guest.removeAllListeners('console-message');
  const rate = { n: 0, since: Date.now(), strikes: 0 };
  guest.on('console-message', (d) => {
    // Every line reaches this process one by one, whatever happens after: a flood is calmed in the page itself.
    const now = Date.now();
    rate.n++;
    if (now - rate.since >= 1000) {
      const perSecond = (rate.n * 1000) / (now - rate.since);
      rate.n = 0;
      rate.since = now;
      if (perSecond > FLOOD_STOP) {
        if (++rate.strikes >= 2) stopFlood(guest);
      } else rate.strikes = 0;
      if (perSecond > FLOOD_TAME) void guest.executeJavaScript(TAME_CONSOLE).catch(() => {});
    }
    const msg = typeof d.message === 'string' ? d.message : '';
    if (!msg) return;
    const source = d.sourceId ? `${d.sourceId.replace(/[?#].*$/, '').slice(0, 280)}${d.lineNumber ? `:${d.lineNumber}` : ''}` : undefined;
    queueConsole(guest.id, { level: d.level, text: msg.slice(0, 1000), source });
  });
}

/*
 * Console floods. Each line a page logs costs this process (which also runs the bridge) an event,
 * before anything can drop it: a page logging tens of thousands of lines a second would freeze
 * the app and finally run it out of memory. Above FLOOD_TAME lines a second the page's console is
 * limited in the page itself (200 lines a second, with a note of how many were left out; a page
 * that logs less keeps its untouched console and true source lines). A page that keeps flooding
 * above FLOOD_STOP for two seconds (it never yields, so it cannot be calmed) is stopped: its tab
 * shows that, with Reload.
 */
const FLOOD_TAME = 1500;
const FLOOD_STOP = 4_000;
const TAME_CONSOLE = `(() => {
  if (window.__sableConsoleLimit) return;
  window.__sableConsoleLimit = true;
  const c = console;
  const info = c.info;
  let n = 0, since = 0, left = 0;
  const pass = () => {
    const now = performance.now();
    if (now - since >= 1000) {
      if (left) info.call(c, 'Sable left out ' + left + ' console lines (the page logged too fast)');
      since = now; n = 0; left = 0;
    }
    if (++n <= 200) return true;
    left++;
    return false;
  };
  for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'count', 'assert', 'timeLog', 'group', 'groupCollapsed']) {
    const f = c[k];
    if (typeof f === 'function') c[k] = function () { if (pass()) return f.apply(this, arguments); };
  }
  addEventListener('error', (e) => { if (!pass()) e.preventDefault(); }, true);
  addEventListener('unhandledrejection', (e) => { if (!pass()) e.preventDefault(); }, true);
})()`;

function stopFlood(guest: WebContents) {
  if (guest.isDestroyed()) return;
  toApp({ type: 'flood', id: guest.id });
  flushBrowserEvents();
  try {
    guest.forcefullyCrashRenderer();
  } catch {
    /* already gone */
  }
}

/*
 * Request floods. The network service is shared with the app itself (its own page and the bridge's
 * socket), so a page firing thousands of requests a second can stall Sable. Every finished or failed
 * request of a panel page is counted per page; one that keeps above REQ_STOP a second for two
 * seconds in a row is stopped like a console flood (its tab shows that, with Reload).
 */
const REQ_STOP = 1_200;
const reqCount = new Map<number, { since: number; n: number; over: number }>();

function countRequest(id: number | undefined) {
  if (typeof id !== 'number') return;
  const now = Date.now();
  let c = reqCount.get(id);
  if (!c) reqCount.set(id, (c = { since: now, n: 0, over: 0 }));
  if (now - c.since >= 1000) {
    c.over = c.n > REQ_STOP ? c.over + 1 : 0;
    c.since = now;
    c.n = 0;
    if (c.over >= 2) {
      reqCount.delete(id);
      const guest = webContents.fromId(id);
      if (guest && !guest.isDestroyed() && guest.getType() === 'webview') stopFlood(guest);
      return;
    }
  }
  c.n++;
}

/*
 * A page the user is not looking at (another tab, or the panel showing another pane) is muted and
 * its process slowed down, so a busy page in the background costs a fraction of a core instead of
 * a whole one. Never the page in front: it runs at full speed.
 */
const hidden = new Set<number>();
const HIDDEN_CPU_RATE = 10;

function setGuestShown(guest: WebContents, shown: boolean) {
  if (shown) hidden.delete(guest.id);
  else hidden.add(guest.id);
  try {
    guest.setAudioMuted(!shown);
  } catch {
    /* gone */
  }
  // Two tabs of one site can share a process: slow it only when no page in it is shown.
  let pid = 0;
  try {
    pid = guest.getOSProcessId();
  } catch {
    return;
  }
  const peers = webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && !w.isDestroyed() && w.hostWebContents === win?.webContents && safePid(w) === pid);
  const slow = peers.every((w) => hidden.has(w.id));
  for (const w of peers) throttle(w, slow && hidden.has(w.id) ? HIDDEN_CPU_RATE : 1);
}

const safePid = (w: WebContents) => {
  try {
    return w.getOSProcessId();
  } catch {
    return -1;
  }
};

function throttle(guest: WebContents, rate: number) {
  const dbg = guest.debugger;
  try {
    if (!dbg.isAttached()) {
      if (rate === 1) return;
      dbg.attach('1.3');
    }
    void dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
  } catch {
    /* another debugger holds the page, or it is gone: it runs as it is */
  }
}

function hardenBrowser() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Local files never load in the panel browser, whoever asks.
  ses.protocol.handle('file', () => new Response('Files do not open in the panel browser.', { status: 403, headers: { 'content-type': 'text/plain' } }));
  ses.on('will-download', (e, item) => {
    e.preventDefault();
    if (win && !win.isDestroyed()) win.webContents.send('sable:browser-event', { type: 'download-blocked', name: item.getFilename() });
  });

  ipcMain.handle('sable:browser-capture', async (e, id: unknown, forAgent: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    const guest = webContents.fromId(Number(id));
    if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== e.sender) throw new Error('That page is gone');
    // A page that hangs may never paint again: the capture gives up rather than keep the caller waiting.
    const image = await Promise.race([guest.capturePage(), sleep(8000).then(() => Promise.reject(new Error('The page did not answer in time')))]);
    const { width, height } = image.getSize();
    const side = Math.max(width, height);
    // For the agent: at most 1568 px on the long side (what models look at in full) and JPEG, so it stays small.
    const max = forAgent === true ? 1568 : 2000;
    const fit = side > max ? image.resize(width >= height ? { width: max } : { height: max }) : image;
    if (forAgent === true) return `data:image/jpeg;base64,${fit.toJPEG(80).toString('base64')}`;
    return fit.toDataURL();
  });

  // Failed requests of panel pages, for the agent's browser_read: the address without its query, the
  // method, and the status or the network error. Never headers or bodies.
  const reportNet = (d: { webContentsId?: number; url: string; method: string; statusCode?: number; error?: string }) => {
    if (!win || win.isDestroyed() || typeof d.webContentsId !== 'number') return;
    let url = d.url;
    try {
      const u = new URL(d.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      url = u.origin + u.pathname;
    } catch {
      return;
    }
    queueNet({ type: 'net', id: d.webContentsId, url: url.slice(0, 300), method: d.method, status: d.statusCode, error: d.error?.slice(0, 80) });
  };
  ses.webRequest.onCompleted((d) => {
    countRequest(d.webContentsId);
    if (d.statusCode >= 400) reportNet({ webContentsId: d.webContentsId, url: d.url, method: d.method, statusCode: d.statusCode });
  });
  ses.webRequest.onErrorOccurred((d) => {
    countRequest(d.webContentsId);
    // An aborted request (a navigation away, a cancelled fetch) is not a failure worth reporting.
    if (d.error === 'net::ERR_ABORTED') return;
    reportNet({ webContentsId: d.webContentsId, url: d.url, method: d.method, error: d.error });
  });
  // The Browser tab says which of its pages is in front; the others are muted and slowed down.
  ipcMain.on('sable:browser-shown', (e, id: unknown, shown: unknown) => {
    if (!fromApp(e)) return;
    const guest = webContents.fromId(Number(id));
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents !== e.sender) return;
    setGuestShown(guest, shown === true);
  });
  ipcMain.handle('sable:browser-clear', async (e) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  });
}

function harden() {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      guardGuest(contents);
      return;
    }
    const guard = (e: { url: string; preventDefault(): void }) => {
      if (isAppUrl(e.url)) return;
      e.preventDefault();
      openOutside(e.url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    // Only the app's own page may embed the panel browser, and only locked down: no Node, no preload,
    // sandboxed, isolated, in its own partition, starting on a web page.
    contents.on('will-attach-webview', (e, prefs, params) => {
      if (!isAppUrl(contents.getURL()) || (params.src && !isViewable(params.src))) {
        e.preventDefault();
        return;
      }
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.nodeIntegrationInWorker = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      prefs.allowRunningInsecureContent = false;
      prefs.experimentalFeatures = false;
      prefs.webviewTag = false;
      prefs.partition = BROWSER_PARTITION;
      // allowpopups only lets window.open reach guardGuest's handler, which never opens a window.
      delete params.preload;
      params.partition = BROWSER_PARTITION;
    });
    contents.on('did-attach-webview', (_e, guest) => {
      if (contents === win?.webContents) batchConsole(guest);
    });
    contents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: 'deny' };
    });
  });

  // The page only loads its own code; agent output may show images (data, blob, https) and nothing else.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${appOrigin.replace(/^http/, 'ws')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    // The panel browser is a <webview>; its pages run in a separate guest and are not framed by the app.
    // The only frame the app embeds is its own widget page (generative UI), sandboxed without same-origin.
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  // The widget page runs code an agent wrote: no network of any kind, inline code only, and it can
  // frame nothing but its own srcdoc child, which inherits this policy.
  const widgetCsp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
  ].join('; ');
  const isWidgetPage = (url: string): boolean => {
    try {
      return new URL(url).pathname === '/widget-frame.html';
    } catch {
      return false;
    }
  };
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${appOrigin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [isWidgetPage(details.url) ? widgetCsp : csp] } });
  });

  const allowed = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && isAppUrl(details.requestingUrl));
  });
  // Electron passes the origin here as a URL with a trailing slash ("http://127.0.0.1:47317/"): compare origins.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && isAppUrl(requestingOrigin));
  hardenBrowser();
  windowCalls();
}

/* ── menu and shortcuts ── */

/**
 * A shortcut the page itself answers (Settings, New session, Open a folder), shown in the menu with
 * its keys. The menu item does not register the accelerator, so the page keeps getting the key as
 * before; clicking the item sends the same key to the page.
 */
function pageKey(label: string, accelerator: string, keyCode: string, modifiers: ('shift' | 'alt')[] = []): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    registerAccelerator: false,
    click: () => {
      const wc = win?.webContents;
      if (!wc || wc.isDestroyed()) return;
      win?.show();
      const mods = ['meta' as const, ...modifiers];
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    },
  };
}

function installMenu() {
  if (!isMac) {
    // No menu bar on Windows and Linux: Chromium handles the edit shortcuts itself, and the
    // view shortcuts are handled per window (see viewShortcuts) so nothing swallows the app's own keys.
    Menu.setApplicationMenu(null);
    return;
  }
  // The usual Mac set. Edit has to be here: on a Mac the copy, paste and undo keys only work through it.
  // Cmd+W closes the window (the app stays in the Dock), Cmd+Q quits and stops the agents.
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        pageKey('Settings…', 'Cmd+,', ','),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [pageKey('New session', 'Shift+Cmd+O', 'o', ['shift']), pageKey('Open a folder…', 'Cmd+O', 'o'), { type: 'separator' }, { role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { label: 'Window', role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Sable on GitHub', click: () => void shell.openExternal('https://github.com/Leonxlnx/sable') },
        { label: 'Releases', click: () => void shell.openExternal('https://github.com/Leonxlnx/sable/releases') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function viewShortcuts(w: BrowserWindow) {
  if (isMac) return; // the View menu carries them
  const wc = w.webContents;
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    let handled = true;
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) wc.toggleDevTools();
    else if (input.key === 'F5' || (mod && !input.shift && !input.alt && key === 'r')) wc.reload();
    else if (mod && !input.alt && key === '0') wc.setZoomLevel(0);
    else if (mod && !input.alt && (key === '=' || key === '+')) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
    else if (mod && !input.alt && key === '-') wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    else handled = false;
    if (handled) e.preventDefault();
  });
}

/** A small native context menu: edit actions in fields, copy for selected text. */
function contextMenu(w: BrowserWindow) {
  w.webContents.on('context-menu', (_e, params) => {
    const f = params.editFlags;
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo', enabled: f.canUndo },
          { role: 'redo', enabled: f.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: f.canCut },
          { role: 'copy', enabled: f.canCopy },
          { role: 'paste', enabled: f.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: f.canSelectAll },
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy' }]
        : [];
    if (params.linkURL && !isAppUrl(params.linkURL)) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Open link in browser', click: () => openOutside(params.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
  });
}

/* ── window ── */

/** Where a --screenshot window lives: far outside every display, so the run never appears on screen. */
const OFF_SCREEN = -32_000;

function createWindow(url: string) {
  // A screenshot run neither reads nor writes the saved window state: fixed size, off-screen.
  const state: WindowState = screenshotFile ? { x: OFF_SCREEN, y: OFF_SCREEN, width: 1360, height: 860 } : loadWindowState();
  const w = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    skipTaskbar: !!screenshotFile,
    title: 'Sable',
    // The packaged executable carries the icon too; this covers `electron .` and Linux.
    icon: isMac ? undefined : path.join(__dirname, isWin ? 'icon.ico' : 'icon.png'),
    backgroundColor: BG,
    // Windows and Linux: no native caption buttons; the page draws its own (WindowControls in App.tsx).
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 23 } } : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The panel's Browser tab; every guest is locked down in harden() (will-attach-webview).
      webviewTag: true,
      backgroundThrottling: !screenshotFile,
      additionalArguments: [`--sable-version=${app.getVersion()}`, ...(evalSnippet || perfRun ? ['--sable-debug'] : [])],
    },
  });

  w.once('ready-to-show', () => {
    if (screenshotFile) {
      // Shown (so it paints) but off-screen and out of the taskbar; the bounds are set again in case
      // the system moved the window back onto a display when it was created.
      w.setBounds({ x: OFF_SCREEN, y: OFF_SCREEN, width: state.width, height: state.height });
      w.showInactive();
      return;
    }
    if (state.maximized) w.maximize();
    if (perfRun) w.showInactive();
    else w.show();
  });
  if (!screenshotFile) {
    measureDrift(w, state);
    w.on('close', () => saveWindowState(w));
  }
  w.on('closed', () => (win = undefined));

  reportWindowState(w);
  viewShortcuts(w);
  contextMenu(w);
  if (screenshotFile) {
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[page ${e.level}] ${e.message}`);
    });
    w.webContents.on('render-process-gone', (_e, d) => console.log(`[page] renderer gone: ${d.reason}`));
  }

  void w.loadURL(url);
  return w;
}

/* ── verification capture ── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function capture(w: BrowserWindow, file: string) {
  const wc = w.webContents;
  // The home screen, a session, or the first-run welcome (.onb) on a fresh profile.
  const rendered = "!document.querySelector('.logo-intro') && !!document.querySelector('.home, .session, .onb')";
  const deadline = Date.now() + 30_000;
  while (!(await wc.executeJavaScript(rendered).catch(() => false))) {
    if (Date.now() > deadline) {
      const seen = await wc.executeJavaScript("location.href + ' :: ' + (document.body?.innerText ?? '').split(/[\\n\\t ]+/).join(' ').slice(0, 300)").catch(() => '?');
      throw new Error(`The app did not render within 30 s (${seen})`);
    }
    await sleep(200);
  }
  if (evalSnippet) {
    const result = await wc.executeJavaScript(evalSnippet, true);
    if (result !== undefined) console.log('[eval]', typeof result === 'string' ? result : JSON.stringify(result));
  }
  await sleep(captureWait);
  const image = await wc.capturePage();
  const out = path.resolve(file);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, image.toPNG());
  const size = image.getSize();
  console.log(`[screenshot] ${out} (${size.width}x${size.height})`);
  if (process.env.SABLE_WINDOW_SHOT) await captureWindow(w, out.replace(/\.png$/i, '') + '-window.png');
}

/**
 * The real window as the system composes it, native caption buttons included (capturePage only has
 * the page). May come back empty when the display is off or capture is not permitted.
 */
async function captureWindow(w: BrowserWindow, file: string) {
  try {
    const { width, height } = w.getContentBounds();
    const scale = screen.getDisplayMatching(w.getBounds()).scaleFactor;
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
    const own = sources.find((s) => s.id === w.getMediaSourceId());
    if (!own || own.thumbnail.isEmpty()) {
      console.log('[window-shot] the system returned no image for this window');
      return;
    }
    writeFileSync(file, own.thumbnail.toPNG());
    const s = own.thumbnail.getSize();
    console.log(`[window-shot] ${file} (${s.width}x${s.height})`);
  } catch (err) {
    console.log('[window-shot] failed:', (err as Error)?.message ?? err);
  }
}

/* ── lifecycle ── */

let quitting = false;
/**
 * Keep awake (server/core/awake.ts). While an agent works anywhere, Windows does not suspend (an
 * overnight run would stop halfway); released a minute after the last work ends. With a phone
 * paired, the computer also stays up while on mains power, so the phone can reach it; never on
 * battery for that. The screen may still turn off either way.
 */
function keepAwake(s: RunningServer) {
  let block: number | undefined;
  let work = false;
  let phone = false;
  const apply = () => {
    const want = work || (phone && !powerMonitor.isOnBatteryPower());
    if (want && block === undefined) block = powerSaveBlocker.start('prevent-app-suspension');
    else if (!want && block !== undefined) {
      if (powerSaveBlocker.isStarted(block)) powerSaveBlocker.stop(block);
      block = undefined;
    }
  };
  s.watchBusy((busy) => ((work = busy), apply()));
  s.watchPhone((on) => ((phone = on), apply()));
  powerMonitor.on('on-ac', apply);
  powerMonitor.on('on-battery', apply);
}

app.on('before-quit', (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  if (win && !win.isDestroyed() && !screenshotFile) saveWindowState(win);
  // Dispose the bridge (agent child processes exit) before the process goes; never hang on it.
  void Promise.race([server.close(), sleep(3000)]).finally(() => app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0));
});
// On a Mac closing the window leaves the app running in the Dock (agents keep working, the phone stays
// connected); clicking the Dock icon opens a window again, Cmd+Q quits.
app.on('window-all-closed', () => {
  if (!isMac || screenshotFile || perfRun) app.quit();
});
app.on('activate', () => {
  if (!server || quitting) return;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
  } else win = createWindow(server.url);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) {
      // A Mac keeps the app running without a window: opening it again brings one back.
      if (server && !quitting) win = createWindow(server.url);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    installMenu();
    // Started from Finder or the Dock, the app has launchd's bare PATH: ask the person's shell for theirs
    // (so `codex`, `git` and `node` are found as in a terminal) before the bridge starts any of them.
    if (!isWin) await fixPathFromLoginShell().catch(() => undefined);
    try {
      server = await startServer({
        root: path.join(app.getAppPath(), 'dist'),
        port: PREFERRED_PORT,
        fallbackToFreePort: true,
        // An installed build updates itself; a build run from a folder (or a test run) does not.
        updates: app.isPackaged && !screenshotFile ? { quit: () => app.quit() } : undefined,
      });
    } catch (err) {
      dialog.showErrorBox('Sable could not start', String((err as Error)?.message ?? err));
      app.quit();
      return;
    }
    appOrigin = new URL(server.url).origin;
    keepAwake(server);
    harden();
    win = createWindow(server.url);

    if (screenshotFile) {
      capture(win, screenshotFile)
        .catch((err) => {
          console.error('[screenshot] failed:', err);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
    }
  });
}
