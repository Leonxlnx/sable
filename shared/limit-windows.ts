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
 * Codex names a model's own limit in front of the window: `<limit id>:primary`, labelled
 * "GPT-5.3-Codex-Spark · 5-hour limit" (its own `codex:*` windows are every model's).
 */
const codexScoped = (l: RateLimit) => l.id.includes(':') && !l.id.startsWith('codex:');

/**
 * The model a per-model window belongs to, lower case ("fable" for `model_Fable`, "opus" for
 * `seven_day_opus`, "gpt-5.3-codex-spark" for a Codex model's own limit, by its label's name or else
 * its id); undefined for the windows every model shares.
 */
export function windowModel(l: RateLimit): string | undefined {
  const m = /^model_(.+)$/.exec(l.id) ?? /^(?:seven_day|five_hour)_(?!overage)(.+)$/.exec(l.id);
  if (m) return m[1].toLowerCase();
  if (codexScoped(l)) return (l.label?.split(' · ')[0]?.trim() || l.id.slice(0, l.id.indexOf(':'))).toLowerCase();
  return undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A per-model window counts only for that model, named by its id or name ("fable", "claude-opus-5",
 * "gpt-5.3-codex-spark"; compared without case or punctuation); a window of every model always counts.
 */
export function windowForModel(l: RateLimit, model: string | { id?: string; name?: string } | undefined): boolean {
  const own = windowModel(l);
  return !own || matchesWindowModel(own, model);
}

/** Match a model from a refusal or a usage row against a picker id or name. */
export function matchesWindowModel(own: string, model: string | { id?: string; name?: string } | undefined): boolean {
  const want = norm(own);
  const names = typeof model === 'string' ? [model] : model ? [model.id, model.name] : [];
  return !!want && names.some((x) => !!x && norm(x).includes(want));
}
