import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderId } from '../../shared/protocol';

export type StartReason = 'chat' | 'sub-agent' | 'check' | 'prewarm' | 'title' | 'draft' | 'limits' | 'status' | 'version' | 'caps' | 'login' | 'logout' | 'reset' | 'reset-credit' | 'remote' | 'history';
export type EndReason = 'exit' | 'error' | 'eof' | 'abort' | 'close' | 'idle' | 'remote' | 'handoff' | 'move' | 'switch' | 'limit' | 'capability' | 'stop' | 'quit' | 'timeout';
type Event = { event: 'start'; reason: StartReason; process: number; alive: number; pid?: number }
  | { event: 'end'; reason: EndReason; process: number; ageMs: number; inFlight: boolean | null; pid?: number }
  | { event: 'wait' | 'enter' | 'leave'; reason: StartReason; pid?: number }
  | { event: 'status-answer'; answer: 'in' | 'out' | 'unknown'; pid?: number }
  | { event: 'refused'; pid?: number; alive?: number; processes?: { process: number; pid?: number; ageMs: number }[] }
  | { event: 'status' | 'retry' | 'signed-out' | 'signed-in' | 'wake' | 'quit-deadline'; pid?: number };
export type JournalRow = Event & { at: number; run: string; agent?: ProviderId; accountId?: string; folder?: number };
export interface AuthScope {
  agent: ProviderId;
  accountId: string;
  reason: StartReason;
  pid?: number;
  journal?: AuthJournal;
  closing?: () => boolean;
}

export function record(scope: AuthScope | undefined, event: Event) {
  scope?.journal?.record(scope, { pid: scope.pid, ...event });
}

const capacity = 4000;

/** Only structured adapter events enter this file. Folder paths and CLI payloads stay at the caller. */
export class AuthJournal {
  private file: string;
  private run = randomUUID();
  private rows: JournalRow[] = [];
  private pending: JournalRow[] = [];
  private written = 0;
  private loaded = false;
  private writing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private serial = 0;
  private folders = new Map<string, number>();
  private accountFolders = new Map<string, number>();
  private processes = new Map<number, { folder: number; born: number; scope: AuthScope; pid?: number; busy: () => boolean }>();
  private drained = new Set<() => void>();

  constructor(home: string) { this.file = path.join(home, 'cache', 'auth-journal.jsonl'); }

  record(scope: Pick<AuthScope, 'agent' | 'accountId'> | undefined, event: Event, at = Date.now()) {
    const folder = scope && this.accountFolders.get(scope.agent + ':' + scope.accountId);
    if (event.event === 'refused') {
      const processes = [...this.processes].filter(([, p]) => p.folder === folder)
        .map(([process, p]) => ({ process, pid: p.pid, ageMs: Math.max(0, at - p.born) }));
      event = { ...event, alive: processes.length, processes };
    }
    const row = { at, run: this.run, ...(scope && { agent: scope.agent, accountId: scope.accountId, folder }), ...event };
    this.pending.push(row);
    if (this.pending.length > capacity) this.pending.shift();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 100);
      this.timer.unref?.();
    }
  }

  started(scope: AuthScope, folder: string, pid?: number, pending: () => boolean = () => true, at = Date.now()) {
    scope.pid = pid; // The same operation's later gate leave can now identify the child.
    const process = ++this.serial;
    const folderId = this.folders.get(folder) ?? this.folders.size + 1;
    this.folders.set(folder, folderId);
    this.accountFolders.set(scope.agent + ':' + scope.accountId, folderId);
    const alive = [...this.processes.values()].filter(p => p.folder === folderId).length;
    this.processes.set(process, { folder: folderId, born: at, scope, pid, busy: () => Date.now() - at < 3000 || pending() });
    this.record(scope, { event: 'start', process, pid, reason: scope.reason, alive }, at);
    return (reason: EndReason, inFlight: boolean | null) => {
      if (!this.processes.delete(process)) return;
      const ended = Date.now();
      this.record(scope, { event: 'end', process, pid, reason, ageMs: ended - at, inFlight }, ended);
      if (!this.active) { for (const done of this.drained) done(); this.drained.clear(); }
    };
  }

  // A reset console belongs to the person across a desktop quit.
  get active() { return [...this.processes.values()].some(p => p.scope.reason !== 'reset'); }
  get busy() { return [...this.processes.values()].some(p => p.scope.reason !== 'reset' && p.busy()); }
  whenDrained() { return this.active ? new Promise<void>(resolve => this.drained.add(resolve)) : Promise.resolve(); }
  noteQuitDeadline() {
    for (const p of this.processes.values()) if (p.scope.reason !== 'reset') this.record(p.scope, { event: 'quit-deadline', pid: p.pid });
  }

  async flush(): Promise<void> {
    if (this.writing) await this.writing;
    if (this.writing) return this.flush();
    if (this.loaded && !this.pending.length) return;
    this.writing = this.save().finally(() => { this.writing = undefined; });
    await this.writing;
    if (this.pending.length) await this.flush();
  }

  private async save() {
    if (!this.loaded) {
      let data = '';
      try { data = await readFile(this.file, 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const lines = data.trimEnd().split('\n').filter(Boolean);
      for (const line of lines.slice(-capacity)) {
        try { this.rows.push(JSON.parse(line)); } catch { /* incomplete final line at crash */ }
      }
      this.written = data && !data.endsWith('\n') ? Infinity : lines.length;
      this.loaded = true;
    }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    const rows = this.rows.concat(batch).slice(-capacity);
    const encode = (events: JournalRow[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      if (this.written + batch.length > capacity + 128) {
        await writeFile(this.file + '.tmp', encode(rows));
        await rename(this.file + '.tmp', this.file);
        this.written = rows.length;
      } else {
        await appendFile(this.file, encode(batch));
        this.written += batch.length;
      }
      this.rows = rows;
    } catch (e) {
      this.pending = batch.concat(this.pending).slice(-capacity);
      this.written = Infinity;
      throw e;
    }
  }

  async lines(limit = capacity) {
    await this.flush();
    const n = Math.max(0, Math.min(capacity, Math.floor(limit)));
    return n ? this.rows.slice(-n).map(row => JSON.stringify(row)) : [];
  }
}

/** Reconstruct from retained observations in the same bridge run. PIDs can be reused. */
export function summarizeAuth(rows: readonly JournalRow[]) {
  const last = new Map<string, number>();
  const signedOut = new Set<string>();
  rows.forEach((row, i) => {
    const key = row.agent + ':' + row.accountId;
    if (row.event === 'signed-in' || (row.event === 'status-answer' && row.answer === 'in')) signedOut.delete(key);
    if (row.event === 'signed-out' || (row.event === 'status-answer' && row.answer === 'out')) {
      if (!signedOut.has(key)) last.set(key, i);
      signedOut.add(key);
    }
  });
  return [...last.values()].map(i => {
    const out = rows[i];
    const start = out.at - 120_000;
    const alive = new Map<number, JournalRow>();
    const events: JournalRow[] = [];
    for (const row of rows.slice(0, i + 1)) {
      if (row.event === 'wake' && row.run === out.run && row.at >= start) events.push(row);
      if (row.run !== out.run || row.agent !== out.agent) continue;
      if (row.accountId !== out.accountId && (out.folder === undefined || row.folder !== out.folder)) continue;
      if (row.at >= start) events.push(row);
      else if (row.event === 'start') alive.set(row.process, row);
      else if (row.event === 'end') alive.delete(row.process);
    }
    return { agent: out.agent, accountId: out.accountId, lastSignOut: out.at, aliveAtWindowStart: [...alive.values()], events };
  });
}
