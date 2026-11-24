import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { showRailTab } from '@/state/actions';
import { useStore } from '@/state/store';
import { Tip } from '@/ui';
import './review-mark.css';

/**
 * Beside the title's crumbs: how many changed files the person has not looked at since they changed
 * (`SessionMeta.review`), as "3 to review" in the crumbs' own tone. A click opens the Changes tab,
 * which opens on New while anything is new. Nothing at 0.
 */
export function ReviewMark({ sessionId }: { sessionId: string }) {
  const n = useStore((s) => s.sessions[sessionId]?.reviewMany ? 'many' : s.sessions[sessionId]?.review ?? 0);
  if (!n) return null;
  return (
    <Tip label="Open Changes">
      <button type="button" className="review-mark" aria-label={`${n === 'many' ? 'Many files' : plural(n, 'file')} to review. Open Changes`} onClick={() => showRailTab('changes')}>
        <Icon name="diff" size={13} />
        <span className="num">{n} to review</span>
      </button>
    </Tip>
  );
}
