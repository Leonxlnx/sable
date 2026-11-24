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
