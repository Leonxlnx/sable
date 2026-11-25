import type { UserItem } from '@shared/protocol';
import { keepRecovery } from '../composer/drafts';
import { holdSend, sendBack, sendDone } from '../composer/pending';
import { rewindTo, sendMessage, wholeMessage } from '@/state/actions';
import { syntheticOf, stripWrappers } from '@shared/synthetic';
import { sameOpenedRow, useStore, type SessionData } from '@/state/store';

export function lastPrompt(d?: SessionData, includeCommand = false) {
  if (d) for (let i = d.roots.length - 1; i >= 0; i--) {
    const row = d.items[d.roots[i]];
    if (row?.type !== 'user' || row.state === 'queued') continue;
    const synthetic = syntheticOf(row);
    if (!synthetic || includeCommand && synthetic.role === 'command') return row;
  }
}

const repeating = new Set<string>();

export async function repeatMessage(sessionId: string, item: UserItem, text: string, mode: 'edit' | 'retry' | 'footer', turnId = item.id, confirmedOlder = false) {
  const key = JSON.stringify([sessionId, turnId]);
  if (repeating.has(key)) return false;
  repeating.add(key);
  try {
    const start = useStore.getState().data[sessionId];
    const expectedEnd = start?.roots.at(-1);
    const clicked = start?.items[item.id];
    const moved = () => { useStore.getState().toast('The conversation moved on', 'error'); return false; };
    if (start && (clicked !== item || !confirmedOlder && lastPrompt(start, mode === 'footer')?.id !== item.id)) return moved();
    const whole = await wholeMessage(sessionId, item);
    if (!whole) return start && useStore.getState().data[sessionId]?.items[item.id] !== item ? moved() : false;
    const current = useStore.getState().data[sessionId];
    if (start && (current?.roots.at(-1) !== expectedEnd || current?.items[item.id] !== whole ||
      !sameOpenedRow(sessionId, item, whole))) return moved();
    if (item.more && (text === item.text || text === stripWrappers(item.text))) text = stripWrappers(whole.text);
    const rewind = mode === 'footer' ? undefined : { itemId: item.id, expectedEnd, expectedLast: confirmedOlder ? undefined : whole };
    const draft = { text, attachments: whole.attachments ?? [], recovery: { rewind } };
    const pending = holdSend(sessionId, draft, false);
    pending.payload = { text, attachments: draft.attachments };
    if (!await keepRecovery()) {
      sendDone(pending);
      return false;
    }
    if (start && (useStore.getState().data[sessionId]?.roots.at(-1) !== expectedEnd ||
        useStore.getState().data[sessionId]?.items[item.id] !== whole)) {
      sendDone(pending);
      return moved();
    }
    const rewound = mode === 'footer' || await rewindTo(sessionId, item.id, false, { ...rewind, operationId: pending.id });
    if (rewound === false) {
      sendDone(pending);
      return false;
    }
    if (rewound && rewind) {
      pending.draft = { ...pending.draft, recovery: { ...pending.draft.recovery, rewind: undefined } };
      if (!await keepRecovery()) {
        const st = useStore.getState();
        st.setDraft(sessionId, sendBack(pending, st.drafts[sessionId]));
        return false;
      }
    }
    if (rewound && mode !== 'edit') {
      const result = await sendMessage(sessionId, text, draft.attachments, { submitId: pending.id });
      if (result.ok) {
        sendDone(pending);
        return true;
      }
      pending.uncertain = result.unknown;
    }
    const st = useStore.getState();
    st.setDraft(sessionId, sendBack(pending, st.drafts[sessionId]));
    return !!rewound && mode === 'edit';
  } finally {
    repeating.delete(key);
  }
}
