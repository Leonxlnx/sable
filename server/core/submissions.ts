import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Phone retries may arrive after a take, rewind or discard. Keep just their keys for the life of the chat. */
export class PhoneReceipts {
  private db?: DatabaseSync;
  private readonly file: string;

  constructor(dir: string) { this.file = path.join(dir, 'phone-submissions.sqlite'); }

  private open() {
    if (!this.db) {
      const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
      const db = new sqlite.DatabaseSync(this.file);
      try {
        db.exec('CREATE TABLE IF NOT EXISTS receipts (chat TEXT, submission TEXT, PRIMARY KEY (chat, submission)) WITHOUT ROWID');
        this.db = db;
      } catch (error) { db.close(); throw error; }
    }
    return this.db;
  }

  has(chat: string, submission: string) {
    return !!this.open().prepare('SELECT 1 FROM receipts WHERE chat = ? AND submission = ?').get(chat, submission);
  }

  record(chat: string, submission: string) {
    this.open().prepare('INSERT OR IGNORE INTO receipts VALUES (?, ?)').run(chat, submission);
  }

  remove(chat: string) {
    if (this.db || existsSync(this.file)) this.open().prepare('DELETE FROM receipts WHERE chat = ?').run(chat);
  }

  close() { this.db?.close(); this.db = undefined; }
}


/**
 * Sends by submission id (`session.send`'s `submitId`, review wave 10, finding 1): a window whose
 * connection died after its message went out cannot know whether the bridge took it, so it puts
 * the message back and a retry carries the same id. A send with an id taken in the last minutes
 * is answered as that send was, without running again; one still running is answered when it ends.
 * A refusal (an error, or `ok: false`) is forgotten, so its retry runs. Bounded in time and count.
 */
export class Submissions<R extends { ok: boolean }> {
  private active = new Map<string, Promise<R>>();
  private seen = new Map<string, { at: number; result: R }>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly max = 500,
    private readonly now: () => number = Date.now,
  ) {}

  pending(sessionId: string, id: string, print = '') {
    return this.active.get(`${sessionId}\u0000${id}\u0000${print}`);
  }

  /**
   * Runs `send` once per `sessionId` + `id` (no id, or one that is not a short string: always).
   * `print`: what the message is (its words and files); an id that comes again with another
   * message is not a retry and is sent. Each message under an id is remembered by itself, so one
   * still on its way is never pushed out by another (review wave 12, #6).
   */
  run(sessionId: string, id: unknown, send: () => Promise<R>, print = ''): Promise<R> {
    if (typeof id !== 'string' || !id || id.length > 128) return send();
    const key = `${sessionId}\u0000${id}\u0000${print}`;
    const active = this.active.get(key);
    if (active) return active;
    const had = this.seen.get(key);
    if (had && this.now() - had.at <= this.ttlMs) return Promise.resolve(had.result);
    const done = send().then(result => {
      if (result.ok && this.max > 0) {
        const at = this.now();
        this.seen.delete(key);
        for (const [k, v] of this.seen) {
          if (at - v.at <= this.ttlMs && this.seen.size < this.max) break;
          this.seen.delete(k);
        }
        this.seen.set(key, { at, result });
      }
      return result;
    }).finally(() => this.active.delete(key));
    this.active.set(key, done);
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
