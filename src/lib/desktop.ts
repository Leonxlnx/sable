/**
 * The desktop shell's bridge (electron/preload.ts), present only inside the Electron app.
 * Everything here is optional: the plain browser build runs without it.
 */
export interface DesktopShell {
  platform: string;
  version: string;
  debug: boolean;
  /** The system's folder dialog; null when cancelled. Missing on older shells. */
  pickFolder?: (startIn?: string) => Promise<string | null>;
  /** The real path of a dropped or picked file; empty when it has none (pasted). Missing on older shells. */
  pathForFile?: (file: File) => string;
  /** The commands behind the page's own window controls (Windows, Linux). Missing on older shells. */
  window?: WindowShell;
  /** The taskbar's part of "this chat needs you" (lib/notify.ts). Missing on older shells. */
  attention?: {
    set: (s: { count: number; flash: boolean }) => void;
    focus: () => void;
  };
}

export interface WindowState {
  maximized: boolean;
  focused: boolean;
  fullScreen: boolean;
}

export interface WindowShell {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  getState: () => Promise<WindowState>;
  onState: (cb: (s: WindowState) => void) => () => void;
}

export const desktop: DesktopShell | undefined = typeof window === 'undefined' ? undefined : (window as { sableDesktop?: DesktopShell }).sableDesktop;

/**
 * Development only: `?wc` in the address shows the window controls in a plain browser so their look
 * can be judged in headless screenshots (`?wc=max` draws the restore icon, `?wc=blur` the unfocused
 * state). The buttons do nothing there.
 */
function previewShell(): WindowShell | undefined {
  if (!import.meta.env.DEV || typeof location === 'undefined') return undefined;
  const flag = new URLSearchParams(location.search).get('wc');
  if (flag === null) return undefined;
  const state: WindowState = { maximized: flag === 'max', focused: flag !== 'blur', fullScreen: false };
  const log = (what: string) => () => console.info(`[window controls preview] ${what}`);
  return { minimize: log('minimize'), toggleMaximize: log('toggle maximize'), close: log('close'), getState: async () => state, onState: () => () => {} };
}

/**
 * The page draws its own minimise / maximise / close buttons on Windows and Linux desktop builds
 * (macOS keeps its traffic lights). Undefined when there are none to draw.
 */
export const windowShell: WindowShell | undefined = desktop ? (desktop.platform !== 'darwin' ? desktop.window : undefined) : previewShell();

/** A dropped or picked file's real path in the desktop app; undefined in the browser or when it has none. */
export function pathForFile(file: File): string | undefined {
  try {
    return desktop?.pathForFile?.(file) || undefined;
  } catch {
    return undefined;
  }
}

/** True when the native folder dialog replaces the in-app folder browser. */
export const hasNativeFolderPicker = !!desktop?.pickFolder;

