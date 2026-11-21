import type { LaunchGeometry } from '@/art/launch-light';

/**
 * Start-up marks: `performance.mark('boot:<name>')`, once per name, when a stage of the start is
 * reached (the bridge's answer, home on screen, the launch's steps). The measuring scripts read them
 * (`scratch/boot1/`); they cost a few entries in the performance timeline.
 */
const seen = new Set<string>();

export function bootMark(name: string) {
  if (seen.has(name)) return;
  seen.add(name);
  try {
    performance.mark(`boot:${name}`);
  } catch {
    /* no timeline */
  }
}

/**
 * What the page's first script (`src/boot.ts`) started while the app's own code was still loading:
 * the bridge's socket with `app.hello` already asked, and the launch light already drawing. Each is
 * taken over once, by `lib/bridge.ts` and `art/LaunchLayer.tsx`.
 */
export interface BootSocket {
  ws: WebSocket;
  /** Frames that arrived before the bridge client took the socket, in order. */
  frames: string[];
  /** The request id `app.hello` is asked with (the client's own ids start above it). */
  helloId: number;
  /** It has been sent (the socket opened before the client took it over). */
  asked: boolean;
}

export interface BootLaunch {
  worker: Worker;
  canvas: HTMLCanvasElement;
  /** The launch's id in the field worker's messages. */
  id: number;
  cell: number;
  geometry: LaunchGeometry;
  /** Replies from the worker before the launch layer took it over, in order. */
  replies: unknown[];
  /** The worker failed: the layer draws the plain form instead. */
  failed: boolean;
  /** Gives the light up if no launch layer takes it (the canvas never stays over the window). */
  timer: number;
}

interface BootState {
  socket?: BootSocket;
  launch?: BootLaunch;
}

export const BOOT_KEY = '__sableBoot';

function state(): BootState | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as Record<string, BootState | undefined>)[BOOT_KEY];
}

export function takeBootSocket(): BootSocket | undefined {
  const s = state();
  const v = s?.socket;
  if (s) s.socket = undefined;
  return v;
}

export function takeBootLaunch(): BootLaunch | undefined {
  const s = state();
  const v = s?.launch;
  if (s) s.launch = undefined;
  if (v) window.clearTimeout(v.timer);
  return v;
}

/** The boot light, still running and not taken over yet (the shared field worker adopts its worker). */
export function bootLight(): BootLaunch | undefined {
  const l = state()?.launch;
  return l && !l.failed ? l : undefined;
}
