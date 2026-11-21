import type { PhoneFileStart } from '@shared/protocol';
import { isBusy, monotonic, nap, stoppedError, untilStopped } from './errors';

/**
 * The downloads' logic, free of Capacitor and the connection (lib/downloads.ts wires it), so it can
 * be tested.
 *
 * Over the secure channel (a phone paired securely, the only way an APK comes): the desktop opens the
 * file the share recorded (`phone.fileStart`: its canonical name, size and the SHA-256 the share
 * recorded when it completed) and the phone asks for it chunk by chunk over the sealed connection
 * (`phone.fileChunk`, at most `WINDOW` asked ahead: the phone sets the pace), each written in order to
 * a file in the app's private storage (`stageWrite`). A connection that goes away pauses it; once
 * back, it goes on from the bytes it has (a new transfer, the same digest, or it starts over). When
 * every byte is there, FilesPlugin.java reads the private file whole and compares it with the digest
 * (`stageFinish`): only a file that matches is kept (and, unless it is an app, copied to
 * Downloads/Sable); one that does not is removed and the row says so. Nothing is public, and nothing
 * says "downloaded", before that. Open and Install hand on that verified private copy (a FileProvider
 * URI), and the installer is reached only for such a record (decided natively, by the final MIME type).
 *
 * Over a pairing from before the secure channel nothing is transferred any more (its bytes and its
 * digest would both come over plain HTTP, and DownloadManager publishes before anything is checked):
 * the row says to pair again (`PLAIN_OFF`), and a system download left running by an older build is
 * stopped at start. Only an older build's finished ones stay to open (checked again natively first).
 * The DownloadManager path below is kept for `link` (tests and the record of how it was): one polling
 * loop that awaits each read, four times a second while bytes move, every few seconds while paused.
 *
 * Starts over the channel go one at a time (the desktop prepares one file per phone at a time and
 * says "Another download is starting" to a second: that is waited out, never a failure), so a
 * reconnect that resumes every paused download does not fail all but one. A file whose verified copy
 * is already on the phone (Android stopped the app after the check, before the page wrote it down) is
 * done at once, never fetched or published twice; a copy that could not go to Downloads/Sable says so
 * (`published: false`). When a finished entry is let go past `KEEP`, its private copy goes too, and at
 * start every private file no entry names is removed (`prune`).
 *
 * Every start has its own attempt, checked after every await (a Stop while the desktop prepares the
 * file ends it for good), and its own signal: a Stop ends a wait on a busy desktop at once, nothing
 * more is asked for it, and the starts behind it go on without waiting for its turn to end. A start
 * has one deadline (`START_BUDGET` from its turn) for every layer that waits on a busy desktop (this
 * queue's "another download is starting" and lib/errors.ts `whileBusy`), and each call is limited
 * to the time left. A start the desktop still refuses for now when that time is up (no room for one
 * more of this phone's transfers) pauses, its bytes kept, and goes on when one of them ends.
 *
 * Storage is written only when what is kept changed, and counts as written only once the write
 * worked (a failed one is tried again with the next change); at most `KEEP` entries. A history that
 * could not be read is not an empty one: nothing is pruned and nothing written over it until it
 * reads (then it is merged under what came meanwhile, and the private files are reconciled).
 */

export type DownloadState = 'idle' | 'asking' | 'pending' | 'running' | 'paused' | 'verifying' | 'done' | 'failed';
export interface Download {
  state: DownloadState;
  /** How it comes: over the sealed connection (`channel`), or DownloadManager over plain HTTP (`system`, a legacy pairing). */
  via?: 'channel' | 'system';
  /** DownloadManager's id once it started (`system`). */
  id?: string;
  bytes?: number;
  total?: number;
  error?: string;
  url?: string;
  /** Which start this entry belongs to (a stopped or newer attempt makes an older one's replies moot). */
  attempt?: number;
  /** What the desktop said the file is (hex SHA-256, bytes). */
  sha256?: string;
  size?: number;
  /** The bytes on the phone are those (checked whole on the phone when they were all there). */
  verified?: boolean;
  /** Its digest came over the secure channel. */
  secure?: boolean;
  /** `channel`: the private file being written (FilesPlugin \`stage*\`), and once checked, the verified record that Open hands on. */
  stage?: string;
  file?: string;
  /** `channel`: the file's canonical name as the desktop named it (shared/file-name.ts). */
  name?: string;
  /** `channel`: the share's file it is (to go on with after a pause, also after a restart). */
  from?: { sid: string; itemId: string; index: number };
  /** `channel`, done: false when its copy could not be put in Downloads/Sable (it is kept in Sable and opens from there). */
  published?: boolean;
}

export type Status = { state: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'gone'; bytes?: number; total?: number; reason?: number };

export interface FilesPlugin {
  // DownloadManager (a legacy pairing).
  download(o: { url: string; name: string; mime?: string; from?: string }): Promise<{ id: string }>;
  status(o: { id: string }): Promise<Status>;
  cancel(o: { id: string }): Promise<void>;
  /** Reads the finished file whole: its SHA-256 and size, and whether they are what was named. */
  verify(o: { id: string; sha256: string; size?: number }): Promise<{ ok: boolean; sha256?: string; size?: number }>;
  // The secure channel's private files.
  /**
   * A private file for `key`'s bytes (the one already there when it is the same file: `have` bytes of
   * it). `file`: that very file is already verified on the phone (its record kept natively), done.
   */
  stageBegin(o: { key: string; name: string; size: number; sha256: string }): Promise<{ id: string; have: number; file?: string; published?: boolean }>;
  /** Appends a chunk (base64) at `offset`, which must be where the file ends. */
  stageWrite(o: { id: string; offset: number; data: string }): Promise<{ have: number }>;
  /** Reads the private file whole and compares it with its digest: kept (a verified record, `file`) or removed. `published`: false when its copy could not go to Downloads/Sable. */
  stageFinish(o: { id: string }): Promise<{ ok: boolean; file?: string; published?: boolean }>;
  /** Drops a private file not finished (stopped). */
  stageDrop(o: { id: string }): Promise<void>;
  /** Removes a verified private copy and its record (its entry was let go). */
  discard?(o: { file: string }): Promise<void>;
  /** Removes every private file and record whose id is not in `keep` (at start). */
  prune?(o: { keep: string[] }): Promise<void>;
}

/** How long one call may wait (`deadline`, on lib/errors.ts `monotonic` time) and what stops it (`signal`: the download was stopped). */
export interface CallCtx {
  signal?: AbortSignal;
  deadline?: number;
}

/** What the secure channel gives (conn.ts over `phone.fileStart` / `phone.fileChunk` / `phone.fileEnd`). */
export interface Channel {
  /** Paired securely: downloads come this way (and only this way). */
  secure(): boolean;
  start(p: { sid: string; itemId: string; index: number }, ctx?: CallCtx): Promise<PhoneFileStart>;
  chunk(p: { transfer: string; offset: number; length: number }, ctx?: CallCtx): Promise<{ data: string }>;
  end(transfer: string): Promise<unknown>;
}

/** An app goes to the installer only from a verified private copy that came over the secure channel. */
export const installable = (d: Download) => d.state === 'done' && d.via === 'channel' && !!d.verified && !!d.file;

/** Why a finished download was thrown away. */
export const SWAPPED = 'Changed on the way, so it was removed.';
/** A pairing from before the secure channel: no file comes that way. */
export const PLAIN_OFF = 'Pair again to download it';
/** The desktop prepares one file per phone at a time; a second start is told this (and waits). */
const BUSY = /another download is starting/i;
/** How a start told "another download is starting" waits before it asks again. */
export const BUSY_WAIT = [300, 600, 1200, 2000, 3000, 4000, 5000, 6000];
/** One start's whole time from its turn: every wait on a busy desktop and the desktop's hashing of the file. */
export const START_BUDGET = 150_000;
/** Chunks asked for ahead of the one being written. */
export const WINDOW = 2;

export interface Deps {
  plugin: FilesPlugin;
  /**
   * A legacy pairing's one-time link for a file (the desktop's `phone.fileLink`), as a URL. Absent (the
   * app): nothing is transferred over a plain pairing, and a system download an older build left
   * running is stopped.
   */
  link?(p: { sid: string; itemId: string; index: number }): Promise<{ url: string; size?: number; sha256?: string; secure?: boolean }>;
  /** The secure channel (absent: downloads only as a legacy pairing does). */
  channel?: Channel;
  /** A lost connection (the call may not have reached the desktop): such a failure pauses, it does not fail. */
  lost?: (err: unknown) => boolean;
  /** On the phone (the system's downloads for a legacy pairing); otherwise the web preview acts those out. */
  native: boolean;
  storage?: { get(): string | null; set(v: string): void };
  /** The app is in the background (the loop stops; `resume` starts it again). */
  hidden?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic time for deadlines (tests). */
  now?: () => number;
  /** The web preview's acted download takes this long. */
  actMs?: () => number;
}

export const KEEP = 60;
/** How often progress is read: while bytes move, and while every transfer waits (paused, for Wi-Fi). */
export const POLL = { moving: 250, paused: 3000 };

const IDLE: Download = { state: 'idle' };
const active = (s: DownloadState) => s === 'pending' || s === 'running' || s === 'paused' || s === 'verifying';
const settled = (s: DownloadState) => s === 'idle' || s === 'done' || s === 'failed';
/** Polled from DownloadManager: a legacy download under way. */
const polled = (d: Download) => d.via !== 'channel' && !!d.id && active(d.state);

const KEYS = ['state', 'via', 'id', 'bytes', 'total', 'error', 'url', 'attempt', 'sha256', 'size', 'verified', 'secure', 'stage', 'file', 'name', 'published'] as const;
const same = (a: Download, b: Download) => KEYS.every((k) => a[k] === b[k]) && a.from === b.from;

export function reasonText(r?: number) {
  // DownloadManager's ERROR_* codes that a person can do something about.
  if (r === 1006) return 'Not enough space on this phone.';
  if (r === 1004 || r === 1002 || (r !== undefined && r >= 400 && r < 600)) return 'The computer no longer has the file, or the link ran out.';
  return 'The download stopped. Try again.';
}

/** An entry after a status read. */
export function fromStatus(d: Download, s: Status): Download {
  if (s.state === 'gone') return { state: 'failed', error: 'The download was removed.', attempt: d.attempt };
  if (s.state === 'failed') return { ...d, state: 'failed', error: reasonText(s.reason) };
  return { ...d, state: s.state, bytes: s.bytes, total: s.total && s.total > 0 ? s.total : d.total };
}

/** What an entry keeps across restarts: where it stands, how it comes, and what the file must be. */
const keepOf = (d: Download): Download => ({
  // A channel download cut off by the app closing goes on when it is back (paused until connected).
  state: d.via === 'channel' && active(d.state) ? 'paused' : d.state,
  ...(d.via ? { via: d.via } : {}),
  ...(d.id ? { id: d.id } : {}),
  ...(d.total !== undefined ? { total: d.total } : {}),
  ...(d.bytes !== undefined && d.via === 'channel' ? { bytes: d.bytes } : {}),
  ...(d.sha256 ? { sha256: d.sha256 } : {}),
  ...(d.size !== undefined ? { size: d.size } : {}),
  ...(d.verified ? { verified: true } : {}),
  ...(d.secure ? { secure: true } : {}),
  ...(d.stage ? { stage: d.stage } : {}),
  ...(d.file ? { file: d.file } : {}),
  ...(d.name ? { name: d.name } : {}),
  ...(d.from ? { from: d.from } : {}),
  ...(d.published === false ? { published: false } : {}),
});
const keepable = (d: Download) => (d.via === 'channel' ? d.state === 'done' || active(d.state) : !!d.id && (d.state === 'done' || active(d.state)));

/** A refusal the desktop gave (it reached the desktop): such a download fails; a lost connection only pauses it. */
const refusedBy = (deps: Deps, err: unknown) => !(deps.lost?.(err) ?? false);

/**
 * The history as kept: `ok` with its entries (`sound`: it was a history, read whole), or not `ok`
 * when the storage itself could not be read (it may hold everything).
 */
function readKept(storage: Deps['storage']): { ok: true; entries: Record<string, Download>; sound: boolean } | { ok: false } {
  let text: string | null;
  try {
    text = storage ? storage.get() : null;
  } catch {
    return { ok: false };
  }
  // Kept: finished ones (Open) and ones still under way (read again, or gone on with).
  const out: Record<string, Download> = {};
  try {
    const raw = JSON.parse(text ?? '{}') as Record<string, Download>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, entries: out, sound: false };
    for (const [k, d] of Object.entries(raw)) if (d && typeof d === 'object' && keepable(d)) out[k] = keepOf(d);
    return { ok: true, entries: out, sound: true };
  } catch {
    // Not a history (damaged): what it named cannot be told, so nothing is pruned by it.
    return { ok: true, entries: out, sound: false };
  }
}

export function createDownloads(deps: Deps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? monotonic;
  let attempts = 0;
  /** What the storage holds as far as this knows (moved on only by a write that worked). */
  let savedJson = '';
  const subs = new Set<() => void>();
  /** Each attempt's stop (a Stop, Forget, or a newer attempt of the same entry aborts it). */
  const stops = new Map<string, AbortController>();
  /** Paused because the desktop had no room for one more of this phone's transfers: each goes on when one of them ends. */
  const turnWait = new Set<string>();

  const first = readKept(deps.storage);
  /** The history could not be read: nothing is written over it (nor pruned by it) until it can be. */
  let unread = !first.ok;
  let all: Record<string, Download> = first.ok ? first.entries : {};

  /** What is kept across restarts: finished downloads and ones under way. */
  const kept = () => {
    const keep: Record<string, Download> = {};
    for (const [k, d] of Object.entries(all)) if (keepable(d)) keep[k] = keepOf(d);
    return JSON.stringify(keep);
  };
  if (first.ok) savedJson = kept();

  if (!deps.link) {
    // No plain transfers any more: a system download an older build left running stops here (before it publishes unchecked bytes).
    for (const [k, d] of Object.entries(all)) {
      if (d.via === 'channel' || !active(d.state)) continue;
      if (d.id && deps.native) void deps.plugin.cancel({ id: d.id }).catch(() => {});
      all = { ...all, [k]: { state: 'failed', via: 'system', error: PLAIN_OFF, attempt: d.attempt, total: d.total } };
    }
  }
  /** Private files no entry names (an entry let go, a record Android cut off before the page wrote it) go: only by a history read whole. */
  function prune() {
    if (!deps.native || !deps.plugin.prune) return;
    const keep = new Set<string>();
    for (const d of Object.values(all)) {
      if (d.stage) keep.add(d.stage);
      if (d.file) keep.add(d.file);
    }
    void deps.plugin.prune({ keep: [...keep] }).catch(() => {});
  }
  if (first.ok && first.sound) prune();

  /** The history read after all (it could not be at start): what came since stays over it, then the private files are reconciled. */
  function readLate(): boolean {
    const r = readKept(deps.storage);
    if (!r.ok) return false;
    unread = false;
    all = { ...r.entries, ...all };
    if (r.sound) prune();
    return true;
  }

  /** Written only when what is kept changed (bytes moving over DownloadManager never write); it counts as written once the write worked. */
  function save() {
    if (unread && !readLate()) return;
    const json = kept();
    if (json === savedJson) return;
    try {
      deps.storage?.set(json);
      savedJson = json;
    } catch {
      /* full: tried again with the next change */
    }
  }

  function set(key: string, d: Download) {
    const cur = all[key];
    if (cur && same(cur, d)) return;
    // The newest last; past `KEEP`, the oldest settled entries go (one still at work is never dropped).
    const next = { ...all };
    delete next[key];
    next[key] = d;
    const keys = Object.keys(next);
    for (let i = 0, over = keys.length - KEEP; i < keys.length && over > 0; i++) {
      if (keys[i] !== key && settled(next[keys[i]].state)) {
        // Its private copy goes with it (nothing could open it any more).
        const file = next[keys[i]].file;
        if (file && next[keys[i]].via === 'channel' && !Object.entries(next).some(([k2, x]) => k2 !== keys[i] && x.file === file)) void deps.plugin.discard?.({ file }).catch(() => {});
        delete next[keys[i]];
        over--;
      }
    }
    all = next;
    subs.forEach((f) => f());
    save();
  }

  let polling = false;
  /** One loop at a time (DownloadManager's downloads); each read awaited; a reply that comes back after its entry changed is dropped. */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (;;) {
        if (deps.hidden?.()) return;
        const live = Object.entries(all).filter(([, d]) => polled(d));
        if (!live.length) return;
        for (const [k, d] of live) {
          if (d.state === 'verifying') {
            await check(k, d);
            continue;
          }
          let s: Status;
          try {
            s = await deps.plugin.status({ id: d.id! });
          } catch {
            continue;
          }
          if (all[k] !== d) continue;
          const next = fromStatus(d, s);
          // There: read whole and compared with what the desktop named before it counts.
          if (next.state === 'done' && next.sha256) {
            const v: Download = { ...next, state: 'verifying' };
            set(k, v);
            await check(k, v);
          } else set(k, next.state === 'done' ? { ...next, verified: false } : next);
        }
        const moving = Object.values(all).some((d) => polled(d) && (d.state === 'running' || d.state === 'pending' || d.state === 'verifying'));
        await sleep(moving ? POLL.moving : POLL.paused);
      }
    } finally {
      polling = false;
    }
  }

  /** A finished DownloadManager file read whole: kept when it is what the desktop named, removed (and said so) when not. */
  async function check(key: string, d: Download) {
    let r: { ok: boolean };
    try {
      r = await deps.plugin.verify({ id: d.id!, sha256: d.sha256!, ...(d.size !== undefined ? { size: d.size } : {}) });
    } catch (err) {
      if (all[key] !== d) return;
      return set(key, { state: 'failed', error: (err as Error).message || 'The file is no longer on this phone.', attempt: d.attempt, total: d.total });
    }
    if (all[key] !== d) return;
    if (r.ok) return set(key, { ...d, state: 'done', verified: true });
    await deps.plugin.cancel({ id: d.id! }).catch(() => {});
    if (all[key] !== d) return;
    set(key, { state: 'failed', error: SWAPPED, attempt: d.attempt, total: d.total });
  }

  /** The web preview: a legacy download acted out (progress over a moment, then done), its attempt checked at every step. */
  function act(key: string, url: string, total: number, attempt: number, what: Pick<Download, 'sha256' | 'size' | 'secure'>) {
    const ms = deps.actMs?.() ?? 2200;
    const t0 = Date.now();
    set(key, { state: 'running', via: 'system', bytes: 0, total, url, id: 'web', attempt, ...what });
    const tick = () => {
      if (all[key]?.attempt !== attempt || all[key]?.state !== 'running') return;
      const k = Math.min(1, (Date.now() - t0) / ms);
      if (k >= 1) return set(key, { state: 'done', via: 'system', bytes: total, total, url, id: 'web', attempt, ...what, verified: !!what.sha256 });
      set(key, { state: 'running', via: 'system', bytes: Math.round(total * k * k * (3 - 2 * k)), total, url, id: 'web', attempt, ...what });
      setTimeout(tick, 120);
    };
    setTimeout(tick, 200);
  }

  /**
   * Starts over the channel, one at a time (the queue), each told "another download is starting"
   * waiting it out, all within one deadline from its turn. A start stopped meanwhile asks nothing
   * more, and the queue goes on at once (a stopped start never holds the ones behind it).
   */
  let starting: Promise<unknown> = Promise.resolve();
  function startOne(p: { sid: string; itemId: string; index: number }, mine: () => boolean, signal: AbortSignal): Promise<PhoneFileStart> {
    const run = starting.then(async () => {
      const deadline = now() + START_BUDGET;
      for (let i = 0; ; i++) {
        // Stopped while it waited its turn: it does not ask at all.
        if (!mine() || signal.aborted) throw stoppedError();
        try {
          return await deps.channel!.start(p, { signal, deadline });
        } catch (err) {
          if (signal.aborted) throw stoppedError();
          if (!BUSY.test((err as Error)?.message ?? '') || i >= BUSY_WAIT.length || now() + BUSY_WAIT[i] > deadline) throw err;
          await nap(BUSY_WAIT[i], signal, sleep);
        }
      }
    });
    starting = untilStopped(run, signal).catch(() => {});
    return run;
  }

  /**
   * A download over the secure channel, from the bytes already in its private file. Each await checks
   * that this attempt is still the entry's; a lost connection pauses it (it goes on when the phone is
   * connected again), a refusal or a file that does not match fails it.
   */
  async function viaChannel(key: string, p: { sid: string; itemId: string; index: number }, attempt: number, size?: number) {
    const ch = deps.channel!;
    const mine = () => all[key]?.attempt === attempt;
    stops.get(key)?.abort();
    const stop = new AbortController();
    stops.set(key, stop);
    const signal = stop.signal;
    const from = { sid: p.sid, itemId: p.itemId, index: p.index };
    const was = all[key];
    set(key, { ...(was && was.via === 'channel' && was.state === 'paused' ? was : {}), state: 'asking', via: 'channel', secure: true, total: was?.total ?? size, attempt, from });
    let transfer: string | undefined;
    let stage: string | undefined;
    /** A transfer was opened on the desktop for it: its end frees room there for one waiting its turn. */
    let opened = false;
    turnWait.delete(key);
    try {
      const s = await startOne(p, mine, signal);
      transfer = s.transfer;
      opened = true;
      if (!mine()) return void ch.end(s.transfer).catch(() => {});
      // A paused download of other bytes (the share recorded another file since) starts over.
      const st = await deps.plugin.stageBegin({ key, name: s.name, size: s.size, sha256: s.sha256 });
      stage = st.id;
      if (!mine()) return void ch.end(s.transfer).catch(() => {});
      const base: Download = { state: 'running', via: 'channel', secure: true, bytes: st.have, total: s.size, sha256: s.sha256, size: s.size, stage: st.id, name: s.name, attempt, from };
      // Already verified on the phone (Android stopped the app after the check, before this was written down): done, not fetched again.
      if (st.file) {
        void ch.end(s.transfer).catch(() => {});
        transfer = undefined;
        return set(key, { ...base, bytes: s.size, state: 'done', verified: true, file: st.file, ...(st.published === false ? { published: false } : {}) });
      }
      set(key, base);
      // Asked ahead (at most WINDOW), written strictly in order.
      let asked = st.have;
      let written = st.have;
      const ahead: { at: number; len: number; reply: Promise<{ data: string }> }[] = [];
      const ask = () => {
        while (ahead.length < WINDOW && asked < s.size) {
          const len = Math.min(s.chunk, s.size - asked);
          const reply = ch.chunk({ transfer: s.transfer, offset: asked, length: len }, { signal });
          reply.catch(() => {});
          ahead.push({ at: asked, len, reply });
          asked += len;
        }
      };
      ask();
      while (written < s.size) {
        const next = ahead.shift()!;
        const r = await next.reply;
        if (!mine()) return void ch.end(s.transfer).catch(() => {});
        const w = await deps.plugin.stageWrite({ id: st.id, offset: next.at, data: r.data });
        if (!mine()) return void ch.end(s.transfer).catch(() => {});
        if (w.have !== next.at + next.len) throw new Error('The download stopped. Try again.');
        written = w.have;
        set(key, { ...base, bytes: written });
        ask();
      }
      void ch.end(s.transfer).catch(() => {});
      transfer = undefined;
      set(key, { ...base, bytes: written, state: 'verifying' });
      // Read whole on the phone (natively) and compared with the digest the share recorded: only then is it there.
      const v = await deps.plugin.stageFinish({ id: st.id });
      if (!mine()) return;
      if (!v.ok || !v.file) return set(key, { state: 'failed', via: 'channel', error: SWAPPED, attempt, total: s.size });
      set(key, { ...base, bytes: written, state: 'done', verified: true, file: v.file, ...(v.published === false ? { published: false } : {}) });
    } catch (err) {
      if (transfer) void ch.end(transfer).catch(() => {});
      if (!mine()) return;
      const cur = all[key];
      // The connection went away: it waits, its bytes kept, and goes on once connected.
      if (!refusedBy(deps, err)) return set(key, { ...cur, state: 'paused', attempt });
      // Still no room on the desktop when its time ran out (every transfer of this phone in use): it
      // waits, its bytes kept, and goes on when one of them ends (or once connected again).
      if (isBusy(err)) {
        turnWait.add(key);
        return set(key, { ...cur, state: 'paused', attempt });
      }
      if (stage) void deps.plugin.stageDrop({ id: stage }).catch(() => {});
      set(key, { state: 'failed', via: 'channel', total: cur?.total ?? size, error: (err as Error).message, attempt });
      throw err;
    } finally {
      if (stops.get(key) === stop) stops.delete(key);
      if (opened) nextInTurn();
    }
  }

  /** A transfer of this phone ended: the first download waiting for room goes on now. */
  function nextInTurn() {
    if (!deps.channel?.secure()) return;
    for (const k of turnWait) {
      turnWait.delete(k);
      const d = all[k];
      if (d?.via === 'channel' && d.state === 'paused' && d.from) return void viaChannel(k, d.from, ++attempts, d.total).catch(() => {});
    }
  }

  /** The attempt of `key` under way stops: nothing more is asked for it, and a wait on a busy desktop ends now. */
  function stopAttempt(key: string) {
    stops.get(key)?.abort();
    stops.delete(key);
  }

  return {
    get: (key: string): Download => all[key] ?? IDLE,
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    set,
    /** Entries in memory (tests). */
    size: () => Object.keys(all).length,
    hasActive: () => Object.values(all).some((d) => polled(d)),
    /** Back on screen (or started again): the loop reads what is still at work. */
    resume: () => void poll(),
    /** Connected again (over the secure channel): channel downloads that paused go on from their bytes. */
    reconnected() {
      if (!deps.channel?.secure()) return;
      for (const [k, d] of Object.entries(all)) if (d.via === 'channel' && d.state === 'paused' && d.from) void viaChannel(k, d.from, ++attempts, d.total).catch(() => {});
    },
    /** Every entry goes (the desktop was forgotten); a download under way stops where it is. */
    forgetAll() {
      attempts++;
      for (const s of stops.values()) s.abort();
      stops.clear();
      turnWait.clear();
      const was = all;
      all = {};
      for (const d of Object.values(was)) {
        if (d.via === 'channel' && d.stage && d.state !== 'done') void deps.plugin.stageDrop({ id: d.stage }).catch(() => {});
        if (d.via !== 'channel' && d.id && active(d.state) && deps.native) void deps.plugin.cancel({ id: d.id }).catch(() => {});
      }
      subs.forEach((f) => f());
      save();
    },

    /** Starts a download of one file of a share step (over the secure channel when that is the connection). */
    async start(key: string, p: { sid: string; itemId: string; index: number; name: string; size?: number; mime?: string; from?: string }) {
      const cur = all[key];
      if (cur && (cur.state === 'asking' || cur.state === 'pending' || cur.state === 'running' || cur.state === 'verifying')) return;
      const attempt = ++attempts;
      if (deps.channel?.secure()) return viaChannel(key, p, attempt, p.size);
      // A pairing from before the secure channel: nothing comes over it (pair again).
      const link = deps.link;
      if (!link) {
        set(key, { state: 'failed', via: 'system', total: p.size, error: PLAIN_OFF, attempt });
        throw new Error(PLAIN_OFF);
      }
      const mine = () => all[key]?.attempt === attempt;
      set(key, { state: 'asking', via: 'system', total: p.size, attempt });
      try {
        const r = await link(p);
        if (!mine()) return;
        const total = r.size ?? p.size;
        // A plain pairing's digest proves nothing (it came the same way as the bytes): kept to catch damage, never to install.
        const what = { ...(r.sha256 ? { sha256: r.sha256.toLowerCase() } : {}), ...(r.size !== undefined ? { size: r.size } : {}) };
        if (!deps.native) return void act(key, r.url, total ?? 1_000_000, attempt, what);
        const { id } = await deps.plugin.download({ url: r.url, name: p.name, mime: p.mime, from: p.from });
        // Stopped while the system was asked: the download it made goes again.
        if (!mine()) return void (await deps.plugin.cancel({ id }).catch(() => {}));
        set(key, { state: 'pending', via: 'system', id, bytes: 0, total, url: r.url, attempt, ...what });
        void poll();
      } catch (err) {
        if (!mine()) return;
        set(key, { state: 'failed', via: 'system', total: p.size, error: (err as Error).message, attempt });
        throw err;
      }
    },

    /** Stops a download, also one whose link or file is still being prepared (that attempt ends now). */
    async cancel(key: string) {
      const d = all[key];
      set(key, { state: 'idle' });
      stopAttempt(key);
      turnWait.delete(key);
      if (d?.via === 'channel') {
        if (d.stage && d.state !== 'done') await deps.plugin.stageDrop({ id: d.stage }).catch(() => {});
        return;
      }
      if (d?.id && deps.native) await deps.plugin.cancel({ id: d.id }).catch(() => {});
    },
  };
}
