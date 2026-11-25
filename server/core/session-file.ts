import { isUtf8 } from 'node:buffer';
import { largeRowReader, scanSession, sessionTail } from './session-json';
import * as fs from 'node:fs';
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { QueuedMessage, TimelineItem, Todo } from '../../shared/protocol';
import { cutItem, isLight, LIGHT, recentStart, workerCut, SNAPSHOT_THRESHOLD, snapshotEnd, turnBoundary } from './trim';

/**
 * A session's timeline on disk, as a base file and a small tail. For a large base the reader
 * keeps settled steps at their window density, with the original bytes indexed on disk.
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
export const READ = { byLineAbove: 256 * 1024 * 1024, inWorkerAbove: 16 * 1024 * 1024, part: 4 << 20, tailStream: 1 << 20, tailLimit: 32 << 20 };

type Line = { offset: number; length: number; chars: number; preview?: TimelineItem; json?: string };
function baseline(line?: Line) {
  return line?.preview ?? (line?.json ? JSON.parse(line.json) as TimelineItem : undefined);
}
type LineIndex = Map<string, Line>;
type Tail = SessionData & { baseCount?: number; baseRoots?: number; endId?: string; baseGen?: number; from?: number; over?: TimelineItem[] };
type BaseFile = { over?: TimelineItem[]; gen?: number; items: TimelineItem[]; todos?: Todo[]; queue?: QueuedMessage[] };
type IndexedRead = { stamp?: number; base: BaseFile; index?: LineIndex; tail: Tail | null };

function readBytes(io: typeof fs, fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  for (let at = 0; at < length;) {
    const n = io.readSync(fd, bytes, at, length - at, offset + at);
    if (!n) throw new Error('Incomplete session file');
    at += n;
  }
  return bytes;
}

/** A recent cut can lose a localhost announcement or the first lines of an error.
 * Flag the exceptional rows whose later old preview must come from disk. */
function project(item: TimelineItem, recent: boolean, cut: typeof cutItem, options: typeof workerCut, detach = true) {
  const view = cut(item, recent ? options.recent : options.old);
  if (view === item) return item;
  const result = item.type === 'tool' ? item.result : undefined;
  const reread = recent && item.type === 'tool' && (
    item.kind === 'bash' && ((item.input as { run_in_background?: boolean } | undefined)?.run_in_background ||
      [item.output, result?.text].some(s => s && s.length > options.recent.at && s.includes('://'))) ||
    item.status === 'error' && [result?.text, result?.stderr].some(s => s && s.length > options.recent.at)
  );
  const mark = { ...(recent && { recent: true }), ...(reread && { reread: true }),
    pictures: result?.images?.length ?? 0, hunks: !!result?.diff?.some(f => f.hunks.length),
    ...(item.type === 'tool' && item.input !== undefined ? { input: true } : {}),
    ...(item.type === 'tool' && view.type === 'tool' && view.detail.background && !item.detail.background ? { legacyBackground: true } : {}) };
  // Detach substrings from the full strings backing the parsed line.
  const marked = { ...view, [options.mark]: mark } as TimelineItem;
  // The worker message already copies the strings across heaps.
  return detach ? structuredClone(marked) : marked;
}

type Row = { tail: boolean; key: string; value: any; line?: Line };
type Header = { base: BaseFile; tail: Tail | null; stamp?: number };


/** A bounded read of complete canonical lines at the end of a base. Byte offsets
 * also let the streaming reader cut the recent rows without a second parse. */
function baseEnd(io: typeof fs, fd: number, size: number, limit: number, bytes: typeof readBytes) {
  const head = /^\{"gen":(\d+),"items":\[\n/.exec(bytes(io, fd, 0, Math.min(80, size)).toString());
  if (!head || !Number.isSafeInteger(Number(head[1])) || Number(head[1]) >= Number.MAX_SAFE_INTEGER) return;
  const start = head[0].length;
  const offset = Math.max(start, size - limit);
  const buf = bytes(io, fd, offset, size - offset);
  const nl = buf.lastIndexOf(10);
  // Older bases could end with an array of unmatched overrides. Its rows
  // have the same shape as timeline rows and cannot form a display suffix.
  if (nl < 0 || buf[nl + 1] !== 93 || buf.includes('\n],"over":[')) return;
  const footer = JSON.parse('{"items":[' + buf.toString('utf8', nl + 1));
  if (Object.keys(footer).some(k => !['items', 'todos', 'queue', 'itemCount', 'rootCount', 'endId'].includes(k)) ||
      !Array.isArray(footer.todos) || (footer.queue !== undefined && !Array.isArray(footer.queue))) return;
  // The provisional read stops at its byte budget. Hydration can keep walking
  // backwards a block at a time, even across a single multi-megabyte record.
  function *backwards(extend = false) {
    let block = buf, at = offset, cursor = nl, end = offset + nl;
    while (end > start) {
      const prev = cursor ? block.lastIndexOf(10, cursor - 1) : -1;
      if (prev < 0 && at > start) {
        if (!extend) return;
        const length = Math.min(limit, at - start);
        at -= length;
        block = bytes(io, fd, at, length);
        cursor = length;
        continue;
      }
      const begin = at + prev + 1;
      const length = end - begin;
      const inBlock = end <= at + block.length ? block.subarray(prev + 1, end - at) : undefined;
      const last = end === offset + nl;
      yield { offset: begin, after: end + 1, length, parse() {
        const line = inBlock ?? bytes(io, fd, begin, length);
        if (!last && line.at(-1) !== 44) throw new Error('Invalid session separator');
        const item = JSON.parse(line.toString('utf8', 0, length - Number(!last))) as TimelineItem;
        if (!item || typeof item.id !== 'string' || Object.hasOwn(item, '\0sable.baseStep')) throw new Error('Invalid session item');
        return item;
      } };
      if (prev < 0) break;
      end = at + prev;
      cursor = prev;
    }
  }
  return { gen: Number(head[1]), start, footer, end: offset + nl, backwards };
}

/** Bounded fast path for the writer's line format. Unusual layouts and large
 * replacement tails use the general streaming parser below. */
function scanLines(io: typeof fs, fd: number, tailFd: number | undefined, projectItems: boolean,
  cut: typeof cutItem, options: typeof workerCut, projectRow: typeof project, emit: (row: Row, bytes: number) => void,
  bytes: typeof readBytes, endOf: typeof baseEnd, large: ReturnType<typeof largeRowReader>): Header | undefined {
  const size = io.fstatSync(fd).size;
  const end = endOf(io, fd, size, 4 << 20, bytes);
  if (!end) return;
  let tail: Tail | null = null;
  let count: number | undefined = end.footer.itemCount;
  if (tailFd !== undefined) {
    const tailSize = io.fstatSync(tailFd).size;
    if (tailSize > 4 << 20) return;
    tail = JSON.parse(bytes(io, tailFd, 0, tailSize).toString());
    if (!tail || !Array.isArray(tail.items) || tail.over && !Array.isArray(tail.over)) return;
    if (tail.baseGen !== end.gen) tail = null;
    // A pre-count on older files needs only line separators, no text decoding.
    count ??= tail?.baseCount;
    if (tail && !Number.isSafeInteger(count)) {
      const chunk = Buffer.allocUnsafe(1 << 20);
      count = 0;
      for (let at = end.start; at <= end.end;) {
        const n = io.readSync(fd, chunk, 0, Math.min(chunk.length, end.end + 1 - at), at);
        if (!n) throw Error('Incomplete session');
        const part = chunk.subarray(0, n);
        for (let i = part.indexOf(10); i >= 0; i = part.indexOf(10, i + 1)) count++;
        at += n;
      }
    }
  }
  const from = tail && Number.isInteger(tail.from) && tail.from! >= 0 && tail.from! <= count! ? tail.from! : Infinity;
  const over = new Map(tail?.over?.map(i => [i.id, i]));
  let skip = Math.max(0, (count ?? 0) - from);
  let turns = tail?.items.filter(i => i.type === 'turn').length ?? 0;
  let recent = turns > options.turns ? Infinity : end.start;
  const maxTurnBytes = 8192;
  if (recent !== Infinity && projectItems) {
    for (const row of end.backwards(true)) {
      if (skip-- > 0) continue;
      // Turn records are small. Validate this assumption below on the forward
      // pass, including tail overrides, before accepting the projection.
      if (row.length > maxTurnBytes) continue;
      const item = row.parse();
      if ((over.get(item.id) ?? item).type === 'turn' && ++turns > options.turns) { recent = row.after; break; }
    }
  }
  let ordinal = 0, offset = end.start;
  const block = Buffer.allocUnsafe(1 << 20);
  const projectOld = (item: TimelineItem) => projectRow(item, false, cut, options, false);
  const projectRecent = (item: TimelineItem) => projectRow(item, true, cut, options, false);
  let parts: Buffer[] = [];
  for (let at = offset; at <= end.end;) {
    const n = io.readSync(fd, block, 0, Math.min(block.length, end.end + 1 - at), at);
    if (!n) throw Error('Incomplete session');
    const chunk = block.subarray(0, n);
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      const last = at + nl === end.end;
      let buffer = chunk, begin = start, stop = nl;
      if (parts.length) {
        parts.push(chunk.subarray(start, nl));
        buffer = Buffer.concat(parts);
        begin = 0;
        stop = buffer.length;
        parts = [];
      }
      if (!last && buffer[stop - 1] !== 44) throw Error('Invalid session separator');
      const length = stop - begin - Number(!last);
      const isRecent = offset >= recent;
      let compact;
      if (length >= 32 << 10 && projectItems && ordinal < from) {
        try { compact = large(buffer.subarray(begin, begin + length), isRecent, isRecent ? projectRecent : projectOld); }
        catch { /* An ambiguous candidate still gets one ordinary parse of its full record. */ }
      }
      let value = compact?.value, chars = compact?.chars ?? 0;
      if (!value) {
        const json = buffer.toString('utf8', begin, begin + length);
        const item = JSON.parse(json);
        if (!item || typeof item.id !== 'string' || Object.hasOwn(item, options.mark)) throw Error('Invalid session item');
        chars = json.length;
        value = ordinal >= from ? { id: item.id, type: item.type, parentId: item.parentId } :
          projectItems ? projectRow(item, isRecent, cut, options, false) : item;
      }
      if (!value || typeof value.id !== 'string') throw Error('Invalid session item');
      if (stop - begin > maxTurnBytes && isRecent && ordinal < from && (over.get(value.id) ?? value).type === 'turn')
        throw Error('Oversized turn record');
      emit({ key: 'items', tail: false, value, line: { offset, length, chars } }, length);
      ordinal++;
      start = nl + 1;
      offset = at + start;
    }
    if (start < n) parts.push(Buffer.from(chunk.subarray(start)));
    at += n;
  }
  if (count !== undefined && ordinal !== count) throw Error('Session row count changed');
  return { base: { ...end.footer, gen: end.gen, items: [] }, tail };
}

type TurnPosition = { id: string; turn: boolean; at?: number; retained?: boolean };

function turnPositions(turns: number) {
  const over = new Map<string, boolean>();
  const all: number[] = [], head: number[] = [];
  function remember(list: number[], index: number) {
    list.push(index);
    if (list.length > turns + 1) list.shift();
  }
  return {
    add(pos: TurnPosition) {
      if (pos.at === undefined) over.set(pos.id, pos.turn);
      else {
        if (pos.turn) remember(all, pos.at);
        if (pos.retained && (over.get(pos.id) ?? pos.turn)) remember(head, pos.at);
      }
    },
    start(active: boolean, suffix: number, count: number) {
      over.clear();
      const needed = turns - (active ? suffix : 0);
      return needed < 0 ? count : ((active ? head : all).at(-needed - 1) ?? -1) + 1;
    },
  };
}

/** The first pass locates the last few turns in both possible prefixes. Only their ordinals
 * and the override types are retained. The second pass sends the actual projection of each row. */
function scanIndexed(io: typeof fs, file: string, tailFile: string | undefined, cut: typeof cutItem,
  options: typeof workerCut, scan: typeof scanSession, projectRow: typeof project, merge: typeof sessionTail,
  positions: ReturnType<typeof turnPositions>, fast: typeof scanLines, bytes: typeof readBytes, endOf: typeof baseEnd, large: ReturnType<typeof largeRowReader>, reset: () => void, emit: (row: Row, bytes: number) => void): Header {
  const fd = io.openSync(file, 'r');
  let tailFd: number | undefined;
  try {
    const stat = io.fstatSync(fd);
    let hasOverrides = false;
    let suffixTurns = 0;
    let tail: Tail | null = null;
    if (tailFile) {
      try { tailFd = io.openSync(tailFile, 'r'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
    try {
      const canonicalRead = fast(io, fd, tailFd, !!tailFile, cut, options, projectRow, emit, bytes, endOf, large);
      if (canonicalRead) return canonicalRead;
    } catch {
      // A valid JSON base can wrap lines differently or include an over section.
      // Discard any speculative batches before the general parser validates it.
      reset();
    }
    if (tailFd !== undefined) {
      tail = scan(io, tailFd, (key, item) => {
        if (key === 'over' && item) {
          hasOverrides = true;
          positions.add({ id: item.id, turn: item.type === 'turn' });
        }
        if (key === 'items' && item?.type === 'turn') suffixTurns++;
      }) as Tail;
    }
    const limit = tail && Number.isInteger(tail.from) && tail.from! >= 0 ? tail.from! : Infinity;
    let count = 0;
    const base = scan(io, fd, (key, item) => {
      if (key !== 'items') return;
      if (!item || typeof item.id !== 'string' || Object.hasOwn(item, options.mark)) throw new Error('Invalid session item');
      if (item.type === 'turn' || hasOverrides && count < limit) {
        positions.add({ id: item.id, at: count, turn: item.type === 'turn', retained: count < limit });
      }
      count++;
    }) as BaseFile;
    const from = merge(base.gen, stat.mtimeMs, tail, count, new Map())?.from ?? null;
    const recent = positions.start(from !== null, suffixTurns, count);
    count = 0;
    scan(io, fd, (key, value, offset, length, chars) => {
      const line = key === 'items' ? { offset, length, chars } : undefined;
      if (line && tailFile) {
        // The suffix is validated, but its obsolete bodies never travel beside the quit tail.
        if (from !== null && count >= from) value = { id: value.id, type: value.type, parentId: value.parentId };
        else value = projectRow(value, count >= recent, cut, options, false);
        count++;
      }
      emit({ key, tail: false, value, line }, length);
    });
    if (tailFd !== undefined && from !== null) scan(io, tailFd, (key, value, _offset, length) => emit({ key, tail: true, value }, length));
    // Legacy and compact files have no canonical generation header to verify at seek time.
    const head = Buffer.alloc(80);
    const n = io.readSync(fd, head, 0, head.length, 0);
    const canonical = head.toString('utf8', 0, n).startsWith(`{"gen":${base.gen},"items":[\n`);
    return { base, tail: from === null ? null : tail, ...(!canonical && { stamp: stat.mtimeMs }) };
  } finally { if (tailFd !== undefined) io.closeSync(tailFd); io.closeSync(fd); }
}

/** Keep the compact baseline as immutable JSON. Crossing heaps copies one
 * string, and parsing it creates the separately mutable runtime row. */
function packRow(row: Row, mark: string) {
  if (row.line && Object.hasOwn(row.value, mark)) {
    row.line.json = JSON.stringify(row.value);
    row.value = { id: row.value.id };
  }
  return row;
}

function collectRead() {
  const base: Record<string, any[]> = Object.create(null), tail: Record<string, any[]> = Object.create(null);
  const index: LineIndex = new Map();
  return {
    reset() {
      for (const key of Object.keys(base)) delete base[key];
      for (const key of Object.keys(tail)) delete tail[key];
      index.clear();
    },
    add({ key, tail: suffix, value, line }: Row) {
      ((suffix ? tail : base)[key] ??= []).push(line?.json ? JSON.parse(line.json) : value);
      if (line) {
        if (index.has(value.id)) throw new Error('Duplicate session item');
        index.set(value.id, line);
      }
    },
    finish(header: Header): IndexedRead {
      return { ...header, base: Object.assign(header.base, base), tail: header.tail && Object.assign(header.tail, tail), index };
    },
  };
}

function readIndexed(file: string, tailFile?: string) {
  const rows = collectRead();
  return rows.finish(scanIndexed(fs, file, tailFile, cutItem, workerCut, scanSession, project, sessionTail, turnPositions(workerCut.turns), scanLines, readBytes, baseEnd, largeRowReader(isUtf8, workerCut), rows.reset, row => rows.add(packRow(row, LIGHT))));
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const __name = f => f;
const { options, ack, part } = workerData;
const pack = (${packRow});
const { cutItem } = (${workerCut.factory})(options.recent, options.keepFiles, (${workerCut.task}));
let rows = [], bytes = 0, positions = [];
function send(message) {
  Atomics.store(ack, 0, 0);
  parentPort.postMessage(message);
  Atomics.wait(ack, 0, 0);
}
function flush() {
  if (rows.length) send({ rows });
  rows = [];
  bytes = 0;
}
const layout = {
  add(position) {
    positions.push(position);
    if ((bytes += 40 + 2 * position.id.length) >= part) {
      send({ positions });
      positions = [];
      bytes = 0;
    }
  },
  start(active, suffix, count) {
    send({ positions, boundary: { active, suffix, count } });
    positions = [];
    bytes = 0;
    return workerData.start[0];
  }
};
try {
  const header = (${scanIndexed})(require('node:fs'), workerData.file, workerData.tail, cutItem, options,
    (${scanSession}), (${project}), (${sessionTail}), layout, (${scanLines}), (${readBytes}), (${baseEnd}), (${largeRowReader})(require('node:buffer').isUtf8, options), () => { rows = []; bytes = 0; send({ reset: true }); }, (row, length) => {
      rows.push(pack(row, options.mark));
      if ((bytes += length) >= part) flush();
    });
  flush();
  parentPort.postMessage({ header });
} catch { parentPort.postMessage({ failed: true }); }
`;

function readInWorker(file: string, tail: string): Promise<Read<IndexedRead>> {
  return new Promise(resolve => {
    const ack = new Int32Array(new SharedArrayBuffer(4));
    const collected = collectRead();
    const layout = turnPositions(workerCut.turns);
    const start = new Float64Array(new SharedArrayBuffer(8));
    const w = new Worker(WORKER, { eval: true, workerData: { file, tail, options: workerCut, ack, start, part: READ.part },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 24 } });
    w.on('message', (msg: { reset?: boolean; positions?: TurnPosition[]; boundary?: { active: boolean; suffix: number; count: number }; rows?: Row[]; header?: Header }) => {
      try {
        if (msg.reset) collected.reset();
        else if (msg.positions) {
          for (const pos of msg.positions) layout.add(pos);
          const b = msg.boundary;
          if (b) start[0] = layout.start(b.active, b.suffix, b.count);
        } else if (msg.rows) {
          for (const row of msg.rows) collected.add(row);
        } else {
          resolve(msg.header ? { ok: true, value: collected.finish(msg.header) } : { ok: false });
          return;
        }
        Atomics.store(ack, 0, 1);
        Atomics.notify(ack, 0);
      } catch {
        resolve({ ok: false });
        void w.terminate();
      }
    });
    w.once('error', () => resolve({ ok: false }));
    w.once('exit', () => resolve({ ok: false }));
  });
}
/** Bytes batched per asynchronous write. */
const CHUNK = 1 << 20;

interface Base {
  count: number;
  roots: number;
  index?: LineIndex;
  stamp?: number;
  orphans?: TimelineItem[];
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
    return { ok: true, value: readIndexed(file).base };
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
  private warned = new Set<string>();
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

  constructor(private readonly pathOf: (id: string) => string,
    private readonly compactLive?: (id: string, saved: TimelineItem, preview: TimelineItem) => void) {}

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

  private large(fileSize: number, id: string) {
    let tailSize = 0;
    try { tailSize = statSync(this.tailOf(id)).size; } catch { /* The reader handles missing and unreadable files. */ }
    return fileSize + tailSize >= READ.inWorkerAbove || fileSize > READ.byLineAbove || tailSize > READ.tailStream;
  }


  /** Display-only, never installs an index or changes the file's read/write state. */
  readEnd(id: string) {
    let fd: number | undefined, tailFd: number | undefined;
    try {
      fd = openSync(this.pathOf(id), 'r');
      const size = fs.fstatSync(fd).size;
      const limit = 2 << 20;
      if (size < 64 << 10) return;
      const end = baseEnd(fs, fd, size, limit, readBytes);
      if (!end || size < limit && end.footer.itemCount === undefined) return;
      let count = end.footer.itemCount, roots = end.footer.rootCount;
      if (count !== undefined && (!Number.isSafeInteger(count) || count <= SNAPSHOT_THRESHOLD ||
        !Number.isSafeInteger(roots) || roots < 0 || roots > count)) return;
      try { tailFd = openSync(this.tailOf(id), 'r'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      let tail: Tail | null = null, from = count;
      const valid = (item: TimelineItem) => item && typeof item.id === 'string' && typeof item.type === 'string' && !isLight(item);
      if (tailFd !== undefined) {
        const length = fs.fstatSync(tailFd).size;
        if (length > limit) return;
        tail = JSON.parse(readBytes(fs, tailFd, 0, length).toString());
        if (tail?.baseCount !== undefined) {
          if (count !== undefined && (count !== tail.baseCount || roots !== tail.baseRoots)) return;
          count = tail.baseCount;
          roots = tail.baseRoots;
        }
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(roots) || roots < 0 || roots > count) return;
        if (!tail || tail.baseGen !== end.gen || !Number.isSafeInteger(tail.from) || tail.from! < 0 || tail.from! > count ||
            !Array.isArray(tail.items) || !tail.items.every(valid) ||
            tail.over !== undefined && (!Array.isArray(tail.over) || !tail.over.every(valid)) ||
            tail.todos !== undefined && !Array.isArray(tail.todos) || tail.queue !== undefined && !Array.isArray(tail.queue)) return;
        from = sessionTail(end.gen, 0, tail, count, new Map())!.from;
      }
      const over = new Map(tail?.over?.map(item => [item.id, item]));
      const suffix = tail?.items ?? [];
      const reverse: TimelineItem[] = [];
      const endId = tail ? tail.endId : end.footer.endId;
      let found = !endId || suffix.some(i => i.id === endId);
      let prompts = suffix.filter(turnBoundary).length;
      let skip = count === undefined ? 0 : count - from;
      let omittedRoots = roots;
      for (const record of end.backwards()) {
        const item = record.parse();
        if (!valid(item)) return;
        if (skip > 0) { skip--; if (!item.parentId) omittedRoots--; continue; }
        if (prompts >= 9 && found && !over.size) break;
        const replacement = over.get(item.id) ?? item;
        over.delete(item.id);
        if (!item.parentId) omittedRoots--;
        reverse.push(replacement);
        if (replacement.id === endId) found = true;
        if (turnBoundary(replacement)) prompts++;
      }
      if (skip || over.size || !found || prompts < 9) return;
      const rows = reverse.reverse().concat(suffix);
      if (new Set(rows.map(i => i.id)).size !== rows.length) return;
      const start = snapshotEnd(rows).start;
      if (!turnBoundary(rows[start]) || endId && rows[start].id !== endId) return;
      const before = count === undefined ? -1 : from - reverse.length + start;
      if (count !== undefined && (before < 0 || omittedRoots < 0 || from + suffix.length <= SNAPSHOT_THRESHOLD)) return;
      for (let i = 0; i < start; i++) if (!rows[i].parentId) omittedRoots++;
      return { items: rows.slice(start), todos: tail?.todos ?? end.footer.todos as Todo[],
        queue: (tail?.queue ?? end.footer.queue ?? []) as QueuedMessage[],
        page: { kind: 'provisional' as const, before, rootsBefore: count === undefined ? -1 : omittedRoots,
          recentAt: Math.max(0, recentStart(rows, workerCut.turns) - start) } };
    } catch { return; }
    finally { if (tailFd !== undefined) closeSync(tailFd); if (fd !== undefined) closeSync(fd); }
  }

  load(id: string): SessionData {
    const file = this.pathOf(id);
    let size: number, mtime: number;
    try { ({ size, mtimeMs: mtime } = statSync(file)); }
    catch (err) {
      return this.finish(id, (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, value: null } : { ok: false }, 0, 0);
    }
    if (this.large(size, id)) {
      try {
        const loaded = readIndexed(file, this.tailOf(id));
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
    if (!this.large(stat.size, id)) return this.load(id);
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
    const invalidOverrides = (over?: TimelineItem[]) => over !== undefined && (!Array.isArray(over) || over.some(invalid));
    if (!Array.isArray(base.items) || invalidOverrides(base.over) || (!loaded?.index && items.some(invalid)) ||
      (tail?.baseGen === gen && (!Array.isArray(tail.items) || tail.items.some(invalid) || invalidOverrides(tail.over)))) {
      this.unreadable.add(id);
      return { items: [], todos: [], unreadable: true };
    }
    let from = items.length;
    let data: SessionData = { items, todos: base.todos ?? [], queue: base.queue };
    const over = new Set<string>();
    let orphans = base.over ?? [];
    const newer = new Map(tail?.baseGen === gen && Array.isArray(tail.over) ? tail.over.map(i => [i.id, i]) : []);
    const merge = sessionTail(base.gen, mtime, tail, items.length, newer);
    if (tail && merge) {
      from = merge.from;
      let head = items.slice(0, from);
      // Settled items changed since the base was written: their newest form, in their place.
      if (newer.size) {
        head = head.map((i) => {
          const n = merge.item(i.id, i);
          if (newer.delete(i.id)) over.add(i.id);
          return n;
        });
        orphans = [...new Map([...orphans, ...newer.values()].map(item => [item.id, item])).values()];
      }
      data = { items: head.concat(tail.items), todos: tail.todos ?? base.todos ?? [], queue: tail.queue ?? base.queue };
    }
    const settled = items.slice(0, from).map((i) => i.id);
    if (orphans.length && !this.warned.has(id)) {
      this.warned.add(id);
      console.warn('Preserving unmatched session overrides', id, orphans.length);
    }
    this.bases.set(id, { gen, count: items.length, roots: items.reduce((n, i) => n + Number(!i.parentId), 0), orphans, stamp: loaded?.stamp, index: loaded?.index, ids: settled, settled: from, idSet: new Set(settled), size, old, over });
    return data;
  }

  /** Re-cut only rows backed by this generation. Tail replacements have their own whole data. */
  recut(id: string, item: TimelineItem, recent: boolean): TimelineItem {
    const base = this.bases.get(id);
    const line = base?.index?.get(item.id);
    if (!line || base?.over.has(item.id)) return item;
    if (isLight(item) && !!item[LIGHT].recent === recent) return item;
    const source = new BaseReader(this.pathOf(id), base);
    try {
      const clean = isDeepStrictEqual(item, baseline(line));
      let view: TimelineItem;
      if (isLight(item) && !recent && !item[LIGHT].reread) {
        const { [LIGHT]: mark, ...row } = item;
        const { recent: _recent, reread: _reread, ...meta } = mark;
        view = Object.assign(cutItem(row, workerCut.old), { [LIGHT]: meta });
      } else {
        const whole = source.whole(item);
        view = project(whole, recent, cutItem, workerCut);
        if (view === item) return item;
        if (!isLight(item) && !isDeepStrictEqual(item, source.original(line))) return item;
      }
      // A frozen save may still have the other cut. BaseReader reconstructs that baseline from disk.
      if (clean || !isLight(item)) {
        delete line.json;
        line.preview = isLight(view) ? structuredClone(view) : undefined;
      }
      return view;
    } finally { source.close(); }
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
    return { items: items.map((item, i) => this.recut(destId, item, i >= recent)), todos: [] };
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
    // Prefer the existing generation at quit when the suffix fits. A rewind can shorten the matching prefix.
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
    if (!whole && base?.orphans?.length) {
      const ids = new Set(base.orphans.map(item => item.id));
      const conflict = items.findIndex(item => ids.has(item.id));
      if (conflict >= 0) from = Math.min(from, conflict);
    }
    const overItems: TimelineItem[] = [];
    if (!whole && base) {
      over = new Set(base.over);
      if (save.dirty !== 'all') for (const d of save.dirty) if (base.idSet.has(d)) over.add(d);
      if (final && (save.dirty === 'all' || this.force.has(id))) over = new Set(base.ids.slice(0, from));
      if (over.size) for (let i = 0; i < from; i++) {
        const item = items[i];
        if (over.has(item.id) && isLight(item) && isDeepStrictEqual(item, baseline(base.index?.get(item.id)))) over.delete(item.id);
        if (over.has(item.id)) overItems.push(item);
      }
      if (!final && overItems.length > OVER_MAX.items) whole = true;
    }
    if (!whole && base && over) {
      const tmp = `${this.tailOf(id)}.${process.pid}.tmp`;
      const head = `{"baseGen":${base.gen},"from":${from},"items":[\n`;
      const endId = final && items.length > SNAPSHOT_THRESHOLD ? items[snapshotEnd(items).start].id : undefined;
      const end = `\n],"baseCount":${base.count},"baseRoots":${base.roots}${endId ? ',"endId":' + JSON.stringify(endId) : ''},"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
      const source = new BaseReader(this.pathOf(id), base);
      let written;
      try {
        written = await writeLines(tmp, [{ head, items: items.slice(from) }, { head: '\n],"over":[\n', items: overItems.concat(base.orphans ?? []) }], end, source, READ.tailLimit);
      } catch (err) {
        if (!(err instanceof TailTooLarge)) throw err;
      } finally { source.close(); }
      const [tailSize, overSize] = written?.sizes ?? [];
      // A big tail folds into the base only when that moves the boundary well on: otherwise a few
      // huge items at the end would have the whole base written again on every save. Changed
      // settled items past their bound go into the base too.
      if (written && (final || (overSize <= OVER_MAX.chars && (tailSize <= TAIL_MAX || settledEnd(items) < from + TAIL_KEEP)))) {
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
    let committed: Base;
    try { committed = await this.writeBase(id, { ...save, items }, source, base?.orphans); }
    finally { source.close(); }
    this.force.delete(id);
    // The new base holds everything: the old tail no longer matches it (and is ignored if this fails).
    try {
      rmSync(this.tailOf(id), { force: true });
    } catch {
      /* ignored on the next read: its baseGen is another */
    }
    if (!final && this.compactLive && committed.size >= READ.inWorkerAbove) {
      const recent = recentStart(items, workerCut.turns);
      let since = performance.now();
      for (let i = 0; i < items.length; i++) {
        if (performance.now() - since > 8) {
          await new Promise<void>(resolve => setImmediate(resolve));
          since = performance.now();
        }
        if (this.bases.get(id) !== committed) break;
        const item = items[i];
        if (isLight(item)) continue;
        const view = project(item, i >= recent, cutItem, workerCut);
        if (view !== item) {
          committed.index!.get(item.id)!.preview = structuredClone(view);
          this.compactLive(id, item, view);
        }
      }
    }
  }

  private async writeBase(id: string, save: SessionData, source: BaseReader, orphans?: TimelineItem[]) {
    const gen = nextGen();
    const file = this.pathOf(id), tmp = `${file}.${process.pid}.tmp`;
    const head = `{"gen":${gen},"items":[\n`;
    const roots = save.items.reduce((n, i) => n + Number(!i.parentId), 0);
    const endId = save.items.length > SNAPSHOT_THRESHOLD ? save.items[snapshotEnd(save.items).start].id : undefined;
    const counts = endId ? `,"endId":${JSON.stringify(endId)}${orphans?.length ? ',"hasOver":true' : ''},"itemCount":${save.items.length},"rootCount":${roots}` : '';
    const foot = `${save.items.length ? '\n' : ''}]${counts},"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}}`;
    const sections = [{ head, items: save.items }];
    if (orphans?.length) sections.push({ head: '\n],"over":[\n', items: orphans });
    const written = await writeLines(tmp, sections, foot, source);
    // Windows cannot replace an open destination. Its old index stays live until the rename.
    source.close();
    const readers = this.reading.get(id);
    if (readers?.size) await Promise.allSettled(readers);
    const ids = save.items.map(i => i.id);
    const base: Base = { gen, count: save.items.length, roots, orphans, ids, settled: settledEnd(save.items), idSet: new Set(ids), size: written.size,
      index: written.index, over: new Set(), notices: { file, prefix: head, rows: written.notices } };
    await renameRetry(tmp, file, () => { if (!this.deleted.has(id)) this.bases.set(id, base); });
    return base;
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
      if (this.base.stamp !== undefined ? fs.fstatSync(this.fd).mtimeMs !== this.base.stamp : readBytes(fs, this.fd, 0, header.length).toString() !== header) throw new Error('Session base generation changed');
    }
    return this.fd;
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  encode(item: TimelineItem): { bytes: Buffer; chars: number } {
    let whole: TimelineItem = item;
    if (isLight(item)) {
      const line = this.base?.index?.get(item.id);
      if (!line) throw new Error('Missing original step');
      const bytes = readBytes(fs, this.open(), line.offset, line.length);
      if (isDeepStrictEqual(item, baseline(line))) return { bytes, chars: line.chars };
      const disk = JSON.parse(bytes.toString());
      whole = this.merge(item, line, disk);
      if (whole === disk) return { bytes, chars: line.chars };
    }
    const json = JSON.stringify(whole);
    return { bytes: Buffer.from(json), chars: json.length };
  }

  original(line: Line): TimelineItem {
    return JSON.parse(readBytes(fs, this.open(), line.offset, line.length).toString());
  }

  whole(item: TimelineItem): TimelineItem {
    if (!isLight(item)) return item;
    const line = this.base?.index?.get(item.id);
    if (!line) throw new Error('Missing original step');
    return this.merge(item, line, this.original(line));
  }

  private merge(item: TimelineItem, line: Line, disk: TimelineItem) {
    if (!isLight(item)) return item;
    if (disk.id !== item.id) throw new Error('Session item offset changed');
    const { [LIGHT]: _pictures, more: _more, ...view } = item;
    const saved = baseline(line);
    const originalView = saved && isLight(saved) && !!saved[LIGHT].recent === !!item[LIGHT].recent
      ? saved : project(disk, !!item[LIGHT].recent, cutItem, workerCut);
    if (!isLight(originalView)) return overlay(disk, originalView, view) as TimelineItem;
    const { [LIGHT]: _originalPictures, more: _originalMore, ...before } = originalView;
    return overlay(disk, before, view) as TimelineItem;
  }
}

class TailTooLarge extends Error {}

/** Write bounded batches. A projected item's opaque bytes pass straight from one base to the next. */
async function writeLines(file: string, sections: { head: string; items: TimelineItem[] }[], foot: string, source: BaseReader, limit = Infinity) {
  const fh = await open(file, 'w');
  const index: LineIndex = new Map();
  const notices = new Map<string, { line: Line; json: string }>();
  const sizes: number[] = [];
  let size = 0, chars = 0, pending = 0;
  let buffers: Buffer[] = [];
  const append = (bytes: Buffer) => {
    if (size + bytes.length > limit) throw new TailTooLarge();
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
        if (section === sections[0]) index.set(item.id, line);
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
