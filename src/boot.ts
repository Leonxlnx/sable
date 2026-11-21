/**
 * The page's first script (index.html loads it before the app). The app's own code takes a while to
 * arrive and run; this starts at once what the first second waits on, and hands it over:
 *
 * - The bridge: the socket opens and `app.hello` is asked straight away. What arrives is kept, in
 *   order, until the app's bridge client takes the socket over (`lib/bridge.ts`), so the app's first
 *   render already has the sessions and settings.
 * - The launch light: the field worker starts and draws the launch piece on a canvas over the whole
 *   window (`art/launch-light.ts`); the launch layer adopts the canvas and the worker when it mounts
 *   (`art/LaunchLayer.tsx`). Only where the layer would draw it in the worker anyway (not under
 *   reduced motion, not on automated development pages, never with the frame-sheet clock).
 *
 * It imports nothing of the app (a few kilobytes), never throws, and leaves nothing behind: a light
 * no layer took is given up after a few seconds.
 */
import { BRIDGE_PATH } from '@shared/protocol';
import { launchColours, launchMeasure, type LaunchMessage } from '@/art/launch-light';
import { BOOT_KEY, bootMark, type BootLaunch, type BootSocket } from '@/lib/boot';

const boot: { socket?: BootSocket; launch?: BootLaunch } = {};
(window as unknown as Record<string, unknown>)[BOOT_KEY] = boot;

/** The id `app.hello` is asked with; the bridge client's own ids start at 1. */
const HELLO_ID = 0;
/** The launch's id in the field worker; the page's other fields number from 1. */
const LAUNCH_ID = 0;
/** How long a light waits to be taken over before it gives itself up. */
const ORPHAN_MS = 8000;

bootMark('boot');

function openSocket() {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${BRIDGE_PATH}`);
    const socket: BootSocket = { ws, frames: [], helloId: HELLO_ID, asked: false };
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: HELLO_ID, method: 'app.hello', params: {} }));
      socket.asked = true;
    };
    ws.onmessage = (ev) => void socket.frames.push(ev.data as string);
    boot.socket = socket;
  } catch {
    /* the client opens its own */
  }
}

function plays(): boolean {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas === 'undefined' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (import.meta.env.DEV) {
    // The same rule as `launchPlays`: automated development pages skip the piece unless they ask for
    // it, and frame sheets (a frozen clock) start it from the layer, as before.
    const hook = (window as unknown as { __sableLaunch?: { on?: boolean; frozen?: boolean } }).__sableLaunch;
    if ((navigator.webdriver && !hook?.on) || hook?.frozen) return false;
  }
  return true;
}

function startLight() {
  if (!plays()) return;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./art/field.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'launch-light';
  canvas.setAttribute('aria-hidden', 'true');
  const { cell, geometry } = launchMeasure(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  // Over the whole window until the layer takes it (the stylesheet for the layer comes with the app).
  canvas.style.cssText = `position:fixed;left:0;top:0;z-index:64;pointer-events:none;image-rendering:pixelated;width:${geometry.cols * cell}px;height:${geometry.rows * cell}px`;
  const give = () => {
    if (boot.launch !== launch) return;
    boot.launch = undefined;
    try {
      worker.postMessage({ type: 'launch', id: LAUNCH_ID, op: 'dispose' } satisfies LaunchMessage);
    } catch {
      /* gone */
    }
    worker.terminate();
    canvas.remove();
  };
  const launch: BootLaunch = { worker, canvas, id: LAUNCH_ID, cell, geometry, replies: [], failed: false, timer: window.setTimeout(give, ORPHAN_MS) };
  worker.onmessage = (e: MessageEvent<{ id?: number; launch?: string }>) => {
    if (e.data?.id !== LAUNCH_ID) return;
    // When it happened (the layer hears of it later).
    if (e.data.launch === 'ignite' || e.data.launch === 'formed') bootMark(`launch-${e.data.launch}`);
    launch.replies.push(e.data);
  };
  worker.onerror = () => {
    // The layer draws the plain form; nothing of this light stays on screen.
    launch.failed = true;
    canvas.remove();
  };
  try {
    document.body.prepend(canvas);
    const off = canvas.transferControlToOffscreen();
    const init: LaunchMessage = { type: 'launch', id: LAUNCH_ID, op: 'init', canvas: off, geometry, colours: launchColours(getComputedStyle(document.documentElement)), frozen: false };
    worker.postMessage(init, [off]);
  } catch {
    worker.terminate();
    canvas.remove();
    return;
  }
  boot.launch = launch;
}

/**
 * The person's own stylesheet (Customize Sable, `server/services/custom.ts`): linked at the end of the
 * body, so it comes after every stylesheet of the app in the cascade, the ones loaded later with a
 * lazy part of the app included (those go into the head). Empty when there is none or it is off;
 * `features/customize/live.ts` swaps it in place when the file changes.
 */
function linkStyles() {
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CUSTOM_STYLES;
    link.dataset.sableCustom = '';
    document.body.append(link);
  } catch {
    /* the app's own look */
  }
}

const CUSTOM_STYLES = '/custom/styles.css';

openSocket();
linkStyles();
startLight();
