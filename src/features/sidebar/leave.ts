import { dissolve, putAway } from '@/lib/dissolve';
import { play, reducedMotion, spring } from '@/lib/motion';

/**
 * A row leaves the list, in the frame of the click.
 *
 * Nothing waits for the bridge: the row's copy goes its own way (deleted: it breaks into the
 * ground's dither; archived: it sinks under the rows coming up, toward the folder's "Archived"
 * line), the row itself is out of the layout at once, and
 * everything below slides up from where it was drawn on one spring. All of it is opacity and
 * transform started in one task, so it runs on the compositor's one clock while the page is busy
 * (the dialog closing, the bridge's answer, the list rendering again). When the list then renders
 * without the row, nothing is left to move: `Flip` measures the same places before and after.
 *
 * Every place is read before the first write and the new places are worked out, not measured: a
 * read after the row is hidden would make the page lay the whole list out inside the click.
 * The slide is on `translate`, Flip's on `transform`: the two add up when both run on a row.
 */

export type LeaveKind = 'delete' | 'archive' | 'folder';

/** The list's spring (Flip's), and the beat the leaving row has to itself before the gap closes. */
const CLOSE = spring(440, 40);
const BEAT = 45;
const GAP = 'gap';

const gapOf = (el: HTMLElement) => el.getAnimations().find((a) => (a as Animation & { id: string }).id === GAP);
/** How far a slide still running holds its element from its place (layout pixels). */
const offsetNow = (el: HTMLElement) => parseFloat(getComputedStyle(el).translate.split(' ')[1] ?? '0') || 0;
const shown = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains('ghost') && el.offsetHeight > 0;

/**
 * How far a scrolled list comes down when it loses `room` at its end: nothing while what is left
 * still fills the view below the scroll position, at most the room itself. (A list that does not
 * scroll reports its view's height as its own: it never comes down.)
 */
export function listShift(scrollTop: number, scrollHeight: number, clientHeight: number, room: number): number {
  return Math.max(0, scrollTop - Math.max(0, scrollHeight - room - clientHeight));
}

/**
 * A folder folding shut near the end of a scrolled list would bring the list's end up: everything
 * slides down, the header under the pointer with it, and the next quick click lands on the folder
 * above. While the pointer stays in the list its rows keep the height they had (empty ground at the
 * end, if it is scrolled to); they let go when the pointer leaves the list. The same holds for a
 * row that leaves under the pointer. Says whether the height is held.
 */
export function holdListEnd(from: Element): boolean {
  const rows = from.closest<HTMLElement>('.side-rows');
  const list = rows?.closest<HTMLElement>('.side-list');
  if (!rows || !list || list.scrollHeight <= list.clientHeight || !list.matches(':hover')) return false;
  const h = rows.offsetHeight;
  if ((parseFloat(rows.style.minHeight) || 0) < h) rows.style.minHeight = `${h}px`;
  if (list.dataset.holdEnd !== undefined) return true;
  list.dataset.holdEnd = '';
  list.addEventListener(
    'pointerleave',
    () => {
      rows.style.minHeight = '';
      delete list.dataset.holdEnd;
    },
    { once: true },
  );
  return true;
}

/**
 * A row that moves to another list (pinned: up to Pinned; let go: down to its folder) leaves its
 * place in the frame of the click: its copy lifts or sinks a little and fades. The place itself
 * stays until the list renders again: the rows between the two places then slide by one row to
 * close it and to make room, and the row arrives where it belongs (its own entrance, once the room
 * is there). Closing the gap here already would move everything below up and back down.
 * Returns what shows the row again, should it still be there (the bridge refused).
 */
export function liftRow(row: HTMLElement, way: 'up' | 'down'): () => void {
  const back = () => {
    if (row.isConnected) row.style.visibility = '';
  };
  if (reducedMotion()) return back;
  const lit = row.matches(':hover');
  const leaving = putAway(row, 0, way === 'up' ? -7 : 7, 130);
  if (lit) leaving?.ghost.firstElementChild?.setAttribute('data-menu', '');
  if (leaving) row.style.visibility = 'hidden';
  return back;
}

/**
 * Takes `row` out of the list with its exit. Returns what brings it back, should the bridge refuse.
 * Under reduced motion the row is simply gone. `folder`: `row` is a folder's whole section; its
 * header breaks into the dither and its rows (when they are few enough to copy) fade with it.
 */
export function leaveRow(row: HTMLElement, kind: LeaveKind): () => void {
  const list = row.closest<HTMLElement>('.side-list');
  const rows = row.closest<HTMLElement>('.side-rows');
  let release = () => {};
  const back = () => {
    release();
    if (!row.isConnected) return;
    row.style.display = '';
    play(row, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  };
  if (!list || !rows || reducedMotion()) {
    row.style.display = 'none';
    return back;
  }

  // ── reads ──
  const view = list.getBoundingClientRect();
  const lit = row.matches(':hover');
  // The room the row takes: to the next row's top, or what the list loses at its end.
  let next = row.nextElementSibling;
  while (next && !shown(next)) next = next.nextElementSibling;
  let prev = row.previousElementSibling;
  while (prev && !shown(prev)) prev = prev.previousElementSibling;
  const room = shown(next) ? next.offsetTop - row.offsetTop : shown(prev) ? row.offsetTop + row.offsetHeight - (prev.offsetTop + prev.offsetHeight) : row.offsetHeight;
  // The first row archived in a folder: its "Archived" line arrives at the folder's end when the
  // list renders again. The folder keeps its height until then, so what is below it never moves
  // up and back down.
  const body = kind === 'archive' ? row.closest<HTMLElement>('.sgroup-body') : null;
  const keep = body && !body.querySelector(':scope > .sarchived') ? body : null;
  const keepHeight = keep ? keep.offsetHeight : 0;
  // What follows the row, level by level up to the list; only what is in view slides.
  const movers: { el: HTMLElement; from: number }[] = [];
  let kept = false;
  for (let el: HTMLElement | null = row; el && el !== rows; el = el.parentElement) {
    if (!kept) {
      for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
        if (!shown(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.bottom < view.top - 40) continue;
        if (r.top > view.bottom + 40) break;
        movers.push({ el: n, from: gapOf(n) ? offsetNow(n) : 0 });
      }
    }
    // Past the folder that keeps its height nothing moves.
    if (el.parentElement === keep) kept = true;
  }
  // Under the pointer the list keeps its end (as a folding folder does); else a list scrolled to its
  // end comes down by what it lost: the whole list slides from where it was, its rows with it.
  const held = keep ? true : holdListEnd(row);
  const shift = held ? 0 : listShift(list.scrollTop, list.scrollHeight, list.clientHeight, room);
  const rowsFrom = gapOf(rows) ? offsetNow(rows) : 0;
  const head = kind === 'folder' ? row.querySelector<HTMLElement>(':scope > .sgroup-head') : null;
  const inside = kind === 'folder' ? row.querySelector<HTMLElement>(':scope > .sgroup-body') : null;
  const few = !!inside && inside.offsetHeight > 0 && inside.offsetHeight <= 900;
  // A folder's copies stand inside the section above it, never between two sections (their spacing
  // is `.sgroup + .sgroup`); the first section's stand before it.
  const above = kind === 'folder' && shown(prev) && prev.classList.contains('sgroup') ? prev : null;
  const place = above ? { into: above } : { before: row };
  // The ground the row breaks into is the list's own, as drawn.
  const ground = getComputedStyle(list).backgroundColor;

  // ── writes ──
  for (const m of [rows, ...movers.map((m) => m.el)]) gapOf(m)?.cancel();
  // (A folder is two copies: the second one's measuring comes after the first is in the page. It is rare.)
  if (few) putAway(inside, 0, 0, 130, place);
  const leaving = kind === 'delete' ? dissolve(row, { ground }) : kind === 'folder' ? dissolve(head, { ground, ...place }) : putAway(row, 0, 6);
  // The copy is never under the pointer: it keeps the lit row's ground and tools by the row's own rule.
  if (lit) leaving?.ghost.firstElementChild?.setAttribute('data-menu', '');
  if (keep) {
    keep.style.minHeight = `${keepHeight}px`;
    const seen = new MutationObserver(() => release());
    release = () => {
      seen.disconnect();
      keep.style.minHeight = '';
      release = () => {};
    };
    seen.observe(keep, { childList: true });
  }
  row.style.display = 'none';
  const slide = (el: HTMLElement, dy: number) => {
    if (Math.abs(dy) < 0.5) return;
    const a = play(el, [{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: CLOSE.duration, easing: CLOSE.easing, delay: BEAT, fill: 'backwards' });
    if (a) a.id = GAP;
  };
  slide(rows, rowsFrom - shift);
  // A follower starts one row's room below its new place (plus what an earlier slide still held): with
  // the list's own slide that is exactly where it was drawn.
  for (const m of movers) slide(m.el, m.from + room);
  return back;
}
