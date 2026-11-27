import type { UpdateWait } from '@shared/protocol';

/**
 * A restart for an update that waits, in words: which chat it waits for and what that chat holds.
 * Pure: the sidebar's row, its menu and Settings › About read the same words.
 */

/** A hold that ends by its age: how long at most, in whole minutes. */
const upTo = (until: number | undefined, now: number) => (until !== undefined && until > now ? ` · ${Math.max(1, Math.ceil((until - now) / 60_000))} min` : '');

/** What a chat holds, in a word or two. */
export function waitWord(w: UpdateWait, now: number): string {
  const many = (w.count ?? 0) > 1;
  switch (w.kind) {
    case 'turn':
      return 'Working';
    case 'starting':
      return 'Starting';
    case 'asks':
      return 'Waiting for you';
    case 'moving':
      return 'Changing account';
    case 'agents':
      return many ? `${w.count} sub-agents` : 'Sub-agent';
    case 'command':
      return (many ? `${w.count} commands` : 'Command') + upTo(w.until, now);
    case 'wake':
      return 'Wake-up' + upTo(w.until, now);
    case 'agent':
      return 'Agent busy' + upTo(w.until, now);
    case 'sable':
      return 'Finishing a step';
  }
}

/** The chats a restart waits for, each once, in the bridge's order. */
export function waitChats(waits: UpdateWait[] | undefined): UpdateWait[] {
  const seen = new Set<string>();
  const out: UpdateWait[] = [];
  for (const w of waits ?? []) {
    if (!w.sessionId || seen.has(w.sessionId)) continue;
    seen.add(w.sessionId);
    out.push(w);
  }
  return out;
}

/** The row's own line: the one chat by its name, several by their count, Sable's own step by itself. */
export function waitLabel(waits: UpdateWait[] | undefined, title: (id: string) => string | undefined): string {
  const chats = waitChats(waits);
  if (chats.length === 1) {
    const name = title(chats[0].sessionId!)?.trim();
    return name ? `Waits for ${name}` : 'Waits for 1 chat';
  }
  if (chats.length > 1) return `Waits for ${chats.length} chats`;
  return waits?.length ? 'Finishing a step' : 'Waits for agents';
}
