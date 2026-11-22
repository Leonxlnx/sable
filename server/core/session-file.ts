import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { QueuedMessage, TimelineItem, Todo } from '../../shared/protocol';

/**
 * A session's timeline on disk, as a base file and a small tail.
 *
 * A long chat holds hundreds of megabytes (images in tool output, long outputs). Writing all of it
 * again after every streamed word kept the bridge (the desktop's main process) busy for about a
 * second at a time and wrote tens of gigabytes an hour. Now:
 *
 * - `<id>.json`, the base: `{ gen, items, todos, queue }`, the same JSON as before (older files
 *   have no `gen`), each item on a line of its own. It always holds the whole timeline as it was
 *   when written. It is written again only when an item it settles moves or goes (a rewind),
 *   when the items changed in it (`over`) pass `OVER_MAX`, or when the tail has grown past `TAIL_MAX`.
 *   (Before, any late patch to a settled item rewrote the whole base: a chat of 90 MB whose
 *   background sub-agents kept finishing wrote 90 MB on every save, every 1.5 s, and froze the window.) That write goes
 *   out in pieces of about a megabyte, so it never blocks for long.
 * - `<id>.tail.json`: `{ baseGen, from, items, over?, todos, queue }`: the timeline from item `from`
 *   on, and `over`: items the base settles that changed since it was written (a background sub-agent
 *   that finished hours after its turn, a late patch to an old step), each in its newest form, read
 *   in place of the base's copy. The base settles only the items before the live end of the chat
 *   (`from`), so streaming into the last items never forces the base to be written again, and a late
 *   change to an old item costs that item, not the whole base. Small; written on every save, in
 *   pieces like the base, so even a big tail never holds the event loop for long.
 *
 * Every write goes to a temporary file first and is renamed into place, so a crash leaves either
 * the old or the new file, and the base is complete on its own. The tail names the base it
 * continues (`baseGen`, never reused): a tail left over from another base is ignored.
 *
 * A file that exists but cannot be read (locked, damaged, too big) is never treated as empty: the
 * session loads with `unreadable` set and nothing is written to it.
 *
 * The runtime says which items changed since the last save (`dirty`), so the store can tell
 * whether the base still holds: everything that changes an item goes through the runtime.
 */

export interface SessionData {
  items: TimelineItem[];
  todos: Todo[];
  queue?: QueuedMessage[];
  /** The file exists but could not be read: the session shows empty and its file is left alone. */
  unreadable?: boolean;
}

export interface SessionSave extends SessionData {
  /** Ids of items changed or added since the last save; 'all' when unknown (a reload, a reset). */
  dirty: Set<string> | 'all';
}

/** The tail is folded into the base once it is bigger than this. */
export const TAIL_MAX = 8 * 1024 * 1024;
/** A base smaller than this is simply written whole every time (as before). */
export const SMALL_BASE = 4 * 1024 * 1024;
/** Changed settled items the tail carries (`over`) before the base is written again with them: count, and characters. */
export const OVER_MAX = { items: 512, chars: 4 * 1024 * 1024 };
/** Items at the end of the chat a new base leaves to the tail (where streaming happens). */
export const TAIL_KEEP = 24;
/** Above this size a base is read line by line (one string cannot hold much more than 512 MB). */
export const READ = { byLineAbove: 256 * 1024 * 1024, inWorkerAbove: 16 * 1024 * 1024 };

type BaseFile = { gen?: number; items: TimelineItem[]; todos?: Todo[]; queue?: QueuedMessage[] };

/**
 * The base read in a worker thread (plain CommonJS, so it runs the same in tests, the dev server and
 * the packaged app): the same rules as `readJson` / `readBaseByLine`.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { file, byLine } = workerData;
const whole = () => JSON.parse(fs.readFileSync(file, 'utf8'));
function lines() {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(10);
  if (at < 0) return null;
  const m = /^\\{"gen":(\\d+),"items":\\[$/.exec(buf.subarray(0, at).toString('utf8'));
  if (!m) return null;
  const items = [];
  let pos = at + 1;
  for (let nl = buf.indexOf(10, pos); nl >= 0; nl = buf.indexOf(10, pos)) {
    const line = buf.subarray(pos, nl).toString('utf8');
    items.push(JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line));
    pos = nl + 1;
  }
  const foot = buf.subarray(pos).toString('utf8');
  if (!foot.startsWith(']')) return null;
  const rest = JSON.parse('{"items":[' + foot);
  return { gen: Number(m[1]), items, todos: rest.todos, queue: rest.queue };
}
try {
  parentPort.postMessage({ ok: true, value: (byLine && lines()) || whole() });
} catch {
  parentPort.postMessage({ ok: false });
}
`;

function readInWorker(file: string, byLine: boolean): Promise<Read<BaseFile>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { file, byLine } });
    w.once('message', (r: Read<BaseFile>) => {
      resolve(r);
      void w.terminate();
    });
    w.once('error', reject);
    w.once('exit', (code) => reject(new Error(`The reading worker ended (${code})`)));
  });
}
/** Pieces of the base written per step (characters). */
const CHUNK = 1 << 20;

interface Base {
  gen: number;
  /** The items the base settles (the timeline before `from`). */
  ids: string[];
  idSet: Set<string>;
  /** The base file's size (bytes as read, characters as written): the small-base rule. */
  size: number;
  /** Read from a file of an older version (no generation): the first save writes the base anew. */
  old?: boolean;
  /** Settled items changed since the base was written: every tail carries them (`over`) until the base is written again. */
  over: Set<string>;
}

type Read<T> = { ok: true; value: T | null } | { ok: false };

/** null when the file is missing; not ok when it exists but cannot be read. */
function readJson<T>(file: string): Read<T> {
  if (!existsSync(file)) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as T };
  } catch {
    return { ok: false };
  }
}

/** A big base, one item per line (as `writeBase` writes it), parsed piece by piece. */
export function readBaseByLine(file: string): Read<{ gen?: number; items: TimelineItem[]; todos?: Todo[]; queue?: QueuedMessage[] }> {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const items: TimelineItem[] = [];
    let head: string | undefined;
    let pending = Buffer.alloc(0);
    const buf = Buffer.alloc(16 << 20);
    for (let pos = 0; pos < size; ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      let chunk = Buffer.concat([pending, buf.subarray(0, n)]);
      let at: number;
      // Every complete line is the head or one item; the last line (no line break) is the foot.
      while ((at = chunk.indexOf(10)) >= 0) {
        const line = chunk.subarray(0, at).toString('utf8');
        chunk = chunk.subarray(at + 1);
        if (head === undefined) head = line;
        else items.push(JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line) as TimelineItem);
      }
      pending = Buffer.from(chunk);
    }
    const foot = pending.toString('utf8');
    const m = /^\{"gen":(\d+),"items":\[$/.exec(head ?? '');
    if (!m || !foot.startsWith(']')) return { ok: false };
    const rest = JSON.parse(`{"items":[${foot}`) as { todos?: Todo[]; queue?: QueuedMessage[] };
    return { ok: true, value: { gen: Number(m[1]), items, todos: rest.todos, queue: rest.queue } };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Where a new base stops settling: after the last finished turn (what comes after it streams now),
 * or before the last `TAIL_KEEP` items while a long turn runs; and before any step still running.
 */
export function settledEnd(items: TimelineItem[]): number {
  let lastTurn = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'turn') {
      lastTurn = i;
      break;
    }
  }
  let end = Math.max(lastTurn + 1, items.length - TAIL_KEEP, 0);
  for (let i = 0; i < end; i++) {
    const it = items[i] as TimelineItem & { status?: string };
    if (it.type === 'tool' && (it.status === 'running' || it.status === 'pending')) {
      end = i;
      break;
    }
  }
  return end;
}

let lastGen = 0;
/** A generation never used before (time based, rising): a tail from any other base never matches. */
const nextGen = () => (lastGen = Math.max(Date.now(), lastGen + 1));

export class SessionFiles {
  private bases = new Map<string, Base>();
  /** The write in progress per session: the next waits for it (two writes never share a temporary file). */
  private writing = new Map<string, Promise<void>>();
  /** Sessions whose last write failed: what changed is no longer known, so the next write is whole. */
  private force = new Set<string>();
  /** Files that exist but could not be read: never written over. */
  private unreadable = new Set<string>();
  /** Deleted sessions: a write still in flight must not bring their file back. */
  private deleted = new Set<string>();

  constructor(private readonly pathOf: (id: string) => string) {}

  private tailOf(id: string) {
    return this.pathOf(id).replace(/\.json$/, '.tail.json');
  }

  load(id: string): SessionData {
    const file = this.pathOf(id);
    let size = 0;
    try {
      size = existsSync(file) ? statSync(file).size : 0;
    } catch {
      /* read below says */
    }
    let read: Read<BaseFile> = size > READ.byLineAbove ? readBaseByLine(file) : readJson<BaseFile>(file);
    // A big file of an older version is one long line (up to about 512 MB): read it whole.
    if (!read.ok && size > READ.byLineAbove) read = readJson<BaseFile>(file);
    return this.finish(id, read, size);
  }

  /**
   * As `load`, but a big file is read and parsed in a worker thread: the main process (the desktop's
   * window and every other chat) keeps running while a chat of hundreds of megabytes loads; only
   * handing the parsed timeline over takes a moment on it.
   */
  async loadAsync(id: string): Promise<SessionData> {
    const file = this.pathOf(id);
    let size = 0;
    try {
      size = existsSync(file) ? statSync(file).size : 0;
    } catch {
      /* read below says */
    }
    if (size < READ.inWorkerAbove) return this.load(id);
    const read = await readInWorker(file, size > READ.byLineAbove).catch(() => undefined);
    return read ? this.finish(id, read, size) : this.load(id);
  }

  private finish(id: string, read: Read<BaseFile>, size: number): SessionData {
    if (!read.ok) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    this.unreadable.delete(id);
    const base = read.value;
    if (!base) return { items: [], todos: [] };
    const old = typeof base.gen !== 'number';
    const gen = old ? 0 : (base.gen as number);
    const items = Array.isArray(base.items) ? base.items : [];
    const tailRead = old ? ({ ok: true, value: null } as const) : readJson<SessionData & { baseGen?: number; from?: number; over?: TimelineItem[] }>(this.tailOf(id));
    // A tail that is there but cannot be read (held by another program for a moment) is not a missing tail:
    // the base alone is an older conversation, and the next save would write a tail over the newer one.
    if (!tailRead.ok) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    const tail = tailRead.value;
    let from = items.length;
    let data: SessionData = { items, todos: base.todos ?? [], queue: base.queue };
    const over = new Set<string>();
    if (tail && tail.baseGen === gen && Array.isArray(tail.items)) {
      from = typeof tail.from === 'number' && tail.from >= 0 && tail.from <= items.length ? tail.from : items.length;
      let head = items.slice(0, from);
      // Settled items changed since the base was written: their newest form, in their place.
      if (Array.isArray(tail.over) && tail.over.length) {
        const newer = new Map(tail.over.filter((i) => i && typeof i.id === 'string').map((i) => [i.id, i]));
        head = head.map((i) => {
          const n = newer.get(i.id);
          if (!n) return i;
          over.add(i.id);
          return n;
        });
      }
      data = { items: head.concat(tail.items), todos: tail.todos ?? base.todos ?? [], queue: tail.queue ?? base.queue };
    }
    const settled = items.slice(0, from).map((i) => i.id);
    this.bases.set(id, { gen, ids: settled, idSet: new Set(settled), size, old, over });
    return data;
  }

  /** Writes what changed. Calls for one session run one after another. */
  save(id: string, data: () => SessionSave): Promise<void> {
    if (this.deleted.has(id) || this.unreadable.has(id)) return Promise.resolve();
    const prev = this.writing.get(id) ?? Promise.resolve();
    const next = prev.then(() => (this.deleted.has(id) || this.unreadable.has(id) ? undefined : this.write(id, data()))).catch(() => void this.force.add(id));
    this.writing.set(id, next);
    void next.finally(() => this.writing.get(id) === next && this.writing.delete(id));
    return next;
  }

  remove(id: string) {
    this.deleted.add(id);
    this.bases.delete(id);
    this.force.delete(id);
    this.unreadable.delete(id);
    const drop = () => {
      for (const f of [this.pathOf(id), this.tailOf(id)]) {
        try {
          rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
    };
    drop();
    // A write in flight renames its file into place after this: remove again once it is done.
    const w = this.writing.get(id);
    if (w) void w.finally(drop);
  }

  /** Waits for the writes in progress. */
  async idle() {
    await Promise.all([...this.writing.values()]);
  }

  private async write(id: string, save: SessionSave) {
    const base = this.bases.get(id);
    // The order as of now: an item moved during a long base write must not appear twice or not at all.
    const items = save.items.slice();
    let whole = !base || base.old || this.force.has(id) || save.dirty === 'all' || base.size < SMALL_BASE || items.length < base.ids.length;
    if (!whole && base) {
      for (let i = 0; i < base.ids.length; i++) {
        if (items[i].id !== base.ids[i]) {
          whole = true;
          break;
        }
      }
    }
    // Settled items changed since the base was written travel in the tail (`over`), up to a bound.
    let over: Set<string> | undefined;
    if (!whole && base) {
      over = new Set(base.over);
      if (save.dirty !== 'all') for (const d of save.dirty) if (base.idSet.has(d)) over.add(d);
      if (over.size > OVER_MAX.items) whole = true;
    }
    if (!whole && base && over) {
      const from = base.ids.length;
      const byId = new Map<string, TimelineItem>();
      if (over.size) for (let i = 0; i < from; i++) if (over.has(items[i].id)) byId.set(items[i].id, items[i]);
      const overItems = [...byId.values()];
      const tmp = `${this.tailOf(id)}.${process.pid}.tmp`;
      const head = `{"baseGen":${base.gen},"from":${from},"items":[\n`;
      const end = `\n],"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
      const sizes = await writePieces(tmp, head, items.slice(from), '\n],"over":[\n', overItems, end);
      // A big tail folds into the base only when that moves the boundary well on: otherwise a few
      // huge items at the end would have the whole base written again on every save. Changed
      // settled items past their bound go into the base too.
      if ((sizes.items <= TAIL_MAX || settledEnd(items) < from + TAIL_KEEP) && sizes.over <= OVER_MAX.chars) {
        await renameRetry(tmp, this.tailOf(id));
        base.over = over;
        return;
      }
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* a leftover temporary file is written over next time */
      }
    }
    const gen = nextGen();
    const size = await writeBase(this.pathOf(id), gen, { ...save, items });
    const end = settledEnd(items);
    const settled = items.slice(0, end).map((i) => i.id);
    this.bases.set(id, { gen, ids: settled, idSet: new Set(settled), size, over: new Set() });
    this.force.delete(id);
    // The new base holds everything: the old tail no longer matches it (and is ignored if this fails).
    try {
      rmSync(this.tailOf(id), { force: true });
    } catch {
      /* ignored on the next read: its baseGen is another */
    }
  }
}

/** Windows refuses a rename while another program (a virus scanner, a reader) has the file open for a moment: try again briefly. */
async function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

/**
 * `head`, the items of `first` one per line, `mid`, the items of `second` likewise, `end`: written
 * in pieces of about a megabyte (each item serialized on its own), so a big tail never holds the
 * event loop for long. Returns the characters `first` and `second` took.
 */
async function writePieces(file: string, head: string, first: TimelineItem[], mid: string, second: TimelineItem[], end: string): Promise<{ items: number; over: number }> {
  const fh = await open(file, 'w');
  const sizes = { items: 0, over: 0 };
  try {
    let buf = head;
    const put = async (list: TimelineItem[], key: 'items' | 'over') => {
      for (let i = 0; i < list.length; i++) {
        const line = JSON.stringify(list[i]) + (i < list.length - 1 ? ',\n' : '');
        sizes[key] += line.length;
        buf += line;
        if (buf.length >= CHUNK) {
          await fh.write(buf, null, 'utf8');
          buf = '';
        }
      }
    };
    await put(first, 'items');
    buf += mid;
    await put(second, 'over');
    buf += end;
    await fh.write(buf, null, 'utf8');
  } finally {
    await fh.close();
  }
  return sizes;
}

/**
 * The whole timeline as the base, one item per line (JSON escapes line breaks inside strings, so
 * every line holds one item), in pieces of about a megabyte so the event loop keeps running.
 * Returns its size in characters.
 */
async function writeBase(file: string, gen: number, save: SessionData): Promise<number> {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w');
  let size = 0;
  try {
    let buf = `{"gen":${gen},"items":[\n`;
    for (let i = 0; i < save.items.length; i++) {
      buf += JSON.stringify(save.items[i]) + (i < save.items.length - 1 ? ',\n' : '\n');
      if (buf.length >= CHUNK) {
        size += buf.length;
        await fh.write(buf, null, 'utf8');
        buf = '';
      }
    }
    buf += `],"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
    size += buf.length;
    await fh.write(buf, null, 'utf8');
  } finally {
    await fh.close();
  }
  await renameRetry(tmp, file);
  return size;
}
