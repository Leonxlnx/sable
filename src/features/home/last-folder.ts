import type { SessionMeta } from '@shared/protocol';

/**
 * The folder the person last worked in: the folder of the chat changed most recently, so home
 * starts there (Home.tsx). A chat with no folder of its own (`chat`, its folder is Sable's), the
 * Customize chat and archived chats say nothing about where the person works; a chat in a lane
 * counts for the folder it was started in, never for the worktree Sable made for it.
 */
export function lastFolder(sessions: Record<string, SessionMeta | undefined>): string | null {
  let best: SessionMeta | null = null;
  for (const m of Object.values(sessions)) {
    if (!m || m.chat || m.custom || m.archived || !m.cwd) continue;
    if (!best || m.updatedAt > best.updatedAt) best = m;
  }
  if (!best) return null;
  return best.lane?.folder || best.cwd;
}
