import { checkSubmission, rewindTo, releaseQueueReceipt, takeQueued, updateQueued } from '@/state/actions';
import { useStore } from '@/state/store';
import { keepRecovery } from './drafts';
import { settleTake, swapIn } from './restore';

/** Resolve only this checkpoint's operation. A missing queue row proves nothing. */
export async function recoverTake(sessionId: string, begin = false): Promise<boolean> {
  const st = useStore.getState();
  const recovery = st.drafts[sessionId]?.recovery;
  const id = recovery?.queueId, op = recovery?.operationId;
  if (!id || !recovery.preview || !op) {
    st.toast('Could not confirm ownership of the queued message.', 'error');
    return false;
  }
  if (!await keepRecovery()) return false;
  if (useStore.getState().drafts[sessionId]?.recovery?.operationId !== op) return false;
  const preview = { text: recovery.preview.text, attachments: recovery.preview.files.map(id => ({ id })) };
  const swap = recovery.swap;
  const result = begin && swap ? await updateQueued(sessionId, id, swap.text, swap.attachments, op, recovery.expected) : undefined;
  const take = result ? undefined : await takeQueued(sessionId, id, op, !begin, begin ? recovery.expected : undefined);
  const now = useStore.getState().drafts[sessionId];
  if (now?.recovery?.operationId !== op) return false;
  const current = result?.current ?? (take?.kind === 'revised' ? take.current : undefined);
  if (current) {
    st.setDraft(sessionId, { recovery: { ...recovery, expected: current } });
    return recoverTake(sessionId, true);
  }
  if (result?.unknown || take?.kind === 'unknown' || swap && take?.kind === 'taken' || result?.ok && !result.previous) {
    st.toast('Could not confirm the queue edit. Your draft is still here.', 'error');
    return false;
  }
  const got = result?.previous ?? (swap && take?.kind === 'message' ? take.message : undefined);
  const next = got ? swapIn(now, preview, { text: got.text, attachments: got.attachments ?? [] })
    : take ? settleTake(now, preview, take) : now;
  st.setDraft(sessionId, { ...next, recovery: next.text || next.attachments.length ? { operationId: op } : undefined });
  if (!await keepRecovery()) return false;
  void releaseQueueReceipt(sessionId, id, op);
  return !!got || take?.kind === 'message';
}

export async function recoverRewind(sessionId: string) {
  const st = useStore.getState();
  const recovery = st.drafts[sessionId]?.recovery;
  if (!recovery?.rewind || !recovery.operationId) return false;
  const { itemId, ...expected } = recovery.rewind;
  const ok = await rewindTo(sessionId, itemId, false, { ...expected, operationId: recovery.operationId });
  if (!ok || useStore.getState().drafts[sessionId]?.recovery !== recovery) return false;
  st.setDraft(sessionId, { recovery: { ...recovery, rewind: undefined } });
  return keepRecovery();
}

/** Before reusing a recovered send as a new draft, ask about its original wire payload. */
export async function recoverSubmission(sessionId: string) {
  const st = useStore.getState();
  const draft = st.drafts[sessionId], recovery = draft?.recovery;
  if (!recovery?.checkSend || !recovery.retry) return false;
  const { retry, payload = draft } = recovery;
  try {
    const answer = await checkSubmission(sessionId, retry.id, payload.text, payload.attachments);
    const now = useStore.getState().drafts[sessionId];
    if (now?.recovery !== recovery) return false;
    if (!answer.ok) {
      st.setDraft(sessionId, { recovery: { ...recovery, checkSend: false } });
      return true;
    }
    const files = new Set(retry.files.split('\u0000'));
    st.setDraft(sessionId, { recovery: undefined, text: now.text === retry.text ? '' : now.text,
      attachments: now.attachments.filter(a => !files.has(a.id)) });
    st.toast('The bridge already accepted this message.', 'info');
    await keepRecovery();
    return false;
  } catch {
    st.toast('Could not confirm the send. Your draft is still here.', 'error');
    return false;
  }
}
