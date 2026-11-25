import type { UserItem } from '@shared/protocol';
import { keepRecovery } from '../composer/drafts';
import { holdSend, sendBack, sendDone } from '../composer/pending';
import { rewindTo, sendMessage, wholeMessage } from '@/state/actions';
import { useStore } from '@/state/store';

const repeating = new Set<string>();

export async function repeatMessage(sessionId: string, item: UserItem, text: string, mode: 'edit' | 'retry' | 'footer', turnId = item.id) {
  const key = JSON.stringify([sessionId, turnId]);
  if (repeating.has(key)) return false;
  repeating.add(key);
  try {
    const whole = await wholeMessage(sessionId, item);
    if (!whole) return false;
    const draft = { text, attachments: whole.attachments ?? [], recovery: {} };
    const pending = holdSend(sessionId, draft, false);
    if (!await keepRecovery()) {
      sendDone(pending);
      return false;
    }
    const rewound = mode === 'footer' || await rewindTo(sessionId, item.id, false);
    if (rewound === false) {
      sendDone(pending);
      return false;
    }
    if (rewound && mode !== 'edit' && (await sendMessage(sessionId, text, draft.attachments, { submitId: pending.id })).ok) {
      sendDone(pending);
      return true;
    }
    const st = useStore.getState();
    st.setDraft(sessionId, sendBack(pending, st.drafts[sessionId]));
    return !!rewound && mode === 'edit';
  } finally {
    repeating.delete(key);
  }
}
