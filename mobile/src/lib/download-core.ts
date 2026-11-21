import type { PhoneFileStart } from '@shared/protocol';

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
 * Over a pairing from before the secure channel: Android's DownloadManager over plain HTTP as before
 * (never an APK: the desktop refuses those links and the row offers no download), one polling loop
 * that awaits each read, reads four times a second while bytes move, every few seconds while a
 * transfer is paused, and not at all while the app is in the background.
 *
 * Every start has its own attempt, checked after every await (a Stop while the desktop prepares the
 * file ends it for good). Storage is written only when what is kept changed; at most `KEEP` entries.
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
  /** A private file for `key`'s bytes (the one already there when it is the same file: `have` bytes of it). */
  stageBegin(o: { key: string; name: string; size: number; sha256: string }): Promise<{ id: string; have: number }>;
  /** Appends a chunk (base64) at `offset`, which must be where the file ends. */
  stageWrite(o: { id: string; offset: number; data: string }): Promise<{ have: number }>;
  /** Reads the private file whole and compares it with its digest: kept (a verified record, `file`) or removed. */
  stageFinish(o: { id: string }): Promise<{ ok: boolean; file?: string }>;
  /** Drops a private file not finished (stopped). */
  stageDrop(o: { id: string }): Promise<void>;
}

/** What the secure channel gives (conn.ts over `phone.fileStart` / `phone.fileChunk` / `phone.fileEnd`). */
export interface Channel {
  /** Paired securely: downloads come this way (and only this way). */
  secure(): boolean;
  start(p: { sid: string; itemId: string; index: number }): Promise<PhoneFileStart>;
  chunk(p: { transfer: string; offset: number; length: number }): Promise<{ data: string }>;
  end(transfer: string): Promise<unknown>;
}

/** An app goes to the installer only from a verified private copy that came over the secure channel. */
export const installable = (d: Download) => d.state === 'done' && d.via === 'channel' && !!d.verified && !!d.file;

/** Why a finished download was thrown away. */
export const SWAPPED = 'Changed on the way, so it was removed.';
/** Chunks asked for ahead of the one being written. */
export const WINDOW = 2;

export interface Deps {
  plugin: FilesPlugin;
  /** A legacy pairing: the one-time link for a file of a share step (the desktop's `phone.fileLink`), as a URL. */
  link(p: { sid: string; itemId: string; index: number }): Promise<{ url: string; size?: number; sha256?: string; secure?: boolean }>;
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

const KEYS = ['state', 'via', 'id', 'bytes', 'total', 'error', 'url', 'attempt', 'sha256', 'size', 'verified', 'secure', 'stage', 'file', 'name'] as const;
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
});
const keepable = (d: Download) => (d.via === 'channel' ? d.state === 'done' || active(d.state) : !!d.id && (d.state === 'done' || active(d.state)));

/** A refusal the desktop gave (it reached the desktop): such a download fails; a lost connection only pauses it. */
const refusedBy = (deps: Deps, err: unknown) => !(deps.lost?.(err) ?? false);

export function createDownloads(deps: Deps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempts = 0;
  let savedJson = '';
  const subs = new Set<() => void>();

  let all: Record<string, Download> = (() => {
    try {
      const raw = JSON.parse(deps.storage?.get() ?? '{}') as Record<string, Download>;
      // Kept: finished ones (Open) and ones still under way (read again, or gone on with).
      const out: Record<string, Download> = {};
      for (const [k, d] of Object.entries(raw)) if (d && keepable(d)) out[k] = keepOf(d);
      return out;
    } catch {
      return {};
    }
  })();

  /** What is kept across restarts: finished downloads and ones under way. */
  const kept = () => {
    const keep: Record<string, Download> = {};
    for (const [k, d] of Object.entries(all)) if (keepable(d)) keep[k] = keepOf(d);
    return JSON.stringify(keep);
  };
  savedJson = kept();

  /** Written only when what is kept changed (bytes moving over DownloadManager never write). */
  function save() {
    const json = kept();
    if (json === savedJson) return;
    savedJson = json;
    try {
      deps.storage?.set(json);
    } catch {
      /* full */
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
   * A download over the secure channel, from the bytes already in its private file. Each await checks
   * that this attempt is still the entry's; a lost connection pauses it (it goes on when the phone is
   * connected again), a refusal or a file that does not match fails it.
   */
  async function viaChannel(key: string, p: { sid: string; itemId: string; index: number }, attempt: number, size?: number) {
    const ch = deps.channel!;
    const mine = () => all[key]?.attempt === attempt;
    const from = { sid: p.sid, itemId: p.itemId, index: p.index };
    const was = all[key];
    set(key, { ...(was && was.via === 'channel' && was.state === 'paused' ? was : {}), state: 'asking', via: 'channel', secure: true, total: was?.total ?? size, attempt, from });
    let transfer: string | undefined;
    let stage: string | undefined;
    try {
      const s = await ch.start(p);
      transfer = s.transfer;
      if (!mine()) return void ch.end(s.transfer).catch(() => {});
      // A paused download of other bytes (the share recorded another file since) starts over.
      const st = await deps.plugin.stageBegin({ key, name: s.name, size: s.size, sha256: s.sha256 });
      stage = st.id;
      if (!mine()) return void ch.end(s.transfer).catch(() => {});
      const base: Download = { state: 'running', via: 'channel', secure: true, bytes: st.have, total: s.size, sha256: s.sha256, size: s.size, stage: st.id, name: s.name, attempt, from };
      set(key, base);
      // Asked ahead (at most WINDOW), written strictly in order.
      let asked = st.have;
      let written = st.have;
      const ahead: { at: number; len: number; reply: Promise<{ data: string }> }[] = [];
      const ask = () => {
        while (ahead.length < WINDOW && asked < s.size) {
          const len = Math.min(s.chunk, s.size - asked);
          const reply = ch.chunk({ transfer: s.transfer, offset: asked, length: len });
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
      set(key, { ...base, bytes: written, state: 'done', verified: true, file: v.file });
    } catch (err) {
      if (transfer) void ch.end(transfer).catch(() => {});
      if (!mine()) return;
      const cur = all[key];
      // The connection went away: it waits, its bytes kept, and goes on once connected.
      if (!refusedBy(deps, err)) return set(key, { ...cur, state: 'paused', attempt });
      if (stage) void deps.plugin.stageDrop({ id: stage }).catch(() => {});
      set(key, { state: 'failed', via: 'channel', total: cur?.total ?? size, error: (err as Error).message, attempt });
      throw err;
    }
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
      const mine = () => all[key]?.attempt === attempt;
      set(key, { state: 'asking', via: 'system', total: p.size, attempt });
      try {
        const r = await deps.link(p);
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
      if (d?.via === 'channel') {
        if (d.stage && d.state !== 'done') await deps.plugin.stageDrop({ id: d.stage }).catch(() => {});
        return;
      }
      if (d?.id && deps.native) await deps.plugin.cancel({ id: d.id }).catch(() => {});
    },
  };
}
