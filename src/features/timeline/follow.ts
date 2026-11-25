/**
 * The conversation's follower (Timeline.tsx), as pure arithmetic so it can be checked without a page.
 */

/** Where a glide to the end stands: its position, speed, and the scroll position it set last. */
export interface Glide {
  pos: number;
  v: number;
  wrote: number;
}

/**
 * One step of a critically damped spring toward `target`, exact for any frame length: `pos` never
 * passes the target from rest and never turns back on a long frame. The stepwise form it replaces
 * (`v += a * dt; pos += v * dt`) turned back once a frame was longer than about 30 ms at w = 24:
 * the view went 75 px toward the end and then 21 px back on the next frame.
 */
export function springStep(pos: number, v: number, target: number, w: number, dt: number): { pos: number; v: number } {
  const x = pos - target;
  const c = v + w * x;
  const e = Math.exp(-w * dt);
  return { pos: target + (x + c * dt) * e, v: (v - w * c * dt) * e };
}

/**
 * One frame of the glide: `top` is the scroll position as it is now, `target` the end. Returns the
 * position to set, and whether the glide has arrived. Something else that moved the view meanwhile
 * (scroll anchoring as rows above were built, the send's lift handed over as scroll) is taken as it
 * is: the glide goes on from there instead of writing its own older position back, which threw the
 * conversation down again by that much.
 */
export function glideFrame(g: Glide, top: number, target: number, w: number, dt: number): { top: number; done: boolean } {
  const moved = top - g.wrote;
  if (Math.abs(moved) >= 1) g.pos += moved;
  const step = springStep(g.pos, g.v, target, w, dt);
  g.pos = step.pos;
  g.v = step.v;
  if (g.pos >= target - 0.4) {
    g.pos = target;
    g.v = 0;
    return { top: target, done: true };
  }
  return { top: g.pos, done: false };
}

/** What a message must be for its arrival at the end to bring the view there (see `sendFollower`). */
export interface LastMessage {
  type: string;
  steered?: boolean;
  state?: string;
}

/**
 * Whether a message that has just become the conversation's last root is a send the view follows:
 * only the first time it gets there. The agent taking a steered message moves it to the end again
 * (`SessionRuntime.taken`), and a reader who scrolled up meanwhile must stay where they are (review
 * window-F4); a steer already taken when it first gets there (a view that was not live when it was
 * sent) is no send either. `synthetic`: words the agent's harness wrote in the person's place.
 */
export function sendFollower(): (id: string, item: LastMessage | undefined, synthetic: boolean) => boolean {
  const seen = new Set<string>();
  return (id, item, synthetic) => {
    if (item?.type !== 'user' || synthetic) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    // Bounded: only the newest few matter.
    if (seen.size > 64) seen.delete(seen.values().next().value as string);
    return !(item.steered && item.state !== 'queued');
  };
}

/**
 * Where the conversation's last line (`.tail`) stands, as far as its glide is concerned: measured
 * from the end of the conversation while the view keeps the end (`stuck`), from its top otherwise.
 * Kept at the end, the line never moves on screen when something above it grows or shrinks: the
 * view moves with it in the same frame. Measured from the top instead, every late height above it
 * (a widget drawn again, a picture, a fold) read as a move, and the glide threw the line by that
 * much and back while it stood still: up to 530 px up and down when a long chat was opened again
 * (day 7, "x sub-agents working jumps around when you click on a chat"). A conversation shorter
 * than the view has no scroll to keep: its end is the top, so the line glides when it is pushed down.
 */
export function tailPlace(offsetTop: number, stuck: boolean, scrollHeight: number, clientHeight: number): number {
  return stuck ? offsetTop - Math.max(0, scrollHeight - clientHeight) : offsetTop;
}

/**
 * How far the line must glide from where it was drawn to its new place (0: none). `prev` is the place
 * last measured and how it was measured; a change of measure (the reader let go of the end or came
 * back) is no move.
 */
export function tailGlide(prev: { place: number; stuck: boolean } | null, place: number, stuck: boolean, drawnOffset = 0): number {
  if (!prev || prev.stuck !== stuck) return 0;
  const d = prev.place + drawnOffset - place;
  return Math.abs(d) < 2 || Math.abs(d) > 480 ? 0 : d;
}

/**
 * The room to add ABOVE the conversation, below one device pixel, so that its end (the lower edge of
 * its last row, `end` layout pixels from the top of what scrolls, this room not counted) stands on a
 * whole number of device pixels; `k` is device pixels to the layout pixel. `keep` is returned when the
 * scale cannot be read.
 *
 * A view kept at the end stands on the scroller's largest offset, which the browser rounds to a whole
 * device pixel. The end is drawn at its own offset less that scroll: whenever the height of what
 * stands above it changes by a fraction (the real heights of older turns built above as a long chat's
 * pages arrive), the end lands on another fraction of a device pixel and its words shimmer by one
 * (at 125% its lower edge read 757.33, 757.53, 757.93 from page to page). With the end's own offset
 * whole, the scroll is whole too and the end is drawn at the view's height less the dock's padding,
 * whatever is built above.
 *
 * The first version of this added the room BELOW the end (a bottom padding that made the whole height
 * a whole number): the scroll was whole then, but the end itself stood that padding higher, a
 * different fraction after every page, and measured in the packaged app it took seven values
 * (756.72 to 757.93) where it had taken six.
 */
export function endSnap(end: number, k: number, keep = 0): number {
  if (!(k > 0) || !Number.isFinite(k) || !Number.isFinite(end)) return keep;
  const dev = end * k;
  const whole = Math.ceil(dev - 1e-3);
  return Math.max(0, (whole - dev) / k);
}
