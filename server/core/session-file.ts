import { constants as bufferLimits, isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { largeRowReader, scanSession, sessionTail } from './session-json';
import * as fs from 'node:fs';
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { open, rename, stat, statfs, unlink } from 'node:fs/promises';
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
/** The optional private restore shares the bridge with the already resident tail, so it is bounded: by the
 *  size a tail reaches before it is folded anyway. (A cap of 1 MiB kept every long chat that rests with a
 *  tail of a few megabytes, which is the usual case, from ever being brought over.) */
const MIGRATION_TAIL_MAX = TAIL_MAX;
// The optional writer allocates a replacement offset map, even for a byte-for-byte copy.
const MIGRATION_ROWS_MAX = 131_072;
const PRIVATE_ROW_MAX = 16 << 20;
const PRIVATE_PAYLOAD_MAX = 64 << 20;
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

function fitsPrivateRead(baseSize: number, tailSize: number, index?: LineIndex) {
  if (!index) return baseSize <= PRIVATE_ROW_MAX;
  // Charge raw footer/metadata and uncut rows. A packed preview takes at most two
  // bytes per UTF-16 unit. A private parser may still need one original row at a time.
  let bytes = baseSize + tailSize;
  for (const line of index.values()) {
    if (line.length > PRIVATE_ROW_MAX) return false;
    if (line.json) bytes += 2 * line.json.length - line.length;
  }
  return bytes <= PRIVATE_PAYLOAD_MAX;
}
type Tail = SessionData & { baseCount?: number; baseRoots?: number; endId?: string; baseGen?: number; from?: number; over?: TimelineItem[] };
type BaseFile = { over?: TimelineItem[]; gen?: number; itemCount?: number; items: TimelineItem[]; todos?: Todo[]; queue?: QueuedMessage[] };
type IndexedRead = Header & { index?: LineIndex };

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
  // A cut already owns its outer object. Only local reads need to detach
  // substrings from the parsed line; crossing heaps does that for the worker.
  Object.assign(view, { [options.mark]: mark });
  return detach ? structuredClone(view) : view;
}

type Row = { tail: boolean; key: string; value: any; line?: Line };
type Header = { base: BaseFile; tail: Tail | null; stamp?: number; copyLines?: boolean };


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
  const footerText = buf.toString('utf8', nl + 1);
  const footer = JSON.parse('{"items":[' + footerText);
  if (Object.keys(footer).some(k => !['items', 'todos', 'queue', 'itemCount', 'rootCount', 'endId', 'foldedTail'].includes(k)) ||
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
      yield {
        offset: begin, after: end + 1, length,
        // JSON can spell a turn with Unicode escapes. Everything else is
        // validated on the forward pass even when the reverse lookup skips it.
        couldBeTurn: () => !inBlock || inBlock.includes('"turn"') || inBlock.includes('\\u'),
        parse() {
          const line = inBlock ?? bytes(io, fd, begin, length);
          if (!last && line.at(-1) !== 44) throw new Error('Invalid session separator');
          const item = JSON.parse(line.toString('utf8', 0, length - Number(!last))) as TimelineItem;
          if (!item || typeof item.id !== 'string' || Object.hasOwn(item, '\0sable.baseStep')) throw new Error('Invalid session item');
          return item;
        },
      };
      if (prev < 0) break;
      end = at + prev;
      cursor = prev;
    }
  }
  const emptyFooter = footerText === '],"todos":[]}' || footerText === '],"todos":[],"queue":[]}';
  return { gen: Number(head[1]), start, footer, emptyFooter, end: offset + nl, backwards };
}

/** Bounded fast path for the writer's line format. Unusual layouts and large
 * replacement tails use the general streaming parser below. */
function scanLines(io: typeof fs, fd: number, tailFd: number | undefined, projectItems: boolean,
  cut: typeof cutItem, options: typeof workerCut, projectRow: typeof project, emit: (row: Row, bytes: number) => void,
  bytes: typeof readBytes, endOf: typeof baseEnd, large: ReturnType<typeof largeRowReader>, requireEmptyFooter = false): Header | undefined {
  const size = io.fstatSync(fd).size;
  const end = endOf(io, fd, size, 4 << 20, bytes);
  if (!end || requireEmptyFooter && !end.emptyFooter) return;
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
      if (row.length > maxTurnBytes || !over.size && !row.couldBeTurn()) continue;
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
      if (length >= (isRecent ? 32 << 10 : 4 << 10) && projectItems && ordinal < from) {
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
  return { base: { ...end.footer, gen: end.gen, items: [] }, tail, copyLines: end.emptyFooter };
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
  positions: ReturnType<typeof turnPositions>, fast: typeof scanLines, bytes: typeof readBytes, endOf: typeof baseEnd, large: ReturnType<typeof largeRowReader>, reset: () => void, emit: (row: Row, bytes: number) => void,
  migrationTailLimit?: number, expected?: { base: fs.Stats; tail?: fs.Stats }, matches = sameFile): Header {
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
    if (expected && (!matches(expected.base, stat) || !matches(expected.tail, tailFd === undefined ? undefined : io.fstatSync(tailFd))))
      throw Error('Changed migration source');
    if (migrationTailLimit !== undefined && tailFd !== undefined) {
      if (io.fstatSync(tailFd).size > migrationTailLimit) throw Error('Large migration tail');
      scan(io, tailFd, () => {}, 'tail');
    }
    try {
      const canonicalRead = fast(io, fd, tailFd, !!tailFile, cut, options, projectRow, emit, bytes, endOf, large, migrationTailLimit !== undefined);
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
    }, migrationTailLimit === undefined ? undefined : 'base') as BaseFile;
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
    // A replacer forces even ordinary rows through the slow JSON encoder.
    // Check the cut value and leave the normal pack on the native fast path.
    function losesNumber(value: unknown): boolean {
      if (typeof value === 'number') return !Number.isFinite(value) || Object.is(value, -0);
      if (value && typeof value === 'object') {
        const fields = value as Record<string, unknown>;
        for (const key in fields) if (losesNumber(fields[key])) return true;
      }
      return false;
    }
    if (!losesNumber(row.value)) {
      row.line.json = JSON.stringify(row.value);
      row.value = { id: row.value.id };
    } else row.line.preview = structuredClone(row.value);
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
  return rows.finish(scanIndexed(fs, file, tailFile, cutItem, workerCut, scanSession, project, sessionTail, turnPositions(workerCut.turns), scanLines, readBytes, baseEnd, largeRowReader(isUtf8, workerCut, bufferLimits.MAX_STRING_LENGTH), rows.reset, row => rows.add(packRow(row, LIGHT))));
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const __name = f => f;
const { options, ack, part } = workerData;
const pack = (${packRow});
const { cutItem } = (${workerCut.factory})(options.recent, options.keepFiles, (${workerCut.task}));
let rows = [], bytes = 0, positions = [];
function send(message) {
  // At most one batch in flight while the worker builds the next one.
  Atomics.wait(ack, 0, 0);
  Atomics.store(ack, 0, 0);
  parentPort.postMessage(message);
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
    Atomics.wait(ack, 0, 0);
    positions = [];
    bytes = 0;
    return workerData.start[0];
  }
};
try {
  const header = (${scanIndexed})(require('node:fs'), workerData.file, workerData.tail, cutItem, options,
    (${scanSession}), (${project}), (${sessionTail}), layout, (${scanLines}), (${readBytes}), (${baseEnd}), (${largeRowReader})(require('node:buffer').isUtf8, options, require('node:buffer').constants.MAX_STRING_LENGTH), () => { rows = []; bytes = 0; send({ reset: true }); }, (row, length) => {
      rows.push(pack(row, options.mark));
      // A cut image crosses heaps as a small packed row. Budget that payload
      // and cap the row count so the main thread only installs a short batch.
      bytes += row.line?.json ? 2 * row.line.json.length + 128 : length;
      if (bytes >= part || rows.length >= 128) flush();
    }, workerData.migrationTailLimit, workerData.source, (${sameFile}));
  flush();
  parentPort.postMessage({ header });
} catch { parentPort.postMessage({ failed: true }); }
`;

function readInWorker(file: string, tail: string, guard?: { check(): void; signal: AbortSignal; source: { base: fs.Stats; tail?: fs.Stats } }): Promise<Read<IndexedRead>> {
  return new Promise(resolve => {
    const ack = new Int32Array(new SharedArrayBuffer(4));
    ack[0] = 1;
    const collected = collectRead();
    const layout = turnPositions(workerCut.turns);
    const start = new Float64Array(new SharedArrayBuffer(8));
    const w = new Worker(WORKER, { eval: true, workerData: { file, tail, options: workerCut, ack, start, part: READ.part, migrationTailLimit: guard && MIGRATION_TAIL_MAX, source: guard?.source },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 24 } });
    const stop = () => { void w.terminate(); };
    guard?.signal.addEventListener('abort', stop, { once: true });
    w.on('message', (msg: { reset?: boolean; positions?: TurnPosition[]; boundary?: { active: boolean; suffix: number; count: number }; rows?: Row[]; header?: Header }) => {
      try {
        guard?.check();
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
    w.once('exit', () => {
      guard?.signal.removeEventListener('abort', stop);
      resolve({ ok: false });
    });
  });
}
/** Bytes batched per asynchronous write. */
const CHUNK = 1 << 20;

/** Everything the counted writer needs for an unchanged indexed base with an empty footer.
 * Its IDs and offsets belong to the reader. No mutable runtime row is retained by the idle job. */
type DiskLayout = { ids: string[]; idSet: Set<string>; roots: number; settled: number; endId: string; todos: Todo[]; queue?: QueuedMessage[] };
type MigrationWrite = { tmp: string; foldedTail?: string; check(): void; unchanged(): Promise<void>; opened(): void };

interface Base {
  /** While the migration rename is in the I/O pool, a seek selects the index by its open descriptor. */
  replacing?: Base;
  /** Only the authoritative read can grant a rewrite of this exact base/tail pair. */
  migration?: { base: fs.Stats; tail?: fs.Stats; layout?: DiskLayout; controller?: AbortController };
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

function sameFile(a?: fs.Stats, b?: fs.Stats | null) {
  return a === b || !!a && !!b && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function migrationSource(base: fs.Stats, tail?: fs.Stats) {
  const stamp = (s?: fs.Stats) => s && [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
  return createHash('sha256').update(JSON.stringify([stamp(base), stamp(tail)])).digest('hex');
}

function incompleteMigration(file: string) {
  const fd = openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!/^\{"gen":\d+,"items":\[\n/.test(readBytes(fs, fd, 0, Math.min(size, 80)).toString())) return false;
    // The writer's last physical line closes the items array and the document.
    const n = Math.min(size, 8192), end = readBytes(fs, fd, size - n, n);
    const nl = end.lastIndexOf(10);
    return end.at(-1) !== 125 || nl >= 0 && end[nl + 1] !== 93;
  } finally { closeSync(fd); }
}

function foldedTailProof(file: string, expected: fs.Stats) {
  if (expected.size > MIGRATION_TAIL_MAX || !expected.isFile()) throw Error('Unknown migration tail');
  const fd = openSync(file, 'r');
  try {
    if (!sameFile(expected, fs.fstatSync(fd))) throw Error('Migration tail changed');
    const stat = fs.fstatSync(fd, { bigint: true });
    return { stat, hash: createHash('sha256').update(readBytes(fs, fd, 0, expected.size)).digest('hex') };
  } finally { closeSync(fd); }
}

/** Only a complete counted migration carries the digest of the exact tail that
 * it folded and a digest of its own bytes through that declaration. */
function verifyFoldedTail(io: typeof fs, hashOf: typeof createHash, bytesAt: typeof readBytes,
  file: string, tail: string, threshold: number, tailLimit: number) {
  if (!io.lstatSync(file).isFile() || !io.lstatSync(tail).isFile()) return;
  const fd = io.openSync(file, 'r');
  try {
    const base = io.fstatSync(fd, { bigint: true });
    if (!base.isFile()) return;
    const size = Number(base.size), length = Math.min(320, size);
    const trailer = bytesAt(io, fd, size - length, length).toString();
    const proof = /,"itemCount":(\d+),"rootCount":(\d+),"foldedTail":"([-\d.e+]+)\/([a-f0-9]{64})\/([a-f0-9]{64})"\}$/.exec(trailer);
    if (!proof) return;
    const [, count, roots, fromGen, tailHash, baseHash] = proof;
    if (!Number.isSafeInteger(+count) || +count <= threshold || +roots > +count) return;
    const tailFd = io.openSync(tail, 'r');
    let tailStat;
    try {
      tailStat = io.fstatSync(tailFd, { bigint: true });
      if (!tailStat.isFile() || tailStat.size > tailLimit) return;
      const bytes = bytesAt(io, tailFd, 0, Number(tailStat.size));
      if (hashOf('sha256').update(bytes).digest('hex') !== tailHash || JSON.parse(bytes.toString()).baseGen !== Number(fromGen)) return;
    } finally { io.closeSync(tailFd); }
    const head = /^\{"gen":(\d+),"items":\[\n/.exec(bytesAt(io, fd, 0, Math.min(80, size)).toString());
    if (!head || !Number.isSafeInteger(Number(head[1])) || Number(head[1]) <= Number(fromGen)) return;
    const hash = hashOf('sha256'), buf = Buffer.allocUnsafe(1 << 20);
    const until = size - 66; // The digest excludes its own 64 digits and the closing quote and brace.
    let rows = -1; // The first newline belongs to the header.
    for (let at = 0; at < until;) {
      const n = io.readSync(fd, buf, 0, Math.min(buf.length, until - at), at);
      if (!n) return;
      const block = buf.subarray(0, n);
      hash.update(block);
      for (let lf = block.indexOf(10); lf >= 0; lf = block.indexOf(10, lf + 1)) rows++;
      at += n;
    }
    if (rows === Number(count) && hash.digest('hex') === baseHash) return { base, tailStat };
  } finally { io.closeSync(fd); }
}

function sameRenamedFile(a: fs.BigIntStats, b?: fs.BigIntStats) {
  return b?.ino === a.ino && b.dev === a.dev && b.size === a.size && b.mtimeNs === a.mtimeNs;
}

/** Even an older bridge can publish between stat and rename. Only unlink a private
 * name, with the verified inode still open. link() restores a displaced replacement
 * exclusively, so a subsequent save at the public name always wins. */
function removeFoldedTail(file: string, tail: string, base: fs.BigIntStats, expected: fs.BigIntStats) {
  const matches = (a: fs.BigIntStats, b?: fs.BigIntStats) => sameRenamedFile(a, b) && b?.ctimeNs === a.ctimeNs;
  const atPath = (name: string) => fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
  if (!matches(base, atPath(file)) || !matches(expected, atPath(tail))) return;
  const fd = openSync(tail, 'r');
  try {
    if (!matches(expected, fs.fstatSync(fd, { bigint: true }))) return;
    const held = tail + '.recover.' + randomUUID();
    fs.renameSync(tail, held);
    let verified = false;
    try {
      const pinned = fs.fstatSync(fd, { bigint: true }), moved = fs.lstatSync(held, { bigint: true });
      // A rename itself can advance ctime.
      verified = pinned.dev === moved.dev && pinned.ino === moved.ino && matches(base, atPath(file)) &&
        expected.size === pinned.size && expected.mtimeNs === pinned.mtimeNs;
    } finally {
      if (!verified) fs.linkSync(held, tail); // If a third writer won, preserve both versions.
    }
    fs.unlinkSync(held);
  } finally { closeSync(fd); }
}

function recoveryBusy(err: unknown) {
  return ['EBUSY', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE'].includes((err as NodeJS.ErrnoException)?.code ?? '');
}

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
    private readonly compactLive?: (id: string, saved: TimelineItem, preview: TimelineItem) => void,
    private readonly exclusively = (action: () => void) => { action(); return true; },
    private readonly writerAdmission?: () => Promise<void> | undefined) {}

  /** Called only by the starting Store while it owns the sessions directory. */
  recoverMigrations(entries: fs.Dirent[]) {
    const candidates = new Set<string>();
    let retry = false;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const held = /^(.+)\.tail\.json\.recover\.([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(entry.name);
        if (held) {
          const tail = this.tailOf(held[1]), claimed = tail + '.recover.' + held[2];
          try { fs.linkSync(claimed, tail); }
          catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
          const a = fs.lstatSync(claimed, { bigint: true }), b = fs.lstatSync(tail, { bigint: true });
          if (a.dev === b.dev && a.ino === b.ino) fs.unlinkSync(claimed);
          candidates.add(held[1]);
          continue;
        }
        const temp = /^(.+)\.json\.migrate\.([1-9]\d*)\.([a-f0-9]{64})\.tmp$/.exec(entry.name);
        if (temp) {
          const file = this.pathOf(temp[1]), tail = this.tailStat(temp[1]);
          if (this.writing.has(temp[1])) continue;
          const base = fs.lstatSync(file, { throwIfNoEntry: false });
          const tmp = file + '.migrate.' + temp[2] + '.' + temp[3] + '.tmp';
          // Older Stores do not renew their owner files. A live PID with a
          // recently written temp can still be copying in such a Store.
          try {
            process.kill(Number(temp[2]), 0);
            if (Date.now() - statSync(tmp).mtimeMs < 86_400_000) { retry = true; continue; }
          } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
          if (base?.isFile() && tail !== null && temp[3] === migrationSource(base, tail) || incompleteMigration(tmp)) fs.unlinkSync(tmp);
        } else if (entry.name.endsWith('.tail.json')) {
          candidates.add(entry.name.slice(0, -10));
        }
      } catch (err) { retry ||= recoveryBusy(err); }
    }
    return { ids: [...candidates], retry };
  }

  /** One worker per recovery pass. It only reads. The owner admits the next
   * chat after applying the previous result under a fresh startup lock. */
  async verifyMigrations(ids: string[], signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !ids.length) return true;
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', ({ file, tail }) => {
        let proof;
        try {
          proof = (${verifyFoldedTail})(require('node:fs'), require('node:crypto').createHash,
            (${readBytes}), file, tail, ${SNAPSHOT_THRESHOLD}, ${MIGRATION_TAIL_MAX});
        } catch (err) { if ((${recoveryBusy})(err)) proof = 'retry'; }
        parentPort.postMessage(proof);
      });
    `, { eval: true });
    let index = 0, complete = false, retry = false;
    const stop = () => { void worker.terminate(); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<boolean>(resolve => {
        worker.once('error', stop);
        worker.once('exit', () => resolve(complete));
        const send = () => worker.postMessage({ file: this.pathOf(ids[index]), tail: this.tailOf(ids[index]) });
        worker.on('message', (proof: ReturnType<typeof verifyFoldedTail> | 'retry') => {
          if (signal.aborted) return;
          const id = ids[index];
          if (proof === 'retry') retry = true;
          else if (proof && !this.exclusively(() => removeFoldedTail(this.pathOf(id), this.tailOf(id), proof.base, proof.tailStat))) {
            stop();
            return;
          }
          if (++index < ids.length) send();
          else { complete = !retry; stop(); }
        });
        send();
      });
    } finally { signal.removeEventListener('abort', stop); }
  }

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

  private tailStat(id: string) {
    try { return statSync(this.tailOf(id), { throwIfNoEntry: false }); }
    catch { return null; } // Unknown, distinct from ENOENT.
  }

  private large(fileSize: number, tailSize: number) {
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
      // Only the counted writer identifies the array that just ended. Its
      // hasOver footer is rejected by baseEnd, even beyond the byte window.
      if (!end) return;
      const count = end.footer.itemCount, roots = end.footer.rootCount;
      if (!Number.isSafeInteger(count) || count <= SNAPSHOT_THRESHOLD ||
        !Number.isSafeInteger(roots) || roots < 0 || roots > count) return;
      try { tailFd = openSync(this.tailOf(id), 'r'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      let tail: Tail | null = null, from = count;
      const valid = (item: TimelineItem) => item && typeof item.id === 'string' && typeof item.type === 'string' && !isLight(item);
      if (tailFd !== undefined) {
        const length = fs.fstatSync(tailFd).size;
        if (length > limit) return;
        tail = JSON.parse(readBytes(fs, tailFd, 0, length).toString());
        if (tail?.baseCount !== undefined && (count !== tail.baseCount || roots !== tail.baseRoots)) return;
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
      if (typeof endId !== 'string') return;
      let found = suffix.some(i => i.id === endId);
      let prompts = suffix.filter(turnBoundary).length;
      let skip = count - from;
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
      if (!turnBoundary(rows[start]) || rows[start].id !== endId) return;
      const before = from - reverse.length + start;
      if (before < 0 || omittedRoots < 0 || from + suffix.length <= SNAPSHOT_THRESHOLD) return;
      for (let i = 0; i < start; i++) if (!rows[i].parentId) omittedRoots++;
      return { items: rows.slice(start), todos: tail?.todos ?? end.footer.todos as Todo[],
        queue: (tail?.queue ?? end.footer.queue ?? []) as QueuedMessage[],
        page: { kind: 'provisional' as const, before, rootsBefore: omittedRoots,
          recentAt: Math.max(0, recentStart(rows, workerCut.turns) - start) } };
    } catch { return; }
    finally { if (tailFd !== undefined) closeSync(tailFd); if (fd !== undefined) closeSync(fd); }
  }

  load(id: string): SessionData {
    const file = this.pathOf(id);
    let stat;
    try { stat = statSync(file); }
    catch (err) {
      return this.finish(id, (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, value: null } : { ok: false });
    }
    const tail = this.tailStat(id);
    if (this.large(stat.size, tail?.size ?? 0)) {
      try {
        const loaded = readIndexed(file, this.tailOf(id));
        return this.finish(id, { ok: true, value: loaded.base }, stat, tail, loaded);
      } catch { return this.finish(id, { ok: false }); }
    }
    return this.finish(id, readJson<BaseFile>(file), stat, tail);
  }

  async loadAsync(id: string): Promise<SessionData> {
    const file = this.pathOf(id);
    let stat;
    try { stat = statSync(file); }
    catch (err) {
      return this.finish(id, (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, value: null } : { ok: false });
    }
    const tail = this.tailStat(id);
    if (!this.large(stat.size, tail?.size ?? 0)) return this.load(id);
    const previous = this.bases.get(id);
    const read = await this.trackRead(id, readInWorker(file, this.tailOf(id))).catch(() => ({ ok: false as const }));
    // A synchronous hydrate that won the race owns the installed index.
    if (this.deleted.has(id) || this.bases.get(id) !== previous) return { items: [], todos: [], unreadable: true };
    if (!read.ok || !read.value) return this.finish(id, { ok: false });
    return this.finish(id, { ok: true, value: read.value.base }, stat, tail, read.value);
  }

  private finish(id: string, read: Read<BaseFile>, stat?: fs.Stats, tailStat?: fs.Stats | null, loaded?: IndexedRead): SessionData {
    const mtime = stat?.mtimeMs ?? 0;
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
    const roots = items.reduce((n, i) => n + Number(!i.parentId), 0);
    const idSet = new Set(settled);
    // The general reader also accepts stale tails and out-of-range prefixes for recovery.
    // Those reads, orphan overrides, and partial/unknown footer formats never authorize a migration.
    const installed: Base = { gen, count: items.length, roots, orphans, stamp: loaded?.stamp, index: loaded?.index,
      ids: settled, settled: from, idSet, size: stat!.size, old, over };
    if (stat && tailStat !== null && (tailStat?.size ?? 0) <= MIGRATION_TAIL_MAX &&
        data.items.length > SNAPSHOT_THRESHOLD && !Object.hasOwn(base, 'itemCount') && !orphans.length &&
        Math.max(items.length, data.items.length) <= MIGRATION_ROWS_MAX &&
        (loaded?.copyLines && !tail || fitsPrivateRead(stat.size, tailStat?.size ?? 0, loaded?.index))) {
      const validMeta = (doc: BaseFile | Tail) => (doc.todos === undefined || Array.isArray(doc.todos)) && (doc.queue === undefined || Array.isArray(doc.queue));
      const cleanTail = !tailStat && !tail || !!tailStat && !!merge && tail?.from === from && validMeta(tail) &&
        (tail.baseCount === undefined && tail.baseRoots === undefined || tail.baseCount === items.length && tail.baseRoots === roots) &&
        (!tail.over || new Set(tail.over.map(i => i.id)).size === tail.over.length) &&
        Object.keys(tail).every(k => ['baseGen', 'from', 'items', 'over', 'baseCount', 'baseRoots', 'endId', 'todos', 'queue'].includes(k));
      if (cleanTail && (base.gen === undefined || !old) && validMeta(base) &&
          Object.keys(base).every(k => ['gen', 'items', 'todos', 'queue', 'over'].includes(k)) &&
          data.items.every(i => i.id.length && typeof i.type === 'string') &&
          idSet.size === settled.length && (!tail || new Set(data.items.map(i => i.id)).size === data.items.length)) {
        installed.migration = { base: stat, tail: tailStat };
        if (loaded?.copyLines && !tail) {
          try {
            installed.migration.layout = { ids: settled, idSet, roots, endId: items[snapshotEnd(items).start].id,
              settled: settledEnd(items), todos: [], queue: data.queue && [] };
          } catch { delete installed.migration; } // A missing boundary must never fail an otherwise readable restore.
        }
      }
    }
    this.bases.set(id, installed);
    return data;
  }

  /** Re-cut only rows backed by this generation. Tail replacements have their own whole data. */
  recut(id: string, item: TimelineItem, recent: boolean): TimelineItem {
    const installed = this.bases.get(id);
    if (!installed?.index) return item;
    if (isLight(item) && !!item[LIGHT].recent === recent) return item;
    const source = new BaseReader(this.pathOf(id), installed);
    try {
      const base = source.current();
      const line = base?.index?.get(item.id);
      if (!line || base?.over.has(item.id)) return item;
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
    this.forgetMigration(id);
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

  needsMigration(id: string) {
    return !!this.bases.get(id)?.migration && !this.unreadable.has(id) && !this.deleted.has(id) && !this.force.has(id);
  }

  forgetMigration(id: string) {
    const base = this.bases.get(id);
    if (base?.migration) {
      base.migration.controller?.abort();
      delete base.migration;
    }
  }

  /** Join the ordinary writer's per-chat lane. An optional rewrite never incurs a save retry at quit. */
  migrate(id: string, atRest: () => boolean): Promise<void> {
    const base = this.bases.get(id), read = base?.migration;
    if (!base || !read || !this.needsMigration(id) || this.writing.has(id) || !atRest()) return Promise.resolve();
    const file = this.pathOf(id);
    const tmp = file + '.migrate.' + process.pid + '.' + migrationSource(read.base, read.tail) + '.tmp';
    const controller = read.controller = new AbortController();
    const check = () => {
      if (this.bases.get(id) !== base || base.migration !== read || this.unreadable.has(id) || !atRest()) throw Error('Session busy');
    };
    const tailStamp = () => stat(this.tailOf(id)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return undefined;
    });
    const unchanged = async () => {
      check();
      const [baseStat, tailStat] = await Promise.all([stat(file), tailStamp()]);
      check();
      if (!sameFile(read.base, baseStat) || !sameFile(read.tail, tailStat)) throw Error('Session file changed');
    };
    const run = async () => {
      let source: BaseReader | undefined;
      let writingTemp = false;
      try {
        await unchanged();
        const { bavail, bsize } = await statfs(file);
        if (!(bavail * bsize >= read.base.size + (read.tail?.size ?? 0) + (64 << 20))) return;
        await unchanged();
        let data: SessionData | DiskLayout;
        if (read.layout) {
          data = read.layout;
          source = new BaseReader(file, base);
        } else {
          // Small unindexed files, a replacement tail, or nonempty footer values need private
          // rows. Restore in a worker; never serialize objects the runtime received 20s ago.
          const privateFiles = new SessionFiles(this.pathOf);
          const loaded = await readInWorker(file, this.tailOf(id), { check, signal: controller.signal, source: { base: read.base, tail: read.tail } });
          await unchanged();
          if (!loaded.ok || !loaded.value) return;
          data = privateFiles.finish(id, { ok: true, value: loaded.value.base }, read.base, read.tail, loaded.value);
          if (!privateFiles.needsMigration(id)) return;
          source = new BaseReader(file, privateFiles.bases.get(id));
        }
        await source.startCopy(read.base);
        await unchanged();
        const folded = read.tail && foldedTailProof(this.tailOf(id), read.tail);
        const foldedTail = folded && base.gen + '/' + folded.hash;
        await this.writeBase(id, data, source, undefined, { tmp, foldedTail, check, unchanged, opened: () => { writingTemp = true; } }, folded?.stat);
        writingTemp = false;
      } catch { /* All pre-commit failures leave the source pair intact. */ }
      finally {
        await source?.endCopy().catch(() => {});
        source?.close();
        if (writingTemp) await unlink(tmp).catch(() => {});
        if (atRest() && base.migration === read) delete base.migration;
      }
    };
    const work = run().finally(() => { if (this.writing.get(id) === work) this.writing.delete(id); });
    this.writing.set(id, work);
    return work;
  }

  remove(id: string) {
    this.forgetMigration(id);
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

  /** With a chat ID, capture only its current write barrier. Quit captures all writers. */
  async idle(id?: string) {
    if (id !== undefined) await this.writing.get(id);
    else await Promise.all([...this.writing.values()]);
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
      const endId = items.length > SNAPSHOT_THRESHOLD ? items[snapshotEnd(items).start].id : undefined;
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
        }, undefined, this.writerAdmission);
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
    const tail = this.tailOf(id);
    let replacing;
    try { replacing = fs.lstatSync(tail, { bigint: true, throwIfNoEntry: false }); }
    catch { /* A tail of unknown identity stays in place. */ }
    let committed: Base;
    try { committed = await this.writeBase(id, { ...save, items }, source, base?.orphans, undefined, replacing); }
    finally { source.close(); }
    this.force.delete(id);
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

  private async writeBase(id: string, save: SessionData | DiskLayout, source: BaseReader, orphans?: TimelineItem[], migration?: MigrationWrite, folded?: fs.BigIntStats) {
    const gen = nextGen();
    const file = this.pathOf(id), tmp = migration?.tmp ?? `${file}.${process.pid}.tmp`;
    const head = `{"gen":${gen},"items":[\n`;
    const items = 'ids' in save ? save.ids : save.items;
    const roots = 'ids' in save ? save.roots : save.items.reduce((n, i) => n + Number(!i.parentId), 0);
    const endId = 'ids' in save ? save.endId : save.items.length > SNAPSHOT_THRESHOLD ? save.items[snapshotEnd(save.items).start].id : undefined;
    const counts = endId ? `,"endId":${JSON.stringify(endId)}${orphans?.length ? ',"hasOver":true' : ''},"itemCount":${items.length},"rootCount":${roots}` : '';
    const meta = `,"todos":${JSON.stringify(save.todos ?? [])}${save.queue ? `,"queue":${JSON.stringify(save.queue)}` : ''}`;
    const foot = (items.length ? '\n]' : ']') + (migration?.foldedTail
      ? meta + counts + ',"foldedTail":"' + migration.foldedTail + '/' : counts + meta + '}');
    const sections: WriteSection[] = ['ids' in save ? { head, ids: save.ids } : { head, items: save.items }];
    if (orphans?.length) sections.push({ head: '\n],"over":[\n', items: orphans });
    const written = await writeLines(tmp, sections, foot, source, Infinity, migration);
    const staged = folded?.isFile() && await stat(tmp, { bigint: true });
    // Windows cannot replace an open destination. Its old index stays live until the rename.
    if (migration) await source.endCopy();
    source.close();
    const readers = this.reading.get(id);
    if (readers?.size) await Promise.allSettled(readers);
    const ids = 'ids' in save ? save.ids : save.items.map(i => i.id);
    const base: Base = { gen, count: items.length, roots, orphans, ids, settled: 'ids' in save ? save.settled : settledEnd(save.items),
      idSet: 'ids' in save ? save.idSet : new Set(ids), size: written.size,
      index: written.index, over: new Set(), notices: { file, prefix: head, rows: written.notices } };
    // Replacing a GB-sized file on Windows can take hundreds of milliseconds.
    // Make both indexes available during that single atomic filesystem operation.
    const previous = migration && this.bases.get(id);
    if (previous) previous.replacing = base;
    try {
      await renameRetry(tmp, file, () => { if (!this.deleted.has(id)) this.bases.set(id, base); }, migration, this.writerAdmission);
    } finally { if (previous) delete previous.replacing; }
    if (folded && staged) {
      try {
        this.exclusively(() => {
          const committed = fs.lstatSync(file, { bigint: true });
          if (sameRenamedFile(staged, committed)) removeFoldedTail(file, this.tailOf(id), committed, folded);
        });
      } catch { /* A changed or inaccessible pair stays on disk. */ }
    }
    return base;
  }
}

/** Windows refuses a rename while another program (a virus scanner, a reader) has the file open for a moment: try again briefly. */
async function renameRetry(from: string, to: string, commit: () => void, migration?: MigrationWrite, admit?: () => Promise<void> | undefined) {
  const admission = admit?.();
  if (admission) await admission;
  for (let i = 0; ; i++) {
    if (migration) { await migration.unchanged(); migration.check(); }
    try {
      if (migration) await rename(from, to);
      else fs.renameSync(from, to);
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
  private copyFile?: Awaited<ReturnType<typeof open>>;
  private block?: { start: number; bytes: Buffer };
  constructor(private file: string, private base: Base | undefined) {}

  current() {
    if (this.base?.replacing) this.open();
    return this.base;
  }

  open() {
    if (this.fd === undefined) {
      if (!this.base?.index) throw new Error('Missing session base index');
      this.fd = openSync(this.file, 'r');
      const replacement = this.base.replacing;
      if (replacement) {
        const next = `{"gen":${replacement.gen},"items":[\n`;
        if (readBytes(fs, this.fd, 0, next.length).toString() === next) {
          this.base = replacement;
          return this.fd;
        }
      }
      const header = `{"gen":${this.base.gen},"items":[\n`;
      if (this.base.stamp !== undefined ? fs.fstatSync(this.fd).mtimeMs !== this.base.stamp : readBytes(fs, this.fd, 0, header.length).toString() !== header) throw new Error('Session base generation changed');
    }
    return this.fd;
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  /** A migration folds exactly the saved prefix. Reused suffix IDs and tail overrides
   * have their own values. Only a retained base row can be copied by offset. */
  retainedLine(id: string, ordinal: number) {
    if (!this.base?.index) throw Error('Missing migration index');
    if (ordinal >= this.base.ids.length || this.base.over.has(id)) return;
    if (this.base.ids[ordinal] !== id) throw Error('Session row changed');
    const line = this.base.index.get(id);
    if (!line) throw Error('Missing original migration row');
    return line;
  }

  async startCopy(expected: fs.Stats) {
    this.copyFile = await open(this.file, 'r');
    if (!sameFile(expected, await this.copyFile.stat())) throw Error('Session file changed');
  }

  async endCopy() {
    const file = this.copyFile;
    this.copyFile = undefined;
    await file?.close();
  }

  /** Read ahead once for neighboring rows. Even a single very large image uses
   * bounded asynchronous reads, with a chance to abandon the temp between blocks. */
  async piece(at: number, remaining: number, reuse = false) {
    let block = this.block;
    if (!block || at < block.start || at >= block.start + block.bytes.length) {
      const bytes = reuse && block?.bytes.length === CHUNK ? block.bytes : Buffer.allocUnsafe(CHUNK);
      const { bytesRead: n } = await this.copyFile!.read(bytes, 0, bytes.length, at);
      if (!n) throw Error('Incomplete session row');
      this.block = block = { start: at, bytes: bytes.subarray(0, n) };
    }
    return block.bytes.subarray(at - block.start, at - block.start + remaining);
  }

  encode(item: TimelineItem): { bytes: Buffer; chars: number } {
    let whole: TimelineItem = item;
    if (isLight(item)) {
      const line = this.current()?.index?.get(item.id);
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
    const line = this.current()?.index?.get(item.id);
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

/** A parsed legacy record can span physical lines. A literal LF in valid JSON
 * is whitespace outside a string. Keep every value token, including its numeric spelling. */
function singleLine(bytes: Buffer) {
  let lf = bytes.indexOf(10);
  if (lf < 0) return bytes;
  const out = Buffer.allocUnsafe(bytes.length - 1);
  let at = 0, written = 0;
  while (lf >= 0) {
    written += bytes.copy(out, written, at, lf);
    at = lf + 1;
    lf = bytes.indexOf(10, at);
  }
  written += bytes.copy(out, written, at);
  return out.subarray(0, written);
}

/** Write bounded batches. A projected item's opaque bytes pass straight from one base to the next. */
type WriteSection = { head: string; items: TimelineItem[] } | { head: string; ids: string[] };
async function writeLines(file: string, sections: WriteSection[], foot: string, source: BaseReader, limit = Infinity, migration?: MigrationWrite) {
  const check = migration?.check;
  const digest = migration?.foldedTail ? createHash('sha256') : undefined;
  const fh = await open(file, check ? 'wx' : 'w');
  migration?.opened();
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
    check?.();
    const bytes = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, pending);
    digest?.update(bytes);
    await fh.writeFile(bytes);
    buffers = [];
    pending = 0;
  };
  let since = performance.now();
  const yieldCopy = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    check!();
    since = performance.now();
  };
  try {
    for (const section of sections) {
      append(Buffer.from(section.head));
      chars += section.head.length;
      const start = chars;
      // scanLines validated every separator. Copy this entire unchanged array in
      // contiguous blocks, and translate its old offsets into the new generation.
      if ('ids' in section) {
        const ids = section.ids;
        const first = source.retainedLine(ids[0], 0)!.offset;
        let length = 0;
        for (const [i, id] of ids.entries()) {
          if (performance.now() - since >= 8) await yieldCopy();
          const line = source.retainedLine(id, i);
          if (!line || line.offset !== first + length) throw Error('Session row offsets changed');
          index.set(id, { ...line, offset: size + length });
          const separator = i + 1 === ids.length ? 0 : 2;
          length += line.length + separator;
          chars += line.chars + separator;
        }
        await flush();
        for (let at = 0; at < length;) {
          check!();
          const block = await source.piece(first + at, length - at, true);
          append(block);
          await flush();
          at += block.length;
        }
        sizes.push(chars - start);
        continue;
      }
      for (let i = 0; i < section.items.length; i++) {
        if (check && performance.now() - since >= 8) await yieldCopy();
        if (i) {
          append(Buffer.from(',\n'));
          chars += 2;
        }
        const item = section.items[i];
        const raw = check && source.retainedLine(item.id, i);
        if (raw) {
          const line = { ...raw, offset: size };
          index.set(item.id, line);
          for (let at = 0; at < raw.length;) {
            const piece = await source.piece(raw.offset + at, raw.length - at);
            const bytes = singleLine(piece);
            line.length -= piece.length - bytes.length;
            line.chars -= piece.length - bytes.length;
            append(bytes);
            at += piece.length;
            if (pending >= CHUNK) await flush();
          }
          chars += line.chars;
          continue;
        }
        if (check && isLight(item)) throw Error('Missing original migration row');
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
    if (digest) {
      const trailer = digest.digest('hex') + '"}';
      await fh.writeFile(trailer);
      chars += trailer.length;
    }
    return { size: chars + foot.length, sizes, index, notices };
  } finally { await fh.close(); }
}
