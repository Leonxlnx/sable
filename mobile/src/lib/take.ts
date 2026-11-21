import { isTransport } from './errors';

/**
 * Taking a queued message back into the composer (`queue.take`) without ever losing it: the desktop
 * keeps the message reserved and hands a receipt (`ack: true` → `take`); the phone first puts the
 * words into the chat's one draft (its field shows them at once) and commits that draft revision to
 * its own storage (a copy that survives Android closing the app and follows the draft until it is
 * sent or emptied: lib/drafts.ts), and only then says so (`phone.takeDone`), which is when the
 * message leaves the queue. Its answer changes nothing on the phone (the words are already where
 * they stay), so a chat left meanwhile loses nothing. Words the phone could not keep are said back (`kept: false`) and the message stays
 * queued. A confirmation that does not get through is sent again (the receipt is idempotent), now a
 * few times and later once the phone is connected again; a desktop from before receipts takes the
 * message as its reply goes out, as it did. Pure over what it is given (tests).
 */
export interface TakeDeps {
  /** `queue.take` with `ack`. */
  take(sid: string, id: string): Promise<{ message?: { text?: string }; take?: string }>;
  /** `phone.takeDone`. */
  done(take: string, kept: boolean): Promise<{ taken: boolean }>;
  /** Keeps the words: in the chat's draft at once, and that draft revision committed (resolves with it); throws when it could not. */
  stage(sid: string, text: string, take?: string): Promise<number | void>;
  /** The receipt was answered: its copy kept for it can go. */
  settle(take: string): void;
  sleep?: (ms: number) => Promise<void>;
}

export const KEEP_FAILED_TAKE = 'This phone could not keep the words, so the message stays queued.';
export const STILL_QUEUED = 'The message also stays queued on the desktop.';

/** How the confirmation is tried again while the connection is cut (then again once connected). */
export const TAKE_RETRY = [800, 2500];

/**
 * Confirms a take the phone kept: true (out of the queue), false (it stayed queued there: changed, or
 * already sent), undefined (not answered: tried again later, `pendingTakes`).
 */
export async function confirmTake(deps: TakeDeps, take: string): Promise<boolean | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      const r = await deps.done(take, true);
      deps.settle(take);
      return !!r?.taken;
    } catch (err) {
      // The desktop said no (an older one without receipts, a receipt it does not know): nothing to wait for.
      if (!isTransport(err)) {
        deps.settle(take);
        return false;
      }
      if (i >= TAKE_RETRY.length) return undefined;
      await sleep(TAKE_RETRY[i]);
    }
  }
}

/**
 * Takes message `id` of chat `sid` back. Resolves with its words once they are kept on the phone
 * (`stillQueued`: the desktop kept it queued too), or with nothing when it was gone already. Throws
 * when the words could not be kept (the message stays queued).
 */
export async function takeBack(deps: TakeDeps, sid: string, id: string): Promise<{ text?: string; stillQueued?: boolean }> {
  const r = await deps.take(sid, id);
  const text = r?.message?.text;
  const take = typeof r?.take === 'string' ? r.take : undefined;
  if (!text) {
    if (take) void deps.done(take, false).catch(() => {});
    return {};
  }
  try {
    await deps.stage(sid, text, take);
  } catch {
    if (take) void deps.done(take, false).catch(() => {});
    throw new Error(KEEP_FAILED_TAKE);
  }
  if (!take) return { text };
  const out = await confirmTake(deps, take);
  return { text, stillQueued: out === false };
}
