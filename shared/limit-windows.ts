import type { RateLimit } from './protocol';

/**
 * What a plan window is, read from its id: the week of all models, the 5-hour window, a window of
 * one model. Pure and shared: the bridge decides moves by them (server/core/limit-policy.ts), the
 * desktop and the phone order accounts by them (shared/use-first.ts).
 */

/** A cap as a usable percent: 1..100, where 100 (or nothing set) means no cap. */
export function capPercent(v: number | undefined): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n < 100 ? n : 100;
}

/** The weekly window across all models (Claude's `seven_day`, Codex's own weekly), never a per-model one. */
export function isAllModelsWeekly(l: RateLimit): boolean {
  if (l.id === 'seven_day') return true;
  if (l.id.startsWith('codex:')) return l.windowMins ? l.windowMins >= 10_080 : l.id === 'codex:secondary';
  return false;
}

/** The 5-hour window (Claude's `five_hour`, Codex's own short window). */
export function isSessionWindow(l: RateLimit): boolean {
  if (l.id === 'five_hour') return true;
  if (l.id.startsWith('codex:')) return l.windowMins ? l.windowMins === 300 : l.id === 'codex:primary';
  return false;
}

/**
 * The model a per-model window belongs to, lower case ("fable" for `model_Fable`, "opus" for
 * `seven_day_opus`); undefined for the windows every model shares.
 */
export function windowModel(l: RateLimit): string | undefined {
  const m = /^model_(.+)$/.exec(l.id) ?? /^(?:seven_day|five_hour)_(?!overage)(.+)$/.exec(l.id);
  return m ? m[1].toLowerCase() : undefined;
}

/** A per-model window counts only for that model (the session's model id names it: "fable", "claude-opus-5"). */
export function windowForModel(l: RateLimit, model: string | undefined): boolean {
  const own = windowModel(l);
  return !own || (!!model && model.toLowerCase().includes(own));
}
