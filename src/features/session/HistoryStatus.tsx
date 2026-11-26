import { historyError, retryHistory, useStore } from '@/state/store';

export function HistoryStatus({ sessionId }: { sessionId: string }) {
  const failed = useStore(s => s.data[sessionId]?.historyFailed);
  // Nothing of it in the window yet (its first read failed or never answered), or only its older part missing.
  const none = useStore(s => !s.data[sessionId]?.loaded);
  if (!failed) return <>Reading conversation…</>;
  return <>{none ? 'Could not read the conversation' : historyError} <button type="button" onClick={() => void retryHistory(sessionId).catch(() => {})}>Try again</button></>;
}
