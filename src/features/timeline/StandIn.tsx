import { memo, useCallback, useEffect, useMemo } from 'react';
import type { UserItem } from '@shared/protocol';
import { useStore, type Store } from '@/state/store';
import { dropStandIn, standInRows, useStandIns, type StandIn } from './stand-in';
import { UserMessage } from './User';

/**
 * The messages sent in this chat whose rows the bridge has not added yet, at the conversation's
 * end in the timeline's own layout (stand-in.ts): the sent card lands here and anything added
 * meanwhile lays out above. A stand-in whose row is there is not drawn in that same commit, and the
 * row takes its place without an entrance (items.tsx, `takesStandIn`).
 */
export const StandInCards = memo(function StandInCards({ sessionId }: { sessionId: string }) {
  const all = useStandIns();
  const mine = useMemo(() => all.filter((s) => s.session === sessionId), [all, sessionId]);
  const found = useStore(
    useCallback(
      (s: Store) => {
        if (!mine.length) return '';
        const d = s.data[sessionId];
        return d ? [...standInRows(mine, sessionId, d.roots, d.items, d.queue).keys()].join('\n') : '';
      },
      [mine, sessionId],
    ),
  );
  // Rows that took over: their stand-ins are done (after the commit that drew the rows).
  useEffect(() => {
    if (!found) return;
    const ids = new Set(found.split('\n'));
    for (const s of mine) if (ids.has(s.id)) dropStandIn(s);
  }, [found, mine]);
  const taken = found ? new Set(found.split('\n')) : null;
  return (
    <>
      {mine.map((s) => (taken?.has(s.id) ? null : <StandInRow key={s.id} s={s} />))}
    </>
  );
});

const StandInRow = memo(function StandInRow({ s }: { s: StandIn }) {
  // The person's own words, just sent: `authored`, so the card shows every one of them as the row that
  // takes its place will (`userItemText`: a message that quotes a note of Sable's is not cut).
  const item = useMemo(() => ({ id: s.id, type: 'user', text: s.text, ts: s.wall, authored: true }) as UserItem, [s.id, s.text, s.wall]);
  return (
    <div className="tl-item" data-t="user" data-standin>
      <UserMessage item={item} landingId={s.submitId} />
    </div>
  );
});
