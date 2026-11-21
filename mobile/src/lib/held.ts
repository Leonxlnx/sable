/**
 * The message held by a long press (screens/MessageMenu.tsx shows its menu). Each hold is its own
 * object: what the menu does after waiting (a shortened answer fetched whole) checks it still holds
 * that one before it opens anything or lets go, so a message dismissed meanwhile never reopens, and a
 * newer menu is never closed by an older one's answer. Pure, so it can be tested.
 */
export interface Hold<T> {
  value: T;
}

export function holder<T>(onChange?: (prev: Hold<T> | null, next: Hold<T> | null) => void) {
  let held: Hold<T> | null = null;
  const subs = new Set<() => void>();
  const set = (next: Hold<T> | null) => {
    const prev = held;
    held = next;
    onChange?.(prev, next);
    subs.forEach((l) => l());
  };
  return {
    current: () => held,
    subscribe(l: () => void) {
      subs.add(l);
      return () => void subs.delete(l);
    },
    hold(value: T): Hold<T> {
      const h = { value };
      set(h);
      return h;
    },
    /** Still the one held (false: dismissed, or another was held since). */
    holds: (h: Hold<T>) => held === h,
    /** Lets go of `h` only (another held since stays); without one, of whatever is held. */
    release(h?: Hold<T>) {
      if (!held || (h && held !== h)) return false;
      set(null);
      return true;
    },
  };
}
