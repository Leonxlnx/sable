import { isTransport } from './errors';
import { epoch, still } from './epoch';

/** The bridge keeps the reserved revision until the phone commits its text and token.
 * Attachment-bearing revisions stay on the desktop. A lost acknowledgement is retried
 * with that token, including after restart. */
export interface TakeDeps {
  /** `queue.take` with `ack`. */
  take(sid: string, id: string): Promise<{ message?: { text?: string; attachments?: readonly unknown[] }; take?: string }>;
  /** `phone.takeDone`. */
  done(take: string, kept: boolean): Promise<{ taken: boolean }>;
  /** Commit the reservation separately from the editable draft. */
  stage(sid: string, text: string, take: string, row: string): Promise<number | void>;
  /** Finish the draft handoff, reconciling a negative confirmation with the queue. */
  settle(take: string, taken: boolean): void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export const KEEP_FAILED_TAKE = 'This phone could not keep the words, so the message stays queued.';
export const STILL_QUEUED = 'The desktop could not confirm the take. Check the queue before sending again.';

/** A lost/expired confirmation can mean the bridge restarted after taking the row.
 * Release our copy only if the same complete message can still be found in its queue. */
export async function stillQueued(row: string, text: string, page: (from: number) => Promise<{
  queue: { id: string; text: string; attachments?: readonly unknown[] }[]; total: number;
}>) {
  const e = epoch();
  for (let from = 0; still(e);) {
    const { queue, total } = await page(from);
    const q = queue.find(q => q.id === row);
    if (q) return q.text === text && !q.attachments?.length;
    from += queue.length;
    if (!queue.length || from >= total) return false;
  }
  throw new Error('Forgotten');
}

/** How the confirmation is tried again while the connection is cut (then again once connected). */
export const TAKE_RETRY = [800, 2500];

/**
 * Confirms a take the phone kept: true (out of the queue), false (it stayed queued there: changed, or
 * already sent), undefined (not answered: tried again later, `pendingTakes`).
 */
export async function confirmTake(deps: TakeDeps, take: string): Promise<boolean | undefined> {
  const e = epoch();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    if (!still(e)) return;
    let taken: boolean;
    try {
      const r = await deps.done(take, true);
      taken = r?.taken === true;
    } catch (err) {
      // The desktop said no (an older one without receipts, a receipt it does not know): nothing to wait for.
      if (!isTransport(err)) throw err;
      if (i >= TAKE_RETRY.length) return undefined;
      await sleep(TAKE_RETRY[i]);
      continue;
    }
    if (!still(e)) return;
    await deps.settle(take, taken);
    return taken;
  }
}

/**
 * Takes message `id` of chat `sid` back. Resolves with its words once they are kept on the phone
 * (`stillQueued`: the desktop kept it queued too), or with nothing when it was gone already. Throws
 * when the words could not be kept (the message stays queued).
 */
export async function takeBack(deps: TakeDeps, sid: string, id: string): Promise<{ text?: string; stillQueued?: boolean }> {
  const e = epoch();
  const r = await deps.take(sid, id);
  if (!still(e)) return {};
  const text = r?.message?.text;
  const take = typeof r?.take === 'string' ? r.take : undefined;
  if (!take) {
    if (!r?.message) return {};
    throw new Error('The desktop did not reserve this message. Update Sable on the desktop.');
  }
  if (r?.message?.attachments?.length) {
    await deps.done(take, false).catch(() => {});
    throw new Error('This message has attachments. Take it back on the desktop.');
  }
  if (!text) {
    await deps.done(take, false).catch(() => {});
    return {};
  }
  try {
    await deps.stage(sid, text, take, id);
  } catch {
    if (still(e)) await deps.done(take, false).catch(() => {});
    throw new Error(KEEP_FAILED_TAKE);
  }
  if (!still(e)) return {};
  const out = await confirmTake(deps, take);
  return { text, stillQueued: out === false };
}
