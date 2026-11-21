/**
 * Claude's Remote Control lives in the chat's agent process, so a chat with it on keeps that
 * process (a few hundred MB) alive while Sable runs. With Remote Control on by default in every
 * chat that would pile up: only the chats used most recently keep theirs, and none for long
 * after its last use. A released chat's process closes as the normal idle close would; its
 * remote status says it reconnects, and the next message starts it again (with a new link).
 */

/** The numbers: how many idle Remote Control processes stay, and how long after a chat's last use. */
export const REMOTE_KEEP = { max: 2, idleMs: 15 * 60_000 };

export interface RemoteHolder {
  /** The chat (for logs). */
  id: string;
  /** When the chat was last used: a message sent, a turn ended, Remote Control switched on. */
  lastActive(): number;
  /** A turn or a background task runs in the process: never released, and it counts toward the max. */
  busy(): boolean;
  /** Close the process now (the keeper has already forgotten it). */
  release(): void;
}

/** Which holders to release now: idle ones beyond the `max` most recently used, or idle for longer than `idleMs`. */
export function remoteToRelease(holders: RemoteHolder[], now: number, keep = REMOTE_KEEP): RemoteHolder[] {
  const byRecent = [...holders].sort((a, b) => b.lastActive() - a.lastActive());
  return byRecent.filter((h, i) => !h.busy() && (i >= keep.max || now - h.lastActive() > keep.idleMs));
}

const holders = new Set<RemoteHolder>();
let timer: NodeJS.Timeout | undefined;

/** A chat's Remote Control process is running (again); the keeper may now close it when it is not needed. */
export function holdRemote(h: RemoteHolder) {
  holders.add(h);
  enforceRemote();
}

/** The process closed for another reason (or Remote Control was switched off). */
export function dropRemote(h: RemoteHolder) {
  if (holders.delete(h)) schedule();
}

/** Releases what is over the limits now, and wakes again when the next idle chat reaches `idleMs`. */
export function enforceRemote(now = Date.now(), keep = REMOTE_KEEP) {
  for (const h of remoteToRelease([...holders], now, keep)) {
    holders.delete(h);
    try {
      h.release();
    } catch {
      /* already gone */
    }
  }
  schedule(now, keep);
}

function schedule(now = Date.now(), keep = REMOTE_KEEP) {
  clearTimeout(timer);
  timer = undefined;
  let next = Infinity;
  for (const h of holders) if (!h.busy()) next = Math.min(next, h.lastActive() + keep.idleMs);
  // Busy chats are looked at again later (their turn ends through scheduleIdleClose, which holds again).
  if (!Number.isFinite(next) && holders.size) next = now + keep.idleMs;
  if (!Number.isFinite(next)) return;
  timer = setTimeout(() => enforceRemote(Date.now(), keep), Math.max(1000, next - now + 50));
  timer.unref?.();
}

/** For tests: forget every holder and the timer. */
export function resetRemoteKeeper() {
  holders.clear();
  clearTimeout(timer);
  timer = undefined;
}
