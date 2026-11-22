/**
 * A wait that can be cut short: `go` runs once, when the wait says it is over or when `now()` is
 * called, whichever comes first.
 *
 * The launch waits for the first frame of a chat it starts into (up to a second and a half) before
 * it opens; a key or a click during that wait is the person asking for the window now, and the
 * piece gives way at once, chat or no chat. `wait` gets the callback to run when it is over (it may
 * run it straight away: there is nothing to wait for on home) and returns its cancel.
 */
export function shortWait(wait: (over: () => void) => () => void, go: () => void): { now: () => void; cancel: () => void } {
  let done = false;
  let stop: () => void = () => {};
  const over = () => {
    if (done) return;
    done = true;
    stop();
    go();
  };
  // (A wait that is over straight away has run `go` before its cancel is known: nothing to stop then.)
  stop = wait(over);
  return {
    now: over,
    cancel: () => {
      if (done) return;
      done = true;
      stop();
    },
  };
}
