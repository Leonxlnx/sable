import { epoch, still } from './epoch';
import { onForget } from './forget';
import { durable, loadPref } from './native';

/**
 * Unsent words per chat, kept across restarts (Android may close the app in the background): written
 * a moment after typing stops (`saveDrafts`), at once when it matters (`writeDrafts`). Words taken
 * back from the queue are also kept apart, committed to Android's storage (`stageTaken`), until the
 * desktop has answered for them: a start after Android closed the app before the page's storage was
 * written puts them back into their draft, and a receipt not yet confirmed is sent again once
 * connected (lib/take.ts). Forgetting the computer forgets them all (lib/erase.ts sweeps the storage).
 */

const DRAFTS = 'sable.drafts';
/** The committed copies of words taken back (Capacitor Preferences, written with Android's commit). */
export const TAKEN = 'sable.taken';

export const drafts = new Map<string, string>(
  (() => {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, string>);
    } catch {
      return [];
    }
  })(),
);

let saveTimer = 0;

/** Writes the drafts now; false when the page's storage would not take them. */
export function writeDrafts(): boolean {
  clearTimeout(saveTimer);
  try {
    const o: Record<string, string> = {};
    for (const [k, v] of drafts) if (v.trim()) o[k] = v;
    localStorage.setItem(DRAFTS, JSON.stringify(o));
    return true;
  } catch {
    return false;
  }
}

export function saveDrafts() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(writeDrafts, 400);
}

const join = (had: string, words: string) => (had.trim() ? `${had.trimEnd()}\n${words}` : words);

// ── words taken back from the queue ──

interface Taken {
  sid: string;
  text: string;
  /** The desktop's receipt, until it answered for it. */
  take?: string;
  at: number;
}
let taken: Taken[] = [];

/** Words left from a start Android cut off: back into their drafts; receipts still unanswered stay to be confirmed. */
const loaded: Promise<void> = (async () => {
  const list = await loadPref<Taken[]>(TAKEN, []);
  if (!Array.isArray(list) || !list.length) return;
  const now = Date.now();
  for (const t of list) {
    if (!t || typeof t.sid !== 'string' || typeof t.text !== 'string') continue;
    const had = drafts.get(t.sid) ?? '';
    if (!had.includes(t.text)) drafts.set(t.sid, join(had, t.text));
  }
  writeDrafts();
  // The desktop remembers a receipt for 15 minutes: older ones are of no use.
  taken = list.filter((t) => t && typeof t.take === 'string' && now - t.at < 15 * 60_000);
  void keepTaken();
})().catch(() => {});

let writing: Promise<void> = Promise.resolve();
function keepTaken(): Promise<void> {
  const json = taken.length ? JSON.stringify(taken) : null;
  const next = writing.then(() => durable(TAKEN, json));
  writing = next.catch(() => {});
  return next;
}

/**
 * Keeps words taken back from the queue: appended to the chat's draft and written now, and a copy
 * committed to Android's storage with the receipt. Resolves once both are kept; throws when they could
 * not be (or the computer was forgotten meanwhile).
 */
export async function stageTaken(sid: string, text: string, take?: string): Promise<void> {
  const e = epoch();
  await loaded;
  if (!still(e)) throw new Error('Forgotten');
  drafts.set(sid, join(drafts.get(sid) ?? '', text));
  if (!writeDrafts()) throw new Error('Not kept');
  taken = [...taken.filter((t) => !take || t.take !== take), { sid, text, ...(take ? { take } : {}), at: Date.now() }];
  await keepTaken();
  if (!still(e)) throw new Error('Forgotten');
}

/** A receipt the desktop answered: its copy goes. */
export function settleTaken(take: string) {
  const before = taken.length;
  taken = taken.filter((t) => t.take !== take);
  if (taken.length !== before) void keepTaken().catch(() => {});
}

/** Receipts not yet answered (sent again once connected). */
export const pendingTakes = async () => (await loaded, taken.filter((t) => t.take).map((t) => t.take!));

// Forgetting the computer forgets the words written for it, with the writes still due.
onForget(() => {
  clearTimeout(saveTimer);
  drafts.clear();
  taken = [];
});
