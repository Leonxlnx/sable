import { createHash } from 'node:crypto';

/**
 * Sends by submission id (`session.send`'s `submitId`, review wave 10, finding 1): a window whose
 * connection died after its message went out cannot know whether the bridge took it, so it puts
 * the message back and a retry carries the same id. A send with an id taken in the last minutes
 * is answered as that send was, without running again; one still running is answered when it ends.
 * A refusal (an error, or `ok: false`) is forgotten, so its retry runs. Bounded in time and count.
 */
export class Submissions<R extends { ok: boolean }> {
  private seen = new Map<string, { at: number; done: Promise<R> }>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly max = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs `send` once per `sessionId` + `id` (no id, or one that is not a short string: always).
   * `print`: what the message is (its words and files); an id that comes again with another
   * message is not a retry and is sent. Each message under an id is remembered by itself, so one
   * still on its way is never pushed out by another (review wave 12, #6).
   */
  run(sessionId: string, id: unknown, send: () => Promise<R>, print = ''): Promise<R> {
    if (typeof id !== 'string' || !id || id.length > 128) return send();
    const t = this.now();
    for (const [k, v] of this.seen) {
      if (t - v.at <= this.ttlMs && this.seen.size <= this.max) break;
      this.seen.delete(k);
    }
    const key = `${sessionId}\u0000${id}\u0000${print}`;
    const had = this.seen.get(key);
    if (had) return had.done;
    const forget = () => {
      if (this.seen.get(key)?.done === done) this.seen.delete(key);
    };
    const done: Promise<R> = send().then(
      (r) => {
        if (!r.ok) forget();
        return r;
      },
      (err) => {
        forget();
        throw err;
      },
    );
    this.seen.set(key, { at: t, done });
    return done;
  }
}

/**
 * What a message is, for telling a retry from another message under the same id: its words and its
 * files. Not whether it steers: a steer whose answer was lost is retried after the turn ended as a
 * plain send, and is still the same message (review wave 12, #4).
 */
export function messagePrint(text: unknown, attachments: unknown): string {
  const files = Array.isArray(attachments) ? attachments.map((a) => (a && typeof a === 'object' ? [(a as { id?: unknown }).id, (a as { name?: unknown }).name, (a as { path?: unknown }).path] : a)) : [];
  return createHash('sha256').update(JSON.stringify([typeof text === 'string' ? text : null, files])).digest('hex');
}
