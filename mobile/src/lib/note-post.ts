import type { NoteBook } from './note-book';

/**
 * Posting the chats' notifications, one at a time. Each post reconciles the chats written down with
 * what Android still shows, counts them for the group's summary, posts, and writes its chat down:
 * two posts at once would both count against the same list (two chats finishing together would each
 * count one, and neither would carry the summary of two). So every post, and a chat's notification
 * taken away, runs on one chain, each after the last.
 *
 * Forgetting the desktop moves the generation on: a post waiting on the chain is dropped, and one
 * under way checks after each await and stops; one that already went up is taken away again, and
 * nothing of it is written down. Pure (the plugin is given), so it can be tested; lib/native.ts wires
 * Android's.
 */

/** One chat's notification as it is posted. */
export interface ChatNote {
  id: number;
  sessionId: string;
  title: string;
  /** The newest line. */
  body: string;
  kind: string;
  /** This time away's lines, newest first (more than one: listed under it when expanded). */
  lines: string[];
}

/** What the poster needs of the notifications plugin. */
export interface NoteApi {
  /** Posting is allowed (never asks: it may be in the background). */
  allowed(): Promise<boolean>;
  /** Before the first post (the channel). */
  prepare(): Promise<void>;
  /** The ids Android shows now, or null when it cannot say. */
  delivered(): Promise<number[] | null>;
  cancel(ids: number[]): Promise<void>;
  /** Puts up a chat's notification and, when `chats` is two or more, the group's summary naming them. */
  post(note: ChatNote, chats: number): Promise<void>;
  /** Every notification goes, shown or pending. */
  clearAll(): Promise<void>;
}

/** The group's summary ("Sable · 2 chats"). */
export const SUMMARY_ID = 1;

export class NotePoster {
  /** Each chat's lines since the app was last on screen, newest first. */
  private lines = new Map<string, { title: string; lines: string[] }>();
  private chain: Promise<unknown> = Promise.resolve();
  private gen = 0;

  constructor(
    private api: NoteApi,
    private book: NoteBook,
    private idFor: (sessionId: string) => number,
  ) {}

  /** Runs `task` after everything before it, unless the desktop was forgotten since it was asked for. */
  private run(task: (live: () => boolean) => Promise<void>): Promise<void> {
    const gen = this.gen;
    const live = () => gen === this.gen;
    const next = this.chain.then(() => (live() ? task(live) : undefined)).catch(() => {});
    this.chain = next;
    return next;
  }

  /** A chat's news: its notification, with the summary when two chats or more have one up. */
  notify(title: string, body: string, sessionId: string, kind: string): Promise<void> {
    return this.run(async (live) => {
      if (!(await this.api.allowed()) || !live()) return;
      await this.api.prepare();
      if (!live()) return;
      const line = body.slice(0, 180);
      const cur = this.lines.get(sessionId) ?? { title, lines: [] };
      cur.title = title;
      cur.lines = [line, ...cur.lines.filter((l) => l !== line)].slice(0, 5);
      this.lines.set(sessionId, cur);
      // What is still up: a notification swiped away no longer counts in the summary.
      const delivered = await this.api.delivered().catch(() => null);
      if (!live()) return;
      if (delivered) this.book.reconcile(delivered);
      const count = this.book.countWith(sessionId);
      // A summary left from chats that were swiped away goes first (with it its group: this chat's own is posted again below).
      if (count < 2 && delivered?.includes(SUMMARY_ID)) {
        await this.api.cancel([SUMMARY_ID]).catch(() => {});
        if (!live()) return;
      }
      const id = this.idFor(sessionId);
      await this.api.post({ id, sessionId, title, body: line, kind, lines: cur.lines.slice() }, count);
      if (!live()) {
        // Forgotten while it went up: it goes again, and is not written down.
        await this.api.cancel(count > 1 ? [id, SUMMARY_ID] : [id]).catch(() => {});
        return;
      }
      // Written down once it is up (a post that failed leaves nothing behind).
      this.book.add(sessionId);
    });
  }

  /** A chat opened on the phone: its notification goes (after any post still going up), the summary only with the last chat's. */
  clearOne(sessionId: string): Promise<void> {
    return this.run(async () => {
      this.lines.delete(sessionId);
      const had = this.book.remove(sessionId);
      await this.api.cancel([this.idFor(sessionId), ...(had && this.book.size === 0 ? [SUMMARY_ID] : [])]).catch(() => {});
    });
  }

  /** Back on screen: the lines of the time away start over (the notifications stay until opened or swiped). */
  forgetLines(): Promise<void> {
    return this.run(async () => void this.lines.clear());
  }

  /**
   * The desktop was forgotten: at once, every post waiting or under way is let go, what was kept goes,
   * and every notification is taken away; what is asked after this waits until that is done. Rejects
   * when Android could not take them away (an erasure then says something is left: lib/erase.ts).
   */
  clear(): Promise<void> {
    this.gen++;
    this.lines.clear();
    this.book.clear();
    const cleared = this.api.clearAll();
    this.chain = Promise.all([this.chain, cleared.catch(() => {})]);
    return cleared;
  }
}
