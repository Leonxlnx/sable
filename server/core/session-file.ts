import { constants as bufferLimits } from 'node:buffer';
import * as fs from 'node:fs';
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { QueuedMessage, TimelineItem, Todo } from '../../shared/protocol';
import { cutItem, isLight, LIGHT, recentStart, workerCut } from './trim';

/**
 * A session's timeline on disk, as a base file and a small tail. For a large line-format base
 * the reader keeps settled old steps as socket previews plus a generation-bound byte index.
 * The stored preview is the baseline for late changes. Only the original line supplies hidden fields.
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

type Line = { offset: number; length: number; chars: number; preview?: TimelineItem };
type LineIndex = Map<string, Line>;
type Tail = SessionData & { baseGen?: number; from?: number; over?: TimelineItem[] };
type BaseFile = { gen?: number; items: TimelineItem[]; todos?: Todo[]; queue?: QueuedMessage[] };
type IndexedRead = { base: BaseFile; index?: LineIndex; tail: Tail | null };

function readBytes(io: typeof fs, fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  for (let at = 0; at < length;) {
    const n = io.readSync(fd, bytes, at, length - at, offset + at);
    if (!n) throw new Error('Incomplete session file');
    at += n;
  }
  return bytes;
}

/** One implementation for synchronous callers and the standalone worker. Pass its dependencies explicitly. */
function readIndexed(io: typeof fs, file: string, tailFile: string | undefined, cut: typeof cutItem,
  boundary: typeof recentStart, bytes: typeof readBytes, options: typeof workerCut, maxLegacy: number): IndexedRead {
  const fd = io.openSync(file, 'r');
  try {
    let tail: Tail | null = null;
    if (tailFile) {
      try {
        tail = JSON.parse(io.readFileSync(tailFile, 'utf8'));
        if (!Array.isArray(tail?.items)) throw new Error('Invalid session tail');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const size = io.fstatSync(fd).size;
    const prefix = bytes(io, fd, 0, Math.min(80, size)).toString();
    const head = /^\{"gen":(\d+),"items":\[\n/.exec(prefix);
    if (!head) {
      if (!tailFile || size > maxLegacy || prefix.startsWith('{"gen":') && prefix.includes('\n')) throw new Error('Invalid session header');
      const base = JSON.parse(io.readFileSync(fd, 'utf8'));
      if (!Array.isArray(base?.items)) throw new Error('Invalid legacy session');
      return { base, tail };
    }
    const gen = Number(head[1]);
    const index: LineIndex = new Map();
    const items: TimelineItem[] = [];
    const chunk = Buffer.allocUnsafe(1 << 20);
    let parts: Buffer[] = [];
    let pos = head[0].length, offset = pos, comma = true;
    while (pos < size) {
      const n = io.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (!n) throw new Error('Incomplete session file');
      let from = 0;
      for (let nl = chunk.indexOf(10); nl >= 0 && nl < n; nl = chunk.indexOf(10, from)) {
        const part = chunk.subarray(from, nl);
        const line = parts.length ? Buffer.concat([...parts, part]) : part;
        if (!comma) throw new Error('Missing item separator');
        comma = line.at(-1) === 44;
        const length = line.length - Number(comma);
        const json = line.toString('utf8', 0, length);
        const item = JSON.parse(json) as TimelineItem;
        if (typeof item.id !== 'string' || index.has(item.id) || Object.hasOwn(item, options.mark)) throw new Error('Invalid session item');
        const range: Line = { offset, length, chars: json.length };
        const view = tailFile ? cut(item, options.old) : item;
        if (view !== item) {
          // Round-trip the preview: a V8 substring can otherwise pin the entire output it came from.
          const result = item.type === 'tool' ? item.result : undefined;
          const mark = { pictures: result?.images?.length ?? 0, hunks: !!result?.diff?.some(f => f.hunks.length),
            ...(item.type === 'tool' && item.input !== undefined ? { input: true } : {}),
            ...(item.type === 'tool' && view.type === 'tool' && view.detail.background && !item.detail.background ? { legacyBackground: true } : {}) };
          range.preview = JSON.parse(JSON.stringify({ ...view, [options.mark]: mark })) as TimelineItem;
          items.push(structuredClone(range.preview));
        } else items.push(item);
        index.set(items[items.length - 1].id, range);
        from = nl + 1;
        offset = pos + from;
        parts = [];
      }
      if (from < n) parts.push(Buffer.from(chunk.subarray(from, n)));
      pos += n;
    }
    const foot = Buffer.concat(parts).toString('utf8');
    if (!foot.startsWith(']') || items.length && comma) throw new Error('Invalid session footer');
    const rest = JSON.parse('{"items":[' + foot);
    // A quit tail can rewind the base or add turns. Promote only steps recent in the actual chat.
    const active = tail?.baseGen === gen && Array.isArray(tail.items) ? tail : undefined;
    const from = active && Number.isInteger(active.from) && active.from! >= 0 && active.from! <= items.length ? active.from! : items.length;
    const newer = new Map(active?.over?.map(i => [i.id, i]));
    const visible = active ? items.slice(0, from).map(i => newer.get(i.id) ?? i).concat(active.items) : items;
    for (let i = boundary(visible, options.turns); i < from; i++) {
      const item = items[i], range = index.get(item.id)!;
      if (range.preview && !newer.has(item.id)) {
        items[i] = JSON.parse(bytes(io, fd, range.offset, range.length).toString('utf8'));
        delete range.preview;
      }
    }
    return { base: { gen, items, todos: rest.todos, queue: rest.queue }, index, tail };
  } finally { io.closeSync(fd); }
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
// tsx annotates nested functions with __name when the server runs from source.
const __name = f => f;
const opts = workerData.options;
const { cutItem } = (${workerCut.factory})(opts.recent, opts.keepFiles, (${workerCut.task}));
try {
  const value = (${readIndexed})(require('node:fs'), workerData.file, workerData.tail, cutItem,
    (${workerCut.boundary}), (${readBytes}), opts, workerData.maxLegacy);
  parentPort.postMessage({ ok: true, value });
} catch { parentPort.postMessage({ ok: false }); }
`;

function readInWorker(file: string, tail: string): Promise<Read<IndexedRead>> {
  return new Promise(resolve => {
    const w = new Worker(WORKER, { eval: true, workerData: { file, tail, options: workerCut, maxLegacy: bufferLimits.MAX_STRING_LENGTH },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 24 } });
    w.once('message', resolve);
    w.once('error', () => resolve({ ok: false }));
    w.once('exit', () => resolve({ ok: false }));
  });
}
/** Bytes batched per asynchronous write. */
const CHUNK = 1 << 20;

interface Base {
  index?: LineIndex;
  /** Byte ranges of restart notices in the last successful write, generation-bound. */
  notices?: { file: string; prefix: string; rows: Map<string, { line: Line; json: string }> };
  gen: number;
  /** The base prefix whose order and changed items are known. */
  ids: string[];
  /** Normal streaming saves keep everything from here onward together in the tail. */
  settled: number;
  idSet: Set<string>;
  /** Preserve the small-base rule: file bytes as read, JSON characters as written. */
  size: number;
  /** Read from a file of an older version (no generation): the first save writes the base anew. */
  old?: boolean;
  /** Settled items changed since the base was written: every tail carries them (`over`) until the base is written again. */
  over: Set<string>;
}

type Read<T> = { ok: true; value: T | null } | { ok: false };

/** null when the file is missing; not ok when it exists but cannot be read. */
function readJson<T>(file: string): Read<T> {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && Array.isArray(value.items) ? { ok: true, value } : { ok: false };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, value: null } : { ok: false };
  }
}

/** A big base, one item per line (as `writeBase` writes it), parsed piece by piece. */
export function readBaseByLine(file: string): Read<BaseFile> {
  try {
    return { ok: true, value: readIndexed(fs, file, undefined, cutItem, recentStart, readBytes, workerCut, 0).base };
  } catch { return { ok: false }; }
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
  /** Readers with an open Windows file handle (a worker load or a fork copying the source). */
  private reading = new Map<string, Set<Promise<unknown>>>();
  /** Sessions whose last write failed: what changed is no longer known, so the next write is whole. */
  private force = new Set<string>();
  /** Files that exist but could not be read: never written over. */
  private unreadable = new Set<string>();
  /** Deleted sessions: a write still in flight must not bring their file back. */
  private deleted = new Set<string>();

  constructor(private readonly pathOf: (id: string) => string) {}

  private trackRead<T>(id: string, work: Promise<T>): Promise<T> {
    const reads = this.reading.get(id) ?? new Set();
    this.reading.set(id, reads);
    reads.add(work);
    return work.finally(() => {
      reads.delete(work);
      if (!reads.size) this.reading.delete(id);
    });
  }

  private tailOf(id: string) {
    return this.pathOf(id).replace(/\.json$/, '.tail.json');
  }

  load(id: string): SessionData {
    const file = this.pathOf(id);
    let size: number, mtime: number;
    try { ({ size, mtimeMs: mtime } = statSync(file)); }
    catch (err) {
      return this.finish(id, (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, value: null } : { ok: false }, 0, 0);
    }
    if (size >= READ.inWorkerAbove || size > READ.byLineAbove) {
      try {
        const loaded = readIndexed(fs, file, this.tailOf(id), cutItem, recentStart, readBytes, workerCut, bufferLimits.MAX_STRING_LENGTH);
        return this.finish(id, { ok: true, value: loaded.base }, size, mtime, loaded);
      } catch { return this.finish(id, { ok: false }, size, mtime); }
    }
    return this.finish(id, readJson<BaseFile>(file), size, mtime);
  }

  async loadAsync(id: string): Promise<SessionData> {
    const file = this.pathOf(id);
    let stat;
    try { stat = statSync(file); }
    catch (err) {
      return this.finish(id, (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, value: null } : { ok: false }, 0, 0);
    }
    if (stat.size < READ.inWorkerAbove) return this.load(id);
    const previous = this.bases.get(id);
    const read = await this.trackRead(id, readInWorker(file, this.tailOf(id))).catch(() => ({ ok: false as const }));
    // A synchronous hydrate that won the race owns the installed index.
    if (this.deleted.has(id) || this.bases.get(id) !== previous) return { items: [], todos: [], unreadable: true };
    if (!read.ok || !read.value) return this.finish(id, { ok: false }, stat.size, stat.mtimeMs);
    return this.finish(id, { ok: true, value: read.value.base }, stat.size, stat.mtimeMs, read.value);
  }

  private finish(id: string, read: Read<BaseFile>, size: number, mtime: number, loaded?: IndexedRead): SessionData {
    if (!read.ok) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    this.unreadable.delete(id);
    const base = read.value;
    if (!base) {
      // An orphaned or inaccessible tail still belongs to a conversation.
      try { statSync(this.tailOf(id)); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.bases.delete(id);
          return { items: [], todos: [] };
        }
      }
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    const old = typeof base.gen !== 'number';
    // A legacy base has no generation field. Its unchanged file timestamp identifies
    // a quit tail until the next ordinary save migrates it to a numbered base.
    const gen = old ? -mtime : (base.gen as number);
    if (!old && (!Number.isSafeInteger(gen) || gen < 0 || gen >= Number.MAX_SAFE_INTEGER)) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    lastGen = Math.max(lastGen, gen);
    const items = Array.isArray(base.items) ? base.items : [];
    const tailRead = loaded ? { ok: true as const, value: loaded.tail } : readJson<Tail>(this.tailOf(id));
    // A tail that is there but cannot be read (held by another program for a moment) is not a missing tail:
    // the base alone is an older conversation, and the next save would write a tail over the newer one.
    if (!tailRead.ok) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    const tail = tailRead.value;
    const invalid = (item: TimelineItem) => !item || typeof item.id !== 'string' || isLight(item);
    if ((!loaded?.index && items.some(invalid)) ||
      (tail?.baseGen === gen && (tail.items.some(invalid) || (Array.isArray(tail.over) && tail.over.some(invalid))))) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    let from = items.length;
    let data: SessionData = { items, todos: base.todos ?? [], queue: base.queue };
    const over = new Set<string>();
    if (tail && tail.baseGen === gen && Array.isArray(tail.items)) {
      from = typeof tail.from === 'number' && Number.isInteger(tail.from) && tail.from >= 0 && tail.from <= items.length ? tail.from : items.length;
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
    this.bases.set(id, { gen, index: loaded?.index, ids: settled, settled: from, idSet: new Set(settled), size, old, over });
    return data;
  }

  wholeItem(id: string, item: TimelineItem): TimelineItem {
    if (!isLight(item)) return item;
    const source = new BaseReader(this.pathOf(id), this.bases.get(id));
    try { return source.whole(item); }
    finally { source.close(); }
  }

  /** Pin the source generation before yielding. The destination has its own base before it is published. */
  async copyBase(sourceId: string, destId: string, items: TimelineItem[]): Promise<SessionData> {
    const source = new BaseReader(this.pathOf(sourceId), this.bases.get(sourceId));
    try {
      if (items.some(isLight)) source.open();
      await this.trackRead(sourceId, this.writeBase(destId, { items, todos: [] }, source));
    } finally { source.close(); }
    const recent = recentStart(items, workerCut.turns);
    return { items: items.map((item, i) => i < recent ? item : this.wholeItem(destId, item)), todos: [] };
  }

  async savedRestartNotice(id: string, notice: string): Promise<boolean> {
    await this.writing.get(id);
    const base = this.bases.get(id);
    const proof = base?.notices;
    const row = proof?.rows.get(notice);
    if (!proof || !row || this.force.has(id)) return false;
    // Seek straight to the notice in the committed tail (or the just-rewritten base).
    // Compare its actual bytes, including type and early, without parsing another timeline.
    let fh;
    try {
      if (proof.file === this.tailOf(id)) {
        if (base.old) {
          if (-statSync(this.pathOf(id)).mtimeMs !== base.gen) return false;
        } else {
          const fd = openSync(this.pathOf(id), 'r');
          try {
            const head = `{"gen":${base.gen},"items":[\n`;
            if (readBytes(fs, fd, 0, head.length).toString() !== head) return false;
          } finally { closeSync(fd); }
        }
      }
      const handle = fh = await open(proof.file, 'r');
      const match = async (offset: number, expected: Buffer) => {
        const buf = Buffer.allocUnsafe(Math.min(expected.length, 65536));
        for (let at = 0; at < expected.length;) {
          const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, expected.length - at), offset + at);
          if (!bytesRead || !buf.subarray(0, bytesRead).equals(expected.subarray(at, at + bytesRead))) return false;
          at += bytesRead;
        }
        return true;
      };
      return await match(0, Buffer.from(proof.prefix)) && await match(row.line.offset, Buffer.from(row.json)) &&
        this.bases.get(id)?.notices === proof;
    } catch { return false; }
    finally { await fh?.close(); }
  }

  /** Writes what changed. Calls for one session run one after another. */
  save(id: string, data: () => SessionSave, final = false): Promise<void> {
    if (this.deleted.has(id) || this.unreadable.has(id)) return Promise.resolve();
    const prev = this.writing.get(id) ?? Promise.resolve();
    const next = prev.then(() => (this.deleted.has(id) || this.unreadable.has(id) ? undefined : this.write(id, data(), final))).catch(err => {
      this.force.add(id);
      if (final) throw err;
    });
    this.writing.set(id, next);
    void next.finally(() => this.writing.get(id) === next && this.writing.delete(id)).catch(() => {});
    return next;
  }

  /** An in-flight save already captured this exact version. Only write again if it failed. */
  async retryAfterWrite(id: string, snapshot: SessionSave) {
    await this.writing.get(id);
    if (this.force.has(id)) await this.save(id, () => snapshot, true);
  }

  needsRetry(id: string) { return this.force.has(id); }

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
    const pending = [...(this.reading.get(id) ?? []), this.writing.get(id)];
    void Promise.allSettled(pending).then(drop);
  }

  /** Waits for the writes in progress. */
  async idle() {
    await Promise.all([...this.writing.values()]);
  }

  private async write(id: string, save: SessionSave, final: boolean) {
    const base = this.bases.get(id);
    // The order as of now: an item moved during a long base write must not appear twice or not at all.
    const items = save.items.slice();
    // At quit keep the existing generation. A rewind can shorten the matching prefix.
    let from = base?.settled ?? 0;
    let whole = !base || base.old || this.force.has(id) || save.dirty === 'all' || base.size < SMALL_BASE || items.length < from;
    if (final && base) {
      whole = false;
      from = 0;
      while (from < base.ids.length && items[from]?.id === base.ids[from]) from++;
    } else if (!whole && base) {
      for (let i = 0; i < from; i++) {
        if (items[i].id !== base.ids[i]) {
          whole = true;
          break;
        }
      }
    }
    // Settled items changed since the base was written travel in the tail (`over`), up to a bound.
    let over: Set<string> | undefined;
    const overItems: TimelineItem[] = [];
    if (!whole && base) {
      over = new Set(base.over);
      if (save.dirty !== 'all') for (const d of save.dirty) if (base.idSet.has(d)) over.add(d);
      if (final && (save.dirty === 'all' || this.force.has(id))) over = new Set(base.ids.slice(0, from));
      if (over.size) for (let i = 0; i < from; i++) {
        const item = items[i];
        if (over.has(item.id) && isLight(item) && isDeepStrictEqual(item, base.index?.get(item.id)?.preview)) over.delete(item.id);
        if (over.has(item.id)) overItems.push(item);
      }
      if (!final && overItems.length > OVER_MAX.items) whole = true;
    }
    if (!whole && base && over) {
      const tmp = `${this.tailOf(id)}.${process.pid}.tmp`;
      const head = `{"baseGen":${base.gen},"from":${from},"items":[\n`;
      const end = `\n],"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
      const source = new BaseReader(this.pathOf(id), base);
      let written;
      try {
        written = await writeLines(tmp, [{ head, items: items.slice(from) }, { head: '\n],"over":[\n', items: overItems }], end, source);
      } finally { source.close(); }
      const [tailSize, overSize] = written.sizes;
      // A big tail folds into the base only when that moves the boundary well on: otherwise a few
      // huge items at the end would have the whole base written again on every save. Changed
      // settled items past their bound go into the base too.
      if (final || (overSize <= OVER_MAX.chars && (tailSize <= TAIL_MAX || settledEnd(items) < from + TAIL_KEEP))) {
        await renameRetry(tmp, this.tailOf(id), () => {
          base.notices = { file: this.tailOf(id), prefix: head, rows: written.notices };
          base.over = over!;
        });
        this.force.delete(id);
        return;
      }
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* a leftover temporary file is written over next time */
      }
    }
    const source = new BaseReader(this.pathOf(id), base);
    try { await this.writeBase(id, { ...save, items }, source); }
    finally { source.close(); }
    this.force.delete(id);
    // The new base holds everything: the old tail no longer matches it (and is ignored if this fails).
    try {
      rmSync(this.tailOf(id), { force: true });
    } catch {
      /* ignored on the next read: its baseGen is another */
    }
  }

  private async writeBase(id: string, save: SessionData, source: BaseReader) {
    const gen = nextGen();
    const file = this.pathOf(id), tmp = `${file}.${process.pid}.tmp`;
    const head = `{"gen":${gen},"items":[\n`;
    const foot = `${save.items.length ? '\n' : ''}],"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
    const written = await writeLines(tmp, [{ head, items: save.items }], foot, source);
    // Windows cannot replace an open destination. Its old index stays live until the rename.
    source.close();
    const readers = this.reading.get(id);
    if (readers?.size) await Promise.allSettled(readers);
    const ids = save.items.map(i => i.id);
    const base: Base = { gen, ids, settled: settledEnd(save.items), idSet: new Set(ids), size: written.size,
      index: written.index, over: new Set(), notices: { file, prefix: head, rows: written.notices } };
    await renameRetry(tmp, file, () => { if (!this.deleted.has(id)) this.bases.set(id, base); });
  }
}

/** Windows refuses a rename while another program (a virus scanner, a reader) has the file open for a moment: try again briefly. */
async function renameRetry(from: string, to: string, commit: () => void) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      commit();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

/** Apply edits to the projected fields only. A missing image or a shortened string in the
 * original preview stands for the intact disk value. Start with disk order for byte-stable saves. */
function overlay(disk: unknown, before: unknown, now: unknown): unknown {
  if (isDeepStrictEqual(before, now)) return disk;
  if (Array.isArray(disk) && Array.isArray(before) && Array.isArray(now)) {
    // An attachment rename or an updated file count must retain that entry's hidden bytes.
    // IDs and diff paths also survive a reorder. Other arrays are replaced as a field.
    const key = (v: unknown) => v && typeof v === 'object' ? ('id' in v ? v.id : 'path' in v ? v.path : undefined) : undefined;
    if (before.every(v => typeof key(v) === 'string')) {
      // Some providers emit several patches for one path. Consume those entries in
      // their original order so two patches never inherit the same hidden hunks.
      const indexes = new Map<unknown, number[]>();
      for (let i = before.length - 1; i >= 0; i--) {
        const k = key(before[i]);
        const group = indexes.get(k);
        if (group) group.push(i);
        else indexes.set(k, [i]);
      }
      return now.map(v => {
        const at = indexes.get(key(v))?.pop();
        return at === undefined ? v : overlay(disk[at], before[at], v);
      });
    }
  }
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!record(disk) || !record(before) || !record(now)) return now;
  const out = { ...disk };
  for (const key of Object.keys(before)) if (!Object.hasOwn(now, key)) delete out[key];
  for (const key of Object.keys(now)) {
    if (!Object.hasOwn(before, key)) Object.defineProperty(out, key, { value: now[key], enumerable: true, writable: true, configurable: true });
    else if (!isDeepStrictEqual(before[key], now[key])) out[key] = overlay(disk[key], before[key], now[key]);
  }
  return out;
}

/** A descriptor pins exactly the generation that supplied the offsets through a save or fork. */
class BaseReader {
  private fd?: number;
  constructor(private file: string, private base: Base | undefined) {}

  open() {
    if (this.fd === undefined) {
      if (!this.base?.index) throw new Error('Missing session base index');
      this.fd = openSync(this.file, 'r');
      const header = `{"gen":${this.base.gen},"items":[\n`;
      if (readBytes(fs, this.fd, 0, header.length).toString() !== header) throw new Error('Session base generation changed');
    }
    return this.fd;
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  encode(item: TimelineItem): { bytes: Buffer; chars: number } {
    if (isLight(item)) {
      const line = this.base?.index?.get(item.id);
      if (line?.preview && isDeepStrictEqual(item, line.preview)) {
        return { bytes: readBytes(fs, this.open(), line.offset, line.length), chars: line.chars };
      }
    }
    const json = JSON.stringify(this.whole(item));
    return { bytes: Buffer.from(json), chars: json.length };
  }

  whole(item: TimelineItem): TimelineItem {
    if (!isLight(item)) return item;
    const line = this.base?.index?.get(item.id);
    if (!line?.preview) throw new Error('Missing original step');
    const disk = JSON.parse(readBytes(fs, this.open(), line.offset, line.length).toString());
    if (disk.id !== item.id) throw new Error('Session item offset changed');
    const { [LIGHT]: _pictures, more: _more, ...view } = item;
    if (!isLight(line.preview)) throw new Error('Missing original preview');
    const { [LIGHT]: _originalPictures, more: _originalMore, ...before } = line.preview;
    return overlay(disk, before, view) as TimelineItem;
  }
}

/** Write bounded batches. A projected item's opaque bytes pass straight from one base to the next. */
async function writeLines(file: string, sections: { head: string; items: TimelineItem[] }[], foot: string, source: BaseReader) {
  const fh = await open(file, 'w');
  const index: LineIndex = new Map();
  const notices = new Map<string, { line: Line; json: string }>();
  const sizes: number[] = [];
  let size = 0, chars = 0, pending = 0;
  let buffers: Buffer[] = [];
  const append = (bytes: Buffer) => {
    buffers.push(bytes);
    pending += bytes.length;
    size += bytes.length;
  };
  const flush = async () => {
    await fh.writeFile(Buffer.concat(buffers, pending));
    buffers = [];
    pending = 0;
  };
  try {
    for (const section of sections) {
      append(Buffer.from(section.head));
      chars += section.head.length;
      const start = chars;
      for (let i = 0; i < section.items.length; i++) {
        if (i) {
          append(Buffer.from(',\n'));
          chars += 2;
        }
        const item = section.items[i];
        const encoded = source.encode(item);
        const bytes = encoded.bytes;
        const line: Line = { offset: size, length: bytes.length, chars: encoded.chars };
        chars += line.chars;
        if (isLight(item)) line.preview = structuredClone(item);
        index.set(item.id, line);
        if (item.type === 'notice' && item.early === 'restart') notices.set(item.id, { line, json: bytes.toString() });
        append(bytes);
        if (pending >= CHUNK) await flush();
      }
      sizes.push(chars - start);
    }
    append(Buffer.from(foot));
    await flush();
    return { size: chars + foot.length, sizes, index, notices };
  } finally { await fh.close(); }
}
