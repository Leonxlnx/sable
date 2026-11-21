import { useSyncExternalStore } from 'react';
import type { SavedPrompt } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';

/**
 * Saved prompts as the bridge keeps them (`prompts.*`, `<home>/prompts.json`), held outside React
 * for the palette, the composer's `/` menu and Settings › Prompts. Read once the bridge is open
 * (again after a reconnect); every change anywhere arrives as `prompts.updated`.
 */

let list: SavedPrompt[] = [];
let version = 0;
/** The bridge has answered once (Settings shows a skeleton until then). */
let loaded = false;
const listeners = new Set<() => void>();

function set(next: SavedPrompt[]) {
  list = next;
  loaded = true;
  version++;
  for (const l of listeners) l();
}

/** Whether the prompts have arrived from the bridge yet. */
export function usePromptsLoaded(): boolean {
  return useSyncExternalStore(subscribePrompts, () => loaded);
}

export function subscribePrompts(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const getPrompts = (): SavedPrompt[] => list;

/** The saved prompts, re-rendering the caller when they change. */
export function useSavedPrompts(): SavedPrompt[] {
  return useSyncExternalStore(subscribePrompts, getPrompts);
}

/** For lists built outside React's view of the prompts (the palette's items): changes when they do. */
export function usePromptsVersion(): number {
  return useSyncExternalStore(subscribePrompts, () => version);
}

function refresh() {
  // An older bridge has none: an empty list.
  void bridge.call('prompts.list', {}).then(set, () => set(list));
}

bridge.on((e) => {
  if (e.type === 'prompts.updated') set(e.prompts);
});
bridge.onStatus((s) => s === 'open' && refresh());
if (bridge.status === 'open') refresh();

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

/** Saves the text under a name (the bridge makes one from the text when it is empty). */
export async function savePrompt(name: string, text: string): Promise<SavedPrompt | null> {
  try {
    const p = await bridge.call('prompts.save', { name, text });
    if (!list.some((x) => x.id === p.id)) set([p, ...list]);
    return p;
  } catch (err) {
    fail(err);
    return null;
  }
}

export async function updatePrompt(id: string, patch: { name?: string; text?: string }): Promise<boolean> {
  // Shown at once; the bridge's answer (and its event) settle it.
  const before = list;
  set(list.map((p) => (p.id === id ? { ...p, ...(patch.name?.trim() ? { name: patch.name.trim() } : {}), ...(patch.text?.trim() ? { text: patch.text } : {}) } : p)));
  try {
    const p = await bridge.call('prompts.update', { id, ...patch });
    set(list.map((x) => (x.id === id ? p : x)));
    return true;
  } catch (err) {
    set(before);
    fail(err);
    return false;
  }
}

export async function removePrompt(id: string): Promise<void> {
  const before = list;
  set(list.filter((p) => p.id !== id));
  try {
    await bridge.call('prompts.remove', { id });
  } catch (err) {
    set(before);
    fail(err);
  }
}

export async function reorderPrompts(ids: string[]): Promise<void> {
  const before = list;
  const byId = new Map(list.map((p) => [p.id, p]));
  const head = ids.map((id) => byId.get(id)).filter((p): p is SavedPrompt => !!p);
  set([...head, ...list.filter((p) => !ids.includes(p.id))]);
  try {
    set(await bridge.call('prompts.reorder', { ids }));
  } catch (err) {
    set(before);
    fail(err);
  }
}

/** The composer the person sees: the open chat's, or home's. */
export const composerKey = () => useStore.getState().ui.activeSessionId ?? 'home';

/** What the composer the person sees holds now. */
export const composerText = () => useStore.getState().drafts[composerKey()]?.text ?? '';

/**
 * Puts a prompt into the composer the person sees, never sending it: in place of an empty draft,
 * else after what is there, on a paragraph of its own.
 */
export function insertPrompt(text: string) {
  const cur = composerText();
  focusComposer(cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${text}` : text);
}
