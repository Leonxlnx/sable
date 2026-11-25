import { useState } from 'react';
import type { UserItem } from '@shared/protocol';
import { userItemText } from '@shared/synthetic';
import { lastPrompt, repeatMessage } from './repeat-message';
import { useStore } from '@/state/store';
import { IconButton, Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/ui';
import { useTimeline } from './ctx';

/** Whether this is the last message of yours that the agent has taken. */
function useIsLast(sessionId: string, id: string): boolean {
  return useStore((s) => {
    const data = s.data[sessionId];
    return lastPrompt(data)?.id === id;
  });
}

/**
 * Two things people do with a message all day, beside copy and rewind (hover tools of a message):
 * - Edit and send again: the conversation goes back to before the message and its text returns to
 *   the composer. One click on your last message; an older one asks first, since everything after
 *   it goes.
 * - Retry, on your last message: the same message is sent again in place of the answer.
 * Both use the existing rewind and leave files as they are.
 */
export function MessageAgain({ item, turnId }: { item: UserItem; turnId: () => string }) {
  const { sessionId } = useTimeline();
  const canRewind = useStore((s) => !!s.data[sessionId]?.caps?.features.rewind);
  const idle = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'idle' || st === 'error';
  });
  const last = useIsLast(sessionId, item.id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!canRewind || !idle || item.state === 'queued' || !item.text) return null;
  // The words as the person wrote them, without a reminder the harness added; a card they sent
  // themselves keeps every word, also a quoted note of Sable's.
  const text = userItemText(item);

  const edit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await repeatMessage(sessionId, item, text, 'edit', turnId(), !last);
    setBusy(false);
    if (!ok) return;
    setOpen(false);
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.dock textarea');
      field?.focus();
      field?.setSelectionRange(text.length, text.length);
    });
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    await repeatMessage(sessionId, item, text, 'retry', turnId());
    setBusy(false);
  };

  return (
    <>
      {last ? (
        <IconButton icon="pencil" label="Edit and send again" size={14} tipSide="top" disabled={busy} onClick={edit} />
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <IconButton icon="pencil" label="Edit and send again" size={14} tipSide="top" />
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" width={288} className="pop-pad rewind">
            <div className="rewind-title">Edit and send again</div>
            <p className="rewind-desc">The message returns to the composer. Everything after it is removed from the conversation.</p>
            <div className="rewind-foot">
              <PopoverClose asChild>
                <button type="button" className="btn btn-sm btn-ghost">
                  Cancel
                </button>
              </PopoverClose>
              <button type="button" className="btn btn-sm" onClick={edit} disabled={busy}>
                Rewind and edit
              </button>
            </div>
          </PopoverContent>
        </Popover>
      )}
      {last && <IconButton icon="reload" label="Retry" size={14} tipSide="top" disabled={busy} onClick={retry} />}
    </>
  );
}
