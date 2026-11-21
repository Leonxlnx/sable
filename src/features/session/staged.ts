import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { afterSend, sendInAir } from '@/features/composer/settle';

/**
 * The session view mounts in steps while a sent message is in the air (the first message from
 * home): the conversation first, in the task that opens the session, then each part that asks
 * through `useStaged` in a task of its own, one per frame. Mounted as one piece, the view, the
 * docked composer, the prompt cards, the conversation's map and the find bar were a single task of
 * about 190 ms right under the flight (four times that on a loaded machine).
 *
 * Any other mount (a chat opened from the list, a switch) is whole at once, as before: nothing is
 * in the air then and the dither veil covers the change.
 */

/** The longest a part waits for the landing (ms), as the lagged chrome does (lib/lagged.ts). */
const LANDED_CAP_MS = 2500;

const queue: (() => void)[] = [];
let pumping = false;

/**
 * After the next frame has been produced, as a task ahead of what else waits (on a loaded machine
 * timers stood behind the bridge's messages for most of a second). A timer stands in where no
 * frame comes.
 */
function afterPaint(fn: () => void) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.clearTimeout(t);
    fn();
  };
  const t = window.setTimeout(run, 80);
  requestAnimationFrame(() => {
    const s = (globalThis as { scheduler?: { postTask?: (cb: () => void, o: { priority: 'user-blocking' }) => Promise<unknown> } }).scheduler;
    if (s?.postTask) void s.postTask(run, { priority: 'user-blocking' }).catch(() => {});
    else window.setTimeout(run, 0);
  });
}

function pump() {
  if (pumping) return;
  pumping = true;
  const next = () => {
    const fn = queue.shift();
    if (!fn) {
      pumping = false;
      return;
    }
    afterPaint(() => {
      fn();
      next();
    });
  };
  next();
}

/**
 * False for a part that waits its turn, then true for good. `soon`: the next free frame (the docked
 * composer: the card flying to the dock stands in for it meanwhile). `landed`: once the message has
 * landed (what nobody can reach during the flight: the prompt cards, the map, the find bar).
 */
export function useStaged(when: 'soon' | 'landed' = 'soon'): boolean {
  const [on, setOn] = useState(() => !sendInAir());
  useEffect(() => {
    if (on) return;
    let live = true;
    // Rendered there and then: left to React's default lane it would be swept into the next
    // update that renders synchronously (see lib/lagged.ts).
    const step = () => live && flushSync(() => setOn(true));
    let asked = false;
    const go = () => {
      if (asked) return;
      asked = true;
      queue.push(step);
      pump();
    };
    const off = when === 'landed' ? afterSend(go) : (go(), undefined);
    // A flight that never reports its landing must not keep the prompt cards away.
    const cap = when === 'landed' ? window.setTimeout(go, LANDED_CAP_MS) : 0;
    return () => {
      live = false;
      off?.();
      window.clearTimeout(cap);
      const at = queue.indexOf(step);
      if (at >= 0) queue.splice(at, 1);
    };
  }, [on, when]);
  return on;
}
