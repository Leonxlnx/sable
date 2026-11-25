import { historyError, retryHistory, useStore } from '@/state/store';

export function HistoryStatus({ sessionId }: { sessionId: string }) {
  const failed = useStore(s => s.data[sessionId]?.historyFailed);
  if (!failed) return <>Reading conversation…</>;
  return <>{historyError} <button type="button" onClick={() => void retryHistory(sessionId).catch(() => {})}>Try again</button></>;
}
