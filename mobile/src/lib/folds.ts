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

export const wasOpen = (key: string) => open.has(key);

export function keepOpen(key: string, on: boolean) {
  open.delete(key);
  if (!on) return;
  open.add(key);
  if (open.size > FOLDS_MAX) open.delete(open.values().next().value as string);
}

onForget(() => open.clear());
