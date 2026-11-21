/**
 * The downloads' logic, free of Capacitor and the connection (lib/downloads.ts wires it), so it can
 * be tested: one attempt per start, each with its own identity, checked after every await (a Stop
 * while the desktop prepares the link ends the attempt for good, and a native download that starts
 * after its attempt was stopped is removed again); one polling loop that awaits each read (never two
 * at once, an older reply never lands over a newer entry), reads four times a second while bytes
 * move, every few seconds while a transfer is paused, and not at all while the app is in the
 * background; storage written only when what is kept changed; at most `KEEP` entries, in memory as
 * on disk.
 */

export type DownloadState = 'idle' | 'asking' | 'pending' | 'running' | 'paused' | 'done' | 'failed';
export interface Download {
  state: DownloadState;
  /** DownloadManager's id once it started. */
  id?: string;
  bytes?: number;
  total?: number;
  error?: string;
  url?: string;
  /** Which start this entry belongs to (a stopped or newer attempt makes an older one's replies moot). */
  attempt?: number;
}

export type Status = { state: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'gone'; bytes?: number; total?: number; reason?: number };

export interface FilesPlugin {
  download(o: { url: string; name: string; mime?: string; from?: string }): Promise<{ id: string }>;
  status(o: { id: string }): Promise<Status>;
  cancel(o: { id: string }): Promise<void>;
}

export interface Deps {
  plugin: FilesPlugin;
  /** The one-time link for a file of a share step (the desktop's `phone.fileLink`), as a URL. */
  link(p: { sid: string; itemId: string; index: number }): Promise<{ url: string; size?: number }>;
  /** On the phone (the system downloads); otherwise the web preview acts it out. */
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
const active = (s: DownloadState) => s === 'pending' || s === 'running' || s === 'paused';
const settled = (s: DownloadState) => s === 'idle' || s === 'done' || s === 'failed';

const same = (a: Download, b: Download) =>
  a.state === b.state && a.id === b.id && a.bytes === b.bytes && a.total === b.total && a.error === b.error && a.url === b.url && a.attempt === b.attempt;

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

export function createDownloads(deps: Deps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempts = 0;
  let savedJson = '';
  const subs = new Set<() => void>();

  let all: Record<string, Download> = (() => {
    try {
      const raw = JSON.parse(deps.storage?.get() ?? '{}') as Record<string, Download>;
      // Kept: finished ones (Open) and ones still in the system's hands (read again).
      const out: Record<string, Download> = {};
      for (const [k, d] of Object.entries(raw)) if (d && d.id && (d.state === 'done' || active(d.state))) out[k] = { state: d.state, id: d.id, total: d.total };
      return out;
    } catch {
      return {};
    }
  })();

  /** What is kept across restarts: finished and running downloads (no byte counts). */
  const kept = () => {
    const keep: Record<string, Download> = {};
    for (const [k, d] of Object.entries(all)) if (d.id && (d.state === 'done' || active(d.state))) keep[k] = { state: d.state, id: d.id, total: d.total };
    return JSON.stringify(keep);
  };
  savedJson = kept();

  /** Written only when what is kept changed (bytes moving never write). */
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
  /** One loop at a time; each read awaited; a reply that comes back after its entry changed is dropped. */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (;;) {
        if (deps.hidden?.()) return;
        const live = Object.entries(all).filter(([, d]) => d.id && active(d.state));
        if (!live.length) return;
        for (const [k, d] of live) {
          let s: Status;
          try {
            s = await deps.plugin.status({ id: d.id! });
          } catch {
            continue;
          }
          if (all[k] !== d) continue;
          set(k, fromStatus(d, s));
        }
        const moving = Object.values(all).some((d) => d.id && (d.state === 'running' || d.state === 'pending'));
        await sleep(moving ? POLL.moving : POLL.paused);
      }
    } finally {
      polling = false;
    }
  }

  /** The web preview: a download acted out (progress over a moment, then done), its attempt checked at every step. */
  function act(key: string, url: string, total: number, attempt: number) {
    const ms = deps.actMs?.() ?? 2200;
    const t0 = Date.now();
    set(key, { state: 'running', bytes: 0, total, url, id: 'web', attempt });
    const tick = () => {
      if (all[key]?.attempt !== attempt || all[key]?.state !== 'running') return;
      const k = Math.min(1, (Date.now() - t0) / ms);
      if (k >= 1) return set(key, { state: 'done', bytes: total, total, url, id: 'web', attempt });
      set(key, { state: 'running', bytes: Math.round(total * k * k * (3 - 2 * k)), total, url, id: 'web', attempt });
      setTimeout(tick, 120);
    };
    setTimeout(tick, 200);
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
    hasActive: () => Object.values(all).some((d) => d.id && active(d.state)),
    /** Back on screen (or started again): the loop reads what is still at work. */
    resume: () => void poll(),

    /** Starts a download of one file of a share step. */
    async start(key: string, p: { sid: string; itemId: string; index: number; name: string; size?: number; mime?: string; from?: string }) {
      const cur = all[key];
      if (cur && (cur.state === 'asking' || cur.state === 'pending' || cur.state === 'running')) return;
      const attempt = ++attempts;
      const mine = () => all[key]?.attempt === attempt;
      set(key, { state: 'asking', total: p.size, attempt });
      try {
        const r = await deps.link(p);
        if (!mine()) return;
        const total = r.size ?? p.size;
        if (!deps.native) return void act(key, r.url, total ?? 1_000_000, attempt);
        const { id } = await deps.plugin.download({ url: r.url, name: p.name, mime: p.mime, from: p.from });
        // Stopped while the system was asked: the download it made goes again.
        if (!mine()) return void (await deps.plugin.cancel({ id }).catch(() => {}));
        set(key, { state: 'pending', id, bytes: 0, total, url: r.url, attempt });
        void poll();
      } catch (err) {
        if (!mine()) return;
        set(key, { state: 'failed', total: p.size, error: (err as Error).message, attempt });
        throw err;
      }
    },

    /** Stops a download, also one whose link is still being prepared (that attempt ends now). */
    async cancel(key: string) {
      const d = all[key];
      set(key, { state: 'idle' });
      if (d?.id && deps.native) await deps.plugin.cancel({ id: d.id }).catch(() => {});
    },
  };
}
