import { epoch, still } from './epoch';
import { onForget } from './forget';
import { durable, readPref } from './native';

/**
 * Unsent words per chat, one draft each, kept across restarts (Android may close the app in the
 * background). Each draft has a revision that every change moves on. The page's storage holds them
 * (`sable.drafts`), written a moment after typing stops and at once when it matters. Whoever shows a
 * chat's field listens (`onDraft`): words put into the draft from elsewhere (taken back from the
 * queue, recovered at a start) are in the field the moment they are in the draft, so the field never
 * writes an older text over them.
 *
 * Words taken back from the queue (lib/take.ts) go into the chat's draft at once, and the draft is
 * also committed to Android's storage (`sable.taken`, Android's commit, not the page's storage that
 * a closed app may lose) before the desktop is told it may let the message go. That committed copy
 * follows the draft from then on (each later edit is committed too) until the draft is sent or
 * emptied, so the words are never only in memory. The receipts not yet answered are kept with it.
 * At a start the committed copy is taken only when it is a newer revision than the page's own draft
 * (expired copies and receipts are dropped first): words sent or edited since are never brought back.
 *
 * Forgetting the computer forgets them all: the load still under way and every write still due let
 * go (each checks the pairing's generation), the writer is drained, then lib/erase.ts removes both keys.
 */

const DRAFTS = 'sable.drafts';
/** The committed copies of drafts that hold words taken back, and the receipts not yet answered (Capacitor Preferences). */
export const TAKEN = 'sable.taken';
/** The desktop remembers a receipt this long. */
export const RECEIPT_MS = 15 * 60_000;
/** A committed copy no change touched for this long is let go (the page's own draft has long been on the storage). */
export const KEPT_MS = 7 * 24 * 3600_000;

/** One chat's words and their revision. */
interface Draft {
  t: string;
  r: number;
}
/** Why a draft changed: typed in its own field (not told back to it), or put there from elsewhere. */
export type DraftWhy = 'typed' | 'taken' | 'put' | 'recovered';

const book = new Map<string, Draft>(
  (() => {
    const out: [string, Draft][] = [];
    try {
      const o = JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, unknown>;
      for (const [k, v] of Object.entries(o ?? {})) {
        // Kept by a build before revisions: plain text.
        if (typeof v === 'string') out.push([k, { t: v, r: 0 }]);
        else if (v && typeof (v as Draft).t === 'string' && Number.isFinite((v as Draft).r)) out.push([k, { t: (v as Draft).t, r: (v as Draft).r }]);
      }
    } catch {
      /* none */
    }
    return out;
  })(),
);

/** The committed copy of each chat whose draft holds words taken back (`at`: when it was last committed). */
const kept = new Map<string, Draft & { at: number }>();
/** Receipts the desktop has not answered yet (sent again once connected). */
let takes: { id: string; sid: string; at: number }[] = [];
/** Chats whose committed copy is behind their draft. */
const behind = new Set<string>();
const subs = new Map<string, Set<(text: string, why: DraftWhy) => void>>();

export const getDraft = (sid: string) => book.get(sid)?.t ?? '';
export const draftRev = (sid: string) => book.get(sid)?.r ?? 0;

/** Listens to `sid`'s draft changing from elsewhere than its own field; returns the way to stop. */
export function onDraft(sid: string, fn: (text: string, why: DraftWhy) => void): () => void {
  let set = subs.get(sid);
  if (!set) subs.set(sid, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size && subs.get(sid) === set) subs.delete(sid);
  };
}

function tell(sid: string, why: DraftWhy) {
  const t = getDraft(sid);
  for (const fn of [...(subs.get(sid) ?? [])]) fn(t, why);
}

/** The new draft of `sid` in memory (its revision moved on); the committed copy, if it has one, is behind it now. */
function put(sid: string, t: string): number {
  const r = draftRev(sid) + 1;
  book.set(sid, { t, r });
  if (kept.has(sid)) behind.add(sid);
  return r;
}

let saveTimer = 0;

/** Writes the drafts to the page's storage now; false when it would not take them. */
function writeDrafts(): boolean {
  try {
    const o: Record<string, Draft> = {};
    for (const [k, v] of book) if (v.t.trim()) o[k] = v;
    localStorage.setItem(DRAFTS, JSON.stringify(o));
    return true;
  } catch {
    return false;
  }
}

/** Writes everything due now: the page's drafts, and the committed copies that are behind (an emptied draft's copy goes). */
export function flushDrafts(): boolean {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const ok = writeDrafts();
  if (behind.size) {
    const at = Date.now();
    for (const sid of behind) {
      const d = book.get(sid);
      if (d?.t.trim()) kept.set(sid, { ...d, at });
      else kept.delete(sid);
    }
    behind.clear();
    void commit().catch(() => {});
  }
  return ok;
}

/**
 * Sets `sid`'s draft (`why`: `typed` in its own field, which is not told back; anything else is
 * told to the field). Written a moment after typing stops; at once when `now` or when it is empty
 * (a send: a committed copy of it goes at once, so its words never come back). Its revision.
 */
export function setDraft(sid: string, text: string, opts: { why?: DraftWhy; now?: boolean } = {}): number {
  const cur = book.get(sid);
  if (cur && cur.t === text) return cur.r;
  if (!cur && !text) return 0;
  const r = put(sid, text);
  if (opts.why && opts.why !== 'typed') tell(sid, opts.why);
  if (opts.now || !text.trim()) flushDrafts();
  else {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushDrafts, 400);
  }
  return r;
}

const join = (had: string, words: string) => (had.trim() ? `${had.trimEnd()}\n${words}` : words);

// ── the committed copies ──

/** The committed copies could be read at the start (a read that failed is not "none": the first write reads them again first). */
let readOk = false;

const serialize = () => (kept.size || takes.length ? JSON.stringify({ v: 2, kept: Object.fromEntries(kept), takes }) : null);

/**
 * What was committed, taken back in: expired copies and receipts are dropped first, then a copy goes
 * into its draft only when it is a newer revision than the draft (the page lost the newest writes);
 * a draft as new or newer (it was read from the storage) has the words, or was sent or edited since.
 * Returns the chats whose draft it changed.
 */
function recover(raw: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const now = Date.now();
  const fresh = (at: unknown, ms: number) => typeof at === 'number' && now - at < ms;
  const changed: string[] = [];
  const receipt = (id: unknown, sid: unknown, at: unknown) => {
    if (typeof id === 'string' && id && typeof sid === 'string' && fresh(at, RECEIPT_MS) && !takes.some((x) => x.id === id)) takes.push({ id, sid, at: at as number });
  };
  if (Array.isArray(v)) {
    // Kept by a build before revisions: one record per take, its words only.
    for (const t of v as { sid?: unknown; text?: unknown; take?: unknown; at?: unknown }[]) {
      if (!t || typeof t.sid !== 'string' || typeof t.text !== 'string' || !t.text) continue;
      // An unanswered receipt past its time left the message queued on the desktop (its words would come twice).
      if (typeof t.take === 'string' ? !fresh(t.at, RECEIPT_MS) : !fresh(t.at, KEPT_MS)) continue;
      receipt(t.take, t.sid, t.at);
      const had = getDraft(t.sid);
      if (had.includes(t.text)) continue;
      put(t.sid, join(had, t.text));
      kept.set(t.sid, { ...book.get(t.sid)!, at: now });
      changed.push(t.sid);
    }
    return changed;
  }
  const o = v as { kept?: Record<string, { t?: unknown; r?: unknown; at?: unknown }>; takes?: { id?: unknown; sid?: unknown; at?: unknown }[] } | null;
  for (const x of Array.isArray(o?.takes) ? o!.takes : []) receipt(x?.id, x?.sid, x?.at);
  for (const [sid, k] of Object.entries(o?.kept ?? {})) {
    if (!k || typeof k.t !== 'string' || typeof k.r !== 'number' || !Number.isFinite(k.r) || !fresh(k.at, KEPT_MS)) continue;
    const cur = book.get(sid);
    // The draft is this revision or newer: it has the words (or was sent or edited since): the copy is done with.
    if (cur && cur.r >= k.r) continue;
    book.set(sid, { t: k.t, r: k.r });
    kept.set(sid, { t: k.t, r: k.r, at: k.at as number });
    changed.push(sid);
  }
  return changed;
}

let writing: Promise<void> = Promise.resolve();
/** The committed copies written, one write at a time, each only while the pairing it was asked for is the one in use. */
function commit(): Promise<void> {
  const e = epoch();
  const next = writing.then(async () => {
    if (!still(e)) return;
    if (!readOk) {
      // What a start could not read is read before anything is written over it.
      const raw = await readPref(TAKEN);
      if (!still(e)) return;
      readOk = true;
      if (raw) for (const sid of recover(raw)) tell(sid, 'recovered');
    }
    await durable(TAKEN, serialize());
  });
  writing = next.catch(() => {});
  return next;
}

/** Drafts and receipts left from a start Android cut off; fenced by the generation (Forget meanwhile takes nothing in). */
const loaded: Promise<void> = (async () => {
  const e = epoch();
  let raw: string | null;
  try {
    raw = await readPref(TAKEN);
  } catch {
    return;
  }
  if (!still(e)) return;
  readOk = true;
  if (!raw) return;
  const changed = recover(raw);
  if (changed.length) writeDrafts();
  for (const sid of changed) tell(sid, 'recovered');
  // Copies done with (and receipts past their time) go from the storage too.
  if (serialize() !== raw) void commit().catch(() => {});
})().catch(() => {});

/**
 * Words taken back from the queue: into the chat's draft at once (its field shows them now), and
 * the draft committed to Android's storage with the receipt. Resolves with the draft's revision once
 * it is committed; throws when it could not be (the words leave the draft again if nothing changed
 * it since) or the computer was forgotten meanwhile.
 */
export async function stageTaken(sid: string, text: string, take?: string): Promise<number> {
  const e = epoch();
  await loaded;
  if (!still(e)) throw new Error('Forgotten');
  const before = getDraft(sid);
  const t = join(before, text);
  const r = put(sid, t);
  kept.set(sid, { t, r, at: Date.now() });
  behind.delete(sid);
  if (take) takes = [...takes.filter((x) => x.id !== take), { id: take, sid, at: Date.now() }];
  tell(sid, 'taken');
  writeDrafts();
  try {
    await commit();
  } catch {
    if (take) takes = takes.filter((x) => x.id !== take);
    // Not kept: the message stays queued, so its words leave the field again (unless it changed since).
    if (still(e) && book.get(sid)?.r === r) {
      kept.delete(sid);
      put(sid, before);
      behind.delete(sid);
      writeDrafts();
      tell(sid, 'put');
    }
    throw new Error('Not kept');
  }
  if (!still(e)) throw new Error('Forgotten');
  return r;
}

/** A receipt the desktop answered: it goes (the committed copy of the draft stays until the draft is sent or emptied). */
export function settleTaken(take: string) {
  const before = takes.length;
  takes = takes.filter((t) => t.id !== take);
  if (takes.length !== before) void commit().catch(() => {});
}

/** Receipts not yet answered (sent again once connected). */
export const pendingTakes = async () => (await loaded, takes.map((t) => t.id));

/** A committed copy of `sid`'s draft is kept (tests). */
export const hasKept = (sid: string) => kept.has(sid);

/** Every write still due has landed or let go (tests, Forget). */
export const drained = () => writing;

// Forgetting the computer forgets the words written for it: nothing due is written any more (each
// write checks the generation, moved on before this runs), and one under way lands before the keys go.
onForget(async () => {
  clearTimeout(saveTimer);
  saveTimer = 0;
  book.clear();
  kept.clear();
  behind.clear();
  takes = [];
  await writing;
});
