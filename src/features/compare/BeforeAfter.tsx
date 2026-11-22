import { lazy, memo, Suspense, useState } from 'react';
import { LazyTip } from '@/components/LazyTip';
import { Icon } from '@/icons';
import type { TurnCapture } from '@shared/protocol';
import { picture, useTurnCapture } from './captures';
import './compare.css';

const loadView = () => import('./CompareView');
const CompareView = lazy(() => loadView().then((m) => ({ default: m.CompareView })));

/** On the way to a click: the view's code and the desktop pictures, so it opens with them. */
function prefetch(sessionId: string, capture: TurnCapture) {
  void loadView();
  const view = capture.views.find((v) => v.kind === 'desktop') ?? capture.views[0];
  for (const shot of [view?.before, view?.after]) if (shot) void picture(sessionId, shot.id);
}

/**
 * Under a turn that edited a local page: "Before / after" beside Preview. While the after is
 * being taken it waits quietly. Only where there is a before: a capture with nothing to compare
 * against (the bridge takes none any more; older chats still hold some) offers nothing.
 */
export const BeforeAfter = memo(function BeforeAfter({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const capture = useTurnCapture(sessionId, turnId);
  const [open, setOpen] = useState(false);
  // Mounted from the first open on, so the dialog can animate out.
  const [opened, setOpened] = useState(false);
  if (!capture || capture.state === 'failed') return null;
  const capturing = capture.state === 'capturing';
  if (!capturing && !capture.views.some((v) => v.before)) return null;
  const view = capture.views.find((v) => v.kind === 'desktop' && v.before) ?? capture.views.find((v) => v.before) ?? capture.views[0];
  const n = view?.regions?.length;
  const meta = capturing ? undefined : n === 0 ? 'No visible change' : n === 1 ? '1 change' : `${n} changes`;
  const tip = capturing ? 'Capturing the page' : undefined;
  const button = (
    <button
      type="button"
      className="preview-btn cmp-btn"
      data-state={capture.state}
      aria-disabled={capturing || undefined}
      aria-label={capturing ? 'Before / after, capturing' : `Before / after${meta ? `, ${meta}` : ''}`}
      onPointerEnter={() => !capturing && prefetch(sessionId, capture)}
      onFocus={() => !capturing && prefetch(sessionId, capture)}
      onClick={() => {
        if (capturing) return;
        setOpened(true);
        setOpen(true);
      }}
    >
      <Icon name="compare" size={14} className="preview-icon" />
      <span className={capturing ? 'preview-name shimmer' : 'preview-name'}>Before / after</span>
      {meta && <span className="preview-host">{meta}</span>}
    </button>
  );
  return (
    <>
      {tip ? (
        <LazyTip label={tip} side="top">
          {button}
        </LazyTip>
      ) : (
        button
      )}
      {opened && (
        <Suspense fallback={null}>
          <CompareView sessionId={sessionId} capture={capture} open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
});
