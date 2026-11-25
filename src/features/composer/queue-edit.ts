import { takeQueued } from '@/state/actions';
import { loadSession, useStore } from '@/state/store';
import { keepRecovery } from './drafts';
import { settleTake } from './restore';

/** After a lost reply, establish ownership from the bridge before treating the recovered field as a new send. */
export async function recoverTake(sessionId: string): Promise<boolean> {
  const recovery = useStore.getState().drafts[sessionId]?.recovery;
  const id = recovery?.queueId;
  if (!id || !recovery?.preview) return false;
  try {
    await loadSession(sessionId, { fresh: true, peek: true });
  } catch {
    useStore.getState().toast('Could not check the queued message. Your draft is still here.', 'error');
    return false;
  }
  const data = useStore.getState().data[sessionId];
  if (!data?.loaded) return false;
  const queued = data.queue.some(q => q.id === id);
  if (queued && !await keepRecovery()) return false;
  const result = queued ? await takeQueued(sessionId, id)
    : data.items[id]?.type === 'user' ? { kind: 'taken' as const } : undefined;
  const st = useStore.getState();
  const now = st.drafts[sessionId];
  if (now?.recovery !== recovery) return false;
  const preview = { text: recovery.preview.text, attachments: recovery.preview.files.map(id => ({ id })) };
  // In neither the queue nor the conversation: the take committed before its answer was lost.
  st.setDraft(sessionId, result ? settleTake(now, preview, result) : { ...now, recovery: {} });
  return !result || result.kind === 'message';
}
