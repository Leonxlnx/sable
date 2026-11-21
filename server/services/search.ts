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
 * files. A chat open on the desktop is read from memory; another is read from its file on disk, line
 * by line, decoding only the lines of messages (a step's line with screenshots is skipped unread), and
 * what it says is kept (keyed by the files' size and time) so the next search does not read it again.
 * Each call is bounded in time and bytes read; what was not read yet is read by the next call, so
 * asking again while an answer is `partial` goes on where the last call stopped.
 */

export const SEARCH = { min: 2, max: 120, hits: 40, perChat: 5, text: 20_000, snippet: 150, bytes: 48 * 1024 * 1024, ms: 900, line: 1024 * 1024, keep: 24_000_000 };

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

const MARKS = ['"type":"user"', '"type":"text"'];

/**
 * A chat's messages from its files (`session-file.ts`: a base of one item per line, and a tail that
 * replaces the base from item `from` on), reading only what it must. Null when it cannot be read.
 */
export async function readSaid(base: string, tail: string): Promise<{ said: Said[]; read: number } | null> {
  let fh: Awaited<ReturnType<typeof openFile>> | undefined;
  let read = 0;
  try {
    fh = await openFile(base, 'r');
    const size = (await fh.stat()).size;
    const said: { k: number; s: Said }[] = [];
    let gen: number | undefined;
    let k = -1; // the item's index (-1: the head line)
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let skipping = false;
    const buf = Buffer.alloc(1 << 20);
    const line = (b: Buffer) => {
      if (k === -1) {
        const m = /^\{"gen":(\d+),"items":\[$/.exec(b.toString('utf8'));
        if (!m) throw new Error('old');
        gen = Number(m[1]);
      } else if (b[0] !== 93 /* ] */ && MARKS.some((m) => b.includes(m))) {
        const t = b.toString('utf8');
        const s = sayOf(JSON.parse(t.endsWith(',') ? t.slice(0, -1) : t) as TimelineItem);
        if (s) said.push({ k, s });
      }
      k++;
    };
    for (let pos = 0; pos < size; ) {
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      read += n;
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl >= 0 && nl < n; nl = buf.indexOf(10, from)) {
        if (skipping) {
          skipping = false;
          k++;
        } else if (pendingLen) {
          pending.push(buf.subarray(from, nl));
          line(Buffer.concat(pending));
          pending = [];
          pendingLen = 0;
        } else line(buf.subarray(from, nl));
        from = nl + 1;
      }
      // The rest of a line: kept for the next piece, unless the line is too long to be a message.
      if (from < n && !skipping) {
        pendingLen += n - from;
        if (pendingLen > SEARCH.line) {
          if (k === -1) throw new Error('old');
          pending = [];
          pendingLen = 0;
          skipping = true;
        } else pending.push(Buffer.from(buf.subarray(from, n)));
      }
    }
    if (gen === undefined) throw new Error('old');
    let out = said;
    try {
      const st = await statFile(tail);
      if (st.size <= 16 * 1024 * 1024) {
        const t = JSON.parse(await readFileAsync(tail, 'utf8')) as { baseGen?: number; from?: number; items?: TimelineItem[] };
        read += st.size;
        if (t.baseGen === gen && Array.isArray(t.items)) {
          const cut = typeof t.from === 'number' && t.from >= 0 ? t.from : Infinity;
          out = said.filter((x) => x.k < cut);
          for (const s of saidOf(t.items)) out.push({ k: Infinity, s });
        }
      }
    } catch {
      /* no tail */
    }
    return { said: out.map((x) => x.s), read };
  } catch (err) {
    // A file of an older version is one line of JSON: read whole when it is not huge.
    if ((err as Error).message === 'old') {
      try {
        const st = await statFile(base);
        if (st.size > 64 * 1024 * 1024) return null;
        const f = JSON.parse(await readFileAsync(base, 'utf8')) as { items?: TimelineItem[] };
        return { said: saidOf(f.items ?? []), read: read + st.size };
      } catch {
        return null;
      }
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { said: [], read };
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export interface SearchOptions {
  /** At most this many hits (1 to `SEARCH.hits`). */
  limit?: number;
  /** At most this many hits per chat (1 to `SEARCH.perChat`). */
  perChat?: number;
  /** Set by the caller when the answer is no longer wanted (a newer query): the search stops at the next chat, partial. */
  signal?: { aborted: boolean };
  /** Budget for this call (tests). */
  bytes?: number;
  ms?: number;
}

const clampInt = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : max);

/** Searches the chats' messages, with what it read from disk kept between calls. */
export class ChatSearch {
  private kept = new Map<string, { key: string; said: Said[]; chars: number }>();
  private chars = 0;

  constructor(private app: App) {}

  private keep(id: string, key: string, said: Said[]) {
    const old = this.kept.get(id);
    if (old) (this.chars -= old.chars), this.kept.delete(id);
    const chars = said.reduce((n, s) => n + s.text.length + 48, 0);
    this.kept.set(id, { key, said, chars });
    this.chars += chars;
    for (const [k, v] of this.kept) {
      if (this.chars <= SEARCH.keep) break;
      this.kept.delete(k);
      this.chars -= v.chars;
    }
  }

  /** A chat's messages: from memory when the desktop has it open, else from its files (kept), or undefined when the budget is spent. */
  private async said(id: string, budget: { bytes: number; until: number; fresh: boolean }): Promise<Said[] | undefined> {
    const rt = this.app.sessions.get(id);
    if (rt?.items.length) return saidOf(rt.items);
    const base = path.join(this.app.store.dir, 'sessions', `${id}.json`);
    const tail = base.replace(/\.json$/, '.tail.json');
    const st = (f: string) => statFile(f).then((s) => `${s.size}:${s.mtimeMs}`, () => '-');
    const key = `${await st(base)}|${await st(tail)}`;
    const have = this.kept.get(id);
    if (have?.key === key) {
      // Used again: the newest kept last.
      this.kept.delete(id);
      this.kept.set(id, have);
      return have.said;
    }
    if (!budget.fresh && (budget.bytes <= 0 || Date.now() > budget.until)) return undefined;
    budget.fresh = false;
    const r = await readSaid(base, tail);
    if (!r) return [];
    budget.bytes -= r.read;
    this.keep(id, key, r.said);
    return r.said;
  }

  /**
   * Messages with every word of the query across the chats that are not archived: newest chats
   * first, newest message first within a chat, at most `perChat` per chat and `limit` in all.
   * `partial` when some chats were not read in this call (time or bytes ran out, or `signal` was set).
   */
  async search(query: unknown, opts: SearchOptions = {}): Promise<MessageSearch> {
    const { q, words } = queryWords(query);
    if (q.length < SEARCH.min || !words.length) return { hits: [] };
    const limit = clampInt(opts.limit, 1, SEARCH.hits);
    const perChat = clampInt(opts.perChat, 1, SEARCH.perChat);
    const chats = [...this.app.sessions.values()]
      .map((rt) => rt.meta)
      .filter((m) => !m.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const budget = { bytes: opts.bytes ?? SEARCH.bytes, until: Date.now() + (opts.ms ?? SEARCH.ms), fresh: true };
    const hits: MessageHit[] = [];
    let partial = false;
    for (const m of chats) {
      if (hits.length >= limit) break;
      if (opts.signal?.aborted) {
        partial = true;
        break;
      }
      const said = await this.said(m.id, budget);
      if (!said) {
        partial = true;
        continue;
      }
      let n = 0;
      for (let i = said.length - 1; i >= 0 && n < perChat && hits.length < limit; i--) {
        const s = said[i];
        if (!matches(s.text, words)) continue;
        hits.push({ sessionId: m.id, itemId: s.id, role: s.role, text: snippetOf(s.text, words), ts: s.ts });
        n++;
      }
    }
    return partial ? { hits, partial } : { hits };
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
 * `search.messages` for the desktop: a newer call stops the one still running (the palette asks
 * again as the person types), which then answers with what it found, partial.
 */
export function registerSearch(app: App) {
  let running: { aborted: boolean } | undefined;
  app.register('search.messages', async ({ query, limit, perChat }) => {
    if (running) running.aborted = true;
    const signal = { aborted: false };
    running = signal;
    try {
      return await searchOf(app).search(typeof query === 'string' ? query : '', { limit, perChat, signal });
    } finally {
      if (running === signal) running = undefined;
    }
  });
}
