import { sessionTail } from '../core/session-json';
import { randomBytes } from 'node:crypto';
import { open as openFile, readFile as readFileAsync, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessageHit, MessageSearch, TimelineItem } from '../../shared/protocol';
import { stripWrappers, syntheticOf } from '../../shared/synthetic';
import type { App } from '../app';

/**
 * Search across chats: the desktop's palette (`search.messages`) and the phone (`phone.search`) ask
 * the same searcher, one per app.
 *
 * Messages only: what the person wrote and what the agents said (root items), never steps, outputs or
 * files. A chat open on the desktop is read from memory; another is read from its files on disk
 * (`session-file.ts`: the tail first, then the base) in pieces of a megabyte, decoding only messages:
 * a short line is parsed when it may hold one, a long one is streamed by `FieldScan`, which keeps the
 * few fields search needs (a message's words, never its pictures) and skips the rest unread. What a
 * chat says is kept (keyed by the files' size and time) so the next search does not read it again.
 *
 * Each call is bounded in bytes read and time, checked between pieces and between slices of a chat's
 * messages, also for a chat in memory. Where it stopped is a cursor (`Run`: the chat, the item, the
 * file offset and the reader's state), so the next call goes on from there whatever was kept; the
 * answer names it (`cursor`), and the same caller asking the same again soon after goes on too (the
 * phone asks again without one). Hits add up across the calls of one search. A part of a chat that
 * could not be read (a damaged file) is counted in `skipped`, never answered as if it were empty.
 */

export const SEARCH = {
  min: 2,
  max: 120,
  hits: 40,
  perChat: 5,
  text: 20_000,
  snippet: 150,
  bytes: 48 * 1024 * 1024,
  ms: 900,
  /** A line longer than this is streamed (`FieldScan`), not parsed whole; a message's words are read up to this. */
  line: 1024 * 1024,
  /** What is kept of the chats read from disk, in all (characters), and of one chat. */
  keep: 24_000_000,
  chatKeep: 4_000_000,
  /** A file is read in pieces of this; a tail up to `tailWhole` is read and parsed at once. */
  chunk: 1024 * 1024,
  tailWhole: 4 * 1024 * 1024,
  /** Messages of a chat matched between two looks at the clock. */
  slice: 512,
  /** Searches with a cursor, at most; one asked again without its cursor within `again` goes on; any is dropped `life` after its last call. */
  runs: 16,
  again: 30_000,
  life: 120_000,
};

/** A message as search reads it. */
export interface Said {
  id: string;
  role: 'user' | 'agent';
  /** Its words, cut to `SEARCH.text`. */
  text: string;
  ts: number;
}

/** The messages of a timeline that search reads: the person's own (not what the agent's harness wrote) and the agent's texts. */
export function saidOf(items: Iterable<TimelineItem>): Said[] {
  const out: Said[] = [];
  for (const it of items) {
    const s = sayOf(it);
    if (s) out.push(s);
  }
  return out;
}

function sayOf(it: TimelineItem): Said | null {
  if (it.parentId) return null;
  if (it.type === 'user') {
    if (it.until?.check || syntheticOf(it)) return null;
    const text = stripWrappers(it.text).trim();
    return text ? { id: it.id, role: 'user', text: text.slice(0, SEARCH.text), ts: it.ts } : null;
  }
  if (it.type === 'text') {
    const text = it.text.trim();
    return text ? { id: it.id, role: 'agent', text: text.slice(0, SEARCH.text), ts: it.ts } : null;
  }
  return null;
}

/** Markdown read as words: links and pictures by their text, no code ticks, emphasis or heading marks. */
const plainOf = (md: string) =>
  md
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,:;!?]|$)/gm, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '');

/** The query as search reads it: lower case, cut to `SEARCH.max`, its distinct words. */
export function queryWords(query: unknown): { q: string; words: string[] } {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
    .slice(0, SEARCH.max);
  return { q, words: [...new Set(q.split(/\s+/).filter(Boolean))] };
}

/** Whether a message has every word of the query (case-insensitive, anywhere in it). */
export const matches = (text: string, words: string[]) => {
  const low = text.toLowerCase();
  return words.every((w) => low.includes(w));
};

/** The words around the first match: a line or two, cut at word boundaries. */
export function snippetOf(text: string, words: string[]): string {
  const flat = plainOf(text).replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = Infinity;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && i < at) at = i;
  }
  if (!Number.isFinite(at) || flat.length <= SEARCH.snippet) return flat.slice(0, SEARCH.snippet);
  let from = Math.max(0, at - 48);
  if (from > 0) {
    const sp = flat.indexOf(' ', from);
    if (sp >= 0 && sp < at) from = sp + 1;
  }
  let to = Math.min(flat.length, from + SEARCH.snippet);
  if (to < flat.length) {
    const sp = flat.lastIndexOf(' ', to);
    if (sp > at) to = sp;
  }
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

// ───────────────────────────── reading JSON as it streams ─────────────────────────────

/** An item's field as it stood in the file: a string's body without its quotes, or any other value's JSON. */
type Field = { kind: 'str' | 'raw'; raw: string; over: boolean };
type Fields = Partial<Record<string, Field>>;

/** How much of an item's field is kept (bytes; 0: skipped unread). */
const ITEM_WANT = new Map<string, number>([
  ['id', 512],
  ['type', 64],
  ['ts', 64],
  ['parentId', 512],
  ['until', 4096],
]);
const itemWant = (k: string) => (k === 'text' ? SEARCH.line : (ITEM_WANT.get(k) ?? 0));
/** The fields kept of a file's root (a tail's `baseGen` and `from`). */
const ROOT_WANT = new Set(['baseGen', 'from', 'gen']);

const Q = 0x22;
const BS = 0x5c;

/** What comes next in an object whose fields are read: a key, its colon, its value, or a comma or the end. */
const enum Next {
  Key,
  Colon,
  Value,
  After,
}

interface Capture {
  name: string;
  parts: Buffer[];
  len: number;
  max: number;
  /** A string's body, or another value's JSON (`prim`: a number, true, false or null, which ends at a comma, a bracket or a space). */
  kind: 'str' | 'raw';
  prim: boolean;
  /** The depth the value sits at (an object or list value closes back to it). */
  depth: number;
  over: boolean;
  root: boolean;
}

/**
 * Reads JSON piece by piece and hands over the items in it with only the fields search needs, never
 * holding the rest (a picture's data, a step's output): a string it does not keep is skipped with
 * native searches for the next quote. `doc`: the input is a file's whole JSON whose root has an
 * `items` list (a tail, or a base of an older version); otherwise it is one item (a base's line).
 */
export class FieldScan {
  private depth = 0;
  private str = false;
  /** The piece ended on a backslash inside a string: the next byte is escaped. */
  private esc = false;
  private next: Next[] = [];
  private keyOf: string[] = [];
  private key: { parts: Buffer[]; len: number; depth: number } | null = null;
  private cap: Capture | null = null;
  /** Where the key or capture in progress starts in the current piece. */
  private from = 0;
  private item: Fields | null = null;
  private list?: 'items' | 'over';
  /** The next quote and backslash in the current piece (Infinity: none). */
  private nq = -1;
  private nb = -1;
  /** The root's fields (`baseGen`, `from`) as JSON. */
  readonly root: Record<string, string> = {};
  /** Items handed over. */
  count = 0;
  /** The input was not the JSON expected. */
  broken = false;
  /** The root closed (a doc), or the item closed (a line). */
  closed = false;
  /** A doc's root had an `items` list. */
  hasItems = false;

  constructor(
    private readonly doc: boolean,
    private readonly onItem: (fields: Fields, index: number) => void,
    private readonly onOverride?: (fields: Fields) => void,
  ) {}

  /** Whether the object at depth `d` is one whose fields are read: a doc's root, an item. */
  private watched(d: number) {
    return (this.doc && d === 1) || (this.item !== null && d === (this.doc ? 3 : 1));
  }

  /** How much of the value of the key at depth `d` is kept. */
  private wanted(d: number): number {
    const k = this.keyOf[d] ?? '';
    return this.doc && d === 1 ? (ROOT_WANT.has(k) ? 64 : 0) : itemWant(k);
  }

  private take(b: Buffer, s: number, e: number) {
    const t = this.key ?? this.cap;
    if (!t || e <= s) return;
    const max = this.key ? 128 : (this.cap as Capture).max;
    const n = Math.max(0, Math.min(max - t.len, e - s));
    if (n) {
      t.parts.push(Buffer.from(b.subarray(s, s + n)));
      t.len += n;
    }
    if (n < e - s && !this.key && this.cap) this.cap.over = true;
  }

  private startCap(kind: Capture['kind'], depth: number, at: number, prim = false) {
    const max = this.wanted(depth);
    if (!max) return;
    this.cap = { name: this.keyOf[depth] ?? '', parts: [], len: 0, max, kind, prim, depth, over: false, root: this.doc && depth === 1 };
    this.from = at;
  }

  /** Ends the capture at `b[at]` (exclusive). */
  private endCap(b: Buffer | undefined, at: number) {
    const c = this.cap;
    if (!c) return;
    if (b) this.take(b, this.from, at);
    this.cap = null;
    const f: Field = { kind: c.kind, raw: Buffer.concat(c.parts).toString('utf8'), over: c.over };
    if (c.root) {
      if (!f.over) this.root[c.name] = f.kind === 'str' ? '"' + f.raw + '"' : f.raw;
    } else if (this.item) this.item[c.name] = f;
  }

  private primAt(d: number) {
    return !!this.cap && this.cap.prim && this.cap.depth === d;
  }

  /** The closing quote of the string in progress in `b[i, e)`, or -1 when the string goes on past `e`. */
  private strEnd(b: Buffer, i: number, e: number): number {
    let p = i;
    if (this.esc) {
      this.esc = false;
      p++;
    }
    for (;;) {
      if (p >= e) return -1;
      if (this.nq < p) {
        const f = b.indexOf(Q, p);
        this.nq = f < 0 ? Infinity : f;
      }
      if (this.nb < p) {
        const f = b.indexOf(BS, p);
        this.nb = f < 0 ? Infinity : f;
      }
      if (this.nb < this.nq && this.nb < e) {
        if (this.nb + 1 >= e) {
          this.esc = true;
          return -1;
        }
        p = this.nb + 2;
        continue;
      }
      return this.nq < e ? this.nq : -1;
    }
  }

  /** Reads `b[s, e)`. */
  push(b: Buffer, s: number, e: number) {
    this.nq = this.nb = -1;
    this.from = s;
    let i = s;
    while (i < e) {
      if (this.str) {
        const q = this.strEnd(b, i, e);
        if (q < 0) break;
        this.str = false;
        if (this.key) {
          this.take(b, this.from, q);
          const raw = Buffer.concat(this.key.parts).toString('utf8');
          const d = this.key.depth;
          this.key = null;
          try {
            this.keyOf[d] = JSON.parse(`"${raw}"`) as string;
          } catch {
            this.keyOf[d] = '';
          }
          this.next[d] = Next.Colon;
        } else if (this.cap?.kind === 'str' && this.cap.depth === this.depth) this.endCap(b, q);
        i = q + 1;
        continue;
      }
      const c = b[i];
      const d = this.depth;
      const at = this.watched(d) ? this.next[d] : undefined;
      if (c === Q) {
        this.str = true;
        if (at === Next.Key) {
          this.key = { parts: [], len: 0, depth: d };
          this.from = i + 1;
        } else if (at === Next.Value) {
          this.next[d] = Next.After;
          if (!this.cap) this.startCap('str', d, i + 1);
        }
      } else if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
        if (at === Next.Value) {
          this.next[d] = Next.After;
          if (!this.cap) this.startCap('raw', d, i);
        }
        this.depth = d + 1;
        if (c === 0x7b) {
          if ((!this.doc && d === 0) || (this.doc && d === 2 && this.list)) {
            this.item = {};
            this.next[d + 1] = Next.Key;
          } else if (this.doc && d === 0) this.next[1] = Next.Key;
        } else if (this.doc && d === 1 && (this.keyOf[1] === 'items' || this.keyOf[1] === 'over' && this.onOverride)) {
          this.list = this.keyOf[1] as 'items' | 'over';
          if (this.list === 'items') this.hasItems = true;
        }
      } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
        if (this.primAt(d)) this.endCap(b, i);
        const nd = d - 1;
        if (nd < 0) {
          this.broken = true;
        } else {
          this.depth = nd;
          if (this.cap && !this.cap.prim && this.cap.kind === 'raw' && this.cap.depth === nd) this.endCap(b, i + 1);
          if (c === 0x7d && this.item && nd === (this.doc ? 2 : 0)) {
            const it = this.item;
            this.item = null;
            if (!this.doc) this.closed = true;
            if (this.list === 'over') this.onOverride?.(it);
            else this.onItem(it, this.count++);
          } else if (c === 0x5d && this.doc && nd === 1) this.list = undefined;
          else if (c === 0x7d && this.doc && nd === 0) this.closed = true;
        }
      } else if (c === 0x3a /* : */) {
        if (at === Next.Colon) this.next[d] = Next.Value;
      } else if (c === 0x2c /* , */) {
        if (this.primAt(d)) this.endCap(b, i);
        if (at !== undefined) this.next[d] = Next.Key;
      } else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        if (this.primAt(d)) this.endCap(b, i);
      } else if (at === Next.Value) {
        // A number, true, false or null.
        this.next[d] = Next.After;
        if (!this.cap) this.startCap('raw', d, i, true);
      }
      i++;
    }
    // What a key or capture in progress took of this piece; the next piece goes on from its start.
    if (this.key || this.cap) this.take(b, this.from, e);
  }

  /** The input ended: a number or word it ended on is complete. */
  end() {
    if (this.cap?.prim) this.endCap(undefined, 0);
  }

  /** The item being read is already known not to be a message search reads (a step, a sub-agent's text): the rest of it need not be read. */
  notMessage(): boolean {
    const it = this.item;
    if (!it) return false;
    const type = it.type ? valueOf(it.type) : undefined;
    return (type !== undefined && type !== 'user' && type !== 'text') || (!!it.parentId && !!valueOf(it.parentId));
  }
}

/** A string kept in part: cut before an escape the cut split, so what is left is still a JSON string. */
function cutEscape(s: string): string {
  const u = /\\u[0-9a-fA-F]{0,3}$/.exec(s);
  if (u) {
    let n = 0;
    while (u.index - 1 - n >= 0 && s[u.index - 1 - n] === '\\') n++;
    if (n % 2 === 0) s = s.slice(0, u.index);
  }
  let n = 0;
  while (n < s.length && s[s.length - 1 - n] === '\\') n++;
  return n % 2 ? s.slice(0, -1) : s;
}

function valueOf(f: Field | undefined): unknown {
  if (!f) return undefined;
  try {
    if (f.kind === 'str') return JSON.parse(`"${f.over ? cutEscape(f.raw) : f.raw}"`);
    return f.over ? undefined : JSON.parse(f.raw);
  } catch {
    return undefined;
  }
}

/** A message from the fields `FieldScan` kept of an item, as `sayOf` reads a whole one. */
function sayFields(f: Fields): Said | null {
  const type = valueOf(f.type);
  if (type !== 'user' && type !== 'text') return null;
  const id = valueOf(f.id);
  if (typeof id !== 'string' || !id) return null;
  const text = valueOf(f.text);
  const until = valueOf(f.until);
  const ts = valueOf(f.ts);
  const parentId = valueOf(f.parentId);
  return sayOf({ id, type, text: typeof text === 'string' ? text : '', ts: typeof ts === 'number' ? ts : 0, ...(parentId ? { parentId } : {}), ...(until && typeof until === 'object' ? { until } : {}) } as TimelineItem);
}

// ───────────────────────────── searching ─────────────────────────────



export interface SearchOptions {
  /** At most this many hits (1 to `SEARCH.hits`). */
  limit?: number;
  /** At most this many hits per chat (1 to `SEARCH.perChat`). */
  perChat?: number;
  /** Set by the caller when the answer is no longer wanted (a newer query): the search stops at the next piece, partial. */
  signal?: { aborted: boolean };
  /** Where an earlier call of the same search stopped (its answer's `cursor`). */
  cursor?: string;
  /** Who asks (a window, a phone): a search goes on only for the one that started it. */
  scope?: string;
  /** Budget for this call (tests). */
  bytes?: number;
  ms?: number;
}

interface Budget {
  bytes: number;
  until: number;
  /** Nothing read or matched yet in this call: the first piece always goes, so every call gets on. */
  fresh: boolean;
  signal?: { aborted: boolean };
  read: number;
}

/** A small ring of a chat's newest matches (the last `n` pushed). */
function ring(list: MessageHit[], h: MessageHit, n: number) {
  list.push(h);
  if (list.length > n) list.shift();
}

/** Where a search stopped inside a chat it reads from memory or from what was kept: the next message to match, going back. */
interface ListCursor {
  kind: 'mem' | 'kept';
  id: string;
  key?: string;
  at: number;
  atId?: string;
  hits: MessageHit[];
}

/** Where a search stopped inside a chat it reads from its files. */
interface FileCursor {
  kind: 'file';
  id: string;
  key: string;
  tail: { over: Map<string, Said | null>; done: boolean; off: number; scan?: FieldScan; ok: boolean; gen?: number; from?: number; hits: MessageHit[]; said: Said[] };
  base: {
    off: number;
    merge?: ReturnType<typeof sessionTail<Said | null>>;
    doc?: FieldScan;
    hits: MessageHit[];
    said: Said[];
    /** The last line seen without its line break (the foot, or a cut-off item). */
    last?: number;
  };
  /** What is collected to keep (characters); over `chatKeep` nothing is kept. */
  chars: number;
  keepable: boolean;
  bad: boolean;
}

type ChatCursor = ListCursor | FileCursor;

/** One search across chats, carried over its calls: the chats in their order, which one it is in and where. */
interface Run {
  token: string;
  scope: string;
  q: string;
  words: string[];
  limit: number;
  perChat: number;
  order: string[];
  i: number;
  hits: MessageHit[];
  cur?: ChatCursor;
  skipped: Set<string>;
  used: number;
  queue: Promise<unknown>;
}

const clampInt = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : max);
const hitOf = (sessionId: string, s: Said, words: string[]): MessageHit => ({ sessionId, itemId: s.id, role: s.role, text: snippetOf(s.text, words), ts: s.ts });

/** Searches the chats' messages, with what it read from disk kept between calls. */
export class ChatSearch {
  private kept = new Map<string, { key: string; said: Said[]; chars: number }>();
  private chars = 0;
  private runs = new Map<string, Run>();
  /** Bytes the last call read from disk (tests, diagnostics). */
  lastRead = 0;

  constructor(private app: App) {}

  private keep(id: string, key: string, said: Said[]) {
    const old = this.kept.get(id);
    if (old) (this.chars -= old.chars), this.kept.delete(id);
    const chars = said.reduce((n, s) => n + s.text.length + 48, 0);
    if (chars > Math.min(SEARCH.chatKeep, SEARCH.keep)) return;
    this.kept.set(id, { key, said, chars });
    this.chars += chars;
    for (const [k, v] of this.kept) {
      if (this.chars <= SEARCH.keep || k === id) break;
      this.kept.delete(k);
      this.chars -= v.chars;
    }
  }

  /**
   * Messages with every word of the query across the chats that are not archived: newest chats
   * first, newest message first within a chat, at most `perChat` per chat and `limit` in all.
   * `partial` (with a `cursor`) when chats are left to read: asking again goes on where this call
   * stopped, and the hits add up. `skipped`: chats with a part that could not be read.
   */
  async search(query: unknown, opts: SearchOptions = {}): Promise<MessageSearch> {
    const { q, words } = queryWords(query);
    if (q.length < SEARCH.min || !words.length) return { hits: [] };
    const limit = clampInt(opts.limit, 1, SEARCH.hits);
    const perChat = clampInt(opts.perChat, 1, SEARCH.perChat);
    const run = this.runFor(opts.scope ?? '', q, words, limit, perChat, opts.cursor);
    const step = run.queue.then(() => this.step(run, opts));
    run.queue = step.catch(() => {});
    return step;
  }

  /** The search to go on with (the cursor's, or this caller's same one asked again soon), or a new one. */
  private runFor(scope: string, q: string, words: string[], limit: number, perChat: number, cursor?: string): Run {
    const now = Date.now();
    for (const [t, r] of this.runs) if (now - r.used > SEARCH.life) this.runs.delete(t);
    const same = (r: Run) => r.scope === scope && r.q === q && r.limit === limit && r.perChat === perChat;
    let run = typeof cursor === 'string' ? this.runs.get(cursor) : undefined;
    if (run && !same(run)) run = undefined;
    if (!run) for (const r of this.runs.values()) if (same(r) && now - r.used <= SEARCH.again) run = r;
    if (run) {
      // The newest used last.
      this.runs.delete(run.token);
      this.runs.set(run.token, run);
      return run;
    }
    const order = [...this.app.sessions.values()]
      .map((rt) => rt.meta)
      .filter((m) => !m.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => m.id);
    run = { token: randomBytes(9).toString('base64url'), scope, q, words, limit, perChat, order, i: 0, hits: [], skipped: new Set(), used: now, queue: Promise.resolve() };
    this.runs.set(run.token, run);
    while (this.runs.size > SEARCH.runs) this.runs.delete(this.runs.keys().next().value as string);
    return run;
  }

  private async step(run: Run, opts: SearchOptions): Promise<MessageSearch> {
    const budget: Budget = { bytes: opts.bytes ?? SEARCH.bytes, until: Date.now() + (opts.ms ?? SEARCH.ms), fresh: true, signal: opts.signal, read: 0 };
    try {
      while (run.i < run.order.length && run.hits.length < run.limit) {
        if (budget.signal?.aborted) break;
        const id = run.order[run.i];
        const rt = this.app.sessions.get(id);
        let found: MessageHit[] | undefined = [];
        if (rt && !rt.meta.archived) {
          found = await this.chat(run, id, budget);
          if (!found) break;
        }
        for (const h of found) if (run.hits.length < run.limit) run.hits.push(h);
        run.i++;
        run.cur = undefined;
      }
    } finally {
      this.lastRead = budget.read;
      run.used = Date.now();
    }
    const more = run.i < run.order.length && run.hits.length < run.limit;
    if (!more) this.runs.delete(run.token);
    const out: MessageSearch = { hits: run.hits.slice() };
    if (more) {
      out.partial = true;
      out.cursor = run.token;
    }
    if (run.skipped.size) out.skipped = run.skipped.size;
    return out;
  }

  /** A chat's newest matches (newest first), or undefined when the budget ran out inside it (the run's cursor says where). */
  private async chat(run: Run, id: string, budget: Budget): Promise<MessageHit[] | undefined> {
    const rt = this.app.sessions.get(id);
    if (rt?.items.length) return this.fromList(run, 'mem', id, rt.items, undefined, budget);
    const base = path.join(this.app.store.dir, 'sessions', `${id}.json`);
    const tail = base.replace(/\.json$/, '.tail.json');
    // Not there ('-') is a state of its own; a file that cannot even be looked at ('?') is never answered from what was kept.
    const st = (f: string) => statFile(f).then((s) => `${s.size}:${s.mtimeMs}`, (err: NodeJS.ErrnoException) => (err?.code === 'ENOENT' ? '-' : '?'));
    const key = `${await st(base)}|${await st(tail)}`;
    const have = this.kept.get(id);
    if (have?.key === key && !key.includes('?')) {
      this.kept.delete(id);
      this.kept.set(id, have);
      return this.fromList(run, 'kept', id, have.said, key, budget);
    }
    return this.fromFile(run, id, base, tail, key, budget);
  }

  /** Out of time (or no longer wanted); `bytes`: reading from disk, also out of bytes. The first piece of a call always goes. */
  private out(budget: Budget, bytes = false) {
    if (budget.signal?.aborted) return true;
    if (budget.fresh) return false;
    return Date.now() > budget.until || (bytes && budget.bytes <= 0);
  }

  /** How much the next read may take: a piece, and never more than what is left of the call (the first piece of a call is whole). */
  private want(budget: Budget, piece: number) {
    return budget.fresh ? piece : Math.max(1, Math.min(piece, Math.floor(budget.bytes)));
  }

  /** Matches a chat's messages from memory or from what was kept, newest first, a slice at a time. */
  private fromList(run: Run, kind: 'mem' | 'kept', id: string, list: readonly (TimelineItem | Said)[], key: string | undefined, budget: Budget): MessageHit[] | undefined {
    const say = kind === 'mem' ? (x: TimelineItem | Said) => sayOf(x as TimelineItem) : (x: TimelineItem | Said) => x as Said;
    let c = run.cur?.kind === kind && run.cur.id === id && run.cur.key === key ? run.cur : undefined;
    if (c && c.atId !== undefined && list[c.at]?.id !== c.atId) {
      // Items came or went since: find the one it stopped at, or start the chat again.
      const j = list.findIndex((x) => x.id === c!.atId);
      c = j >= 0 ? { ...c, at: j } : undefined;
    }
    if (!c) c = { kind, id, key, at: list.length - 1, hits: [] };
    run.cur = c;
    while (c.at >= 0 && c.hits.length < run.perChat) {
      if (this.out(budget)) {
        c.atId = list[c.at]?.id;
        return undefined;
      }
      const stop = Math.max(-1, c.at - SEARCH.slice);
      for (; c.at > stop && c.hits.length < run.perChat; c.at--) {
        const s = say(list[c.at]);
        if (s && matches(s.text, run.words)) c.hits.push(hitOf(id, s, run.words));
      }
      budget.fresh = false;
    }
    return c.hits;
  }

  /** Reads a chat's files from where the cursor stopped: the tail (when it is there), then the base. */
  private async fromFile(run: Run, id: string, base: string, tail: string, key: string, budget: Budget): Promise<MessageHit[] | undefined> {
    let c = run.cur?.kind === 'file' && run.cur.id === id && run.cur.key === key ? run.cur : undefined;
    if (!c) {
      c = {
        kind: 'file',
        id,
        key,
        tail: { over: new Map(), done: false, off: 0, ok: false, hits: [], said: [] },
        base: { off: 0, hits: [], said: [] },
        chars: 0,
        keepable: true,
        bad: false,
      };
    }
    run.cur = c;
    const cur = c;
    const collect = (list: Said[], s: Said) => {
      if (!cur.keepable) return;
      cur.chars += s.text.length + 48;
      if (cur.chars > Math.min(SEARCH.chatKeep, SEARCH.keep)) {
        cur.keepable = false;
        cur.tail.said = [];
        cur.base.said = [];
      } else list.push(s);
    };
    const onTail = (s: Said | null) => {
      if (!s) return;
      collect(cur.tail.said, s);
      if (matches(s.text, run.words)) ring(cur.tail.hits, hitOf(id, s, run.words), run.perChat);
    };
    const onBase = (k: number, f: Fields) => {
      const merge = cur.base.merge;
      if (merge && k >= merge.from) return;
      const itemId = valueOf(f.id);
      const original = sayFields(f);
      const s = merge && typeof itemId === 'string' ? merge.item(itemId, original) : original;
      if (!s) return;
      collect(cur.base.said, s);
      if (matches(s.text, run.words)) ring(cur.base.hits, hitOf(id, s, run.words), run.perChat);
    };

    if (!cur.tail.done && !(await this.readTail(cur, tail, budget, onTail))) return undefined;
    const r = await this.readBase(cur, base, budget, onBase);
    if (r === 'paused') return undefined;
    const tailOn = !!cur.base.merge;
    const hits = [...(tailOn ? cur.tail.hits : [])].reverse().concat([...cur.base.hits].reverse()).slice(0, run.perChat);
    if (cur.bad) run.skipped.add(id);
    else if (cur.keepable && r === 'done') this.keep(id, key, tailOn ? cur.base.said.concat(cur.tail.said) : cur.base.said);
    return hits;
  }

  /**
   * Read a tail within the search budget, streaming its message fields when large.
   * False when the budget ran out. A tail that is not there is
   * none; one that is there but cannot be read or parsed is a part of the chat not searched (`bad`:
   * said in `skipped`, and nothing of the chat is kept), never taken for none.
   */
  private async readTail(c: FileCursor, file: string, budget: Budget, onTail: (s: Said | null) => void): Promise<boolean> {
    const t = c.tail;
    const failed = (err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') c.bad = true;
    };
    let size: number;
    try {
      size = (await statFile(file)).size;
    } catch (err) {
      failed(err);
      t.done = true;
      return true;
    }
    // Read whole only when it fits what is left of this call (the first piece of a call always goes).
    if (size <= SEARCH.tailWhole && !t.scan && (budget.fresh || size <= budget.bytes)) {
      if (this.out(budget, true)) return false;
      try {
        const v = JSON.parse(await readFileAsync(file, 'utf8')) as { baseGen?: number; from?: number; items?: TimelineItem[]; over?: TimelineItem[] };
        if (v && Array.isArray(v.items)) {
          t.ok = true;
          t.gen = v.baseGen;
          t.from = v.from;
          for (const it of v.over ?? []) t.over.set(it.id, sayOf(it));
          for (const it of v.items) onTail(it && typeof it === 'object' ? sayOf(it) : null);
        } else c.bad = true;
      } catch (err) {
        failed(err);
      }
      budget.bytes -= size;
      budget.read += size;
      budget.fresh = false;
      t.done = true;
      return true;
    }
    t.scan ??= new FieldScan(true, (f) => onTail(sayFields(f)), f => {
      const id = valueOf(f.id);
      if (typeof id === 'string') t.over.set(id, sayFields(f));
    });
    let fh: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      fh = await openFile(file, 'r');
      const buf = Buffer.allocUnsafe(SEARCH.chunk);
      while (t.off < size) {
        if (this.out(budget, true)) return false;
        const { bytesRead: n } = await fh.read(buf, 0, this.want(budget, buf.length), t.off);
        if (n <= 0) break;
        t.off += n;
        budget.bytes -= n;
        budget.read += n;
        budget.fresh = false;
        t.scan.push(buf, 0, n);
      }
      t.scan.end();
      const num = (raw: string | undefined) => {
        try {
          const v: unknown = raw === undefined ? undefined : JSON.parse(raw);
          return typeof v === 'number' ? v : undefined;
        } catch {
          return undefined;
        }
      };
      t.ok = t.scan.closed && !t.scan.broken && t.scan.hasItems;
      // There but not whole (cut off, damaged): its messages were not all searched.
      if (!t.ok) c.bad = true;
      t.gen = num(t.scan.root.baseGen);
      t.from = num(t.scan.root.from);
    } catch (err) {
      // Gone since it was looked at: none. Locked or unreadable: said, never taken for none.
      failed(err);
    } finally {
      await fh?.close().catch(() => {});
    }
    t.scan = undefined;
    t.done = true;
    return true;
  }

  /** Search streams only the fields it needs. When a tail exists the first pass locates its
   * generation and retained prefix, even if the generation follows the items in compact JSON. */
  private async readBase(c: FileCursor, file: string, budget: Budget, onBase: (k: number, f: Fields) => void): Promise<'done' | 'paused' | 'gone'> {
    const b = c.base;
    let fh: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      fh = await openFile(file, 'r');
      const { size, mtimeMs } = await fh.stat();
      const buf = Buffer.allocUnsafe(SEARCH.chunk);
      for (;;) {
        const measuring = c.tail.ok && b.merge === undefined;
        b.doc ??= new FieldScan(true, measuring ? () => {} : (f, k) => onBase(k, f));
        while (b.off < size) {
          if (this.out(budget, true)) return 'paused';
          const { bytesRead: n } = await fh.read(buf, 0, this.want(budget, buf.length), b.off);
          if (!n) throw new Error('Incomplete session file');
          b.off += n;
          budget.bytes -= n;
          budget.read += n;
          budget.fresh = false;
          b.doc.push(buf, 0, n);
        }
        b.doc.end();
        if (!b.doc.closed || b.doc.broken || !b.doc.hasItems) c.bad = true;
        if (!measuring || c.bad) return 'done';
        const field = b.doc.root.gen === undefined ? undefined : JSON.parse(b.doc.root.gen);
        b.merge = sessionTail(field, mtimeMs, { baseGen: c.tail.gen, from: c.tail.from }, b.doc.count, c.tail.over);
        b.off = 0;
        b.doc = undefined;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || c.tail.ok) c.bad = true;
      return 'gone';
    } finally { await fh?.close().catch(() => {}); }
  }
}

const searchers = new WeakMap<App, ChatSearch>();

/** The app's searcher (one per app: the phone and the desktop share what it read). */
export function searchOf(app: App): ChatSearch {
  let s = searchers.get(app);
  if (!s) {
    s = new ChatSearch(app);
    searchers.set(app, s);
  }
  return s;
}

/**
 * `search.messages` for the desktop: within one window (`scope`; a call without one counts as one
 * window), a newer call stops the one still running (the palette asks again as the person types),
 * which then answers with what it found, partial. Another window's search goes on.
 */
export function registerSearch(app: App) {
  const running = new Map<string, { aborted: boolean }>();
  app.register('search.messages', async ({ query, limit, perChat, cursor, scope }) => {
    const from = typeof scope === 'string' && scope ? scope.slice(0, 100) : '';
    const prev = running.get(from);
    if (prev) prev.aborted = true;
    const signal = { aborted: false };
    running.set(from, signal);
    try {
      return await searchOf(app).search(typeof query === 'string' ? query : '', { limit, perChat, signal, cursor: typeof cursor === 'string' ? cursor : undefined, scope: `desktop:${from}` });
    } finally {
      if (running.get(from) === signal) running.delete(from);
    }
  });
}
