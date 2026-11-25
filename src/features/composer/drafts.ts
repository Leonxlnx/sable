import { useStore, type Draft } from '@/state/store';
import { overflowDraft } from './draft-overflow';
import { putBack, type FieldDraft } from './restore';
import { draftsWithPending, onPending } from './pending';

/**
 * What you typed stays: the store keeps a draft per session while the app runs (switching away
 * and back). Ordinary drafts keep their words. A draft recovering from a queue edit or rewind
 * also keeps its attachments and ownership information.
 */
const KEY = 'sable.drafts';
const MAX_DRAFTS = 40;
const MAX_CHARS = 40_000;

/** The drafts worth keeping, as text by key: non-empty, the most recent ones, each within a size. */
export function packDrafts(drafts: Record<string, FieldDraft>): Record<string, string | FieldDraft> {
  const entries = Object.entries(drafts);
  const normal = entries.filter(([, d]) => !d.recovery && d.text.trim() && d.text.length <= MAX_CHARS)
    .slice(-MAX_DRAFTS).map(([k, d]) => [k, d.text]);
  const recovering = entries.filter(([, d]) => d.recovery && (d.text || d.attachments.length));
  return Object.fromEntries([...normal, ...recovering]);
}

/** Drafts read back from storage; anything malformed is dropped. */
export function unpackDrafts(raw: string | null): Record<string, Draft> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, Draft> = {};
    for (const [k, text] of Object.entries(v as Record<string, unknown>)) {
      if (text && typeof text === 'object' && 'recovery' in text && text.recovery && typeof text.recovery === 'object'
          && 'text' in text && typeof text.text === 'string' && 'attachments' in text && Array.isArray(text.attachments)
          && text.attachments.every(a => a && typeof a.id === 'string' && typeof a.name === 'string' && ['image', 'file', 'text'].includes(a.kind))) {
        out[k] = text as FieldDraft;
      } else if (typeof text === 'string' && text && text.length <= MAX_CHARS) out[k] = { text, attachments: [] };
    }
    return out;
  } catch {
    return {};
  }
}

let started = false;
const PREFIX = 'overflow:';
let checkpoint: (() => Promise<void>) | undefined;

/** Finish saving the recovery copy before the bridge removes the original. */
export async function keepRecovery(): Promise<boolean> {
  try {
    await checkpoint?.();
    return true;
  } catch {
    useStore.getState().toast('Could not save the recovery draft. The original message is still in place.', 'error');
    return false;
  }
}

/** Reads the kept drafts into the store once, then writes changes back (debounced, and on leaving). */
export function keepDrafts() {
  if (started || typeof localStorage === 'undefined') return;
  started = true;
  let saved = '';
  let pointer = '';
  let restoring: Promise<void> | undefined;
  const restore = (raw: string) => {
    saved = raw;
    const kept = unpackDrafts(raw);
    if (Object.keys(kept).length) useStore.setState(s => {
      const drafts = { ...kept, ...s.drafts };
      for (const [key, draft] of Object.entries(kept)) {
        if (draft.recovery && s.drafts[key]) drafts[key] = { ...putBack(s.drafts[key], draft), recovery: draft.recovery };
      }
      return { drafts };
    });
  };
  try {
    const raw = localStorage.getItem(KEY) ?? '';
    if (raw.startsWith(PREFIX)) {
      pointer = raw;
      restoring = overflowDraft(raw).then(value => {
        if (value === undefined) throw new Error('Recovery draft missing');
        restore(value);
        restoring = undefined;
      });
      void restoring.catch(() => useStore.getState().toast('Could not read the saved recovery draft.', 'error'));
    } else restore(raw);
  } catch { /* A checkpoint below still has to succeed before a destructive edit. */ }
  let timer = 0;
  let writing: Promise<void> | undefined;
  const saveCurrent = async () => {
    if (restoring) await restoring;
    timer = 0;
    const next = JSON.stringify(packDrafts(draftsWithPending(useStore.getState().drafts)));
    if (next === saved) return;
    const old = pointer;
    let nextPointer = '';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      nextPointer = PREFIX + crypto.randomUUID();
      await overflowDraft(nextPointer, next);
      try {
        localStorage.setItem(KEY, nextPointer);
      } catch (err) {
        void overflowDraft(nextPointer, null).catch(() => {});
        throw err;
      }
    }
    saved = next;
    pointer = nextPointer;
    if (old) void overflowDraft(old, null).catch(() => {});
  };
  const write = (): Promise<void> => {
    if (writing) return writing.then(write, write);
    writing = saveCurrent().finally(() => { writing = undefined; });
    return writing;
  };
  checkpoint = write;
  const save = () => { void write().catch(() => {}); };
  const soon = () => {
    if (!timer) timer = window.setTimeout(save, 500);
  };
  useStore.subscribe((s, p) => {
    if (s.drafts !== p.drafts) soon();
  });
  onPending(soon);
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);
}
