import { conn } from './conn';

/**
 * Pictures of a step (a screenshot), asked of the desktop one at a time (`phone.image`) and kept
 * for this run: the last few only (each can be a megabyte or two).
 */
const KEEP = 16;
const kept = new Map<string, string>();
const asking = new Map<string, Promise<string>>();

export const picKey = (sid: string, itemId: string, index: number) => `${sid}\u0000${itemId}\u0000${index}`;

export function keptPic(sid: string, itemId: string, index: number): string | undefined {
  return kept.get(picKey(sid, itemId, index));
}

export function loadPic(sid: string, itemId: string, index: number): Promise<string> {
  const key = picKey(sid, itemId, index);
  const have = kept.get(key);
  if (have) return Promise.resolve(have);
  let p = asking.get(key);
  if (!p) {
    p = conn
      .call('phone.image', { sessionId: sid, itemId, index }, 45_000)
      .then((r) => {
        kept.delete(key);
        kept.set(key, r.data);
        while (kept.size > KEEP) kept.delete(kept.keys().next().value as string);
        return r.data;
      })
      .finally(() => asking.delete(key));
    asking.set(key, p);
  }
  return p;
}
