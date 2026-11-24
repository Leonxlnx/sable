import type { Effort, ModelInfo, ProviderId } from '@shared/protocol';

// ───────────────────────── reasoning effort ─────────────────────────

const EFFORT_NAMES: Record<Effort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** What to call a reasoning effort, everywhere efforts are listed ("xhigh" → "Extra high"). */
export function effortName(e: Effort): string;
export function effortName(e: Effort | undefined): string | undefined;
export function effortName(e: Effort | undefined): string | undefined {
  return e ? (EFFORT_NAMES[e] ?? e) : undefined;
}

/**
 * The level reads as "ultra": it carries the same mark as ultracode, so the idea looks the same
 * whether it is a level the model offers (Codex) or a mode beside the level (Claude Code).
 */
export const isUltraEffort = (e: Effort | undefined) => e === 'ultra';

/**
 * Which models a menu lists, and what they are called.
 *
 * Agents report every model they can run, including older generations and aliases
 * (Claude Code's `default`). By default Sable lists what the agent's own picker offers
 * (or, when it does not say, the newest version of each family), without aliases that name a listed model.
 * Settings › Models can show or hide any model; the model in use is always listed.
 */

const VERSION = /\d+(?:\.\d+)*/;
/** "Opus 5.5" or "GPT-6.1 Terra": up to three words with a version number in them, nothing else. */
const VERSIONED_NAME = /^[A-Za-z][\w-]*(?:[ -][\w.-]*\w){0,2}$/;

/** The key a model's visibility override is stored under in `AppSettings.modelVisibility`. */
export const visibilityKey = (provider: ProviderId, modelId: string) => `${provider}:${modelId}`;

/**
 * The model a description names, when it names one: the whole description ("Fable 5.2") or
 * its first part ("Opus 5.5 · Best for…" → "Opus 5.5").
 */
function namedIn(description: string | undefined): string | undefined {
  const head = description?.split(/\s+·\s+/)[0]?.trim();
  if (!head || head.length > 80) return undefined;
  if (head.length <= 40 && VERSION.test(head) && VERSIONED_NAME.test(head)) return head;
  // Claude Code's alias says it in a sentence: "Use the default model (currently Opus 5.5)".
  const current = /\(currently\s+([^)]{1,40})\)/i.exec(head)?.[1]?.trim();
  return current && VERSION.test(current) && VERSIONED_NAME.test(current) ? current : undefined;
}

/**
 * The model an alias stands for, by name: Claude Code's "Default (recommended)" describes
 * itself as "Opus 5.5 · …". Undefined for a model that is not an alias.
 */
export function aliasTarget(m: ModelInfo): string | undefined {
  const named = namedIn(m.description);
  if (!named) return undefined;
  return named.toLowerCase().startsWith(m.name.toLowerCase()) ? undefined : named;
}

/**
 * What to call a model: its full versioned name when the agent only gives the family
 * ("Fable" described as "Fable 5.2 · …" reads "Fable 5.2"), and an alias reads as the
 * model it resolves to.
 */
export function modelName(m: ModelInfo | undefined): string | undefined {
  if (!m) return undefined;
  const named = namedIn(m.description);
  return named && (aliasTarget(m) || named.toLowerCase().startsWith(m.name.toLowerCase())) ? named : m.name;
}

/**
 * What to call a model known only by its id (a session's model, the id a context report
 * names): the listed model's name when the agent lists it, otherwise the id made readable
 * ("claude-opus-5-5-20261101" → "Opus 5.5", "gpt-6.1-sol" → "GPT-6.1-Sol").
 */
export function modelNameById(id: string | undefined, models: ModelInfo[] | undefined): string | undefined {
  if (!id) return undefined;
  const listed = models?.find((m) => m.id === id);
  if (listed) return modelName(listed);
  const words = id
    .replace(/\[.*?\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2')
    .split('-');
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (/^gpt$/i.test(words[0] ?? '')) return ['GPT', ...words.slice(1).map(cap)].join('-');
  return words.map(cap).join(' ');
}

/** "Fable 5.2" → family "fable", version [5, 2]; "GPT-6.1-Sol" → "gpt sol", [6, 1]. */
export function familyOf(name: string): { family: string; version: number[] } {
  const v = VERSION.exec(name);
  const family = (v ? name.replace(v[0], ' ') : name)
    .replace(/[\s._-]+/g, ' ')
    .trim()
    .toLowerCase();
  return { family, version: v ? v[0].split('.').map(Number) : [] };
}

function compareVersions(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Ids of the models listed when the user has changed nothing. When the agent says which models
 * its own picker offers (`ModelInfo.picker`), exactly those, so a model released tomorrow is
 * listed the day the agent offers it; otherwise the newest version of each family.
 */
export function currentGeneration(models: ModelInfo[]): Set<string> {
  if (models.some((m) => m.picker !== undefined)) return offeredByAgent(models);
  return newestOfEachFamily(models);
}

/** The models the agent's picker offers, without an alias that names one of them. */
function offeredByAgent(models: ModelInfo[]): Set<string> {
  const offered = models.filter((m) => m.picker !== false);
  const listed = new Set(offered.filter((m) => !aliasTarget(m)).map((m) => modelName(m)));
  return new Set(offered.filter((m) => !aliasTarget(m) || !listed.has(aliasTarget(m))).map((m) => m.id));
}

function newestOfEachFamily(models: ModelInfo[]): Set<string> {
  const names = new Map(models.map((m) => [m.id, modelName(m)!]));
  const listed = new Set(models.filter((m) => !aliasTarget(m)).map((m) => names.get(m.id)!));
  const newest = new Map<string, number[]>();
  for (const m of models) {
    if (aliasTarget(m)) continue;
    const { family, version } = familyOf(names.get(m.id)!);
    if (!version.length) continue;
    const best = newest.get(family);
    if (!best || compareVersions(version, best) > 0) newest.set(family, version);
  }
  const out = new Set<string>();
  for (const m of models) {
    const target = aliasTarget(m);
    // An alias of a listed model would show the same name twice.
    if (target) {
      if (!listed.has(target)) out.add(m.id);
      continue;
    }
    const { family, version } = familyOf(names.get(m.id)!);
    const best = newest.get(family);
    if (!version.length || !best || compareVersions(version, best) >= 0) out.add(m.id);
  }
  return out;
}

/**
 * The models a model menu lists, in the agent's order: the current generation, then the
 * user's overrides (either way), and always the model in use. When the model in use is an
 * alias of a listed model, the alias stands in for it so the name is never listed twice.
 */
export function visibleModels(provider: ProviderId, models: ModelInfo[], overrides: Record<string, boolean> | undefined, currentId?: string): ModelInfo[] {
  const base = currentGeneration(models);
  const shown = (m: ModelInfo) => overrides?.[visibilityKey(provider, m.id)] ?? base.has(m.id);
  const current = models.find((m) => m.id === currentId);
  const standIn = current && aliasTarget(current);
  const out = models.filter((m) => {
    if (m.id === currentId) return true;
    if (standIn && !aliasTarget(m) && modelName(m) === standIn) return false;
    return shown(m);
  });
  const list = out.length ? out : models.filter((m) => base.has(m.id));
  // A saved model the agent no longer lists stays chosen and in the menu, by its name only.
  return currentId && !current && models.length ? [...list, savedModel(currentId, models)] : list;
}

/** A stand-in for a model the user chose that the agent's list no longer has. */
export function savedModel(id: string, models: ModelInfo[]): ModelInfo {
  return { id, name: modelNameById(id, models) ?? id };
}

export { modelSpeeds, speedFor, toggledSpeed, offeredSpeeds, defaultableSpeeds, isPaidSpeed } from '@shared/speed';
