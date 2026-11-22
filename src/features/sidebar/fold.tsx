import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { play, reducedMotion, slideLeft, spring } from '@/lib/motion';
import { holdListEnd, listShift, partsInView } from './leave';

/**
 * A folder folds and unfolds without its height ever being animated.
 *
 * Animating the height laid the whole list out on every frame: with a long folder below, a fold was
 * five positions in a quarter of a second (the film: 338, 325, 325, 275 px), on a clock of its own.
 * Here the layout takes its final shape at once and three things move on one spring, started in one
 * task, as translate alone (the compositor's):
 * - the edge: the folder's body is clipped by its own box, which slides, while its children slide
 *   the other way and so stand still: rows are uncovered or covered from the header down;
 * - everything below (`followers`), which rides exactly on that edge (only what can be seen of it:
 *   a long folder below is taken apart into its rows, never slid as one layer);
 * - folding, the body React has just taken out: it is put back as a dead copy, out of the flow, cut
 *   down to the rows that can be seen, and removed when the edge has closed.
 * A fold longer than the list is tall moves only as far as can be seen (`reach`): past the list's
 * lower edge nothing is drawn, so the rest is taken in one step there.
 * A click while a fold runs turns it back from where the edge is (`edgeOf`, worked out, never read).
 * A long folder unfolds a screenful of rows first; the rest mount when it stands (`Unfolding`):
 * building four hundred rows took the page half a second before the first frame of the unfold.
 * Reduced motion: nothing moves; the rows are there or not.
 */

/** The list's spring (the one a leaving row's gap closes on). */
const FOLD = spring(440, 40);
/** What a fold needs beyond the list's lower edge to end out of sight (px). */
const PAST = 60;

interface Run {
  /** The edge's way, in px below the body's top: from, to. */
  from: number;
  to: number;
  anims: Animation[];
  /** A folded body on its way out. */
  ghost?: HTMLElement;
  /** An unfolding body, clipped until it is whole. */
  body?: HTMLElement;
}

/** The fold under way, by the element the body stands in. */
const runs = new WeakMap<Element, Run>();

/** Where the edge of a fold under way stands at `now` (px below the body's top). */
export function edgeOf(run: { from: number; to: number }, started: number | null, now: number): number {
  return run.to + slideLeft(FOLD, run.from - run.to, started, now);
}

/** How far a fold of a body `height` tall moves, when `room` of it can be seen below its top. */
export function reach(height: number, room: number): number {
  return Math.min(height, Math.max(PAST, room + PAST));
}

/**
 * A screenful of rows and a few more, for a list that builds the rest a moment later. A row is
 * 30 px at the interface's own size and smaller when the interface is set smaller, while the
 * window's height is in screen pixels: counted without the zoom, a small interface got fewer rows
 * than fit, and what stood below them jumped when the rest mounted.
 */
export function screenful(viewHeight: number, zoom: number): number {
  return Math.ceil(viewHeight / (28 * Math.min(1, zoom > 0 ? zoom : 1))) + 6;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function stop(host: Element): number | null {
  const run = runs.get(host);
  if (!run) return null;
  const edge = edgeOf(run, (run.anims[0]?.startTime as number | null) ?? null, performance.now() + 16);
  for (const a of run.anims) a.cancel();
  run.ghost?.remove();
  if (run.body) run.body.removeAttribute('data-folding');
  runs.delete(host);
  return edge;
}

/** What stands below `body` in the list, level by level, as far as a slide seen between `top` and `bottom` moves it. */
function followers(body: HTMLElement, rows: HTMLElement, top: number, bottom: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let el: HTMLElement | null = body; el && el !== rows; el = el.parentElement) {
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.getBoundingClientRect().top > bottom) break;
      partsInView(n, top, bottom, out);
    }
  }
  return out;
}

function run(host: Element, state: Omit<Run, 'anims'>, moves: [Element, number, number][], done: () => void) {
  const timing = { duration: FOLD.duration, easing: FOLD.easing };
  const anims = moves.flatMap(([el, a, b]) => play(el, [{ translate: `0 ${a}px` }, { translate: `0 ${b}px` }], timing) ?? []);
  const mine: Run = { ...state, anims };
  runs.set(host, mine);
  const end = () => {
    if (runs.get(host) !== mine) return;
    runs.delete(host);
    done();
  };
  if (anims[0]) anims[0].finished.then(end, () => {});
  else end();
}

/** The body has just been laid out whole: it is uncovered from its top down while what is below rides the edge. */
function unfold(body: HTMLElement) {
  const host = body.parentElement;
  const list = body.closest<HTMLElement>('.side-list');
  const rows = body.closest<HTMLElement>('.side-rows');
  if (!host || !list || !rows || reducedMotion()) return;
  const view = list.getBoundingClientRect();
  const height = body.offsetHeight;
  if (height < 2) return;
  const far = reach(height, view.bottom - body.getBoundingClientRect().top);
  const edge = clamp(stop(host) ?? 0, 0, far);
  // Below the body, where the slide draws it: from the body's height above its place (less the edge) down.
  const below = followers(body, rows, view.top - 40 + (height - far), view.bottom + 40 + (height - edge));
  body.setAttribute('data-folding', '');
  const a = -(height - edge);
  const b = -(height - far);
  run(host, { from: edge, to: far, body }, [[body, a, b], ...[...body.children].map((c): [Element, number, number] => [c, -a, -b]), ...below.map((el): [Element, number, number] => [el, a, b])], () => body.removeAttribute('data-folding'));
}

/** The body a header's click is about to fold: the section's own, or the archived rows under their line. */
function bodyOf(trigger: Element): HTMLElement | null {
  const el = trigger.classList.contains('sarchived') ? trigger.nextElementSibling : trigger.closest('.sgroup')?.querySelector(':scope > .sgroup-body');
  return el instanceof HTMLElement && el.classList.contains('sgroup-body') && !el.hasAttribute('data-gone') ? el : null;
}

/**
 * Said in the click that toggles a folder, before the state changes. An open folder is about to
 * fold: its measures are taken while it stands, and the moment React has taken its body out the
 * fold plays. (An unfolding folder needs no word: its body plays when it mounts, `FoldBody`.)
 */
export function foldCue(trigger: Element) {
  const body = bodyOf(trigger);
  const host = body?.parentElement;
  const list = body?.closest<HTMLElement>('.side-list');
  const rows = body?.closest<HTMLElement>('.side-rows');
  if (!body || !host || !list || !rows) return;
  // Plain under reduced motion (and whatever still moves here, the setting changed mid-way, stops).
  if (reducedMotion()) return void stop(host);
  // Reads, while the folder stands.
  const view = list.getBoundingClientRect();
  const height = body.offsetHeight;
  const box = { top: body.offsetTop, left: body.offsetLeft, width: body.offsetWidth };
  const far = reach(height, view.bottom - body.getBoundingClientRect().top);
  // Below the body, where the slide draws it: up to the body's height above where it stands now.
  const below = followers(body, rows, view.top - 40 + (height - far), view.bottom + 40 + height);
  // A list scrolled to its end comes down when it gets shorter: under the pointer it keeps its end
  // (holdListEnd); else that fold is plain, the whole list moving is not this motion.
  const plain = !holdListEnd(trigger) && listShift(list.scrollTop, list.scrollHeight, list.clientHeight, height) > 0;
  const gone = new MutationObserver(() => {
    if (body.isConnected) return;
    gone.disconnect();
    window.clearTimeout(cap);
    // An unfold still under way ends with its body, whether this fold plays or not: left running,
    // what is below kept sliding from a place the layout had already taken back.
    const at = stop(host);
    if (plain) return;
    const edge = clamp(at ?? far, 0, far);
    // The body React let go of is the copy: only the rows that can be seen, out of the flow.
    const keep = Math.ceil(far / 30) + 2;
    body.querySelectorAll('.srow').forEach((r, i) => i >= keep && r.remove());
    body.setAttribute('data-gone', '');
    body.setAttribute('aria-hidden', 'true');
    body.inert = true;
    body.style.cssText = `position:absolute;top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${height}px;margin:0;overflow:hidden;pointer-events:none;`;
    host.appendChild(body);
    const a = -(height - edge);
    run(host, { from: edge, to: 0, ghost: body }, [[body, a, -height], ...[...body.children].map((c): [Element, number, number] => [c, -a, height]), ...below.map((el): [Element, number, number] => [el, edge, 0])], () => body.remove());
  });
  gone.observe(host, { childList: true });
  // Not folded after all (the click did something else): nothing waits.
  const cap = window.setTimeout(() => gone.disconnect(), 400);
}

/**
 * Until when (`performance.now()`) the unfold a list of rows mounts in still runs; 0 when none does.
 * A list of rows reads it once, as it mounts: during an unfold it builds a screenful and the rest
 * when the unfold has ended. A body that mounts inside one that unfolds plays nothing of its own.
 */
export const Unfolding = createContext({ until: 0 });

/**
 * A folder's rows (and a project's folders, and the archived rows): mounted while open. Mounted
 * after the list first drew (`enter`), it unfolds.
 */
export function FoldBody({ className, enter, children }: { className: string; enter: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const outer = useContext(Unfolding);
  // As it was when the body mounted: a body of the first paint never unfolds later.
  const [mine] = useState(() => {
    const now = performance.now();
    const late = enter && !reducedMotion() && !(outer.until > now);
    return { late, until: late ? now + FOLD.duration + 80 : outer.until };
  });
  const played = useRef(false);
  useLayoutEffect(() => {
    if (played.current || !mine.late || !ref.current) return;
    played.current = true;
    unfold(ref.current);
  }, [mine]);
  return (
    <Unfolding.Provider value={mine}>
      <div ref={ref} className={className}>
        {children}
      </div>
    </Unfolding.Provider>
  );
}
