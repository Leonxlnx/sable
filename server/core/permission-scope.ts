import type { PermissionScope } from '../../shared/protocol';

/**
 * An approval's scope in words, one line per thing it reaches (`PermissionScope`): the agents'
 * adapters put these lines in a request's `description` or `reason`, and the phone endpoint allows a
 * request from a phone only when each line shows there whole (phone.ts `phonePermission`).
 */

/** A changed file as a line: its path, a moved one from where to where. */
export const fileLine = (f: { path: string; from?: string }) => (f.from && f.from !== f.path ? `${f.from} → ${f.path}` : f.path);

/** The lines for grant roots, network destinations and sandbox paths (files go by `fileLine`, or by a change's diff). */
export function scopeLines(s: PermissionScope | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const h of s.hosts ?? []) out.push(h === '*' ? 'Network access' : `Network access to ${h}`);
  for (const r of s.roots ?? []) out.push(`Allow writes under ${r} for this session`);
  for (const p of s.write ?? []) out.push(`Write: ${p}`);
  for (const p of s.read ?? []) out.push(`Read: ${p}`);
  for (const d of s.dirs ?? []) out.push(`Always: access to ${d}`);
  for (const r of s.rules ?? []) out.push(`Always: allow ${r}`);
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
  for (const k of ['roots', 'hosts', 'read', 'write', 'dirs', 'rules'] as const) {
    const list = (s[k] ?? []).filter((x) => typeof x === 'string' && x.length > 0);
    if (list.length) out[k] = list;
  }
  if (s.files?.length) out.files = s.files;
  if (s.unknown) out.unknown = true;
  return Object.keys(out).length ? out : undefined;
}
