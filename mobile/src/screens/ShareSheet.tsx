import { useEffect } from 'react';
import { baseName } from '@desk/lib/format';
import { haptic } from '@m/lib/native';
import { dropShare, listenForShares, shareInto, shareIntoNew, shareTargets, useShared } from '@m/lib/share-in';
import { useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { ProviderMark } from '@m/ui/marks';
import { Choice, Sheet } from '@m/ui/Sheet';

/**
 * Share into Sable (2.22): text or a link shared from another app asks which chat it goes to: the new
 * chat first, then the Recent list (pinned first, the newest after). A tap puts the words in that
 * chat's draft and opens it; nothing is sent. The sheet shows what was shared, as it will go in.
 */
export function ShareSheet() {
  const shared = useShared();
  const sessions = useStore((s) => s.sessions);
  const paired = useStore((s) => s.conn !== 'unpaired');
  useEffect(() => listenForShares(), []);
  const open = !!shared && paired;
  const targets = open ? shareTargets(sessions) : [];
  return (
    <Sheet open={open} onClose={dropShare} title="Add to a chat" className="share-sheet">
      {shared && (
        <>
          <p className="share-preview">{shared.text}</p>
          <div className="choices">
            <Choice icon={<Icon name="plus" size={18} />} onPick={() => (haptic('select'), shareIntoNew(shared.text))}>
              New chat
            </Choice>
            {targets.map((s) => (
              <Choice key={s.id} icon={<ProviderMark provider={s.provider} size={16} />} aside={s.chat ? undefined : baseName(s.cwd)} onPick={() => (haptic('select'), shareInto(s.id, shared.text))}>
                <span className="share-title">{s.title || 'Chat'}</span>
              </Choice>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}
