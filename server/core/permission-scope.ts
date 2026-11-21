import type { PermissionSave, PermissionScope } from '../../shared/protocol';

/**
 * An approval's scope in words, one line per thing it reaches (`PermissionScope`): the agents'
 * adapters put these lines in a request's `description` or `reason`, and the phone endpoint allows a
 * request from a phone only when each line shows there whole (phone.ts `phonePermission`).
 */

/** A changed file as a line: its path, a moved one from where to where. */
export const fileLine = (f: { path: string; from?: string }) => (f.from && f.from !== f.path ? `${f.from} → ${f.path}` : f.path);

/** Where an "always" answer keeps what it saves, in words. */
export const WHERE: Record<PermissionSave['where'], string> = {
  session: 'for this session',
  projectSettings: "in this project's settings",
  localSettings: "in this project's local settings",
  userSettings: 'in your settings, for every project',
  cliArg: 'for this run',
};

/** A rule's behaviour, as the start of its line. */
const BEHAVIOUR: Record<NonNullable<PermissionSave['behavior']>, string> = { allow: 'allow', deny: 'deny', ask: 'ask before' };

/** The lines of what an "always" answer saves: each folder, rule and mode with what it does and where it is kept. */
export function saveLines(saves: readonly PermissionSave[] | undefined): string[] {
  const out: string[] = [];
  for (const s of saves ?? []) {
    const where = WHERE[s.where] ?? s.where;
    for (const d of s.dirs ?? []) out.push(`Always: access to ${d} ${where}`);
    for (const r of s.rules ?? []) out.push(`Always: ${BEHAVIOUR[s.behavior ?? 'allow'] ?? s.behavior} ${r} ${where}`);
    if (s.mode) out.push(`Always: switch to ${s.mode} mode ${where}`);
  }
  return out;
}

/** The lines for grant roots, network destinations, sandbox paths and what an "always" answer saves (files go by `fileLine`, or by a change's diff). */
export function scopeLines(s: PermissionScope | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const h of s.hosts ?? []) out.push(h === '*' ? 'Network access' : `Network access to ${h}`);
  for (const r of s.roots ?? []) out.push(`Allow writes under ${r} for this session`);
  for (const p of s.write ?? []) out.push(`Write: ${p}`);
  for (const p of s.read ?? []) out.push(`Read: ${p}`);
  out.push(...saveLines(s.saves));
  return out;
}

/** Words of the agent's own and the scope's lines, one per line (empty: none). */
export function withScope(words: string | null | undefined, s: PermissionScope): string | undefined {
  const lines = [...(words?.trim() ? [words.trim()] : []), ...scopeLines(s)];
  return lines.length ? lines.join('\n') : undefined;
}

/** A scope with only the fields that hold something (undefined when nothing does). */
export function compactScope(s: PermissionScope): PermissionScope | undefined {
  const out: PermissionScope = {};
  for (const k of ['roots', 'hosts', 'read', 'write'] as const) {
    const list = (s[k] ?? []).filter((x) => typeof x === 'string' && x.length > 0);
    if (list.length) out[k] = list;
  }
  if (s.files?.length) out.files = s.files;
  const saves = (s.saves ?? []).filter((v) => v.dirs?.length || v.rules?.length || v.mode);
  if (saves.length) out.saves = saves;
  if (s.savesUnknown) out.savesUnknown = true;
  if (s.unknown) out.unknown = true;
  return Object.keys(out).length ? out : undefined;
}
