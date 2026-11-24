/**
 * Which card the deck should show in front when it opens (or now, while it is open): a
 * notification's click asks for its chat's card (`lib/notify.ts`). Taken once.
 */
let wanted: string | null = null;
const listeners = new Set<(key: string) => void>();

export function askFront(key: string) {
  wanted = key;
  for (const l of listeners) l(key);
}

/** The card asked for, once (the deck reads it as it opens). */
export function takeFront(): string | null {
  const k = wanted;
  wanted = null;
  return k;
}

/** An open deck hears asks as they come. */
export function onFront(l: (key: string) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
