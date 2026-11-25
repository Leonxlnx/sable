import { useStore, type Draft } from '@/state/store';
import { overflowDraft } from './draft-overflow';
import { type FieldDraft } from './restore';
import { pendingDrafts, takeDeferred, onPending } from './pending';

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
  const recovering = entries.filter(([, d]) => d.recovery && (d.text || d.attachments.length || d.recovery.queueId || d.recovery.rewind));
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
    useStore.getState().toast('Could not save the recovery draft.', 'error');
    return false;
  }
}

/** Reads the kept drafts into the store once, then writes changes back (debounced, and on leaving). */
export function keepDrafts() {
  if (started || typeof localStorage === 'undefined') return;
  started = true;
  const root = 'sable.window.';
  const ownerKey = 'sable.windowId';
  const slots = new Map<string, string>(); // Last committed value of each claimed entry.
  const owners = new Map<string, string>(); // The storage key this action owns.
  const waiting = new Map<string, { key: string; draft: Draft }>();
  const generated = new WeakMap<object, string>();
  const fields = new Map<string, string>();
  let owner: string;
  let timer = 0;
  const acquire = (id: string) => new Promise<boolean>((resolve, reject) => {
    if (!globalThis.navigator?.locks) { resolve(true); return; }
    void navigator.locks.request(root + id, { ifAvailable: true }, lock => {
      resolve(!!lock);
      if (lock) return new Promise<void>(() => {}); // Released by the browser on window destruction.
    }).catch(reject);
  });
  const readSlot = async (raw: string) => {
    if (!raw.startsWith(PREFIX)) return raw;
    const data = await overflowDraft(raw);
    if (data === undefined) throw Error('Recovery draft missing');
    return data;
  };
  const actionOf = (draft: Draft) => {
    if (!draft.recovery) return;
    if (draft.recovery.operationId) return draft.recovery.operationId;
    let id = generated.get(draft.recovery);
    if (!id) generated.set(draft.recovery, id = crypto.randomUUID());
    return id;
  };
  const showWaiting = () => {
    for (const [slot, entry] of waiting) {
      const current = useStore.getState().drafts[entry.key];
      if (current && (current.recovery?.queueId || current.recovery?.rewind || current.text || current.attachments.length)) continue;
      waiting.delete(slot);
      if (!entry.draft.recovery) fields.set(entry.key, slot.slice(slot.indexOf('/') + 1));
      useStore.getState().setDraft(entry.key, entry.draft);
    }
  };
  const restore = async () => {
    owner = sessionStorage.getItem(ownerKey) || crypto.randomUUID();
    while (!await acquire(owner)) owner = crypto.randomUUID();
    sessionStorage.setItem(ownerKey, owner);
    const prefixes = new Set([owner]);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k && k.startsWith(root));
    // A second live instance (including a duplicated tab) keeps its lock and its drafts.
    if (globalThis.navigator?.locks) for (const id of new Set(keys.map(k => k.slice(root.length).split('/')[0]))) {
      if (id !== owner && await acquire(id)) prefixes.add(id);
    }
    for (const slot of keys) {
      if (!prefixes.has(slot.slice(root.length).split('/')[0])) continue;
      const value = localStorage.getItem(slot);
      if (!value) continue;
      const raw = await readSlot(value);
      const entry = JSON.parse(raw) as { key: string; draft: Draft };
      const action = slot.slice(slot.indexOf('/') + 1);
      if (entry.draft.recovery && !entry.draft.recovery.operationId) generated.set(entry.draft.recovery, action);
      owners.set(action, slot);
      slots.set(slot, raw);
      waiting.set(slot, entry);
    }
    // Import the old shared file once. Commit the owned copies before removing it.
    const legacy = localStorage.getItem(KEY);
    if (legacy && (!globalThis.navigator?.locks || await acquire('legacy'))) {
      for (const [key, draft] of Object.entries(unpackDrafts(await readSlot(legacy)))) {
        const action = actionOf(draft) ?? 'draft-' + crypto.randomUUID();
        const slot = root + owner + '/' + action;
        owners.set(action, slot);
        waiting.set(slot, { key, draft });
      }
      await persist();
      if (localStorage.getItem(KEY) === legacy) localStorage.removeItem(KEY);
    }
    showWaiting();
  };
  const storeSlot = async (slot: string, value: string) => {
    if (slots.get(slot) === value) return;
    const old = localStorage.getItem(slot);
    try { localStorage.setItem(slot, value); }
    catch {
      const pointer = PREFIX + crypto.randomUUID();
      await overflowDraft(pointer, value);
      try { localStorage.setItem(slot, pointer); }
      catch (err) { await overflowDraft(pointer, null); throw err; }
    }
    slots.set(slot, value);
    if (old?.startsWith(PREFIX)) void overflowDraft(old, null).catch(() => {});
  };
  const persist = async () => {
    const entries = new Map(waiting);
    const put = (action: string, key: string, draft: Draft) => {
      const slot = owners.get(action) ?? root + owner + '/' + action;
      owners.set(action, slot);
      entries.set(slot, { key, draft });
    };
    const drafts = useStore.getState().drafts;
    for (const [key, packed] of Object.entries(packDrafts(drafts))) {
      const draft = drafts[key];
      let action = actionOf(draft);
      if (!action) {
        action = fields.get(key) ?? 'field-' + crypto.randomUUID();
        fields.set(key, action);
      }
      put(action, key, typeof packed === 'string' ? { text: packed, attachments: [] } : draft);
    }
    for (const p of pendingDrafts()) put(p.id, p.key, p.draft);
    for (const [slot, entry] of entries) await storeSlot(slot, JSON.stringify(entry));
    for (const slot of slots.keys()) if (!entries.has(slot)) {
      const old = localStorage.getItem(slot);
      localStorage.removeItem(slot);
      slots.delete(slot);
      owners.delete(slot.slice(slot.indexOf('/') + 1));
      if (old?.startsWith(PREFIX)) void overflowDraft(old, null).catch(() => {});
    }
  };
  const restoring = restore();
  void restoring.catch(() => useStore.getState().toast('Could not read the saved recovery draft.', 'error'));
  let writing: Promise<void> | undefined;
  const saveCurrent = async () => {
    await restoring;
    timer = 0;
    for (const p of takeDeferred()) {
      const slot = owners.get(p.id) ?? root + owner + '/' + p.id;
      owners.set(p.id, slot);
      waiting.set(slot, { key: p.key, draft: { ...p.draft, recovery: {
        ...p.draft.recovery, operationId: p.id, checkSend: p.uncertain, payload: p.payload,
        retry: { id: p.id, text: p.draft.text, files: p.draft.attachments.map(a => a.id).join('\u0000') },
      } } });
    }
    showWaiting();
    await persist();
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
    if (s.drafts === p.drafts) return;
    for (const [key, draft] of Object.entries(p.drafts)) {
      const next = s.drafts[key];
      if (draft === next || !draft.recovery || !next?.recovery) continue;
      const action = actionOf(draft)!;
      if (action === actionOf(next) || !(draft.recovery.queueId || draft.recovery.rewind)) continue;
      const slot = owners.get(action) ?? root + owner + '/' + action;
      owners.set(action, slot);
      waiting.set(slot, { key, draft });
    }
    soon();
  });
  onPending(soon);
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);
}
