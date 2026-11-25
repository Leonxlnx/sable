import { useState } from 'react';
import type { ToolItem } from '@shared/protocol';
import { sendMessage } from '@/state/actions';
import { DELEGATE_RETRY_LABEL, delegateRetry } from './delegate-word';

/**
 * "Send report again": the one action of a handed-over task whose report went out and whose delivery
 * the bridge could not confirm (`delegateReceiptState: 'unknown'`). The answer is saved on the step
 * and the agent may already have it, so nothing is sent again by itself: the person decides, here or
 * by the command the bridge's own notice names. The press sends that command (`/report-retry` with
 * the decision's token, `delegateRetry`) as the composer would; the bridge takes it as the decision,
 * never as a message to the agent, and the row's word changes with its answer. A refusal (the
 * decision was taken elsewhere meanwhile) is the bridge's toast. Nothing where there is no decision.
 */
export function ReportAgain({ sessionId, item, className }: { sessionId: string; item: Pick<ToolItem, 'delegateReceiptState' | 'delegateRetryId'>; className: string }) {
  const command = delegateRetry(item);
  const [sending, setSending] = useState(false);
  if (!command) return null;
  const send = async () => {
    if (sending) return;
    setSending(true);
    await sendMessage(sessionId, command);
    setSending(false);
  };
  return (
    <button type="button" className={className} aria-disabled={sending || undefined} onClick={() => void send()}>
      {DELEGATE_RETRY_LABEL}
    </button>
  );
}
