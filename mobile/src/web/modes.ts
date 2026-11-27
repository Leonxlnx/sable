import type { ModeInfo, ModeTone, ProviderId } from '@shared/protocol';

/**
 * A chat's mode as the prompt bar shows it in a browser, which is told no agent's capabilities (web
 * access's hello carries none): the agents' own modes by their ids (server/providers/claude.ts,
 * demo-catalog.ts, codex-map.ts, opencode-map.ts), shown and never offered. An id this list does not
 * know shows nothing.
 */
const KNOWN: Partial<Record<ProviderId, Record<string, [string, ModeTone]>>> = {
  claude: { default: ['Ask first', 'ask'], acceptEdits: ['Accept edits', 'edit'], plan: ['Plan', 'plan'], auto: ['Auto', 'auto'], bypassPermissions: ['Bypass', 'danger'] },
  demo: { default: ['Ask first', 'ask'], acceptEdits: ['Accept edits', 'edit'], plan: ['Plan', 'plan'], bypassPermissions: ['Bypass', 'danger'] },
  codex: { 'read-only': ['Read only', 'plan'], default: ['Ask', 'ask'], auto: ['Auto', 'edit'], 'full-access': ['Full access', 'danger'] },
  opencode: { build: ['Build', 'ask'], plan: ['Plan', 'plan'], 'allow-all': ['Allow all', 'danger'] },
};

export function knownMode(provider: ProviderId, id: string | undefined): ModeInfo | undefined {
  const m = id ? KNOWN[provider]?.[id] : undefined;
  return m ? { id: id!, name: m[0], description: '', tone: m[1] } : undefined;
}
