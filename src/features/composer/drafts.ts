import { useStore, type Draft } from '@/state/store';
import { draftsWithPending, onPending } from './pending';

/**
 * What you typed stays: the store keeps a draft per session while the app runs (switching away
 * and back), and this keeps the text of each across a restart. Text only: attachments hold image
 * data and are not written to disk here. A message still on its way to the bridge is written as
 * part of its draft (pending.ts), so a reload before the bridge took it brings its words back.
 */
const KEY = 'sable.drafts';
const MAX_DRAFTS = 40;
const MAX_CHARS = 40_000;

/** The drafts worth keeping, as text by key: non-empty, the most recent ones, each within a size. */
export function packDrafts(drafts: Record<string, Draft>): Record<string, string> {
  const entries = Object.entries(drafts)
    .filter(([, d]) => d?.text && d.text.trim() !== '' && d.text.length <= MAX_CHARS)
    .map(([k, d]) => [k, d.text] as const);
  // Object keys keep insertion order: the last ones written are the most recent.
  return Object.fromEntries(entries.slice(-MAX_DRAFTS));
}

/** Drafts read back from storage; anything malformed is dropped. */
export function unpackDrafts(raw: string | null): Record<string, Draft> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, Draft> = {};
    for (const [k, text] of Object.entries(v as Record<string, unknown>)) {
      if (typeof text === 'string' && text && text.length <= MAX_CHARS) out[k] = { text, attachments: [] };
    }
    return out;
  } catch {
    return {};
  }
}

let started = false;

/** Reads the kept drafts into the store once, then writes changes back (debounced, and on leaving). */
export function keepDrafts() {
  if (started || typeof localStorage === 'undefined') return;
  started = true;
  let saved = '';
  try {
    saved = localStorage.getItem(KEY) ?? '';
    const kept = unpackDrafts(saved);
    // What is already in the store (typed before this ran) wins over what was kept.
    if (Object.keys(kept).length) useStore.setState((s) => ({ drafts: { ...kept, ...s.drafts } }));
  } catch {
    return;
  }
  let timer = 0;
  const write = () => {
    timer = 0;
    const next = JSON.stringify(packDrafts(draftsWithPending(useStore.getState().drafts)));
    if (next === saved) return;
    saved = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* full or private: the drafts stay in memory */
    }
  };
  const soon = () => {
    if (!timer) timer = window.setTimeout(write, 500);
  };
  useStore.subscribe((s, p) => {
    if (s.drafts !== p.drafts) soon();
  });
  onPending(soon);
  window.addEventListener('pagehide', write);
  window.addEventListener('beforeunload', write);
}
