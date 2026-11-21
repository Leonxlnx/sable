import { bumpEpoch } from './epoch';
import { runForget } from './forget';

/**
 * Erasing everything this phone kept for a desktop (Forget, or a pairing that replaced it with another
 * computer; conn.ts orders it and keeps the restart-safe mark). Independent of which screens and
 * modules ever loaded and of any module's own index of what it wrote: the page's storage is read for
 * every key that belongs to the pairing (all of `sable.` except this phone's own settings), and the
 * native side removes every private file and every copy Sable published, whatever the page recorded.
 * The generation moves on first, so work still under way for that desktop writes nothing back.
 */

/** This phone's own settings under `sable.`, kept when a desktop goes (every other `sable.` key belongs to it). */
export const DEVICE_KEYS: readonly string[] = ['sable.diffwrap', 'sable.reviewhint'];
const DEVICE_PREFIXES: readonly string[] = ['sable.debug.'];

/** The page's storage as erasing needs it (localStorage). */
export interface KeyList {
  readonly length: number;
  key(i: number): string | null;
  removeItem(k: string): void;
}

export const ownedByPairing = (k: string) => k.startsWith('sable.') && !DEVICE_KEYS.includes(k) && !DEVICE_PREFIXES.some((p) => k.startsWith(p));

/** Every key of the pairing's, read from the storage itself. */
export function pairingKeys(ls: KeyList): string[] {
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && ownedByPairing(k)) out.push(k);
  }
  return out;
}

/** Removes them, then reads again: the keys still there (none when it worked). */
export function sweep(ls: KeyList): string[] {
  for (const k of pairingKeys(ls)) {
    try {
      ls.removeItem(k);
    } catch {
      /* counted below */
    }
  }
  return pairingKeys(ls);
}

export interface EraseDeps {
  /** The page's storage (none: nothing to sweep). */
  storage: KeyList | null;
  /** Android's side (native.ts `eraseNative`): the names of the steps that failed. */
  native: () => Promise<string[]>;
}

/**
 * Erases it all: the generation moves on, the loaded modules let go of what they hold (and of writes
 * they still had due, drained before their keys go), the page's storage is swept, Android removes its
 * files, copies, notifications and shortcuts, and the storage is swept again (a hook or a late write
 * may have put something back). What failed, by name (empty when nothing of the desktop is left): a
 * module that could not let go (`forget`) counts, as does every native step, so the erasure's mark
 * stays and it goes on later.
 */
export async function eraseAll(deps: EraseDeps): Promise<string[]> {
  bumpEpoch();
  const hooks = await runForget().catch(() => 1);
  if (deps.storage) sweep(deps.storage);
  const failed = await deps.native().catch(() => ['native']);
  const left = deps.storage ? sweep(deps.storage) : [];
  return [...(hooks ? ['forget'] : []), ...failed, ...(left.length ? ['storage'] : [])];
}

/** The page's localStorage, where there is one. */
export const pageStorage = (): KeyList | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
