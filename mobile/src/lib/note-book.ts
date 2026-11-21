/**
 * Which chats have a notification up, kept across restarts (Android closes the app in the
 * background), so the group's summary can say "2 chats". A person swipes notifications away without
 * the app hearing of it, so before each new one the list is reconciled with what Android still shows
 * (`reconcile`), and a chat is written down only once its notification was posted (`add` after the
 * schedule went through). Pure: storage and the notification ids are given.
 */
export interface NoteStore {
  get(): string | null;
  set(v: string): void;
}

export class NoteBook {
  private chats: string[];

  constructor(
    private store: NoteStore,
    private idFor: (sessionId: string) => number,
    private max = 50,
  ) {
    this.chats = (() => {
      try {
        const v = JSON.parse(store.get() ?? '[]') as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-max) : [];
      } catch {
        return [];
      }
    })();
  }

  private save() {
    try {
      this.store.set(JSON.stringify(this.chats));
    } catch {
      /* full */
    }
  }

  /** The chats with a notification up, oldest first. */
  list(): readonly string[] {
    return this.chats;
  }

  get size() {
    return this.chats.length;
  }

  /** Android shows these notification ids now: a chat whose notification is not among them was swiped away (or cleared). */
  reconcile(delivered: readonly number[]) {
    const up = new Set(delivered);
    const kept = this.chats.filter((id) => up.has(this.idFor(id)));
    if (kept.length === this.chats.length) return;
    this.chats = kept;
    this.save();
  }

  /** How many chats the summary names once `sessionId`'s goes up too. */
  countWith(sessionId: string): number {
    return this.chats.includes(sessionId) ? this.chats.length : this.chats.length + 1;
  }

  /** `sessionId`'s notification was posted: newest last. */
  add(sessionId: string) {
    this.chats = [...this.chats.filter((x) => x !== sessionId), sessionId].slice(-this.max);
    this.save();
  }

  /** Its notification went (the chat was opened): true when it was written down. */
  remove(sessionId: string): boolean {
    if (!this.chats.includes(sessionId)) return false;
    this.chats = this.chats.filter((x) => x !== sessionId);
    this.save();
    return true;
  }

  /** None (the desktop was forgotten). */
  clear() {
    this.chats = [];
    this.save();
  }
}
