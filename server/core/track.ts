import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tracksWork } from '../../shared/background';
import type { ToolItem, TrackedWork } from '../../shared/protocol';
import { trackedEndReport } from '../../shared/synthetic';
import { waited } from '../../shared/work-label';
import { isTrackTool, oneLine, readTrackCall } from '../providers/track-tool';
import { openOwnFile } from '../services/git';
import { windowsPowerShell } from '../services/term';
import { folderNow, within } from './contain';
import type { SessionRuntime } from './runtime';

/**
 * Tracked work (`track_work`, `ToolItem.tracked`): a process the agent started outside its own tools
 * and asked Sable to watch. Sable OBSERVES only: nothing here starts, signals or ends a process, and
 * the one command it ever runs is the system's own process listing, to tell a reused id apart.
 *
 * - One timer for every tracked process of every chat, only while there is one (`TRACK.everyMs`). A
 *   look is `process.kill(pid, 0)` (no signal is sent: the system only says whether the id exists).
 * - A reused id: the process's start time is its identity (`TrackedWork.born`). Linux reads it from
 *   /proc at every look. Windows and macOS have no way without a helper process, so one helper for
 *   all tracked ids runs when a process is tracked, when a chat is read again after a restart, and
 *   once a minute while anything is tracked (`TRACK.bornEveryMs`); between two of those a reused id
 *   reads as still running. An id whose start cannot be read (another user's process) is watched by
 *   its liveness alone.
 * - The log, when one was named: the END of the file (`TRACK.tail` bytes) read as text when its size
 *   or time changed, through the chat folder's containment (`openOwnFile`: inside the chat's folder
 *   or its lane's worktree, no link on the way). What it holds is untrusted: one plain line, cut.
 * - The end: the row says so (`state: 'ended'`, the time Sable saw it go), and the agent is told once
 *   by the way a delegated child's report travels (`delegateReport: 'pending'`, the wake and its
 *   guards and budget in `server/app.ts`, the text in `shared/synthetic.ts`): at rest that is a turn
 *   of the agent's own, mid-turn it goes in at the next step. After the person's Stop it waits for
 *   their next message (`delegateWait: 'stop'`), never a wake.
 * - Tracked work holds no account move and no update: the process is not Sable's and outlives both.
 *   After a restart a chat with tracked work is read again by itself (`restored`): a row whose
 *   process still lives, with the start it had, is watched on; any other reads as ended with no end
 *   time, and its report goes out then.
 */

export const TRACK = {
  /** Tracked at once per chat. */
  max: 16,
  /** Between two looks at the processes. */
  everyMs: 3000,
  /** Between two readings of the processes' start times where that takes a helper process. */
  bornEveryMs: 60_000,
  /** The end of a log that is read (bytes). */
  tail: 4096,
  /** The log's last line as a row shows it (characters). */
  line: 200,
  /** The end of the log the agent is given: lines, and characters in all. */
  reportLines: 12,
  reportChars: 2000,
  /** A call whose step never appears is forgotten after this. */
  attachMs: 30_000,
};

/** How Sable looks at processes. Injected in tests. */
export interface ProcessProbe {
  /** Whether a process with this id exists now. Sends no signal. */
  alive(pid: number): boolean;
  /** The process's start, at once and without a helper, where the system has it (Linux); undefined: not known. */
  born?(pid: number): string | undefined;
  /** The start of each of these that exists and may be read, by one helper for all (Windows, macOS). */
  bornAll(pids: number[]): Promise<Map<number, string>>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No permission to signal it: it exists.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a helper printed, whatever it exited with (an id that is gone makes the listing fail for that one alone). */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, cwd: path.dirname(file) }, (_err, stdout) => resolve(String(stdout ?? '')));
    } catch {
      resolve('');
    }
  });
}

/** `pid start` lines, as both helpers print them. */
function bornLines(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

/** The system's own answers. */
export function systemProbe(): ProcessProbe {
  if (process.platform === 'linux') {
    const born = (pid: number) => {
      try {
        // Field 22 (starttime) counted after the name, which may itself hold spaces and brackets.
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined;
      } catch {
        return undefined;
      }
    };
    return {
      alive,
      born,
      bornAll: async (pids) => new Map(pids.flatMap((pid) => { const b = born(pid); return b ? [[pid, b] as [number, string]] : []; })),
    };
  }
  if (process.platform === 'win32') {
    return {
      alive,
      bornAll: async (pids) => {
        if (!pids.length) return new Map();
        const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch {} }; exit 0`;
        return bornLines(await run(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script]));
      },
    };
  }
  return {
    alive,
    bornAll: async (pids) => (pids.length ? bornLines(await run('/bin/ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')])) : new Map()),
  };
}

/**
 * The end of a log as plain lines, newest last: UTF-8 (or UTF-16, as Windows PowerShell's `>`
 * writes), colour codes and control characters out, a progress line's last state (after its last
 * carriage return), empty lines left out, each cut to `TRACK.line`.
 */
export function tailLines(buf: Buffer, wholeFile = false): string[] {
  let text: string;
  const zeros = buf.subarray(0, 512).filter((b) => b === 0).length;
  if (zeros > Math.min(buf.length, 512) / 4) text = buf.subarray(buf.length % 2).toString('utf16le');
  else text = buf.toString('utf8');
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
  const rows = text.split(/\r?\n/);
  // The first row of a tail that starts mid-file is the end of a line: only a whole line counts, unless it is all there is.
  if (!wholeFile && rows.length > 1) rows.shift();
  return rows.map((row) => oneLine(row.slice(row.lastIndexOf('\r') + 1).replace(/\ufffd+/g, ' '), TRACK.line)).filter(Boolean);
}

interface Watch {
  rt: SessionRuntime;
  item: string;
  pid: number;
  since: number;
  /** The row has its `tracked`: false while the step of the call has not appeared yet. */
  attached: boolean;
  tracked: TrackedWork;
  title: string;
  born?: string;
  /** The log's real place and what was last read of it. */
  log?: { file: string; root: string; size?: bigint; mtime?: bigint; reading?: boolean };
  ending?: boolean;
}

export interface TrackHost {
  /** The chat with this id now (undefined: removed). */
  session(id: string): SessionRuntime | undefined;
  log: (...args: unknown[]) => void;
}

export class WorkTracker {
  private watches = new Map<string, Watch>();
  private timer?: NodeJS.Timeout;
  private bornAt = 0;
  private bornRun?: Promise<void>;
  /** A process was tracked while the helper ran: it runs once more for what it did not ask about. */
  private bornAgain = false;
  private disposed = false;

  constructor(
    private host: TrackHost,
    private probe: ProcessProbe = systemProbe(),
    private now: () => number = Date.now,
  ) {}

  /** How many processes are watched now (tests, the timer). */
  get size() {
    return this.watches.size;
  }

  /**
   * The tool call: returns at once. `stepId`: the call's own step where the agent names it, else the
   * newest unclaimed step of this tool.
   */
  track(rt: SessionRuntime, args: unknown, stepId?: string): { ok: boolean; text: string } {
    if (this.disposed) return { ok: false, text: 'Sable is closing: nothing is tracked.' };
    const call = readTrackCall(args);
    if (typeof call === 'string') return { ok: false, text: call };
    const mine = [...this.watches.values()].filter((w) => w.rt === rt);
    const same = mine.find((w) => w.pid === call.pid);
    if (same) return { ok: false, text: `Process ${call.pid} is already tracked as "${same.title}".` };
    if (mine.length >= TRACK.max) return { ok: false, text: `Nothing is tracked: Sable tracks at most ${TRACK.max} at once per chat. Wait for one to end.` };
    if (call.pid === process.pid || call.pid === process.ppid) return { ok: false, text: "Nothing is tracked: that is Sable's own process." };
    if (!this.probe.alive(call.pid)) {
      return { ok: false, text: `Nothing is tracked: no process with id ${call.pid} is running. Track the long-lived process itself, not a shell that has already exited.` };
    }
    let log: Watch['log'];
    if (call.log) {
      const place = logPlace(rt, call.log);
      if (!place) return { ok: false, text: `Nothing is tracked: the log must be a file inside this chat's folder (${rt.meta.cwd}). Call again with a log there, or without one.` };
      log = place;
    }
    const item = stepId && rt.get(stepId) ? stepId : claim(rt, new Set(mine.map((w) => w.item))) ?? stepId;
    if (!item) return { ok: false, text: 'Nothing is tracked: Sable could not find this call in the conversation.' };
    const since = this.now();
    const tracked: TrackedWork = { pid: call.pid, ...(call.by ? { by: call.by } : {}), ...(call.log ? { log: call.log } : {}), state: 'running', since };
    const watch: Watch = { rt, item, pid: call.pid, since, attached: false, tracked, title: call.title, log };
    this.watches.set(key(rt, item), watch);
    this.attach(watch);
    this.arm();
    void this.readBorn();
    if (log) void this.readLog(watch);
    return {
      ok: true,
      text: `Tracking "${call.title}" (process ${call.pid}). The chat shows it as work, and Sable tells you once when the process is gone, also after your turn has ended: do not poll for that.${call.log ? '' : ' No log was named, so the row shows no progress.'}`,
    };
  }

  /**
   * A chat read from disk after a restart: every row still marked running is looked at once. Its
   * process lives (with the start it had, where both are known): watched on. Otherwise it ended
   * while Sable was closed: the row says so with no end time and its report goes out.
   */
  restored(rt: SessionRuntime) {
    if (this.disposed) return;
    for (const row of rt.items) {
      if (!tracksWork(row) || this.watches.has(key(rt, row.id))) continue;
      const t = row.tracked;
      const watch: Watch = { rt, item: row.id, pid: t.pid, since: t.since, attached: true, tracked: t, title: row.title, born: t.born, log: t.log ? logPlace(rt, t.log) : undefined };
      this.watches.set(key(rt, row.id), watch);
      if (!this.probe.alive(t.pid)) {
        void this.end(watch, { why: 'closed' });
        continue;
      }
      const born = this.probe.born?.(t.pid);
      if (born && t.born && born !== t.born) void this.end(watch, { why: 'reused' });
    }
    if (this.watches.size) {
      this.arm();
      void this.readBorn(true);
    }
  }

  /** The person stops the watching (never the process): the row reads "Not tracked", the agent is told nothing. */
  stop(rt: SessionRuntime, itemId: string): boolean {
    const row = rt.get<ToolItem>(itemId);
    if (!tracksWork(row)) return false;
    this.watches.delete(key(rt, itemId));
    rt.patch<ToolItem>(itemId, { tracked: { ...row.tracked, state: 'left' } });
    return true;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.watches.clear();
  }

  private arm() {
    if (this.timer || this.disposed || !this.watches.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch((err) => this.host.log('tracked work: a look failed', (err as Error).message)).finally(() => this.arm());
    }, TRACK.everyMs);
    this.timer.unref?.();
  }

  /** The row gets its `tracked` once the call's step is in the conversation. */
  private attach(watch: Watch) {
    const row = watch.rt.get<ToolItem>(watch.item);
    if (row?.type !== 'tool' || row.tracked) return;
    watch.attached = true;
    watch.title = row.title && isTrackTool(row.name) && row.title !== 'Track work' ? row.title : watch.title;
    watch.rt.patch<ToolItem>(watch.item, { tracked: { ...watch.tracked, ...(watch.born ? { born: watch.born } : {}) }, ...(row.title === watch.title ? {} : { title: watch.title }) });
  }

  /** One look at everything: what is gone ends, what lives has its log read. */
  async tick(): Promise<void> {
    const ends: Promise<void>[] = [];
    for (const [k, watch] of this.watches) {
      const { rt } = watch;
      if (this.host.session(rt.id) !== rt) {
        this.watches.delete(k);
        continue;
      }
      if (!watch.attached) {
        this.attach(watch);
        if (!watch.attached) {
          if (this.now() - watch.since > TRACK.attachMs) this.watches.delete(k);
          continue;
        }
      } else if (!tracksWork(rt.get(watch.item))) {
        // Rewound, cleared, replaced or let go by the person: nothing to watch for.
        this.watches.delete(k);
        continue;
      }
      if (watch.ending) continue;
      if (!this.probe.alive(watch.pid)) {
        ends.push(this.end(watch, {}));
        continue;
      }
      const born = this.probe.born?.(watch.pid);
      if (born && watch.born && born !== watch.born) {
        ends.push(this.end(watch, { why: 'reused' }));
        continue;
      }
      if (born && !watch.born) this.setBorn(watch, born);
      if (watch.log) void this.readLog(watch);
    }
    await Promise.all(ends);
    if (!this.probe.born && this.watches.size && this.now() - this.bornAt >= TRACK.bornEveryMs) await this.readBorn();
  }

  private setBorn(watch: Watch, born: string) {
    watch.born = born;
    const row = watch.rt.get<ToolItem>(watch.item);
    if (watch.attached && tracksWork(row) && row.tracked.born !== born) watch.rt.patch<ToolItem>(watch.item, { tracked: { ...row.tracked, born } });
  }

  /** The start of every watched process, by one helper: a first reading is kept, another one than before is a reused id. */
  private readBorn(force = false): Promise<void> {
    if (!force && this.probe.born) return Promise.resolve();
    if (this.bornRun) {
      this.bornAgain = true;
      return this.bornRun;
    }
    this.bornAt = this.now();
    const pids = [...new Set([...this.watches.values()].filter((w) => !w.ending).map((w) => w.pid))];
    if (!pids.length) return Promise.resolve();
    const asked = new Set(this.watches.values());
    this.bornRun = this.probe.bornAll(pids).then(async (map) => {
      const ends: Promise<void>[] = [];
      for (const watch of asked) {
        if (watch.ending || this.watches.get(key(watch.rt, watch.item)) !== watch) continue;
        const born = map.get(watch.pid);
        if (!born) continue;
        if (!watch.born) this.setBorn(watch, born);
        else if (born !== watch.born) ends.push(this.end(watch, { why: 'reused' }));
      }
      await Promise.all(ends);
    }).catch((err) => this.host.log('tracked work: process starts could not be read', (err as Error).message))
      .finally(() => {
        this.bornRun = undefined;
        if (this.bornAgain && !this.disposed) {
          this.bornAgain = false;
          void this.readBorn(true);
        }
      });
    return this.bornRun;
  }

  /** The end of the log, when it changed since the last look: its last line onto the row. */
  private async readLog(watch: Watch, final = false): Promise<string[] | undefined> {
    const log = watch.log;
    if (!log || (log.reading && !final)) return undefined;
    log.reading = true;
    try {
      const root = await folderNow(log.root);
      if (typeof root === 'string') return undefined;
      // By the folder's canonical place: a name that reaches the file through a link is refused there.
      const got = await openOwnFile(path.join(root.real, path.relative(log.root, log.file)), root).catch(() => null);
      if (!got || typeof got === 'string') return undefined;
      try {
        const size = got.st.size;
        if (!final && size === log.size && got.st.mtimeNs === log.mtime) return undefined;
        const length = Number(size > BigInt(TRACK.tail) ? BigInt(TRACK.tail) : size);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await got.fh.read(buf, 0, length, Number(size) - length);
        log.size = size;
        log.mtime = got.st.mtimeNs;
        const lines = tailLines(buf.subarray(0, bytesRead), Number(size) <= TRACK.tail);
        const line = lines.at(-1);
        const row = watch.rt.get<ToolItem>(watch.item);
        if (!final && line && watch.attached && tracksWork(row) && row.tracked.line !== line) watch.rt.patch<ToolItem>(watch.item, { tracked: { ...row.tracked, line } });
        return lines;
      } finally {
        await got.fh.close().catch(() => {});
      }
    } catch {
      return undefined;
    } finally {
      log.reading = false;
    }
  }

  /** The process is gone: the row says so, and its report waits for the agent as a delegated child's does. */
  private async end(watch: Watch, how: { why?: 'closed' | 'reused' }): Promise<void> {
    if (watch.ending) return;
    watch.ending = true;
    const { rt } = watch;
    const at = how.why ? undefined : this.now();
    const lines = await this.readLog(watch, true);
    this.watches.delete(key(rt, watch.item));
    const row = rt.get<ToolItem>(watch.item);
    if (this.disposed || this.host.session(rt.id) !== rt || !tracksWork(row)) return;
    const kept: string[] = [];
    let chars = 0;
    for (const line of (lines ?? []).slice(-TRACK.reportLines).reverse()) {
      if ((chars += line.length + 1) > TRACK.reportChars) break;
      kept.unshift(line);
    }
    const text = trackedEndReport({ pid: watch.pid, ...(at ? { ran: waited(at - watch.since) } : {}), ...(how.why ? { why: how.why } : {}), lines: kept, log: !!row.tracked.log });
    // After the person's Stop nothing wakes the agent: the report goes with their next message.
    const held = rt.stopRequested;
    const line = lines?.at(-1) ?? row.tracked.line;
    rt.patch<ToolItem>(watch.item, {
      tracked: { ...row.tracked, state: 'ended', ...(at ? { endedAt: at } : {}), ...(line ? { line } : {}) },
      result: { text },
      delegateDeliveryId: row.delegateDeliveryId ?? randomUUID(),
      delegateReport: 'pending',
      ...(held ? { delegateWait: 'stop' as const } : {}),
    });
    rt.pendingDelegateReports.add(watch.item);
    const prepared = held ? undefined : rt.stageDelegateReports?.();
    try {
      await rt.persistDelegate?.();
      prepared?.();
    } catch (err) {
      this.host.log('tracked work: the end could not be saved', (err as Error).message);
    }
    if (!held && this.host.session(rt.id) === rt) rt.onDelegateReport?.();
  }
}

const key = (rt: SessionRuntime, item: string) => `${rt.id}\n${item}`;

/** The newest step of this tool the chat has that carries no tracked work and no watch yet. */
function claim(rt: SessionRuntime, taken: Set<string>): string | undefined {
  for (let i = rt.items.length - 1; i >= 0; i--) {
    const it = rt.items[i];
    if (it.type === 'turn' && !it.parentId) return undefined;
    if (it.type === 'tool' && !it.parentId && isTrackTool(it.name) && !it.tracked && !taken.has(it.id) && (it.status === 'running' || it.status === 'pending')) return it.id;
  }
  return undefined;
}

/**
 * Where a named log lies: resolved against the chat's folder, and inside it or the chat's lane (its
 * worktree) by its name. Whether the file there really is inside (no link on the way) is asked at
 * every read (`openOwnFile`). Undefined: outside.
 */
function logPlace(rt: SessionRuntime, log: string): { file: string; root: string } | undefined {
  const cwd = rt.meta.cwd;
  if (!cwd) return undefined;
  const file = path.resolve(cwd, log);
  for (const root of [rt.meta.lane?.path, cwd]) {
    if (root && file !== path.resolve(root) && within(path.resolve(root), file)) return { file, root: path.resolve(root) };
  }
  return undefined;
}
