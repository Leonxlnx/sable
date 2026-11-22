import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Sandboxed preload: the page gets a few facts about the shell, the native folder dialog, the window
 * commands behind its own minimise / maximise / close buttons, the real path of a dropped or
 * picked file (Electron's webUtils.getPathForFile), and narrow calls for the panel browser
 * (capture a page, clear its data, say which page is in front, hear its events), nothing else.
 * The app version arrives as an extra argument from the main process.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

interface BrowserEvent {
  type: string;
  name?: string;
  id?: number;
  url?: string;
  method?: string;
  status?: number;
  error?: string;
  key?: string;
  on?: boolean;
  count?: number;
  lines?: { level: string; text: string; source?: string }[];
  /** The document of the page a console or failed-request batch came from ('doc': the page's new document). */
  doc?: number;
  /** 'signin-released': which hold ended. */
  hold?: string;
}

interface WindowState {
  maximized: boolean;
  focused: boolean;
  fullScreen: boolean;
}

const toState = (s: unknown): WindowState => {
  const o = (s ?? {}) as Partial<WindowState>;
  return { maximized: !!o.maximized, focused: o.focused !== false, fullScreen: !!o.fullScreen };
};

contextBridge.exposeInMainWorld('sableDesktop', {
  platform: process.platform,
  version: arg('sable-version') ?? '',
  /** True only for verification runs started with --eval. */
  debug: process.argv.includes('--sable-debug'),
  /** Shows the system's folder dialog; resolves to the chosen folder, or null when cancelled. */
  pickFolder: (startIn?: string): Promise<string | null> => ipcRenderer.invoke('sable:pick-folder', typeof startIn === 'string' ? startIn : undefined),
  /** The real path of a file the user dropped or picked (empty for pasted or generated files). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  /** The page's own minimise / maximise / close buttons (Windows, Linux): three commands and the window's state. */
  window: {
    minimize: () => ipcRenderer.send('sable:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('sable:window', 'toggle-maximize'),
    close: () => ipcRenderer.send('sable:window', 'close'),
    getState: (): Promise<WindowState> => ipcRenderer.invoke('sable:window-state').then(toState),
    onState: (cb: (s: WindowState) => void) => {
      if (typeof cb !== 'function') return () => {};
      const listener = (_e: unknown, msg: unknown) => cb(toState(msg));
      ipcRenderer.on('sable:window-state', listener);
      return () => {
        ipcRenderer.removeListener('sable:window-state', listener);
      };
    },
  },
  browser: {
    /** `forAgent`: smaller, as JPEG, for the agent's browser_screenshot. */
    capture: (webContentsId: number, opts?: { forAgent?: boolean }): Promise<string> => ipcRenderer.invoke('sable:browser-capture', Number(webContentsId), !!opts?.forAgent),
    clearData: (): Promise<void> => ipcRenderer.invoke('sable:browser-clear'),
    /**
     * Saved sign-ins (electron/sign-in.ts): main fills the page itself. `begin` arms the hold and gives a
     * ticket for the page's document; `fill` answers only whether it signed in and the user name.
     */
    /** A token from main for one request of the agent's tools, served by this page (electron/sign-in-core.ts Attestations). */
    attest: (webContentsId: number): Promise<string | null> => ipcRenderer.invoke('sable:browser-attest', Number(webContentsId)),
    signIn: {
      begin: (webContentsId: number, origin: string, token: string): Promise<{ ticket: string; hold: string; canSave: boolean; address: string; action: string }> =>
        ipcRenderer.invoke('sable:signin-begin', Number(webContentsId), String(origin), String(token)),
      fill: (webContentsId: number, ticket: string, cred: { kind: 'typed'; username: string; password: string; save: boolean } | { kind: 'saved'; id: string; username: string }, token: string): Promise<{ ok: boolean; code: string; user?: string }> =>
        ipcRenderer.invoke('sable:signin-fill', Number(webContentsId), String(ticket), cred, String(token)),
      cancel: (webContentsId: number, ticket: string, token: string, why: 'cancelled' | 'not-looking'): Promise<void> => ipcRenderer.invoke('sable:signin-cancel', Number(webContentsId), String(ticket), String(token), why),
      finish: (webContentsId: number, hold: string, how: 'continue' | 'close'): Promise<boolean> => ipcRenderer.invoke('sable:signin-finish', Number(webContentsId), String(hold), how),
    },
    /** Which page is in front: the others are muted and slowed down by the shell. */
    setShown: (webContentsId: number, shown: boolean) => ipcRenderer.send('sable:browser-shown', Number(webContentsId), !!shown),
    /**
     * Blocked downloads, keys typed in a page that the tab answers ('key': f, t, w, l, shift+t), failed requests of a page ('net': url without query, method, status or error;
     * 'net-dropped': how many more), its console in batches ('console': lines and how many were
     * dropped) and whether it stopped answering ('hang'). The shell sends them in batches.
     */
    onEvent: (cb: (e: BrowserEvent) => void) => {
      if (typeof cb !== 'function') return () => {};
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const lines = (v: unknown) =>
        Array.isArray(v)
          ? v.slice(0, 200).map((l: { level?: unknown; text?: unknown; source?: unknown }) => ({ level: String(l?.level ?? 'info'), text: String(l?.text ?? '').slice(0, 1000), source: str(l?.source)?.slice(0, 300) }))
          : undefined;
      const one = (msg: Record<string, unknown>) =>
        cb({
          type: String(msg?.type),
          name: msg?.name ? String(msg.name) : undefined,
          id: typeof msg?.id === 'number' ? msg.id : undefined,
          url: str(msg?.url),
          method: str(msg?.method),
          status: typeof msg?.status === 'number' ? msg.status : undefined,
          error: str(msg?.error),
          key: str(msg?.key),
          on: typeof msg?.on === 'boolean' ? msg.on : undefined,
          count: typeof msg?.count === 'number' ? msg.count : typeof msg?.dropped === 'number' ? msg.dropped : undefined,
          lines: lines(msg?.lines),
          doc: typeof msg?.doc === 'number' ? msg.doc : undefined,
          hold: str(msg?.hold),
        });
      const listener = (_e: unknown, msg: unknown) => {
        if (Array.isArray(msg)) for (const m of msg) one(m);
        else one(msg as Record<string, unknown>);
      };
      ipcRenderer.on('sable:browser-event', listener);
      return () => {
        ipcRenderer.removeListener('sable:browser-event', listener);
      };
    },
  },
});
