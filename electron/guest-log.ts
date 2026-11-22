/**
 * What the Browser tab's pages log, batched for the app's window (pure; electron/main.ts owns the timer
 * and the sending). Every entry carries the document it belongs to from the moment it is recorded: a
 * console line the document current when it was logged, a failed request the document current when the
 * request started (remembered per request id, bounded, forgotten when the request ends). A commit flushes
 * the outgoing document's tail first, as that document's, then says the new document, in that order.
 */

export type GuestLine = { level: string; text: string; source?: string };
export type GuestNet = { url: string; method: string; status?: number; error?: string };
export type GuestEvent =
  | { type: 'console'; id: number; doc: number; lines: GuestLine[]; dropped: number }
  | ({ type: 'net'; id: number; doc: number } & GuestNet)
  | { type: 'net-dropped'; id: number; doc: number; count: number }
  | { type: 'doc'; id: number; doc: number };

export type GuestLogLimits = { lines: number; net: number; requests: number };

type Bucket = { lines: GuestLine[]; dropped: number; net: GuestNet[]; netDropped: number };

export class GuestLog {
  private docs = new Map<number, number>();
  /** Per guest, per document: what has not gone out yet. */
  private pending = new Map<number, Map<number, Bucket>>();
  /** Request id to [guest, the document current when it started]; oldest out past `requests`. */
  private started = new Map<number, [number, number]>();

  constructor(private limits: GuestLogLimits = { lines: 60, net: 30, requests: 2000 }) {}

  doc(id: number): number {
    return this.docs.get(id) ?? 0;
  }

  /** A request of a guest starts: it belongs to the document current now. */
  begin(id: number, requestId: number) {
    this.started.delete(requestId);
    this.started.set(requestId, [id, this.doc(id)]);
    while (this.started.size > this.limits.requests) this.started.delete(this.started.keys().next().value as number);
  }

  /** A request ended (whatever its outcome): its document, if its start was seen, and it is forgotten. */
  end(requestId: number, id: number): number {
    const s = this.started.get(requestId);
    this.started.delete(requestId);
    return s && s[0] === id ? s[1] : this.doc(id);
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

  private take(id: number, out: GuestEvent[]) {
    const g = this.pending.get(id);
    if (!g) return;
    this.pending.delete(id);
    for (const doc of [...g.keys()].sort((a, b) => a - b)) {
      const b = g.get(doc)!;
      if (b.lines.length || b.dropped) out.push({ type: 'console', id, doc, lines: b.lines, dropped: b.dropped });
      for (const e of b.net) out.push({ type: 'net', id, doc, ...e });
      if (b.netDropped) out.push({ type: 'net-dropped', id, doc, count: b.netDropped });
    }
  }

  /** A new document committed: the outgoing one's tail first, then the new document. */
  commit(id: number): GuestEvent[] {
    const out: GuestEvent[] = [];
    this.take(id, out);
    const doc = this.doc(id) + 1;
    this.docs.set(id, doc);
    out.push({ type: 'doc', id, doc });
    return out;
  }

  /** Everything not gone out yet, per guest in document order. */
  flush(): GuestEvent[] {
    const out: GuestEvent[] = [];
    for (const id of [...this.pending.keys()]) this.take(id, out);
    return out;
  }

  /** A guest is gone. */
  forget(id: number) {
    this.docs.delete(id);
    this.pending.delete(id);
    for (const [r, s] of this.started) if (s[0] === id) this.started.delete(r);
  }

  get size() {
    return this.started.size;
  }
}
