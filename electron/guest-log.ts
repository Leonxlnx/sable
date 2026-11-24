/**
 * What the Browser tab's pages log, batched for the app's window (pure; electron/main.ts owns the timer
 * and the sending). Every entry carries the document it belongs to from the moment it is recorded: a
 * console line the document current when it was logged, a failed request the document current when the
 * request started (remembered per request id, bounded, forgotten when the request ends). A commit flushes
 * the outgoing document's tail first, as that document's, then says the new document, in that order.
 *
 * A navigation's own request is the exception: a page that is itself a 404 or a 500 belongs to the
 * document that answer brings, the one after the document the request started on. The answer can end
 * before its page commits (a small page from a near server always does), so such an entry is stamped
 * with a document that is not there yet and held back until it is: sent earlier, the window would
 * wipe it with the reset the commit brings, and the most useful failed request of all never reached
 * the agent. A navigation that gets no answer (the address refused, no network) brings no document:
 * its failure is the current page's.
 */

export type GuestLine = { level: string; text: string; source?: string };
export type GuestNet = { url: string; method: string; status?: number; error?: string };
export type GuestEvent =
  | { type: 'console'; id: number; doc: number; lines: GuestLine[]; dropped: number }
  | ({ type: 'net'; id: number; doc: number } & GuestNet)
  | { type: 'net-dropped'; id: number; doc: number; count: number }
  | { type: 'doc'; id: number; doc: number }
  | { type: 'log-ready'; id: number; doc: number };

export type GuestLogLimits = { lines: number; net: number; requests: number };

type Bucket = { lines: GuestLine[]; dropped: number; net: GuestNet[]; netDropped: number };

export class GuestLog {
  private docs = new Map<number, number>();
  /** Per guest, per document: what has not gone out yet. */
  private pending = new Map<number, Map<number, Bucket>>();
  /** Request id to [guest, the document current when it started, a navigation's own request]; oldest out past `requests`. */
  private started = new Map<number, [number, number, boolean]>();
  /** Undefined until the first batch after the loaded renderer answered, then its fixed set of requests. */
  private loadRequests = new Map<number, number[] | undefined>();

  constructor(private limits: GuestLogLimits = { lines: 60, net: 30, requests: 2000 }) {}

  doc(id: number): number {
    return this.docs.get(id) ?? 0;
  }

  loadEnded(id: number, doc: number) {
    if (this.doc(id) === doc) this.loadRequests.set(id, undefined);
  }

  awaitingLoadBatch(id: number) {
    return this.loadRequests.has(id);
  }

  /**
   * A request of a guest starts: it belongs to the document current now. A navigation's own request
   * (`main`) belongs to the document it brings; what an earlier navigation that never committed left
   * waiting for its document is dropped, since this one's document is another.
   */
  begin(id: number, requestId: number, main = false) {
    // A redirect sends its next hop under the same request: the request keeps the document it
    // first started on (another page may have committed between two hops).
    const was = this.started.get(requestId);
    this.started.delete(requestId);
    this.started.set(requestId, was && was[0] === id ? was : [id, this.doc(id), main]);
    while (this.started.size > this.limits.requests) this.started.delete(this.started.keys().next().value as number);
    if (main) this.ahead(id, () => {});
  }

  /**
   * A request ended (whatever its outcome) and is forgotten: the document its failure belongs to.
   * A sub-resource: the document it started on. A navigation's own request that got an answer: the
   * document after the one it started on, committed yet or not. One that got no answer
   * (`answered` false), or a request whose start was not seen: the current document.
   */
  end(requestId: number, id: number, answered = true): number {
    const s = this.started.get(requestId);
    this.started.delete(requestId);
    if (!s || s[0] !== id) return this.doc(id);
    if (!s[2]) return s[1];
    return answered ? s[1] + 1 : this.doc(id);
  }

  /** Takes out what waits for a document of `id` that has not committed, handing each bucket to `each`. */
  private ahead(id: number, each: (b: Bucket) => void) {
    const g = this.pending.get(id);
    if (!g) return;
    const now = this.doc(id);
    for (const doc of [...g.keys()]) {
      if (doc <= now) continue;
      const b = g.get(doc)!;
      g.delete(doc);
      each(b);
    }
    if (!g.size) this.pending.delete(id);
  }

  /**
   * A navigation ended without a document of its own (the engine shows its error page instead, which
   * is no commit): what waited for that document is the current page's.
   */
  settle(id: number) {
    const now = this.doc(id);
    this.ahead(id, (b) => {
      for (const e of b.net) this.net(id, now, e);
      if (b.netDropped) this.bucket(id, now).netDropped += b.netDropped;
    });
  }

  private bucket(id: number, doc: number): Bucket {
    let g = this.pending.get(id);
    if (!g) this.pending.set(id, (g = new Map()));
    let b = g.get(doc);
    if (!b) g.set(doc, (b = { lines: [], dropped: 0, net: [], netDropped: 0 }));
    return b;
  }

  /** A console line, the current document's. */
  console(id: number, line: GuestLine) {
    const b = this.bucket(id, this.doc(id));
    if (b.lines.length >= this.limits.lines) b.dropped++;
    else b.lines.push(line);
  }

  /** A failed request, the document it started on (`end` gave it). */
  net(id: number, doc: number, ev: GuestNet) {
    const b = this.bucket(id, doc);
    if (b.net.length >= this.limits.net) b.netDropped++;
    else b.net.push(ev);
  }

  /** What can go out of a guest's entries: every document's up to the current one (one not committed yet waits). */
  private take(id: number, out: GuestEvent[]) {
    const g = this.pending.get(id);
    if (!g) return;
    const now = this.doc(id);
    for (const doc of [...g.keys()].sort((a, b) => a - b)) {
      if (doc > now) continue;
      const b = g.get(doc)!;
      g.delete(doc);
      if (b.lines.length || b.dropped) out.push({ type: 'console', id, doc, lines: b.lines, dropped: b.dropped });
      for (const e of b.net) out.push({ type: 'net', id, doc, ...e });
      if (b.netDropped) out.push({ type: 'net-dropped', id, doc, count: b.netDropped });
    }
    if (!g.size) this.pending.delete(id);
  }

  /** A new document committed: the outgoing one's tail first, then the new document, then what waited for it. */
  commit(id: number): GuestEvent[] {
    this.loadRequests.delete(id);
    const out: GuestEvent[] = [];
    this.take(id, out);
    const doc = this.doc(id) + 1;
    this.docs.set(id, doc);
    out.push({ type: 'doc', id, doc });
    this.take(id, out);
    return out;
  }

  /** Everything not gone out yet, per guest in document order. */
  flush(): GuestEvent[] {
    const out: GuestEvent[] = [];
    for (const id of [...this.pending.keys()]) this.take(id, out);
    // The marker travels behind the entries, including the last request's outcome, in the same IPC.
    for (const [id, captured] of this.loadRequests) {
      const doc = this.doc(id);
      const requests = captured ?? [];
      if (!captured) {
        for (const [request, [guest, startDoc, main]] of this.started) {
          if (guest === id && (main ? startDoc + 1 : startDoc) === doc) requests.push(request);
        }
        this.loadRequests.set(id, requests);
      }
      if (requests.some((r) => this.started.get(r)?.[0] === id)) continue;
      out.push({ type: 'log-ready', id, doc });
      this.loadRequests.delete(id);
    }
    return out;
  }

  /** A guest is gone. */
  forget(id: number) {
    this.loadRequests.delete(id);
    this.docs.delete(id);
    this.pending.delete(id);
    for (const [r, s] of this.started) if (s[0] === id) this.started.delete(r);
  }

  get size() {
    return this.started.size;
  }
}
