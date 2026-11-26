import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_ACCOUNT, type LimitsMeta, type ProviderId, type RateLimit, type UsageReport, type UsageRow, type UsageSession } from '../../shared/protocol';
import type { App } from '../app';
import type { DemoProvider } from '../providers/demo';
import { codexWindowLabel } from '../providers/codex-map';
import { demoLimitSamples, demoUsage, type DemoLimitProfile } from '../providers/demo-catalog';
import { LimitsBook } from './limits';

/**
 * Local token usage, read-only, from the transcripts the agents keep on disk:
 *
 *   Claude Code  <config dir>/projects/<folder>/<session>.jsonl  (and <session>/subagents/*.jsonl):
 *                assistant lines carry `message.usage`, `message.model`, `timestamp`, `cwd`,
 *                `sessionId`; `cost-state` lines carry the CLI's own running cost.
 *   Codex        <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl (and archived_sessions, zstd):
 *                `token_usage_record` lines (older: `token_count` events) carry usage per reply,
 *                `turn_context` the model and folder, `token_count` the rate-limit snapshot.
 *
 * Every file is summarised into buckets (session, local day, model). The summaries are cached by
 * path, size and mtime, so a second scan reads only what grew (from where it stopped) or changed.
 * Reading happens in small slices that yield to the event loop, so the bridge never stalls.
 */

export type TranscriptFormat = 'claude' | 'codex';

export interface UsageSource {
  provider: ProviderId;
  accountId: string;
  format: TranscriptFormat;
  /** A folder to walk for transcripts. */
  dir: string;
}

/** A rate-limit sample found in a transcript: window id as Sable names it (`codex:primary`), time, percent. */
export interface LimitSample {
  id: string;
  t: number;
  percent: number;
  windowMins?: number;
  resetsAt?: number;
}

interface Bucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  replies: number;
  cost: number;
}

interface SessionInfo {
  project: string;
  title?: string;
  lastAt: number;
}

/** Parser state carried between incremental reads of one file. */
interface ParseState {
  /** Claude: recent message ids with the usage already counted for them (lines repeat per content block). */
  ids?: [string, number, number, number, number][];
  /** Claude: the last running cost seen per session. */
  cost?: Record<string, number>;
  lastDay?: string;
  lastModel?: string;
  lastSession?: string;
  /** Codex. */
  model?: string;
  cwd?: string;
  session?: string;
  records?: boolean;
  lastTotal?: number;
  titled?: boolean;
}

interface FileEntry {
  size: number;
  mtime: number;
  /** Bytes consumed (up to the last full line). */
  offset: number;
  state: ParseState;
  /** `${session}\t${day}\t${model}` → totals. */
  buckets: Record<string, Bucket>;
  sessions: Record<string, SessionInfo>;
  samples?: LimitSample[];
}

interface IndexFile {
  v: 2;
  files: Record<string, FileEntry & { provider: ProviderId; accountId: string; format: TranscriptFormat }>;
}

export const USAGE_DAYS = 30;
const DAY = 86_400_000;
/** Buckets older than this are dropped from the cache. */
const KEEP_DAYS = 35;
/** Rate-limit samples older than this are not kept (they only serve the pace of current windows). */
const SAMPLE_DAYS = 8;
/** Work this long, then yield. */
const SLICE_MS = 6;

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Cooperative time slicing: call `tick()` often; it yields once a slice is used up. */
class Slicer {
  private start = performance.now();
  async tick() {
    if (performance.now() - this.start < SLICE_MS) return;
    await yieldNow();
    this.start = performance.now();
  }
}

const emptyBucket = (): Bucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, replies: 0, cost: 0 });
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The transcript folders of one account, for agents Sable knows how to read. */
export function transcriptSources(provider: ProviderId, accountId: string, accountDir: string | undefined, home = homedir(), env = process.env): UsageSource[] {
  if (provider === 'claude') {
    const dir = accountDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
    return [{ provider, accountId, format: 'claude', dir: path.join(dir, 'projects') }];
  }
  if (provider === 'codex') {
    const dir = accountDir ?? env.CODEX_HOME ?? path.join(home, '.codex');
    return [
      { provider, accountId, format: 'codex', dir: path.join(dir, 'sessions') },
      { provider, accountId, format: 'codex', dir: path.join(dir, 'archived_sessions') },
    ];
  }
  return [];
}

export interface ScanResult {
  /** Transcripts in range. */
  files: number;
  /** Files read (new or changed) and how many bytes of them. */
  read: number;
  bytes: number;
  ms: number;
  /** The slowest reads (bytes, ms), for diagnostics. */
  slowest: [number, number][];
}

/** Extra rows from elsewhere (Sable's own sessions of agents without transcripts, the Demo). */
export interface ExtraUsage {
  rows: UsageRow[];
  sessions: Record<string, UsageSession>;
}

export class UsageScanner {
  private index: IndexFile = { v: 2, files: {} };
  private loaded = false;
  private running?: Promise<ScanResult>;
  private again = false;
  private saveTimer?: NodeJS.Timeout;
  scannedAt?: number;

  constructor(private opts: { cacheFile?: string; now?: () => number } = {}) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  get scanning() {
    return !!this.running;
  }

  fileCount() {
    return Object.keys(this.index.files).length;
  }

  /** Loads the cache from disk (once). */
  ready() {
    return this.load();
  }

  private loading?: Promise<void>;

  private load() {
    this.loading ??= (async () => {
      if (this.opts.cacheFile) {
        try {
          const raw = JSON.parse(await readFile(this.opts.cacheFile, 'utf8')) as IndexFile;
          if (raw?.v === 2 && raw.files) this.index = raw;
        } catch {
          /* no cache yet */
        }
      }
      this.loaded = true;
    })();
    return this.loading;
  }

  /** Scans the sources (one scan at a time; a call during a scan runs one more afterwards). */
  scan(sources: UsageSource[], onProgress?: () => void): Promise<ScanResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      let result: ScanResult;
      do {
        this.again = false;
        result = await this.scanOnce(sources, onProgress);
      } while (this.again);
      return result;
    })().finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  /**
   * Lists and stats every transcript, then reads the new and changed ones, newest first, so a
   * first scan fills in the recent days first. `onProgress` is called every couple of seconds
   * while files are being read.
   */
  private async scanOnce(sources: UsageSource[], onProgress?: () => void): Promise<ScanResult> {
    const t0 = performance.now();
    await this.load();
    const slicer = new Slicer();
    const cutoff = this.now() - (USAGE_DAYS + 1) * DAY;
    const seen = new Set<string>();
    const todo: { file: string; src: UsageSource; size: number; mtime: number; prev?: FileEntry }[] = [];
    for (const src of sources) {
      const files = await listTranscripts(src, cutoff, slicer);
      for (let i = 0; i < files.length; i += 32) {
        const batch = files.slice(i, i + 32);
        const stats = await Promise.all(batch.map((f) => stat(f).catch(() => null)));
        for (let j = 0; j < batch.length; j++) {
          const file = batch[j];
          const st = stats[j];
          if (!st || !st.isFile() || st.mtimeMs < cutoff) continue;
          seen.add(file);
          const prev = this.index.files[file];
          const same = prev?.accountId === src.accountId;
          if (prev && same && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
          todo.push({ file, src, size: st.size, mtime: st.mtimeMs, prev: same ? prev : undefined });
        }
        await slicer.tick();
      }
    }
    let removed = false;
    for (const file of Object.keys(this.index.files)) if (!seen.has(file)) {
      delete this.index.files[file];
      removed = true;
    }
    todo.sort((a, b) => b.mtime - a.mtime);
    let read = 0;
    let bytes = 0;
    let told = performance.now();
    let savedAt = 0;
    const slowest: [number, number][] = [];
    for (const t of todo) {
      const f0 = performance.now();
      const entry = await this.readFile(t.file, t.src, t.size, t.mtime, t.prev, slicer).catch(() => undefined);
      slowest.push([t.size, Math.round(performance.now() - f0)]);
      if (slowest.length > 5) slowest.sort((a, b) => b[1] - a[1]).pop();
      if (entry) {
        bytes += t.size - (t.prev && t.size > t.prev.size ? t.prev.offset : 0);
        this.index.files[t.file] = { ...entry, provider: t.src.provider, accountId: t.src.accountId, format: t.src.format };
        read++;
      }
      if (performance.now() - told > 2500) {
        told = performance.now();
        onProgress?.();
        // A long first scan keeps what it has read so far, should the bridge restart meanwhile.
        if (read - savedAt >= 20) {
          savedAt = read;
          this.save();
        }
      }
    }
    this.scannedAt = this.now();
    if (read || removed) this.save();
    return { files: seen.size, read, bytes, ms: Math.round(performance.now() - t0), slowest: slowest.sort((a, b) => b[1] - a[1]) };
  }

  private async readFile(file: string, src: UsageSource, size: number, mtime: number, prev: FileEntry | undefined, slicer: Slicer): Promise<FileEntry> {
    const zst = file.endsWith('.zst');
    // Appended since the last read: continue from where it stopped. Anything else starts over.
    const resume = !zst && prev && size > prev.size && prev.offset <= size;
    const entry: FileEntry = resume
      ? { ...structuredClone(prev), size, mtime }
      : { size, mtime, offset: 0, state: {}, buckets: {}, sessions: {} };
    const parse = src.format === 'claude' ? parseClaudeLine : parseCodexLine;
    const cutoffDay = dayKey(this.now() - KEEP_DAYS * DAY);
    const sampleCut = this.now() - SAMPLE_DAYS * DAY;
    const ctx: LineContext = { entry, cutoffDay, sampleCut, fileSession: path.basename(file).replace(/\.jsonl(\.zst)?$/, '') };
    const wants = src.format === 'claude' ? claudeWants : codexWants;
    let input: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown };
    if (zst) {
      // Archived Codex sessions are zstd files: readable where this Node has zstd (22.15+), as a stream.
      const make = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
      if (!make) return { ...entry, offset: size };
      input = createReadStream(file, { highWaterMark: 128 * 1024 }).pipe(make()) as typeof input;
    } else input = createReadStream(file, { start: entry.offset, highWaterMark: 128 * 1024 });
    await new Promise<void>((resolve, reject) => {
      // The line being assembled. A huge line (images in a tool result) keeps only its two ends:
      // copying it whole on every chunk would cost far more than it is worth.
      let parts: Buffer[] = [];
      let partsLen = 0;
      let head: Buffer | null = null;
      let chunkStart = entry.offset;
      input.on('data', (data) => {
        const chunk = data as Buffer;
        input.pause();
        const lines: { buf: Buffer; cut: boolean }[] = [];
        let consumedTo = -1;
        let pos = 0;
        while (pos < chunk.length) {
          const nl = chunk.indexOf(10, pos);
          const piece = chunk.subarray(pos, nl < 0 ? chunk.length : nl);
          parts.push(piece);
          partsLen += piece.length;
          if (head) {
            while (parts.length > 1 && partsLen - parts[0].length >= KEEP_ENDS) partsLen -= parts.shift()!.length;
          } else if (partsLen > HUGE_LINE) {
            const all = Buffer.concat(parts);
            head = Buffer.from(all.subarray(0, KEEP_ENDS));
            parts = [Buffer.from(all.subarray(all.length - KEEP_ENDS))];
            partsLen = KEEP_ENDS;
          }
          if (nl < 0) break;
          lines.push({ buf: head ? Buffer.concat([head, ...parts]) : parts.length === 1 ? parts[0] : Buffer.concat(parts), cut: !!head });
          parts = [];
          partsLen = 0;
          head = null;
          consumedTo = chunkStart + nl + 1;
          pos = nl + 1;
        }
        chunkStart += chunk.length;
        // Partial pieces still point into this chunk: keep copies, not the whole chunk.
        if (parts.length) parts = parts.map((b) => Buffer.from(b));
        void (async () => {
          for (const l of lines) {
            // Most bytes are tool output: only lines that can matter are decoded at all.
            if (l.buf.length && wants(l.buf, ctx.entry.state)) parse(l.buf.toString('utf8'), ctx, l.cut);
            await slicer.tick();
          }
          if (consumedTo >= 0 && !zst) entry.offset = consumedTo;
          input.resume();
        })().catch(reject);
      });
      input.on('end', () => {
        // A last line without a newline counts once it is complete JSON (otherwise it is still being written).
        const tail = head ? '' : Buffer.concat(parts).toString('utf8').trim();
        if (tail) {
          try {
            JSON.parse(tail);
            parse(tail, ctx, false);
            if (!zst) entry.offset = chunkStart;
          } catch {
            /* read it next time */
          }
        }
        if (zst) entry.offset = size;
        resolve();
      });
      input.on('error', reject);
    });
    // Old buckets and samples leave the cache.
    for (const k of Object.keys(entry.buckets)) if (k.split('\t')[1] < cutoffDay) delete entry.buckets[k];
    if (entry.samples) entry.samples = entry.samples.filter((s) => s.t >= sampleCut).slice(-400);
    return entry;
  }

  /** Rate-limit samples found in transcripts, per account. */
  samples(): Map<string, LimitSample[]> {
    const out = new Map<string, LimitSample[]>();
    for (const f of Object.values(this.index.files)) {
      if (!f.samples?.length) continue;
      const key = `${f.provider}:${f.accountId}`;
      const list = out.get(key) ?? [];
      list.push(...f.samples);
      out.set(key, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.t - b.t);
    return out;
  }

  /** The last `days` days (ending today) as rows, plus `extra` rows from elsewhere. */
  report(days = USAGE_DAYS, extra?: ExtraUsage, links?: Map<string, Partial<UsageSession>>): UsageReport {
    const from = dayKey(this.now() - (days - 1) * DAY);
    const rows = new Map<string, UsageRow>();
    const sessions: Record<string, UsageSession> = {};
    for (const f of Object.values(this.index.files)) {
      for (const [key, b] of Object.entries(f.buckets)) {
        const [sid, day, model] = key.split('\t');
        if (day < from) continue;
        const skey = `${f.provider}:${sid}`;
        const rkey = `${skey}\t${day}\t${model}`;
        const row = rows.get(rkey) ?? { day, session: skey, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, replies: 0 };
        row.input += b.input;
        row.output += b.output;
        row.cacheRead += b.cacheRead;
        row.cacheWrite += b.cacheWrite;
        row.replies += b.replies;
        if (b.cost) row.costUsd = (row.costUsd ?? 0) + b.cost;
        rows.set(rkey, row);
        const info = f.sessions[sid];
        const s = (sessions[skey] ??= { provider: f.provider, accountId: f.accountId, project: info?.project ?? '', providerSessionId: sid, lastAt: 0 });
        if (info) {
          s.lastAt = Math.max(s.lastAt, info.lastAt);
          if (!s.project && info.project) s.project = info.project;
          if (info.title && !s.title) s.title = info.title;
        }
      }
    }
    for (const r of extra?.rows ?? []) if (r.day >= from) rows.set(`${r.session}\t${r.day}\t${r.model}\t${rows.size}`, r);
    for (const [k, s] of Object.entries(extra?.sessions ?? {})) sessions[k] ??= s;
    if (links) for (const [k, l] of links) if (sessions[k]) sessions[k] = { ...sessions[k], ...l, title: l.title || sessions[k].title };
    // Only sessions with rows in range travel.
    const used = new Set([...rows.values()].map((r) => r.session));
    for (const k of Object.keys(sessions)) if (!used.has(k)) delete sessions[k];
    return { days, rows: [...rows.values()], sessions, scannedAt: this.scannedAt, scanning: this.scanning, files: this.fileCount() };
  }

  private save() {
    if (!this.opts.cacheFile) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 2000);
    this.saveTimer.unref?.();
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const file = this.opts.cacheFile;
    if (!file || !this.loaded) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.index), 'utf8');
      await rename(tmp, file);
    } catch {
      /* the cache is best effort */
    }
  }
}

/** Every transcript under a source folder, skipping dated folders that end before `cutoff`. */
async function listTranscripts(src: UsageSource, cutoff: number, slicer: Slicer): Promise<string[]> {
  const out: string[] = [];
  const cutDay = dayKey(cutoff);
  const walk = async (dir: string, depth: number, datePath: string[]) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= 4) continue;
        // Codex keeps sessions/YYYY/MM/DD: a month or day that ended before the cutoff holds nothing new.
        if (src.format === 'codex' && /^\d{2,4}$/.test(e.name)) {
          const parts = [...datePath, e.name];
          const lastDay = parts.length === 1 ? `${parts[0]}-12-31` : parts.length === 2 ? `${parts[0]}-${parts[1]}-31` : parts.join('-');
          if (lastDay < cutDay) continue;
          await walk(full, depth + 1, parts);
        } else await walk(full, depth + 1, datePath);
      } else if (e.isFile() && (e.name.endsWith('.jsonl') || (src.format === 'codex' && e.name.endsWith('.jsonl.zst')))) out.push(full);
      await slicer.tick();
    }
  };
  await walk(src.dir, 0, []);
  return out;
}

interface LineContext {
  entry: FileEntry;
  cutoffDay: string;
  sampleCut: number;
  fileSession: string;
}

function add(ctx: LineContext, session: string, day: string, model: string, b: Partial<Bucket>) {
  if (day < ctx.cutoffDay) return;
  const key = `${session}\t${day}\t${model}`;
  const t = (ctx.entry.buckets[key] ??= emptyBucket());
  t.input += b.input ?? 0;
  t.output += b.output ?? 0;
  t.cacheRead += b.cacheRead ?? 0;
  t.cacheWrite += b.cacheWrite ?? 0;
  t.replies += b.replies ?? 0;
  t.cost += b.cost ?? 0;
}

function touch(ctx: LineContext, session: string, patch: { project?: string; title?: string; at?: number }) {
  const s = (ctx.entry.sessions[session] ??= { project: '', lastAt: 0 });
  if (patch.project && !s.project) s.project = patch.project;
  if (patch.title) s.title = patch.title;
  if (patch.at && patch.at > s.lastAt) s.lastAt = patch.at;
}

const firstLine = (text: string, max = 90) => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
};

/** A user prompt worth naming a session after (not a command echo, caveat or injected context). */
const promptText = (t: unknown) => (typeof t === 'string' && t.trim() && !/^\s*</.test(t) ? firstLine(t) : undefined);

/** Whether a Claude Code line can matter, checked on the bytes before anything is decoded. */
function claudeWants(b: Buffer, st: ParseState): boolean {
  return (
    b.includes('"type":"assistant"') ||
    b.includes('"type":"cost-state"') ||
    b.includes('"type":"custom-title"') ||
    (b[0] === 123 && b[1] === 34 && b.subarray(0, 17).toString() === '{"type":"summary"') ||
    (!st.titled && b.length < 20_000 && b.includes('"type":"user"'))
  );
}

/** Whether a Codex line can matter. */
function codexWants(b: Buffer, st: ParseState): boolean {
  if (b.includes('"token_usage_record"') || b.includes('"token_count"') || b.includes('"turn_context"') || b.includes('"session_meta"')) return true;
  return !st.titled && b.length < 20_000 && b.includes('"role":"user"');
}

/** Lines longer than this keep only their first and last KEEP_ENDS bytes. */
const HUGE_LINE = 1024 * 1024;
const KEEP_ENDS = 64 * 1024;

/** Lines longer than this are not parsed whole: the few fields needed are cut out (a big file write can make an assistant line megabytes long). */
const BIG_LINE = 64 * 1024;

const strAt = (line: string, key: string, from: number, last = false) => {
  const k = `"${key}":"`;
  const i = last ? line.lastIndexOf(k) : line.indexOf(k, from);
  if (i < 0 || i < from) return undefined;
  const j = line.indexOf('"', i + k.length);
  return j < 0 ? undefined : line.slice(i + k.length, j);
};

/** The fields of a very long assistant line, without parsing its content: message keys come before the content, line keys after it. */
function bigAssistant(line: string) {
  const m = line.indexOf('"message":{');
  // The reply's usage comes after its content, so the last one is it (content may hold objects of its own).
  const u = line.lastIndexOf('"usage":{');
  if (m < 0 || u < m) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = u + 8; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 123) depth++;
    else if (c === 125 && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return undefined;
  try {
    return {
      type: 'assistant',
      message: { model: strAt(line, 'model', m), id: strAt(line, 'id', m), usage: JSON.parse(line.slice(u + 8, end)) },
      requestId: strAt(line, 'requestId', end, true),
      timestamp: strAt(line, 'timestamp', end, true),
      sessionId: strAt(line, 'sessionId', end, true),
      cwd: strAt(line, 'cwd', end, true),
    };
  } catch {
    return undefined;
  }
}

export function parseClaudeLine(line: string, ctx: LineContext, cut = false) {
  const st = ctx.entry.state;
  // A huge line cut to its ends: only an assistant reply is worth reading from it.
  if (cut && !line.includes('"type":"assistant"')) return;
  // Inside JSON strings quotes are escaped, so this matches only a real top-level type.
  if (line.includes('"type":"assistant"') && line.includes('"usage":{')) {
    let o;
    try {
      o = cut || line.length > BIG_LINE ? bigAssistant(line) : JSON.parse(line);
    } catch {
      return;
    }
    if (o?.type !== 'assistant' || !o.message?.usage) return;
    const model = String(o.message.model ?? '');
    if (!model || model === '<synthetic>') return;
    const t = Date.parse(o.timestamp);
    if (!Number.isFinite(t)) return;
    const u = o.message.usage;
    const now = [num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)] as const;
    const id = String(o.message.id ?? o.uuid ?? '') + ':' + String(o.requestId ?? '');
    const ids = (st.ids ??= []);
    const seen = ids.find((x) => x[0] === id);
    let d: number[] = [...now];
    if (seen) {
      // The same reply again (one line per content block): count only what grew.
      const counted = seen.slice(1) as number[];
      d = now.map((v, i) => Math.max(0, v - counted[i]));
      for (let i = 0; i < 4; i++) seen[i + 1] = Math.max(counted[i], now[i]);
    } else {
      ids.push([id, ...now]);
      // Repeats of a reply follow it directly: a few recent ids are enough.
      if (ids.length > 8) ids.shift();
    }
    const session = String(o.sessionId ?? ctx.fileSession);
    const day = dayKey(t);
    st.lastDay = day;
    st.lastModel = model;
    st.lastSession = session;
    add(ctx, session, day, model, { input: d[0], output: d[1], cacheRead: d[2], cacheWrite: d[3], replies: seen ? 0 : 1, cost: num(o.costUSD) });
    touch(ctx, session, { project: typeof o.cwd === 'string' ? o.cwd : undefined, at: t });
    return;
  }
  if (line.includes('"type":"cost-state"')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o?.type !== 'cost-state' || typeof o.totalCostUSD !== 'number') return;
    const session = String(o.sessionId ?? st.lastSession ?? ctx.fileSession);
    const cost = (st.cost ??= {});
    const last = cost[session] ?? 0;
    const v = Math.max(0, o.totalCostUSD);
    // A new CLI process starts from zero again.
    const delta = v >= last ? v - last : v;
    cost[session] = v;
    if (delta > 0 && st.lastDay) add(ctx, session, st.lastDay, st.lastModel ?? '', { cost: delta });
    return;
  }
  if (line.includes('"type":"custom-title"') || line.startsWith('{"type":"summary"')) {
    try {
      const o = JSON.parse(line);
      const title = o?.type === 'custom-title' ? o.customTitle : o?.type === 'summary' ? o.summary : undefined;
      if (typeof title === 'string' && title.trim()) touch(ctx, String(o.sessionId ?? st.lastSession ?? ctx.fileSession), { title: firstLine(title) });
    } catch {
      /* skip */
    }
    return;
  }
  // The first real prompt names a session that has no title.
  if (!st.titled && line.includes('"type":"user"') && line.length < 20_000) {
    try {
      const o = JSON.parse(line);
      if (o?.type !== 'user' || o.isMeta || o.isSidechain) return;
      const c = o.message?.content;
      const text = promptText(typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: { type?: string }) => b?.type === 'text')?.text : undefined);
      if (!text) return;
      st.titled = true;
      const session = String(o.sessionId ?? ctx.fileSession);
      const s = ctx.entry.sessions[session];
      if (!s?.title) touch(ctx, session, { title: text, project: typeof o.cwd === 'string' ? o.cwd : undefined });
    } catch {
      /* skip */
    }
  }
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** OpenAI counts cached input inside `input_tokens`: split it out like Claude's. */
function codexBucket(u: CodexUsage): Partial<Bucket> {
  const cached = num(u.cached_input_tokens);
  const write = num(u.cache_write_input_tokens);
  return { input: Math.max(0, num(u.input_tokens) - cached - write), cacheRead: cached, cacheWrite: write, output: num(u.output_tokens), replies: 1 };
}

const SIGNALS = ['"token_usage_record"', '"token_count"', '"turn_context"', '"session_meta"', '"role":"user"'];

export function parseCodexLine(line: string, ctx: LineContext, cut = false) {
  if (cut || !SIGNALS.some((s) => line.includes(s))) return;
  const st = ctx.entry.state;
  if (line.includes('"role":"user"') && (st.titled || line.length > 20_000 || !line.includes('"response_item"'))) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const p = o?.payload;
  if (!p) return;
  const t = Date.parse(o.timestamp);
  const session = st.session ?? ctx.fileSession;
  switch (o.type) {
    case 'session_meta':
      st.session = String(p.id ?? p.session_id ?? ctx.fileSession);
      if (typeof p.cwd === 'string') st.cwd = p.cwd;
      touch(ctx, st.session, { project: st.cwd, at: Number.isFinite(t) ? t : undefined });
      return;
    case 'turn_context':
      if (typeof p.model === 'string') st.model = p.model;
      if (typeof p.cwd === 'string') st.cwd = p.cwd;
      return;
    case 'token_usage_record':
      if (!Number.isFinite(t) || !p.usage) return;
      st.records = true;
      add(ctx, session, dayKey(t), st.model ?? '', codexBucket(p.usage));
      touch(ctx, session, { project: st.cwd, at: t });
      return;
    case 'response_item': {
      if (p.type !== 'message' || p.role !== 'user' || st.titled) return;
      const text = Array.isArray(p.content) ? promptText(p.content.find((c: { type?: string }) => c?.type === 'input_text')?.text) : undefined;
      if (!text) return;
      st.titled = true;
      touch(ctx, session, { title: text, project: st.cwd });
      return;
    }
    case 'event_msg': {
      if (p.type !== 'token_count' || !Number.isFinite(t)) return;
      const total = num(p.info?.total_token_usage?.total_tokens);
      // Older rollouts have no usage records: count each new total once.
      if (!st.records && p.info?.last_token_usage && total && total !== st.lastTotal) {
        add(ctx, session, dayKey(t), st.model ?? '', codexBucket(p.info.last_token_usage));
        touch(ctx, session, { project: st.cwd, at: t });
      }
      if (total) st.lastTotal = total;
      const rl = p.rate_limits;
      if (rl && t >= ctx.sampleCut) {
        const key = rl.limit_id ?? 'codex';
        for (const slot of ['primary', 'secondary'] as const) {
          const w = rl[slot];
          if (!w || typeof w.used_percent !== 'number') continue;
          const resets = typeof w.resets_at === 'number' ? (w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at) : typeof w.resets_in_seconds === 'number' ? t + w.resets_in_seconds * 1000 : undefined;
          (ctx.entry.samples ??= []).push({ id: `${key}:${slot}`, t, percent: Math.max(0, Math.min(100, Math.round(w.used_percent))), windowMins: num(w.window_minutes) || undefined, resetsAt: resets });
        }
      }
      return;
    }
    default:
      return;
  }
}

// ───────────────────────────── the service ─────────────────────────────

/** How often an opened Usage view may trigger a scan on its own (a refresh click always scans). */
const AUTO_SCAN_GAP_MS = 20_000;

/**
 * Plan limits remembered per account (with history and pace) and local token usage, as RPCs:
 * `usage.limits`, `usage.report`; pushes `limits.report` after every read and `usage.updated`
 * after a scan. Nothing is scanned until the Usage view first asks.
 */
export function registerUsage(app: App, opts: { home?: string; sources?: () => UsageSource[] } = {}) {
  const book = new LimitsBook(path.join(app.store.dir, 'usage', 'limits.json'));
  const scanner = new UsageScanner({ cacheFile: path.join(app.store.dir, 'cache', 'usage-index.json') });
  const accounts = () => [...app.providers.keys()].flatMap((provider) => app.accountList(provider).map((a) => ({ provider, accountId: a.id })));
  const sources =
    opts.sources ??
    (() =>
      accounts().flatMap(({ provider, accountId }) =>
        transcriptSources(provider, accountId, accountId === DEFAULT_ACCOUNT ? undefined : app.accountDir(provider, accountId), opts.home, opts.home ? {} : process.env),
      ));

  const demoProfile = (accountId: string): DemoLimitProfile | undefined => {
    try {
      return (app.provider('demo', accountId) as Partial<DemoProvider>).limitProfile?.();
    } catch {
      return undefined;
    }
  };

  const record = (provider: ProviderId, accountId: string, limits: RateLimit[], meta: LimitsMeta, at?: number) => {
    book.record(provider, accountId, limits, meta, at);
    // The Demo's windows come with a made-up past, so the view has a history to draw.
    if (provider === 'demo') for (const l of limits) if ((book.report(provider, accountId).history[l.id]?.length ?? 0) < 3) book.seed(provider, accountId, l.id, demoLimitSamples(l));
    app.emit({ type: 'limits.report', report: book.report(provider, accountId) });
  };

  /** Codex writes its rate-limit snapshots into its transcripts: history for the pace, and limits newer than the last read. */
  const seedFromTranscripts = () => {
    for (const [key, list] of scanner.samples()) {
      const [provider, accountId] = key.split(':') as [ProviderId, string];
      if (provider !== 'codex') continue;
      // Snapshots from before the account's sign-in changed are the previous person's (review wave 8, #26).
      const since = app.limitsForgottenAt(provider, accountId);
      const byId = new Map<string, LimitSample[]>();
      for (const s of list) if (s.t > since) byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
      if (!byId.size) continue;
      for (const [id, samples] of byId) book.seed(provider, accountId, id, samples.map((s): [number, number] => [s.t, s.percent]));
      const latest = list[list.length - 1];
      const known = book.report(provider, accountId);
      if (latest && latest.t > (known.readAt ?? 0)) {
        const limits = [...byId.values()]
          .map((s) => s[s.length - 1])
          .filter((s) => latest.t - s.t < 60_000)
          .map((s): RateLimit => ({ id: s.id, label: codexWindowLabel(s.id, s.windowMins), percent: s.percent, resetsAt: s.resetsAt, ...(s.windowMins ? { windowMins: s.windowMins } : {}) }));
        if (limits.length) record(provider, accountId, limits, { planLimits: true }, latest.t);
      } else app.emit({ type: 'limits.report', report: book.report(provider, accountId) });
    }
  };

  const extra = (): ExtraUsage => {
    const out: ExtraUsage = { rows: [], sessions: {} };
    if (app.providers.has('demo')) {
      for (const a of app.accountList('demo')) {
        const profile = demoProfile(a.id);
        if (!profile) continue;
        const u = demoUsage(a.id, profile);
        out.rows.push(...u.rows);
        Object.assign(out.sessions, u.sessions);
      }
    }
    // Sable's own sessions of agents that keep no transcripts (the Demo).
    for (const rt of app.sessions.values()) {
      const m = rt.meta;
      if (m.provider !== 'demo' || !(m.usage.inputTokens || m.usage.outputTokens)) continue;
      const key = `sable:${m.id}`;
      out.rows.push({
        day: dayKey(m.updatedAt),
        session: key,
        model: m.model,
        input: m.usage.inputTokens,
        output: m.usage.outputTokens,
        cacheRead: m.usage.cacheReadTokens ?? 0,
        cacheWrite: 0,
        replies: m.usage.turns,
        ...(m.usage.costUsd ? { costUsd: m.usage.costUsd } : {}),
      });
      out.sessions[key] = { provider: m.provider, accountId: m.accountId ?? DEFAULT_ACCOUNT, project: m.cwd, title: m.title, sableId: m.id, lastAt: m.updatedAt };
    }
    return out;
  };

  /** Transcript sessions that are open in Sable carry Sable's title and open there. */
  const links = () => {
    const out = new Map<string, Partial<UsageSession>>();
    for (const rt of app.sessions.values()) {
      const m = rt.meta;
      if (m.providerSessionId && m.provider !== 'demo') out.set(`${m.provider}:${m.providerSessionId}`, { sableId: m.id, title: m.title });
    }
    return out;
  };

  const build = async () => {
    await scanner.ready();
    return scanner.report(USAGE_DAYS, extra(), links());
  };

  let lastScanAt = 0;
  const runScan = () => {
    lastScanAt = Date.now();
    // A long first scan shows what it has every few seconds.
    const run = scanner.scan(sources(), () => void build().then((report) => app.emit({ type: 'usage.updated', report })));
    void run
      .then(async (r) => {
        if (r.read) app.log(`usage: ${r.files} transcripts, ${r.read} read, ${r.ms} ms`);
        seedFromTranscripts();
        app.emit({ type: 'usage.updated', report: await build() });
      })
      .catch((err) => app.log('usage scan failed', (err as Error).message));
    return run;
  };

  // A turn that ended changed a transcript: read what grew, once the agent has written it.
  let turnTimer: NodeJS.Timeout | undefined;
  const afterTurn = () => {
    if (!scanner.scannedAt) return;
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => void runScan(), 4000);
    turnTimer.unref?.();
  };

  const unsubscribe = app.subscribe((e) => {
    if (e.type === 'limits.updated' && e.accountId && e.meta) record(e.provider, e.accountId, e.limits, e.meta);
    else if (e.type === 'item.added' && e.item.type === 'turn') afterTurn();
  });

  // An account signed in as someone else now (or with an API key in place of a plan): its old reading is not its own.
  app.onLimitsForgotten((provider, accountId) => {
    book.remove(provider, accountId);
    app.emit({ type: 'limits.report', report: book.report(provider, accountId) });
  });

  app.register('usage.limits', () =>
    accounts()
      .map(({ provider, accountId }) => book.report(provider, accountId))
      .filter((r) => r.readAt !== undefined || r.planLimits === false || r.limits.length > 0),
  );

  app.register('usage.report', async ({ refresh }) => {
    if (refresh || (!scanner.scanning && Date.now() - lastScanAt > AUTO_SCAN_GAP_MS)) void runScan();
    return build();
  });

  app.onDispose(async () => {
    unsubscribe();
    clearTimeout(turnTimer);
    await Promise.all([book.flush(), scanner.flush()]);
  });

  return { book, scanner };
}
