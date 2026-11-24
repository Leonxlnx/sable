import { EASE_OUT, play, reducedMotion, uiZoom } from '@/lib/motion';
import { CARD_FONT, CARD_LINE, CARD_PAD_TOP, CARD_PAD_X, isLongMessage } from '@/features/timeline/user-card';
import { holdSend } from './settle';
import { freezeSignal, pour, prewarmSignal, type Pour } from './signal';
import { fieldBeatAt } from '@/art/events';
import { quarterTiles } from '@/art/veil';
import { BORN, COLLAPSE, collapseEase, linearEasing, planSignal, shiftAt, shiftEase, type Box, type SignalPlan, type SignalSpec } from './signal-shape';

/**
 * A sent message leaves the composer as signal and arrives as a card, made of the app's own
 * ordered dither (signal-shape.ts has the beats and the geometry): the words in the field go in
 * place, a quarter of the 4x4 Bayer cells at a time; one continuous ivory hairline grows out of the
 * key's top in the first frame and runs up to where the message will stand, its foot on the key
 * until its head has arrived; there the card opens out of the point of arrival as one growing
 * shape (its well and its hairline together, only the growing edge cut by the dither) while the
 * line's tail is drawn up into it; the words stand whole in two frames, and the conversation's own
 * card takes over.
 *
 * - Who draws what: the line and the opening shape are drawn by a worker on a canvas of its own
 *   (signal.ts), under the card's layer; the words and the card are page layers that only change
 *   opacity on the compositor, both on the same clock with times taken from the same plan.
 *   Nothing runs per frame on the main thread, so a session mounting or a turn starting cannot
 *   make it stutter.
 * - The clock: time zero is one frame before the frame the send first shows in (`begin`,
 *   `FIRST_FRAME`), not the key: that first frame already differs (the first quarter of the words
 *   is gone, the key has begun to give), and whatever the main thread took to get it out, the
 *   motion plays from there. Everything of the message runs on that one clock, the worker's
 *   drawing, the page's layers and the send key's part (launch.ts) alike.
 * - The key's handler (`launchFlight`) reads the page once and then only writes; what shows
 *   nothing yet waits for the frame after (`after`).
 * - The field answers (art/events.ts): the wave starts where the line leaves the key, a softer
 *   ripple where it meets the card.
 * - Where it lands is guessed before the row exists (from the stage's geometry, the numbers
 *   timeline.css lays the row out with). When the real row mounts it stays hidden until the card
 *   sits on it. A row known before the line reaches the card simply moves the landing; one known
 *   later moves everything still to come (the outline, the card) to it.
 * - The landing is a cut: the copy sits pixel for pixel on the real card and the two swap in one
 *   frame. A row that is still moving then takes the small remainder itself.
 * - The first message from home leaves the home composer the same way; the composer leaves for
 *   the dock while the line still draws (home/handoff.ts, `barLeaving`).
 * - A message queued while a turn runs runs a short line into the queue tray's new row.
 * - A queued message sent from its row leaves from the row's end.
 * - When its row is late (a loaded machine, a slow bridge), the card waits where it landed and
 *   says so with one thing only: a hairline that fills slowly along its lower edge, on the
 *   compositor. It holds until the row is there (or the bridge refuses the message: then it goes
 *   back into the field with its words).
 * Under reduced motion there is none of this: the items fade in as before.
 */

export type FlightDest = 'timeline' | 'tray';

/** The beat the key and the backdrop share: ms from the press to the key's release. */
export const RELEASE = 40;

/** A point on a path: ms since the launch, offset from the start (px), speed (px/s). */
export interface Sample {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Flight {
  key: string;
  dest: FlightDest;
  /** The chat it was sent in (null from home until the chat exists, see `scope`): only that chat's rows claim it. */
  session: string | null;
  /** When it left, on the bridge's clock (ms since epoch): a message older than that is history, never its landing. */
  wall: number;
  steer: boolean;
  /**
   * Time zero of the message, on the page's clock: the frame its gathering words first show in
   * (under load the key's handler and that frame's own making hold it back; starting there means
   * no beat is skipped). Every animation of the message and the worker's drawing are timed from it.
   */
  t0: number;
  started: boolean;
  /** Animations of others that run on this message's clock (the home bar's glide). */
  synced: Animation[];
  /** What the launch read of the page (others acting in the same handler take it from here instead of reading again). */
  read: { card: DOMRect | null; stage: DOMRect | null; column: number; fieldHeight: number; z: number };
  /** The backdrop's beats still to come (the wave where the line leaves, the ripple where it meets the card). */
  beats: number[];
  signal: Pour | null;
  plan: SignalPlan;
  /** The words leaving their source, a layer per quarter of the dither (gone once gone). */
  pourEls: HTMLElement[];
  /** The landing layer (the message card, or the queue row's words) and its parts: the whole card, and its quarters (the well's and the words'). */
  el: HTMLDivElement;
  inner: HTMLElement;
  whole: HTMLElement;
  wells: HTMLElement[];
  quarters: HTMLElement[];
  surface: HTMLElement | null;
  /** Where the layer stands untransformed: the planned landing. */
  box: Box;
  /** The card's steps (made again when the landing moves before the line reaches it). */
  anims: Animation[];
  /** The late correction, played on `inner` (the same curve the worker follows). */
  fixAnim: Animation | null;
  fixEnd: number;
  /** Every animation of the message, for the dev freeze. */
  all: Animation[];
  /** The line has run its course: the card is complete (or the row's words are). */
  resting: boolean;
  target: HTMLElement | null;
  row: HTMLElement | null;
  ending: boolean;
  done: () => void;
  wait: Animation[];
  line: HTMLElement | null;
  answer: HoldAnswer;
  answeredAt: number;
  timer: number;
  restTimer: number;
  /** Where the words stood in their source (a refused message goes back there). */
  home: { left: number; top: number; s0: number };
  /** The bar the line leaves, while the bar holds still for it. */
  bar: HTMLElement | null;
  /** The field closing to one line (left to finish whatever happens to the message). */
  barAnim: Animation | null;
  /** The conversation making room for the message before its row exists (see `scrollAhead`). */
  ahead: Ahead | null;
  /** What is left of that motion once the row is there and the view is at its end. */
  slide: { content: HTMLElement; anim: Animation } | null;
}

/** The conversation's content moving up ahead of a message, and how far it goes. */
interface Ahead {
  content: HTMLElement;
  scroller: HTMLElement;
  anim: Animation;
  by: number;
}

/** What the composer keeps of a launch: the bridge's answer decides how the wait ends. */
export interface FlightHandle {
  /**
   * The bridge took the message (`true`: its row has a little while left to appear, then the card
   * lets go) or refused it (`false`: the message goes back into the field; resolves once it has,
   * for the words to be put back).
   */
  settle(ok: boolean): Promise<void>;
  /** The chat the message went to, once known (a first message from home). */
  scope(sessionId: string): void;
  /** The view it left from is gone (or the message goes back elsewhere): what is in the air fades where it is. */
  release(): void;
}

const pending: Flight[] = [];
/**
 * Messages that mounted in the conversation with no message in the air yet (a tray row may still
 * leave): claimed within `UNCLAIMED_MS`, forgotten after (so no old conversation is held).
 */
const unclaimed: { key: string; root: HTMLElement; at: number; session: string | null; ts: number | null }[] = [];
const UNCLAIMED_MS = 400;
const pruneUnclaimed = (now: number) => {
  for (let i = unclaimed.length - 1; i >= 0; i--) if (now - unclaimed[i].at >= UNCLAIMED_MS || !unclaimed[i].root.isConnected) unclaimed.splice(i, 1);
};

/** The bars a line leaves: each holds still (`data-pouring`) until the last of its messages has left it. */
const holding = new WeakMap<HTMLElement, number>();
function holdBar(bar: HTMLElement, ms: number) {
  holding.set(bar, (holding.get(bar) ?? 0) + 1);
  bar.setAttribute('data-pouring', '');
  window.setTimeout(() => {
    const n = (holding.get(bar) ?? 1) - 1;
    holding.set(bar, n);
    if (n <= 0) bar.removeAttribute('data-pouring');
  }, ms);
}

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 160);
const matches = (flightKey: string, text: string) => {
  const k = norm(text);
  return !!flightKey && (k === flightKey || k.startsWith(flightKey) || flightKey.startsWith(k));
};

/** How much older than the launch a row's message may be and still be the one sent (two clocks of one machine, a little skew). */
export const FRESH_SLACK_MS = 2000;

/** Where a row (or a tray row) that might take a message in the air belongs. */
export interface LandingSite {
  /** The chat it is shown in. */
  session?: string | null;
  /** Its message's time (`UserItem.ts`): a message from before the launch is history. */
  ts?: number | null;
}

/**
 * Whether a message in the air may land on a row with `text` at `site`: the same destination, the
 * same words, the same chat (when both are known), and a message no older than the launch. So a
 * chat switched to never takes another chat's message, and an old row with the same words ("Continue")
 * mounting in view never takes a new one. Pure, for tests.
 */
export function claimable(f: Pick<Flight, 'dest' | 'key' | 'session' | 'wall'> & { target?: unknown; ending?: boolean }, dest: FlightDest, text: string, site: LandingSite = {}): boolean {
  if (f.dest !== dest || f.target || f.ending || !matches(f.key, text)) return false;
  if (f.session && site.session && f.session !== site.session) return false;
  if (site.ts != null && site.ts < f.wall - FRESH_SLACK_MS) return false;
  return true;
}

/** A flight's matching fields, for `claimable` (and the tests). */
export const flightKey = (text: string, dest: FlightDest, session: string | null, wall: number) => ({ key: norm(text), dest, session, wall });

/** Words for the tray that nothing has claimed fade after this long; none outlives the last. */
const NO_CLAIM_MS = 1400;
const MAX_LIFE_MS = 6000;
/**
 * A message holds for its row: at most this long while the bridge has not answered (a new session
 * may still be starting on a loaded machine), and this long once it has taken the message (its row
 * is in the store by then; one that does not show is in a view no longer on screen).
 */
export const HOLD_MS = 15000;
export const ACKED_MS = 3000;

/** What the bridge has said about a sent message so far. */
export type HoldAnswer = 'pending' | 'taken' | 'refused';

/**
 * What a message in the air does about its row, decided again whenever something changes. It never
 * fades for being late: it lands once its row is there, goes back into the field when the bridge
 * refused the message, and lets go only when the row has not shown `ACKED_MS` after the bridge took
 * the message (it is in a view no longer on screen) or after `HOLD_MS` without any answer. Pure, so
 * the hold can be tested.
 */
export function bubbleHold(s: { row: boolean; answer: HoldAnswer; sinceLaunch: number; sinceAnswer: number }): 'land' | 'hold' | 'back' | 'release' {
  if (s.row) return 'land';
  if (s.answer === 'refused') return 'back';
  if (s.answer === 'taken' && s.sinceAnswer >= ACKED_MS) return 'release';
  if (s.sinceLaunch >= HOLD_MS) return 'release';
  return 'hold';
}

/** When the waiting state begins, in ms after the key, for a message complete at `pathEnd` ms. */
export const waitStart = (pathEnd: number) => Math.max(WAIT_MIN, pathEnd + WAIT_AFTER);
/** The waiting state starts this long after the message is complete, and never before `WAIT_MIN` after the key. */
const WAIT_AFTER = 120;
const WAIT_MIN = 380;
/** The hairline's slow fill: quick at first, then ever slower, never quite to the end on its own. */
const WAIT_FILL = 9000;
const WAIT_REACH = 0.94;

/** The widest a card grows: this share of the reading column. */
const CARD_SHARE = 0.8;
/** The first message's card sits this far under the top of the stage (the conversation's top padding). */
const FIRST_TOP = 56;
/** A new message's card sits this far under the conversation's last row. */
const LANDING_GAP = 26;
/** The narrowest side padding of a conversation row (timeline.css `.tl-content --gutter`). */
const MIN_GUTTER = 24;
/** A bar without a key (nothing sends from one today): the line leaves this far in from its right edge. */
const CORNER = 34;
/** A queue row (composer.css `.cq-list`, `.cq-row`): inset in the tray, its height, its corners, where its words start. */
const ROW = { inset: 6, gap: 6, height: 28, radius: 14, text: 35 };

function columnToken(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--column')) || 760;
}

/**
 * The reading column inside a conversation of the given left edge and width, the way timeline.css
 * lays it out (`--gutter: max(24px, (100% - var(--column)) / 2)` on each side of every row).
 */
export function columnEdges(left: number, width: number, column: number): { left: number; right: number; width: number } {
  const gutter = Math.max(MIN_GUTTER, (width - column) / 2);
  return { left: left + gutter, right: left + width - gutter, width: Math.max(0, width - gutter * 2) };
}

/**
 * Whether a landing box is certain enough to fly to: it has a size, it sits inside the reading
 * column (a pixel of slack), and it is within a viewport's reach of the visible conversation (it
 * may still be rising from behind the composer while the view follows it).
 */
export function landingCertain(
  box: { left: number; right: number; top: number; bottom: number; width: number; height: number },
  col: { left: number; right: number },
  view: { top: number; bottom: number },
): boolean {
  if (!(box.width > 0 && box.height > 0)) return false;
  if (box.left < col.left - 1 || box.right > col.right + 1) return false;
  const reach = view.bottom - view.top;
  return box.bottom > view.top - reach * 0.25 && box.top < view.bottom + reach;
}

/**
 * Where the first message's card sits in a new session, from the stage alone (before the session
 * exists): its right edge on the reading column's, its top under the conversation's top padding.
 */
export function firstLanding(stage: { left: number; top: number; width: number }, column: number, card: { width: number }): { left: number; top: number } {
  return { left: columnEdges(stage.left, stage.width, column).right - card.width, top: stage.top + FIRST_TOP };
}

/** The page around the send, read once before anything is written (one layout for all of it). */
interface Geometry {
  z: number;
  column: number;
  stage: DOMRect | null;
  card: DOMRect | null;
  /** The open conversation: its content box, its scroller and where its last row ends. */
  content: DOMRect | null;
  scroller: DOMRect | null;
  lastBottom: number | null;
  contents: number;
  contentEl: HTMLElement | null;
  fromEnd: number;
  viewH: number;
}

function readGeometry(cardEl: HTMLElement | null, column: number, stageEl: Element | null): Geometry {
  const contents = document.querySelectorAll<HTMLElement>('.tl-content');
  const content = contents.length === 1 ? contents[0] : null;
  const sc = content?.parentElement ?? null;
  const last = content ? [...content.children].reverse().find((n) => !n.classList.contains('tail')) : null;
  const z = uiZoom();
  return {
    z,
    column,
    stage: stageEl?.getBoundingClientRect() ?? null,
    contentEl: content,
    // How far the view is from its end, and how tall it is (read here: `scrollAhead` only writes).
    fromEnd: sc ? sc.scrollHeight - sc.clientHeight - sc.scrollTop : 0,
    viewH: sc ? sc.clientHeight : 0,
    card: cardEl?.getBoundingClientRect() ?? null,
    content: content?.getBoundingClientRect() ?? null,
    scroller: content?.parentElement?.getBoundingClientRect() ?? null,
    lastBottom: last ? last.getBoundingClientRect().bottom : null,
    contents: contents.length,
  };
}

/**
 * Where the card will sit, guessed before its row exists. In an open conversation: just under the
 * last row, or just above the dock once the view has followed it. The real row corrects it.
 */
function guessLanding(g: Geometry, w: number, h: number, first: boolean): { left: number; top: number } | null {
  const z = g.z;
  if (first) {
    if (!g.stage) return null;
    return firstLanding({ left: g.stage.left / z, top: g.stage.top / z, width: g.stage.width / z }, g.column, { width: w });
  }
  // Two conversations on stage (a session switch is fading one out): the real row decides.
  if (g.contents !== 1 || !g.content) return null;
  const c = g.content;
  const right = columnEdges(c.left / z, c.width / z, g.column).right;
  const after = g.lastBottom != null ? g.lastBottom / z + LANDING_GAP : c.top / z + FIRST_TOP;
  const y = Math.min(g.card ? g.card.top / z - 64 - h : after, after);
  const sc = g.scroller;
  if (sc && !(y >= sc.top / z && y + h <= (g.card ? g.card.top : sc.bottom) / z + 1)) return null;
  return { left: right - w, top: y };
}

interface Source {
  el: HTMLElement;
  /** The words, as shown in `el` (its text box: padding excluded, scroll applied). */
  text: string;
  oneLine?: boolean;
}

/** Where the words stand in their source, their type, and the part of them that shows. */
function measure(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const z = uiZoom();
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const size = parseFloat(cs.fontSize) || 14;
  const line = parseFloat(cs.lineHeight) || size * 1.5;
  return {
    cs,
    // Read now: nothing is read from the style once the launch has started writing.
    font: fontOf(cs),
    padY: padT + padB,
    color: cs.color,
    left: r.left / z + padL,
    top: r.top / z + padT - el.scrollTop,
    width: r.width / z - padL - padR,
    size,
    line,
    view: { top: r.top / z + padT, bottom: r.bottom / z - padB },
    box: { left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z },
  };
}
type Measured = NonNullable<ReturnType<typeof measure>>;

function fontOf(cs: CSSStyleDeclaration) {
  return `font-size:${cs.fontSize};line-height:${cs.lineHeight};font-family:${cs.fontFamily};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};`;
}

/**
 * The first frame a message shows in is already this far into its motion (ms): the frame after
 * the key press moves (the words have begun to run, the key has begun to give), instead of
 * standing for one frame exactly as the field stood. One frame's worth, whatever the first frame
 * took to make: nothing more of the motion is ever skipped.
 */
const FIRST_FRAME = 16;

/**
 * An animation timed from the message's start (`t0`, the page's clock), so it agrees with the
 * worker frame for frame. Before the start is known (the launch's first frame) it is left pending,
 * `FIRST_FRAME` in: it begins there in the first frame it shows in; the start then puts what shows
 * nothing yet on the message's clock (`begin`).
 */
function fromKey(f: Pick<Flight, 't0' | 'all' | 'started'>, el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  const a = play(el, frames, { easing: 'linear', fill: 'both', ...opts });
  if (!a) return null;
  if (f.started) a.startTime = f.t0;
  else a.currentTime = FIRST_FRAME;
  if (frozenAt != null) {
    a.pause();
    a.currentTime = frozenAt;
  }
  f.all.push(a);
  return a;
}

/** A dither cell of a whole number of device px (about 2), in page px. */
function ditherCell(): number {
  const k = (window.devicePixelRatio || 1) * uiZoom();
  return Math.max(2, Math.round(2 * k)) / k;
}

/** Masks `el` to quarter `q` of the 4x4 ordered dither (ranks 4q to 4q+3): a static mask, only its opacity ever changes. */
function quarter(el: HTMLElement, q: number, cell: number) {
  el.classList.add('send-q');
  const tile = quarterTiles('#000', cell)[q];
  el.style.setProperty('mask-image', tile);
  el.style.setProperty('-webkit-mask-image', tile);
  el.style.setProperty('mask-size', `${cell * 4}px ${cell * 4}px`);
  el.style.setProperty('-webkit-mask-size', `${cell * 4}px ${cell * 4}px`);
  return el;
}

/**
 * Steps `el` between shown and hidden at the given times (ms after time zero), each a cut on the
 * compositor: one animation over the whole run, so nothing of a later step shows before its time.
 */
function stepped(f: Pick<Flight, 't0' | 'all' | 'started'>, el: Element, from: number, changes: [number, number][]): Animation | null {
  const last = Math.max(1, ...changes.map((c) => c[0])) + 1;
  const frames: Keyframe[] = [{ offset: 0, opacity: from, easing: 'steps(1, end)' }];
  for (const [t, o] of changes) frames.push({ offset: Math.min(1, Math.max(0, t / last)), opacity: o, easing: 'steps(1, end)' });
  frames.push({ offset: 1, opacity: changes.length ? changes[changes.length - 1][1] : from });
  return fromKey(f, el, frames, { duration: last });
}

/**
 * The words go in place: the visible text as four layers (clipped to the field), each one
 * quarter of the dither, gone a quarter at a time, the densest ranks first (sparse, checker,
 * gone). Nothing of it moves, is cut apart or re-wrapped.
 */
function dissolveWords(f: Pick<Flight, 't0' | 'all' | 'started' | 'plan'>, src: Source, m: Measured): HTMLElement[] {
  const view = { top: m.view.top, height: Math.max(m.line, m.view.bottom - m.view.top) };
  const cell = ditherCell();
  const text = src.text.length > 4000 ? src.text.slice(0, 4000) : src.text;
  const out: HTMLElement[] = [];
  for (let q = 0; q < 4; q++) {
    const layer = document.createElement('div');
    layer.className = 'send-gather';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = `left:${m.left}px;top:${view.top}px;width:${m.width}px;height:${view.height}px;`;
    quarter(layer, q, cell);
    const words = document.createElement('div');
    words.style.cssText = `top:${(m.top - view.top).toFixed(2)}px;width:${m.width}px;${m.font}color:${m.color};`;
    if (src.oneLine) words.setAttribute('data-one-line', '');
    words.textContent = text;
    layer.appendChild(words);
    document.body.appendChild(layer);
    stepped(f, layer, 1, [[f.plan.dissolve[3 - q], 0]]);
    out.push(layer);
  }
  return out;
}

/**
 * The card the message becomes: the conversation's own `.user-card` (the whole, laid out in flow,
 * which gives the layer its size), and over it its two parts: the well (`.send-surface`, the
 * card's numbers), which takes over from the well the canvas draws as the card opens, and the
 * words alone, which stand whole in two frames once the opening shape holds them. At the handover
 * the whole takes their place in one frame (never both: text drawn twice reads bolder).
 */
function makeCard(text: string, steer: boolean, max: number) {
  const el = document.createElement('div');
  el.className = 'send-bubble';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `left:0;top:0;width:max-content;max-width:${max}px;`;
  const inner = document.createElement('div');
  inner.className = 'send-in';
  // A steer lands not yet taken: at the waiting tone (timeline.css `.user[data-queued] .user-card`).
  if (steer) inner.style.opacity = '0.6';
  const card = () => {
    const c = document.createElement('div');
    c.className = 'user-card';
    c.style.maxWidth = 'none';
    const words = document.createElement('div');
    words.className = 'user-text';
    // A long message is clipped in the conversation too, at the same line (timeline.css `.user-text[data-clipped]`).
    if (isLongMessage(text)) words.setAttribute('data-clipped', '');
    words.textContent = text;
    c.appendChild(words);
    return c;
  };
  const whole = document.createElement('div');
  whole.className = 'send-whole';
  whole.appendChild(card());
  const well = document.createElement('i');
  well.className = 'send-surface';
  const words = document.createElement('div');
  words.className = 'send-words';
  words.appendChild(card());
  inner.append(whole, well, words);
  el.appendChild(inner);
  return { el, inner, whole, wells: [well], quarters: [words], surface: null };
}

/** A queue row's words, as the tray will show them: the whole, and the words that stand first. */
function makeRowWords(text: string, cs: CSSStyleDeclaration | null) {
  const el = document.createElement('div');
  el.className = 'send-flight';
  el.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  inner.className = 'send-in';
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? text;
  const row = () => {
    const words = document.createElement('div');
    words.className = 'send-row-text';
    if (cs) words.style.cssText = fontOf(cs);
    words.textContent = line;
    return words;
  };
  const whole = document.createElement('div');
  whole.className = 'send-whole';
  whole.appendChild(row());
  const words = document.createElement('div');
  words.className = 'send-words';
  words.appendChild(row());
  inner.append(whole, words);
  el.appendChild(inner);
  return { el, inner, whole, wells: [] as HTMLElement[], quarters: [words], surface: null };
}

/**
 * Opacity at the given times (ms after time zero) on the compositor, one animation over the whole
 * run: each change a cut at its time, or (`glide`) a straight run from the change before.
 */
function keyed(f: Pick<Flight, 't0' | 'all' | 'started'>, el: Element, from: number, changes: [number, number, boolean?][]): Animation | null {
  const last = Math.max(1, ...changes.map((c) => c[0])) + 1;
  const frames: Keyframe[] = [{ offset: 0, opacity: from }];
  let prev = from;
  for (const [t, o, glide] of changes) {
    const offset = Math.min(1, Math.max(0, t / last));
    if (!glide) frames.push({ offset, opacity: prev });
    frames.push({ offset, opacity: o });
    prev = o;
  }
  frames.push({ offset: 1, opacity: prev });
  return fromKey(f, el, frames, { duration: last });
}

/**
 * The card's layers as the shape opens on the canvas: the words whole in two frames once it holds
 * them, the well taking over from the canvas's in three, and at the handover the whole card in
 * their place in one frame.
 */
function unfoldAnims(f: Flight) {
  for (const a of f.anims) a.cancel();
  f.anims = [];
  const p = f.plan;
  const push = (a: Animation | null) => a && f.anims.push(a);
  for (const w of f.wells) push(keyed(f, w, 0, [[p.fill[0] ?? p.hand, 0], [p.fill[1] ?? p.hand, 1, true], [p.hand, 0]]));
  for (const w of f.quarters) push(keyed(f, w, 0, [[p.words[0], 0.5], [p.words[1], 1], [p.hand, 0]]));
  push(keyed(f, f.whole, 0, [[p.hand, 1]]));
}

/** Places the landing layer on its box. */
function place(f: Flight) {
  const b = f.box;
  f.el.style.left = `${b.left.toFixed(2)}px`;
  f.el.style.top = `${b.top.toFixed(2)}px`;
  f.el.style.width = `${b.width.toFixed(2)}px`;
  f.el.style.maxWidth = 'none';
}

/** The bar holds still (no transitions of its own) while the line leaves it and its field closes. */
const BAR_HOLD = BORN + 200;
/** The field closes once the words are mostly gone (their layers stay where the words stood). */
const FIELD_CLOSES = 56;

/**
 * Lifts `text` out of `source` (the composer's field, or a queue row's text) and keeps it in the
 * air until something with the same text claims it. Call before the field is cleared.
 *
 * This is the key's own handler, and what it costs is the wait before the first frame. So: the
 * card goes into the page first (hidden), then everything is read at once (one layout, the one
 * the frame needs anyway), then everything is written; nothing is read back after a write. All
 * that the first frame shows or the compositor and the worker need (the words, the card and its
 * reveal, the line's canvas) is in place when it returns: a layer that entered the page later
 * would only show once the main thread draws again, and right after a send that can take a long
 * time. What is no layer (the timers, the backdrop's beats) follows right after
 * that frame (`after`).
 */
export function launchFlight(source: Source, opts: { dest: FlightDest; steer?: boolean; first?: boolean; session?: string | null }): FlightHandle | null {
  if (reducedMotion() || !source.text.trim()) return null;
  const t0 = performance.now();
  const bubble = opts.dest === 'timeline';
  const steer = !!opts.steer;
  const first = !!opts.first;
  const z = uiZoom();
  // The layer it lands as, in the page before anything is read: measured with the rest.
  const stageEl = document.querySelector('.stage-body');
  const column = columnToken();
  const made = bubble ? makeCard(source.text, steer, 10) : makeRowWords(source.text, null);
  made.el.style.visibility = 'hidden';
  if (bubble) {
    // Its widest: a share of the reading column (the stage's width is read with the rest; until
    // then the stage's last known width does).
    const w = stageEl ? (stageEl as HTMLElement).offsetWidth : 0;
    made.el.style.maxWidth = `${w ? Math.floor(columnEdges(0, w, column).width * CARD_SHARE) : 600}px`;
  } else made.el.style.height = `${ROW.height}px`;
  document.body.appendChild(made.el);

  // Every read, and nothing written before the last of them: one layout for the whole launch.
  const m = measure(source.el);
  if (!m) {
    made.el.remove();
    return null;
  }
  const bar = source.oneLine ? null : source.el.closest<HTMLElement>('.cmp-card');
  const g = readGeometry(bar, column, stageEl);
  // The key the line leaves from: a disc in the bar's corner (composer.css `.cmp-keys`).
  const keyR = bar?.querySelector('.cmp-keys')?.getBoundingClientRect();
  const rowEl = source.oneLine ? source.el.closest<HTMLElement>('[data-qrow]') : null;
  const rowBox = rowEl?.getBoundingClientRect();
  const cardR = g.card;
  // Fractional: a width rounded down would wrap the last word.
  const size = bubble ? made.el.getBoundingClientRect() : null;
  // The field closes to one line with the words. A docked bar grows upward, so its key stays
  // where it is; the home card's copy keeps its top (home/handoff.ts), so its key comes up by
  // what the field loses.
  const ta = bar && source.el instanceof HTMLTextAreaElement ? source.el : null;
  const oneLine = m.line + m.padY;
  const shrink = ta ? Math.max(0, m.box.bottom - m.box.top - oneLine) : 0;
  const from: SignalSpec['from'] =
    cardR && keyR?.width
      ? { x: (keyR.left + keyR.width / 2) / z, y: keyR.top / z - (first ? shrink : 0), edge: true, r: keyR.width / 2 / z }
      : cardR
        ? { x: cardR.right / z - CORNER, y: cardR.top / z + (first ? 0 : shrink), edge: true }
        : rowBox
          ? { x: rowBox.right / z - 44, y: (rowBox.top + rowBox.height / 2) / z, edge: false }
          : { x: m.box.right - 30, y: (m.box.top + m.box.bottom) / 2, edge: false };

  // Where it lands, and how far the conversation has to move up before that place is clear of its last lines.
  let box: Box;
  let room = 0;
  if (size) {
    const w = size.width / z;
    const h = size.height / z;
    const guess = guessLanding(g, w, h, first);
    // No guess (a view changing under it): just above the bar, on the column's right; the row decides.
    const at = guess ?? { left: (cardR ? cardR.right / z : from.x + CORNER) - w, top: (cardR ? cardR.top / z : from.y) - 64 - h };
    box = { left: at.left, top: at.top, width: w, height: h, radii: [18, 18, 6, 18] };
    // A steer lands while the view follows a running turn: that follower keeps it clear.
    if (guess && !first && !steer && g.lastBottom != null) room = g.lastBottom / z + LANDING_GAP - guess.top;
  } else box = rowBoxOf(g, from, first ? 0 : shrink);

  // From here on, writes only.
  const spec: SignalSpec = { from, to: box, kind: bubble ? 'bubble' : 'row', ...(steer ? { tone: 0.6 } : {}) };
  // Under a first message the bar leaves while the line draws: room for that below.
  const signal = pour(spec, first ? 150 : 0);
  const f: Flight = {
    key: norm(source.text),
    dest: opts.dest,
    session: opts.session ?? null,
    wall: Date.now(),
    steer,
    t0,
    started: false,
    synced: [],
    read: { card: cardR, stage: g.stage, column, fieldHeight: m.box.bottom - m.box.top, z },
    beats: [],
    signal,
    plan: signal.plan,
    pourEls: [],
    ...made,
    box,
    anims: [],
    fixAnim: null,
    fixEnd: 0,
    all: [],
    resting: false,
    target: null,
    row: null,
    ending: false,
    done: holdSend(),
    wait: [],
    line: null,
    answer: 'pending',
    answeredAt: 0,
    timer: 0,
    restTimer: 0,
    home: { left: 0, top: 0, s0: 1 },
    bar,
    barAnim: null,
    ahead: null,
    slide: null,
  };
  // Where the card stands to show its words exactly on the field's (a refused message goes back there).
  const s0 = Math.min(1, m.size / CARD_FONT);
  f.home = { left: m.left - CARD_PAD_X * s0, top: m.top - CARD_PAD_TOP * s0 + (m.line - CARD_LINE * s0) / 2, s0 };
  place(f);
  f.el.style.visibility = '';
  // The words go in place, and the landing resolves as the line reaches it.
  f.pourEls = dissolveWords(f, source, m);
  // A queue row's words are going out of it: the row itself shows none (it leaves the tray
  // meanwhile; one that stays gets its words back).
  if (source.oneLine) {
    const el = source.el;
    el.style.opacity = '0';
    window.setTimeout(() => (el.style.opacity = ''), COLLAPSE + 400);
  }
  unfoldAnims(f);
  // The bar holds still while the line leaves it, and its field closes behind the words on
  // their curve (composer.css `.cmp-card[data-pouring]`; the composer's own measure then sets the
  // same height).
  if (bar) holdBar(bar, BAR_HOLD);
  if (ta && shrink > 0.5 && !first) {
    ta.style.overflowY = 'hidden';
    ta.style.height = `${oneLine}px`;
    // Timed from the same frame as the words (a transition would start whenever the busy main
    // thread next gets to it), and above whatever the composer writes meanwhile.
    f.barAnim = fromKey(f, ta, [{ height: `${(oneLine + shrink).toFixed(2)}px` }, { height: `${oneLine}px` }], { duration: COLLAPSE, delay: FIELD_CLOSES, easing: linearEasing(collapseEase, 20), fill: 'backwards' });
  }
  pending.push(f);
  // A conversation row that mounted first (the bridge answered before this row left the tray): the
  // view already follows it. Otherwise the conversation makes room for the card now.
  let early: HTMLElement | null = null;
  if (bubble) {
    pruneUnclaimed(t0);
    const i = unclaimed.findIndex((u) => claimable(f, 'timeline', u.key, u));
    if (i >= 0) early = unclaimed.splice(i, 1)[0].root;
    else if (room > 0.5) scrollAhead(f, room, g);
  }
  const lead = f.all[0] ?? null;
  // The waiting state is set now, to begin once the card is complete: on the compositor from the
  // first frame, it shows on time even while the main thread is busy mounting the row it waits for.
  if (bubble) waitFrom(f, waitStart(f.plan.end));
  begin(f, g, lead);
  if (early) landInTimeline(early, source.text, { steer, late: true, session: f.session });
  // Whatever happens on the way, nothing outlives this: the real message always shows.
  window.setTimeout(() => abort(f), bubble ? HOLD_MS + 2000 : MAX_LIFE_MS);
  if (import.meta.env.DEV) devHook();
  return {
    settle: (ok) => settle(f, ok),
    scope: (id) => {
      f.session = id;
    },
    release: () => abort(f),
  };
}

/** The composers showing each chat, counted (a remount, or React's strict double mount, is no close). */
const views = new Map<string, number>();

/**
 * A composer of `sessionId` is on screen; the returned function says it left. When the last one
 * has left (a switch to another chat, the view closing), the chat's messages still in the air fade
 * where they are, so none is left to land on whatever the next view mounts.
 */
export function holdFlights(sessionId: string): () => void {
  views.set(sessionId, (views.get(sessionId) ?? 0) + 1);
  return () => {
    const n = (views.get(sessionId) ?? 1) - 1;
    if (n > 0) views.set(sessionId, n);
    else views.delete(sessionId);
    queueMicrotask(() => {
      if (views.has(sessionId)) return;
      for (const f of [...pending]) if (f.session === sessionId) abort(f);
    });
  };
}

/**
 * A queue row's place: the tray's newest row, just above the bar, where it comes to rest. The bar
 * grows upward and its field closes to one line behind the words (`shrink` px): the bar's top, and
 * the tray standing on it, end up that much lower than they are at the press. Aimed at the top as
 * it is at the press, the words stood on the tray's head line, 18 px too high, until the row took
 * over (day 7 video, "it jumps a bit high").
 */
function rowBoxOf(g: Geometry, from: SignalSpec['from'], shrink = 0): Box {
  const z = g.z;
  const c = g.card ?? new DOMRect(from.x * z - 400, from.y * z, 434, 60);
  return { left: c.left / z + ROW.inset, top: c.top / z + shrink - ROW.gap - ROW.height, width: c.width / z - ROW.inset * 2, height: ROW.height, radii: [ROW.radius, ROW.radius, ROW.radius, ROW.radius] };
}

/**
 * Runs `fn` as the next task, ahead of what else is waiting (timers, the work the send set off):
 * after the frame being made now has gone to the screen.
 */
function nextTask(fn: () => void) {
  const s = (globalThis as { scheduler?: { postTask?: (cb: () => void, o: { priority: 'user-blocking' }) => Promise<unknown> } }).scheduler;
  if (s?.postTask) return void s.postTask(fn, { priority: 'user-blocking' }).catch(() => {});
  if (typeof MessageChannel !== 'function') return void window.setTimeout(fn, 0);
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    ch.port1.close();
    fn();
  };
  ch.port2.postMessage(0);
}

/**
 * Starts the message. Its time zero is the moment its first frame is on screen, not the key and
 * not that frame's start: the layers made at the key are left to start by themselves (animations
 * with no start time begin together when the compositor first shows them, however long the main
 * thread took to get that frame out, so none of the motion is skipped). The worker has to be told
 * that moment. The compositor reports it (`lead.ready`), but only once the main thread is free
 * again, which after a send can be much later; so the worker is started right behind the frame
 * (the next task, ahead of the work the send set off) on that task's time, and put right when the
 * report comes in while nothing of the line shows yet. Everything of the message that shows
 * later than its first frames runs on that same clock (`align`). A hidden window shows no frame: a
 * timer starts the message instead. What the launch left for later follows at once.
 */
function begin(f: Flight, g: Geometry, lead: Animation | null) {
  // Every layer of the message, the field's words included, is put on the message's own clock,
  // the one the worker draws by. Left to start by themselves they run from the moment the
  // compositor first shows them, which on a loaded machine is some frames after the worker's
  // zero, and the compositor's report of that moment comes too late to move the worker (below):
  // a queued message's words still stood in the field, dithered, while its line had already
  // closed round its row in the tray (the words in two places for 60 ms). On one clock a late
  // first frame only skips a step of the dissolve.
  const align = () => {
    if (frozenAt != null) return;
    for (const a of new Set([...f.all, ...f.wait, ...f.synced])) a.startTime = f.t0;
  };
  const go = (at: number) => {
    if (f.started) return;
    f.t0 = at;
    f.started = true;
    align();
    if (frozenAt != null)
      for (const a of [...f.all, ...f.synced]) {
        a.pause();
        a.currentTime = frozenAt;
      }
    // A message given up before its first frame (its row was no place to land) draws nothing.
    if (!f.ending) f.signal?.start(at);
    armRest(f);
    after(f, g);
  };
  // The first frame shows the message `FIRST_FRAME` in, so its zero lies that far before that frame.
  requestAnimationFrame(() => nextTask(() => go(performance.now() - FIRST_FRAME)));
  window.setTimeout(() => go(performance.now() - FIRST_FRAME), 160);
  const exact = () => {
    const at = lead?.startTime;
    if (typeof at !== 'number') return;
    if (!f.started) return go(at);
    // Only while nothing of the line shows yet on either clock: a correction never shows.
    const t = performance.now() - Math.min(at, f.t0);
    if (Math.abs(at - f.t0) < 2 || t > f.plan.born || f.ending || frozenAt != null) return;
    f.t0 = at;
    f.signal?.retime(at);
    align();
    armRest(f);
  };
  lead?.ready.then(exact, () => {});
  armRest(f);
}

/**
 * What the launch left for after its first frame (nothing of it shows by itself): a still of the
 * the backdrop's beats and the timers of the hold.
 */
function after(f: Flight, g: Geometry) {
  if (f.ending) return;
  const bubble = f.dest === 'timeline';
  beatsFor(f);
  if (bubble) {
    if (!f.target) review(f);
  } else if (!f.target) f.timer = window.setTimeout(() => !f.target && abort(f), NO_CLAIM_MS);
}

/** Rests once the line has run its course; the words' layers go once gone. */
function armRest(f: Flight) {
  window.clearTimeout(f.restTimer);
  const left = f.t0 + f.plan.end - performance.now();
  f.restTimer = window.setTimeout(() => rest(f), Math.max(0, left));
  const poured = f.t0 + COLLAPSE + 40 - performance.now();
  window.setTimeout(() => {
    if (frozen) return;
    for (const p of f.pourEls) p.remove();
    f.pourEls = [];
  }, Math.max(0, poured));
}

/**
 * The backdrop answers the line (art/events.ts): the pressure wave from where it leaves the key,
 * and a softer ripple from where it meets the card. A queued message's wave is quieter, and its
 * landing (a hop away) has none.
 */
function beatsFor(f: Flight) {
  const p = f.plan;
  const z = uiZoom();
  const at = (ms: number, fn: () => void) => f.beats.push(window.setTimeout(fn, Math.max(0, f.t0 + ms - performance.now())));
  at(p.snap, () => {
    const o = f.plan.spec.from;
    fieldBeatAt('send', o.x * z, o.y * z, f.dest === 'tray' ? 0.6 : 1);
  });
  if (f.dest !== 'timeline') return;
  at(p.land, () => {
    const s = shiftAt(f.plan, f.plan.land);
    const meet = f.plan.path[f.plan.path.length - 1];
    fieldBeatAt('pulse', (meet.x + s.x) * z, (meet.y + s.y) * z, 0.5);
  });
}

function dropBeats(f: Flight) {
  for (const t of f.beats) window.clearTimeout(t);
  f.beats = [];
}

/** The message launched from `bar` in this same handler (not yet started). */
function leavingFlight(bar: HTMLElement): Flight | null {
  let f: Flight | null = null;
  for (const p of pending) if (p.bar === bar && !p.started && !p.ending) f = p;
  return f;
}

/**
 * What the launch of the message leaving `bar` read of the page, in page px (already divided by
 * the zoom): the bar's box, the stage's, the reading column and the field's height. The launch
 * has written to the page since; reading these again in the same handler would lay the page out a
 * second time before the first frame.
 */
export function launchRead(bar: HTMLElement): { card: { left: number; top: number; width: number; height: number }; stage: { left: number; top: number; width: number; bottom: number } | null; column: number; fieldHeight: number } | null {
  const f = leavingFlight(bar);
  const r = f?.read;
  if (!r?.card) return null;
  const z = r.z;
  return {
    card: { left: r.card.left / z, top: r.card.top / z, width: r.card.width / z, height: r.card.height / z },
    stage: r.stage ? { left: r.stage.left / z, top: r.stage.top / z, width: r.stage.width / z, bottom: r.stage.bottom / z } : null,
    column: r.column,
    fieldHeight: r.fieldHeight,
  };
}

/**
 * The bar this message is leaving is about to glide away (the first message from home,
 * home/handoff.ts): recorded on the plan, by (dx, dy) in all, from `BAR_LEAVES` on.
 * Returns how to put an animation on the message's clock (its time zero is the message's first
 * frame), or null when no message is leaving that bar.
 */
export function barLeaving(bar: HTMLElement, by: { dx: number; dy: number }): ((a: Animation) => void) | null {
  const f = leavingFlight(bar);
  if (!f) return null;
  f.signal?.leaving(by);
  if (f.signal) f.plan = f.signal.plan;
  return onFlightClock(bar);
}

/**
 * How to put an animation on the clock of the message leaving `bar` in this same handler (its
 * time zero is the message's first frame, the clock its line is drawn by): the send key's part
 * (launch.ts), the home bar's glide. Null when no message is leaving that bar.
 */
export function onFlightClock(bar: HTMLElement): ((a: Animation) => void) | null {
  const flight = leavingFlight(bar);
  if (!flight) return null;
  return (a) => {
    if (flight.started) a.startTime = flight.t0;
    else {
      flight.synced.push(a);
      a.currentTime = FIRST_FRAME;
    }
    if (frozenAt != null) {
      a.pause();
      a.currentTime = frozenAt;
    }
  };
}

/**
 * The conversation makes room at the key. At the end of a long conversation the card lands where
 * the view will be once it has followed the new row, just above the bar, which is over the last
 * lines until the row mounts and the view scrolls (on a loaded machine, well after the card is
 * there). So the content moves up by what the row needs, on the compositor, on the curve the view
 * follows its end with (Timeline.tsx, `FOLLOW_W`); when the row mounts, `handOver` turns that lift
 * into the scroll in one frame. It waits `AHEAD_WAIT` first: a row that comes that soon (an idle
 * machine) is simply followed by the view, as it always was.
 */
const FOLLOW_W = 24;
const followAt = (ms: number) => {
  const v = (FOLLOW_W * Math.max(0, ms)) / 1000;
  return 1 - (1 + v) * Math.exp(-v);
};
const AHEAD_MS = 300;
const AHEAD_WAIT = 64;

/** The content's own vertical offset as drawn now (CSS px). */
const liftOf = (el: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 || 0;

function scrollAhead(f: Flight, by: number, g: Geometry) {
  const content = g.contentEl;
  const sc = content?.parentElement;
  if (!content || !sc) return;
  // Only from the end: a reader further up gets the end when the row comes, a view still gliding
  // to its end must not be overtaken, and one message moves it at a time.
  if (g.fromEnd > 2 || by > g.viewH) return;
  if (pending.some((p) => p.ahead?.content === content || p.slide?.content === content)) return;
  const n = Math.ceil(AHEAD_MS / 16);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= n; i++) frames.push({ offset: i / n, transform: `translateY(${(-by * (i === n ? 1 : followAt((AHEAD_MS * i) / n))).toFixed(2)}px)` });
  const anim = fromKey(f, content, frames, { duration: AHEAD_MS, delay: AHEAD_WAIT });
  if (anim) f.ahead = { content, scroller: sc, anim, by };
}

/** Takes the lift out of the flight's animations (it is no longer the message's to freeze or end). */
function takeAhead(f: Flight): Ahead | null {
  const a = f.ahead;
  if (!a) return null;
  f.ahead = null;
  const i = f.all.indexOf(a.anim);
  if (i >= 0) f.all.splice(i, 1);
  return a;
}

/**
 * The row is there: the content's lift becomes the scroll in the same frame, so nothing moves.
 * Whatever the real row needs beyond the guess is the view's own follower's to scroll, as for any
 * row (a transform cannot carry it: content drawn lower than the end only lengthens the scroller,
 * and the follower would chase it). A lift that went further than the conversation now reaches
 * settles back onto its end, still on the compositor (drawn higher, so the scroller is unchanged).
 */
function handOver(f: Flight) {
  const a = takeAhead(f);
  if (!a) return;
  const lift = a.content.isConnected ? -liftOf(a.content) : 0;
  a.anim.cancel();
  if (lift < 0.5) return;
  const sc = a.scroller;
  const before = sc.scrollTop;
  sc.scrollTop = before + lift;
  const over = sc.scrollTop - before - lift;
  if (over > -0.5) return;
  const anim = play(a.content, [{ transform: `translateY(${over.toFixed(2)}px)` }, { transform: 'translateY(0px)' }], { duration: 240, easing: EASE_OUT });
  if (!anim) return;
  const slide = { content: a.content, anim };
  f.slide = slide;
  const off = () => f.slide === slide && (f.slide = null);
  anim.finished.then(off, off);
}

/** No row is coming (refused, given up): the conversation goes back down where it was. */
function releaseAhead(f: Flight) {
  const a = takeAhead(f);
  if (!a) return;
  const y = a.content.isConnected ? liftOf(a.content) : 0;
  a.anim.cancel();
  if (Math.abs(y) > 0.5) play(a.content, [{ transform: `translateY(${y.toFixed(2)}px)` }, { transform: 'translateY(0px)' }], { duration: 260, easing: EASE_OUT });
}

/** The waiting state, from `at` ms after the key: a hairline filling along the card's lower edge (the card itself keeps its tone). */
function waitFrom(f: Flight, at: number) {
  const inner = f.inner;
  const line = document.createElement('i');
  line.className = 'send-wait';
  line.setAttribute('aria-hidden', 'true');
  inner.appendChild(line);
  f.line = line;
  const fill = fromKey(
    f,
    line,
    [
      { transform: 'scaleX(0)', opacity: 0 },
      { transform: `scaleX(${(WAIT_REACH * 0.03).toFixed(3)})`, opacity: 1, offset: 0.015 },
      { transform: `scaleX(${WAIT_REACH})`, opacity: 1 },
    ],
    { duration: WAIT_FILL, delay: at, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
  );
  f.wait = fill ? [fill] : [];
}

/** Whether the waiting state has begun (its animations are past their delay). */
const waiting = (f: Flight) => f.wait.length > 0 && f.wait[0].effect?.getComputedTiming().progress != null;

function endWait(f: Flight) {
  for (const a of f.wait) a.cancel();
  f.wait = [];
}

/**
 * The swap after a wait: the hairline goes on from where it stood on the row's own edge, runs to
 * the end and fades, so the wait visibly completes as the message lands.
 */
function finishWait(f: Flight, card: HTMLElement) {
  const scale = f.line ? new DOMMatrixReadOnly(getComputedStyle(f.line).transform).a : 0;
  const line = document.createElement('i');
  line.className = 'send-wait';
  line.setAttribute('aria-hidden', 'true');
  card.appendChild(line);
  // It runs to the end (the first half), then lets go (the second).
  const run = play(
    line,
    [
      { transform: `scaleX(${scale.toFixed(4)})`, opacity: 1, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
      { transform: 'scaleX(1)', opacity: 1, offset: 0.5, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
      { transform: 'scaleX(1)', opacity: 0 },
    ],
    { duration: 380, easing: 'linear', fill: 'forwards' },
  );
  const gone = () => line.remove();
  if (run) run.finished.then(gone, gone);
  else gone();
}

/** A message's hold, decided now and again when it could next change (see bubbleHold). */
function review(f: Flight) {
  window.clearTimeout(f.timer);
  if (f.ending || f.target) return;
  const now = performance.now();
  const sinceLaunch = now - f.t0;
  const sinceAnswer = f.answer === 'pending' ? 0 : now - f.answeredAt;
  const next = bubbleHold({ row: false, answer: f.answer, sinceLaunch, sinceAnswer });
  if (next === 'release') return abort(f);
  if (next === 'back') return void goBack(f);
  const wait = f.answer === 'taken' ? Math.min(ACKED_MS - sinceAnswer, HOLD_MS - sinceLaunch) : HOLD_MS - sinceLaunch;
  f.timer = window.setTimeout(() => review(f), Math.max(16, wait));
}

/** The bridge's answer (see FlightHandle). */
function settle(f: Flight, ok: boolean): Promise<void> {
  if (f.ending) return Promise.resolve();
  if (!ok) {
    f.answer = 'refused';
    return goBack(f);
  }
  f.answer = 'taken';
  f.answeredAt = performance.now();
  if (f.dest === 'timeline') review(f);
  return Promise.resolve();
}

/** The springs (stiffness, damping) of a card going back: the axis that leads and the one that follows. */
const LEAD = { k: 520, c: 40 };
const FOLLOW = { k: 460, c: 38 };
/** The throw: each axis leaves at this share of its trip per second, so the first frames cover ground. */
const THROW = 4;
const THROW_FOLLOW = 1.5;
/** How far it sinks while the key gives (px). */
const DIP = 2;

/**
 * A path from `from` to (gx, gy), stepped ahead of time (semi-implicit Euler, 4 ms steps, a sample
 * every 16 ms): a short gather until the release, the throw, then one spring per axis until it
 * rests exactly there. A refused message's card flies back into the field on it. Pure, so it can
 * be tested.
 */
export function springPath(from: Sample, gx: number, gy: number, opts: { release?: number; sideways?: boolean } = {}): Sample[] {
  const release = opts.release ?? 0;
  const out = [from];
  let { t, x, y, vx, vy } = from;
  // A path that starts after the release (a re-aim) is already thrown.
  let thrown = t > release;
  const sx = opts.sideways ? LEAD : FOLLOW;
  const sy = opts.sideways ? FOLLOW : LEAD;
  const h = 0.004;
  for (let i = 1; i < 400; i++) {
    t += 4;
    let done = false;
    if (t <= release) y = DIP * Math.sin((t / release) * Math.PI * 0.5);
    else {
      if (!thrown) {
        thrown = true;
        vx = (opts.sideways ? THROW : THROW_FOLLOW) * (gx - x);
        vy = (opts.sideways ? THROW_FOLLOW : THROW) * (gy - y);
      }
      vx += (sx.k * (gx - x) - sx.c * vx) * h;
      vy += (sy.k * (gy - y) - sy.c * vy) * h;
      x += vx * h;
      y += vy * h;
      done = Math.hypot(gx - x, gy - y) < 0.4 && Math.hypot(vx, vy) < 12;
    }
    if (done) {
      out.push({ t, x: gx, y: gy, vx: 0, vy: 0 });
      break;
    }
    if (i % 4 === 0) out.push({ t, x, y, vx, vy });
  }
  return out;
}

/**
 * Refused: before the card is complete, what is in the air fades as the words are put back in the
 * field; a complete card flies back to where its words stood, shrinking to the field's type while
 * its surface dissolves. Resolves when the words can be put back (the caller does that).
 */
function goBack(f: Flight): Promise<void> {
  f.ending = true;
  window.clearTimeout(f.timer);
  window.clearTimeout(f.restTimer);
  releaseAhead(f);
  dropBeats(f);
  drop(f);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  const tone = parseFloat(getComputedStyle(f.inner).opacity) || 1;
  endWait(f);
  f.line?.remove();
  f.signal?.cancel();
  for (const p of f.pourEls) p.remove();
  f.pourEls = [];
  const finish = (a: Animation | null) =>
    new Promise<void>((resolve) => {
      const gone = () => {
        f.el.remove();
        f.done();
        resolve();
      };
      if (a) a.finished.then(gone, gone);
      else gone();
    });
  const t = performance.now() - f.t0;
  if (f.dest !== 'timeline' || t < f.plan.hand) {
    for (const a of f.all) if (a !== f.barAnim) a.pause();
    return finish(play(f.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' }));
  }
  // From where it is (the correction folded in) back onto the words' place in the field.
  const fix = shiftAt(f.plan, t);
  for (const a of f.all) a.cancel();
  const to = { x: f.home.left - f.box.left, y: f.home.top - f.box.top };
  const path = springPath({ t: 0, x: fix.x, y: fix.y, vx: 0, vy: 0 }, to.x, to.y);
  const end = path[path.length - 1].t || 1;
  const frames: Keyframe[] = path.map((p) => {
    const u = p.t / end;
    return { offset: Math.min(1, u), transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) scale(${(1 + (f.home.s0 - 1) * Math.min(1, u * 1.4)).toFixed(4)})` };
  });
  frames[frames.length - 1].offset = 1;
  f.el.style.transformOrigin = '0 0';
  const back = play(f.el, frames, { duration: end, easing: 'linear', fill: 'forwards' });
  if (tone < 1) play(f.inner, [{ opacity: tone }, { opacity: 1 }], { duration: 160, easing: EASE_OUT, fill: 'forwards' });
  // The well goes as the words settle back into the field (the whole card's own, `::before`).
  const well = f.whole.querySelector<HTMLElement>('.user-card');
  if (well) play(well, [{ backgroundColor: 'transparent' }], { duration: 1, fill: 'forwards' });
  return finish(back);
}

/** What the landing layer lines up with: the message's card, or the tray row. */
const landingEl = (f: Flight) => (f.dest === 'tray' ? (f.target?.closest<HTMLElement>('[data-qrow]') ?? f.target) : f.target);

/** The target's place at rest (the conversation follows a sent message to its end: the row rests that much higher). */
function targetAt(f: Flight): { left: number; top: number; width: number; height: number } | null {
  const t = landingEl(f);
  if (!t?.isConnected) return null;
  const z = uiZoom();
  const r = t.getBoundingClientRect();
  if (!r.width) return null;
  const sc = f.dest === 'timeline' ? t.closest<HTMLElement>('.tl-content')?.parentElement : null;
  const gap = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight - sc.scrollTop) : 0;
  // The rest of the room-making motion still to come (the content is drawn that much lower now).
  const slide = f.slide && f.slide.anim.playState === 'running' && f.slide.content.isConnected ? liftOf(f.slide.content) : 0;
  return { left: r.left / z, top: r.top / z - gap - slide, width: r.width / z, height: r.height / z };
}

/** The line has run its course. With a target the real thing takes over; without one the card waits. */
function rest(f: Flight) {
  f.resting = true;
  if (frozen || !f.target || f.ending) return;
  if (performance.now() < f.fixEnd) return;
  if (f.dest === 'tray') still(f);
  else land(f);
}

/**
 * The tray opens under the words (its height animates), so its row may still be moving when they
 * are complete: they hold until it has come to rest, then the two swap. A few frames of polling, once.
 */
function still(f: Flight) {
  let last: { left: number; top: number } | null = null;
  let tries = 0;
  const tick = () => {
    if (f.ending) return;
    const to = targetAt(f);
    if (!to) return abort(f);
    // At rest: the swap moves the row by whatever is left between the words and it.
    if ((last && Math.abs(to.left - last.left) < 0.3 && Math.abs(to.top - last.top) < 0.3) || ++tries > 45) return land(f);
    last = to;
    requestAnimationFrame(tick);
  };
  tick();
}

/**
 * The swap. The copy sits on the real card: one goes, the other shows, in one frame. A row that
 * is not quite there (the view is still catching up, a line arrived above it) takes the remainder
 * itself and settles onto its place.
 */
function land(f: Flight) {
  if (f.ending) return;
  handOver(f);
  const to = targetAt(f);
  f.ending = true;
  window.clearTimeout(f.timer);
  window.clearTimeout(f.restTimer);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  if (f.dest === 'timeline' && f.target && waiting(f)) finishWait(f, f.target);
  endWait(f);
  const el = landingEl(f);
  if (to && shown && el) {
    const fix = shiftAt(f.plan, performance.now() - f.t0);
    // Where the copy stands now against where the row is now (not at rest: the row moves the rest itself).
    const r = el.getBoundingClientRect();
    const z = uiZoom();
    const dx = f.box.left + fix.x - r.left / z;
    const dy = f.box.top + fix.y - r.top / z;
    if (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6) {
      // The row paints outside its own box while it settles (rows are paint-contained at rest).
      const item = shown.closest<HTMLElement>('.tl-item');
      if (item) {
        item.style.contentVisibility = 'visible';
        window.setTimeout(() => (item.style.contentVisibility = ''), 260);
      }
      play(shown, [{ translate: `${dx.toFixed(2)}px ${dy.toFixed(2)}px` }, { translate: '0px 0px' }], { duration: 200, easing: EASE_OUT });
    }
  }
  f.el.remove();
  for (const p of f.pourEls) p.remove();
  f.pourEls = [];
  drop(f);
  f.done();
}

function abort(f: Flight) {
  if (f.ending) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  window.clearTimeout(f.restTimer);
  releaseAhead(f);
  dropBeats(f);
  const shown = f.row ?? f.target;
  if (shown) shown.style.opacity = '';
  f.signal?.cancel();
  for (const p of f.pourEls) p.remove();
  f.pourEls = [];
  const done = () => f.el.remove();
  const a = play(f.el, [{ opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' });
  if (a) a.finished.then(done, done);
  else done();
  drop(f);
  f.done();
}

function drop(f: Flight) {
  const i = pending.indexOf(f);
  if (i >= 0) pending.splice(i, 1);
}

function claim(dest: FlightDest, text: string, site: LandingSite): Flight | null {
  const i = pending.findIndex((f) => claimable(f, dest, text, site));
  return i >= 0 ? pending[i] : null;
}

/** Whether `target` (a message's card in the conversation) is a place the card may land on. */
function certainTarget(target: HTMLElement): boolean {
  const content = target.closest<HTMLElement>('.tl-content');
  const scroller = content?.parentElement;
  if (!content || !scroller) return false;
  const z = uiZoom();
  const c = content.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const col = columnEdges(c.left / z, c.width / z, columnToken());
  const box = { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
  return landingCertain(box, col, { top: s.top / z, bottom: s.bottom / z });
}

/**
 * The real landing takes over from the guess. Before the line reaches the card, the landing simply moves
 * (nothing of it shows yet). After that, everything still to come moves by the difference: the
 * worker shifts the outline, the card's layer takes the same shift on the same curve.
 */
function aim(f: Flight) {
  const to = targetAt(f);
  if (!to) return abort(f);
  const t = performance.now() - f.t0;
  const cur = shiftAt(f.plan, Math.max(t, f.fixEnd - f.t0));
  const dx = to.left - (f.box.left + cur.x);
  const dy = to.top - (f.box.top + cur.y);
  const resized = Math.abs(to.width - f.box.width) > 0.5 || Math.abs(to.height - f.box.height) > 0.5;
  if (t < f.plan.launch - 8 && f.signal) {
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3 && !resized) return;
    const height = f.dest === 'tray' ? f.box.height : to.height;
    f.box = { ...f.box, left: to.left, top: to.top, width: to.width, height };
    place(f);
    f.signal.retarget(f.box);
    f.plan = f.signal.plan;
    unfoldAnims(f);
    armRest(f);
    return;
  }
  if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) {
    if (f.resting) rest(f);
    return;
  }
  // Lands where the row is by the time it touches down (or soon after, when it already has).
  const dur = Math.max(160, f.plan.land - t);
  const s = { at: t, dx, dy, dur };
  if (f.signal) f.signal.shift(s);
  if (f.signal?.plan !== f.plan) f.plan.shifts.push(s);
  f.fixEnd = f.t0 + t + dur;
  // The words' layer follows the same sum of shifts, from now to the end of the last one.
  const frames: Keyframe[] = [];
  const n = Math.max(4, Math.round(dur / 16));
  for (let i = 0; i <= n; i++) {
    const at = t + (dur * i) / n;
    const p = shiftAt(f.plan, at);
    frames.push({ offset: i / n, transform: `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px)` });
  }
  const old = f.fixAnim;
  f.fixAnim = fromKey(f, f.inner, frames, { duration: dur, delay: t, fill: 'forwards' });
  old?.cancel();
  window.setTimeout(() => f.resting && rest(f), Math.max(0, f.fixEnd - performance.now()) + 4);
}

/**
 * A message mounted in the conversation (`root` is its `.user` element). When its message is in
 * the air, it lands here: the row skips its own entrance and stays clear until the card sits on
 * it, then the two swap. Returns true when a message in the air took it.
 */
export function landInTimeline(root: HTMLElement, text: string, opts: { steer?: boolean; late?: boolean } & LandingSite = {}): boolean {
  if (reducedMotion()) return false;
  const f = claim('timeline', text, opts);
  if (!f) {
    if (!opts.late) {
      const now = performance.now();
      pruneUnclaimed(now);
      unclaimed.push({ key: text, root, at: now, session: opts.session ?? null, ts: opts.ts ?? null });
      if (unclaimed.length > 4) unclaimed.shift();
      // Forgotten once it can no longer be claimed, so a conversation left behind is not held.
      window.setTimeout(() => pruneUnclaimed(performance.now()), UNCLAIMED_MS + 20);
    }
    return false;
  }
  const card = root.querySelector<HTMLElement>('.user-card');
  if (!card) return false;
  // Its turn is new. Until a settled-looking turn has been drawn once it stands at its estimated
  // height (timeline.css `.tg` content-visibility), which puts the conversation's end a few hundred
  // px too far down for a frame or more (many under load): drawn in full while the message lands,
  // so the end it is measured against is the real one. Its size is remembered by then.
  const turn = root.closest<HTMLElement>('.tg');
  if (turn) {
    turn.style.contentVisibility = 'visible';
    window.setTimeout(() => (turn.style.contentVisibility = ''), 3000);
  }
  // The conversation moved up for it: that lift becomes the scroll now, before anything is measured.
  handOver(f);
  // A row that is not where a message belongs (off the column, out of reach, not laid out): the
  // message fades where it is and the row makes its own entrance.
  if (!certainTarget(card)) {
    abort(f);
    return false;
  }
  root.setAttribute('data-flight', '');
  for (const a of root.getAnimations()) a.cancel();
  // The card becomes this card: the same width and lines, its marks and attachments.
  const width = card.getBoundingClientRect().width / uiZoom();
  const copy = card.cloneNode(true) as HTMLElement;
  copy.style.cssText = `max-width:none;width:${width.toFixed(2)}px;transition:none;opacity:1;`;
  // Its tone (a steer not yet taken waits at a lower one) on the layer, so the well's quarters take it too.
  f.inner.style.opacity = getComputedStyle(card).opacity;
  for (const c of f.el.querySelectorAll('.user-card')) c.replaceWith(copy.cloneNode(true));
  // Past the line's arrival the landing keeps its place and only shifts: the card takes the real width now.
  f.el.style.width = `${width.toFixed(2)}px`;
  f.target = card;
  f.row = root;
  root.style.opacity = '0';
  watch(f);
  return true;
}

/**
 * Where a row rests is only known once the conversation has laid out around it (the turn it starts
 * settles in the effects after it mounts): measured on the next frame, and again just before the
 * line reaches the card and just before, so a late change moves it instead of
 * showing as a jump at the landing.
 */
function watch(f: Flight) {
  requestAnimationFrame(() => !f.ending && aim(f));
  const at = (ms: number) => {
    const wait = f.t0 + ms - performance.now();
    if (wait > 0) window.setTimeout(() => !f.ending && aim(f), wait);
  };
  at(f.plan.launch - 24);
  at(f.plan.land - 40);
}

/** A queued message's row appeared in the tray: the words land on it. */
export function landInTray(textEl: HTMLElement, text: string, session?: string | null): boolean {
  if (reducedMotion()) return false;
  const f = claim('tray', text, { session });
  if (!f) return false;
  // The words take the row's type and stand where its text starts.
  const row = textEl.closest<HTMLElement>('[data-qrow]');
  const words = f.el.querySelectorAll<HTMLElement>('.send-row-text');
  if (words.length && row) {
    const cs = getComputedStyle(textEl);
    const z = uiZoom();
    const css = `${fontOf(cs)}padding-left:${((textEl.getBoundingClientRect().left - row.getBoundingClientRect().left) / z).toFixed(2)}px;`;
    for (const w of words) w.style.cssText = css;
  }
  f.target = textEl;
  textEl.style.opacity = '0';
  // The tray is still unfolding under it (a transform): the guess is where the row comes to rest,
  // and what is left is settled once it has (`still`).
  return true;
}

/** A queued message left the tray for the conversation: it gathers at the row's end and rises from there. */
export function launchFromTray(textEl: HTMLElement, text: string, session?: string | null) {
  if (reducedMotion()) return;
  launchFlight({ el: textEl, text, oneLine: true }, { dest: 'timeline', session });
}

/** For tests and the dev console: messages in the air. */
export const flightsInAir = () => pending.length;

// ── dev: frame sheets ──

let frozen = false;
let frozenAt: number | null = null;

/** Dev only: holds every message in the air at `t` ms after its key (null lets them run on). */
function freezeFlights(t: number | null) {
  frozen = t != null;
  frozenAt = t;
  freezeSignal(t);
  for (const f of pending) {
    for (const a of [...f.all, ...f.synced]) {
      if (t == null) {
        a.startTime = f.t0;
      } else {
        a.pause();
        a.currentTime = t;
      }
    }
    if (t == null) {
      armRest(f);
      if (f.resting) rest(f);
    }
  }
}

function devHook() {
  const w = window as unknown as { __sableSignal?: object };
  if (!w.__sableSignal)
    w.__sableSignal = {
      freeze: freezeFlights,
      plan: (spec: SignalSpec) => planSignal(spec),
      inAir: () => pending.length,
      easing: linearEasing(shiftEase),
      debug: () =>
        pending.map((f) => ({ dest: f.dest, t: Math.round(performance.now() - f.t0), skew: f.anims.map((a) => (typeof a.startTime === 'number' ? Math.round((a.startTime - f.t0) * 10) / 10 : null)), box: f.box, from: f.plan.spec.from, land: f.plan.land, hand: f.plan.hand, end: f.plan.end, shifts: f.plan.shifts, target: !!f.target, ending: f.ending, resting: f.resting, el: f.el.getBoundingClientRect().toJSON(), ahead: f.ahead?.by ?? null, slide: !!f.slide })),
    };
}

// The worker that draws the line is loaded while the page is idle, ahead of the first send.
if (typeof window !== 'undefined') prewarmSignal();
