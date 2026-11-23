/**
 * Claude's Remote Control lives in the chat's agent process, so a chat with it on keeps that
 * process (a few hundred MB) alive while Sable runs. With Remote Control on by default in every
 * chat that would pile up: only the chats used most recently keep theirs, and none for long
 * after its last use. A released chat's process closes as the normal idle close would; its
 * remote status says it reconnects, and the next message starts it again (with a new link).
 */

import { authGate } from './auth-gate';

/** The numbers: how many idle Remote Control processes stay, and how long after a chat's last use. */
export const REMOTE_KEEP = { max: 6, idleMs: 45 * 60_000 };

export interface RemoteHolder {
  /** The chat (for logs). */
  id: string;
  /** When the chat was last used: a message sent, a turn begun or ended, Remote Control switched on. */
  lastActive(): number;
  /**
   * The process holds work (a turn, the agent's own running state, a background task, a wake-up due
   * soon): never released, and it counts toward the max.
   */
  busy(): boolean;
  /**
   * Close the process now (the keeper has already forgotten it). `false`: it declined, as the process
   * turned busy meanwhile; the keeper holds it again.
   */
  release(): void | boolean;
}

/**
 * Which holders to release now: idle ones beyond the `max` most recently used, or idle for longer
 * than `idleMs`. Idleness counts from the later of the last use and `wokeAt`, the last wake from
 * sleep: a laptop that slept through the evening has not been idle all that time, and work the sleep
 * suspended goes on when it wakes.
 */
export function remoteToRelease(holders: RemoteHolder[], now: number, keep = REMOTE_KEEP, wokeAt = 0): RemoteHolder[] {
  const byRecent = [...holders].sort((a, b) => b.lastActive() - a.lastActive());
  return byRecent.filter((h, i) => !h.busy() && (i >= keep.max || now - Math.max(h.lastActive(), wokeAt) > keep.idleMs));
}

const holders = new Set<RemoteHolder>();
/** Holders whose release waits for its slot after a wake (`authGate.afterWake`): a drop meanwhile cancels it. */
const releasing = new Set<RemoteHolder>();
let timer: NodeJS.Timeout | undefined;
/** The last wake from sleep the keeper knows of (0: none). */
let wokeAt = 0;

/** A wake from sleep at `at`: idleness counts from it (`idleSince`). */
export function noteWake(at = Date.now()) {
  wokeAt = Math.max(wokeAt, at);
}

/**
 * Where idleness counts from for a process last used at `lastActive`: that, or the last wake from
 * sleep when it is later (for the idle close of an agent process as for the keeper).
 */
export function idleSince(lastActive: number, now = Date.now()): number {
  if (authGate.waking(now)) noteWake(now);
  return Math.max(lastActive, wokeAt);
}

/** A chat's Remote Control process is running (again); the keeper may now close it when it is not needed. */
export function holdRemote(h: RemoteHolder) {
  releasing.delete(h);
  holders.add(h);
  enforceRemote();
}

/** The process closed for another reason (or Remote Control was switched off). */
export function dropRemote(h: RemoteHolder) {
  releasing.delete(h);
  if (holders.delete(h)) schedule();
}

/** Releases what is over the limits now, and wakes again when the next idle chat reaches `idleMs`. */
export function enforceRemote(now = Date.now(), keep = REMOTE_KEEP) {
  // A wake another timer saw (the auth gate's) counts as one here too.
  if (authGate.waking(now)) noteWake(now);
  for (const h of remoteToRelease([...holders], now, keep, wokeAt)) {
    holders.delete(h);
    releasing.add(h);
    // After a sleep every idle one is due at once, while each renews its sign-in: spread out (auth-gate.ts).
    authGate.afterWake(() => {
      if (!releasing.delete(h)) return;
      // Work began while the release waited for its slot (a turn, a task): the process stays and the
      // keeper keeps counting it, so it is let go once idle again and holds its place toward the max.
      let declined = h.busy();
      if (!declined) {
        try {
          declined = h.release() === false;
        } catch {
          /* already gone */
        }
      }
      if (declined && !holders.has(h)) {
        holders.add(h);
        schedule();
      }
    });
  }
  schedule(now, keep);
}

function schedule(now = Date.now(), keep = REMOTE_KEEP) {
  clearTimeout(timer);
  timer = undefined;
  let next = Infinity;
  for (const h of holders) if (!h.busy()) next = Math.min(next, Math.max(h.lastActive(), wokeAt) + keep.idleMs);
  // Busy chats are looked at again later (their turn ends through scheduleIdleClose, which holds again).
  if (!Number.isFinite(next) && holders.size) next = now + keep.idleMs;
  if (!Number.isFinite(next)) return;
  const wait = Math.max(1000, next - now + 50);
  timer = setTimeout(() => {
    // A timer that fired far too late slept with the laptop: the time asleep was no idleness.
    const t = Date.now();
    if (authGate.noteTimer(now + wait, t)) noteWake(t);
    enforceRemote(t, keep);
  }, wait);
  timer.unref?.();
}

/** For tests: forget every holder, the timer and the last wake. */
export function resetRemoteKeeper() {
  holders.clear();
  releasing.clear();
  clearTimeout(timer);
  timer = undefined;
  wokeAt = 0;
}
