import type { Attachment } from '@shared/protocol';
import { epoch, still } from './epoch';
import { onForget } from './forget';
import { durable, readPref } from './native';

/**
 * Each chat and the home composer own a revisioned draft in sable.drafts. Empty
 * revisions survive a reload. The native outbox can replay a committed clear
 * without replacing a later edit.
 *
 * sable.taken holds reserved text separately until the desktop confirms a take.
 * Settlement copies it into the draft once. A legacy receipt already placed
 * its words in the field. Forget drains the writer before erasing both stores.
 */

const DRAFTS = 'sable.drafts';
/** The committed copies of drafts that hold words taken back, and the receipts not yet answered (Capacitor Preferences). */
export const TAKEN = 'sable.taken';
/** The desktop remembers a receipt this long. */
export const RECEIPT_MS = 15 * 60_000;
/** A committed copy no change touched for this long is let go (the page's own draft has long been on the storage). */
export const KEPT_MS = 7 * 24 * 3600_000;

/** One chat's words and their revision. */
export interface Draft {
  t: string;
  r: number;
  files?: Attachment[];
  /** This empty revision was left by Send. A person deleting the text also advances the revision. */
  afterSend?: true;
  /** Takes already copied here while Android was committing their settlement. */
  applied?: string[];
}
export const HOME_DRAFT = '/new-chat';
const EMPTY: Draft = { t: '', r: 0 };
/** The source of a field change, also used to focus a confirmed take. */
export type DraftWhy = 'typed' | 'taken' | 'put' | 'recovered';

const book = new Map<string, Draft>(
  (() => {
    const out: [string, Draft][] = [];
    try {
      const o = JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, unknown>;
      for (const [k, v] of Object.entries(o ?? {})) {
        // Kept by a build before revisions: plain text.
        if (typeof v === 'string') out.push([k, { t: v, r: 0 }]);
        else if (v && typeof (v as Draft).t === 'string' && Number.isFinite((v as Draft).r)) out.push([k, v as Draft]);
      }
      const home = localStorage.getItem('sable.newdraft');
      if (home && !out.some(([sid]) => sid === HOME_DRAFT)) out.push([HOME_DRAFT, { t: home, r: 0 }]);
    } catch {
      /* none */
    }
    return out;
  })(),
);

/** The committed copy of each chat whose draft holds words taken back (`at`: when it was last committed). */
type CommittedDraft = Draft & { at: number; retain?: true };
const kept = new Map<string, CommittedDraft>();
/** Receipts the desktop has not answered yet (sent again once connected). */
interface TakeReceipt {
  id: string;
  sid: string;
  at: number;
  staged?: { text: string; row: string; revision: number };
}
let takes: TakeReceipt[] = [];
const staging = new Set<string>();
/** Chats whose committed copy is behind their draft. */
const behind = new Set<string>();
const editedSinceStart = new Set<string>();
const subs = new Map<string, Set<(text: string, why: DraftWhy) => void>>();

export const getDraft = (sid: string) => book.get(sid)?.t ?? '';
export const composition = (sid: string): Draft => book.get(sid) ?? EMPTY;
export const draftRev = (sid: string) => book.get(sid)?.r ?? 0;

/** Listen to every revision of this field. */
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
function put(sid: string, t: string, files = composition(sid).files, r = draftRev(sid) + 1): number {
  const { applied } = composition(sid);
  book.set(sid, { t, r, ...(files?.length && { files }), ...(applied?.length && { applied }) });
  if (kept.has(sid)) behind.add(sid);
  return r;
}

let saveTimer = 0;

/** Writes the drafts to the page's storage now; false when it would not take them. */
function writeDrafts(): boolean {
  try {
    const o: Record<string, Draft> = {};
    // An empty field still owns its revision across process death.
    for (const [k, v] of book) o[k] = v;
    localStorage.setItem(DRAFTS, JSON.stringify(o));
    localStorage.removeItem('sable.newdraft');
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
  // One large photo can exceed WebView storage and block a different chat's next
  // words as well. Commit the drafts through the native writer in that case.
  if (!ok) for (const sid of book.keys()) behind.add(sid);
  if (behind.size) {
    const at = Date.now();
    for (const sid of behind) {
      const d = book.get(sid);
      if (d && (!ok || d.t || d.files?.length)) kept.set(sid, { ...d, at, ...(!ok && { retain: true }) });
      else kept.delete(sid);
    }
    behind.clear();
    void commit().catch(() => {});
  }
  return ok;
}

/** Replace the composition and advance its revision. Clearing or now flushes it immediately. */
export function setDraft(sid: string, text: string, opts: { why?: DraftWhy; now?: boolean; files?: Attachment[]; touch?: boolean } = {}): number {
  const cur = book.get(sid);
  if (!opts.touch && (cur?.t ?? '') === text && (!opts.files || opts.files === cur?.files)) return cur?.r ?? 0;
  const r = put(sid, text, opts.files);
  editedSinceStart.add(sid);
  tell(sid, opts.why ?? 'typed');
  if (opts.now || !text.trim()) flushDrafts();
  else {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushDrafts, 400);
  }
  return r;
}

/** Replay a committed send's clear if Android lost the page's last writes. A later edit,
 * including typing and erasing the same words, always has a higher revision. */
export function clearThrough(sid: string, revision: number, recovering = false) {
  const d = composition(sid);
  if (recovering && editedSinceStart.has(sid)) {
    // The page was behind and the person typed before the native journal finished loading.
    if (d.r > revision + 1) return;
    put(sid, d.t, d.files, revision + 2);
  } else {
    if (d.r > revision) return;
    put(sid, '', [], revision + 1);
    book.set(sid, { ...composition(sid), afterSend: true });
  }
  flushDrafts();
  tell(sid, 'put');
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
  const o = v as { kept?: Record<string, CommittedDraft>; takes?: TakeReceipt[] } | null;
  for (const x of Array.isArray(o?.takes) ? o!.takes : []) {
    if (x?.staged && typeof x.staged.text === 'string' && typeof x.staged.row === 'string' && typeof x.sid === 'string' && typeof x.id === 'string') {
      if (!takes.some(t => t.id === x.id)) takes.push(x);
    } else receipt(x?.id, x?.sid, x?.at);
  }
  for (const [sid, k] of Object.entries(o?.kept ?? {})) {
    if (!k || typeof k.t !== 'string' || !Number.isFinite(k.r) || (!k.retain && !fresh(k.at, KEPT_MS))) continue;
    const cur = book.get(sid);
    if (cur && editedSinceStart.has(sid) && cur.r < k.r) {
      put(sid, cur.t, cur.files, k.r + 1);
      changed.push(sid);
      continue;
    }
    // The draft is this revision or newer: it has the words (or was sent or edited since): the copy is done with.
    if (cur && cur.r >= k.r) continue;
    book.set(sid, { t: k.t, r: k.r, files: k.files, applied: k.applied, afterSend: k.afterSend });
    kept.set(sid, k);
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

/** A failed initial preference read is retried before consuming a field revision. */
export async function draftsReady() {
  const e = epoch();
  await loaded;
  if (still(e) && !readOk) await commit();
}

/** Home has no destination chat until session.create answers. Keep its field on
 * Android through that request, including a process death before the chat ID arrives. */
export async function keepOpeningDraft(draft: Draft, e: number) {
  await draftsReady();
  if (!still(e)) throw new Error('The computer was forgotten.');
  if (composition(HOME_DRAFT) !== draft) throw new Error('The new chat draft changed. Press Send again.');
  kept.set(HOME_DRAFT, { ...draft, at: Date.now(), retain: true });
  await commit();
  if (!still(e)) throw new Error('The computer was forgotten.');
}

/** The complete text-only reservation, separate from the editable field until the desktop answers. */
export async function stageTaken(sid: string, text: string, take: string, row: string): Promise<number> {
  const e = epoch();
  await loaded;
  if (!still(e)) throw new Error('Forgotten');
  const revision = draftRev(sid);
  const record = { id: take, sid, at: Date.now(), staged: { text, row, revision } };
  takes.push(record);
  staging.add(take);
  try {
    await commit();
    if (!still(e)) throw new Error('Forgotten');
    return revision;
  } catch (err) {
    if (still(e)) takes = takes.filter(x => x !== record);
    throw err;
  } finally {
    staging.delete(take);
  }
}

export const takeReceipt = (id: string) => takes.find(t => t.id === id);

/** Move the staged copy into the draft once, or release it if the complete row is still
 * on the desktop. Older receipts already put their words in the field before confirming. */
export async function settleTaken(take: string, keepWords: boolean) {
  const record = takeReceipt(take);
  if (!record || staging.has(take)) return;
  const { sid, staged } = record;
  const e = epoch();
  if (keepWords && staged && !composition(sid).applied?.includes(take)) {
    const t = join(getDraft(sid), staged.text);
    put(sid, t);
    const draft = { ...composition(sid), applied: [...(composition(sid).applied ?? []), take] };
    book.set(sid, draft);
    kept.set(sid, { ...draft, at: Date.now() });
    behind.delete(sid);
    if (!writeDrafts()) kept.set(sid, { ...draft, at: Date.now(), retain: true });
    tell(sid, 'taken');
  }
  takes = takes.filter(t => t !== record);
  try {
    await commit();
  } catch (err) {
    if (still(e)) takes.push(record);
    throw err;
  }
  if (still(e) && composition(sid).applied?.includes(take)) {
    const draft = composition(sid);
    book.set(sid, { ...draft, applied: draft.applied!.filter(id => id !== take) });
    writeDrafts();
  }
}

export const pendingTakes = async () => (await draftsReady(), takes.filter(t => !staging.has(t.id)).map(t => t.id));

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
  editedSinceStart.clear();
  takes = [];
  await writing;
  // Erase removes this preference even if the interrupted initial read never finished.
  readOk = true;
});
