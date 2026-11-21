import { useMemo } from 'react';
import type { PermissionRequest, QuestionRequest } from '@shared/protocol';
import { useStore } from './store';

/** A prompt waiting on you in some chat: a permission or the agent's questions. */
export interface Card {
  key: string;
  sessionId: string;
  /** What it asks, in a line. */
  title: string;
  createdAt: number;
  perm?: PermissionRequest;
  question?: QuestionRequest;
}

/** Every prompt waiting across the chats that are not archived, the oldest first (home's strip and its deck). */
export function usePending(): Card[] {
  const pending = useStore((s) => s.pending);
  // Only whether each chat is there and not archived (not its every update).
  const live = useStore((s) => {
    let out = '';
    for (const r of [...s.pending.permissions, ...s.pending.questions]) {
      const m = s.sessions[r.sessionId];
      if (m && !m.archived) out += `${r.sessionId},`;
    }
    return out;
  });
  return useMemo(() => {
    const ok = new Set(live.split(','));
    const cards: Card[] = [
      ...pending.permissions.map((p) => ({ key: `p:${p.id}`, sessionId: p.sessionId, title: p.title, createdAt: p.createdAt, perm: p })),
      ...pending.questions.map((q) => ({ key: `q:${q.id}`, sessionId: q.sessionId, title: q.questions[0]?.question || 'A question for you', createdAt: q.createdAt, question: q })),
    ];
    return cards.filter((c) => ok.has(c.sessionId)).sort((a, b) => a.createdAt - b.createdAt);
  }, [pending, live]);
}
