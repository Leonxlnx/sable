/**
 * What the reader opened in a chat (a turn's line, a checkpoint's steps), kept while the app is
 * open, as the desktop does: a checkpoint that folds into its turn when the turn ends, or a turn
 * that leaves a long chat's page and comes back, is as it was left. Memory only and bounded; it
 * holds ids alone and goes with the desktop.
 */
import { onForget } from './forget';

/** More than a person opens in a sitting; the oldest goes first. */
export const FOLDS_MAX = 600;
const open = new Set<string>();

/** The key of a turn's line, or of one piece inside it. */
export const foldKey = (sid: string, turn: string, piece = '') => `${sid}\n${turn}\n${piece}`;

/** The key of one step's own disclosure (a command's output opened inside a checkpoint): per chat and item, wherever it stands. */
export const stepKey = (sid: string, id: string) => `${sid}\n\u0000step\n${id}`;

export const wasOpen = (key: string) => open.has(key);

export function keepOpen(key: string, on: boolean) {
  open.delete(key);
  if (!on) return;
  open.add(key);
  if (open.size > FOLDS_MAX) open.delete(open.values().next().value as string);
}

/**
 * A step's detail fetched from the desktop when it opened (its output, its change), kept so that
 * reopening the turn shows it again without asking twice. Small: the newest few only.
 */
export const DETAILS_MAX = 40;
const details = new Map<string, unknown>();

export function keptDetail<T>(sid: string, id: string): T | undefined {
  return details.get(stepKey(sid, id)) as T | undefined;
}

export function keepDetail(sid: string, id: string, item: unknown) {
  const key = stepKey(sid, id);
  details.delete(key);
  details.set(key, item);
  if (details.size > DETAILS_MAX) details.delete(details.keys().next().value as string);
}

onForget(() => {
  open.clear();
  details.clear();
});
