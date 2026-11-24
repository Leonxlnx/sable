import { memo, useState } from 'react';
import type { ThinkingItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { Elapsed } from './Tool';
import { useWhole } from './ctx';
import { thinkingRow } from './step-row';
import { shortDuration } from './util';

/**
 * Reasoning: one quiet line with its time, a shimmer while it runs. The text is one click away,
 * also while it is still being thought, and nothing opens by itself, so the trail never jumps.
 */
export const Thinking = memo(function Thinking({ item }: { item: ThinkingItem }) {
  const show = useStore((s) => s.settings.showThinking);
  const [open, setOpen] = useState(false);
  useWhole(item, open && show);
  const { canOpen, label } = thinkingRow(item, show);

  const head = (
    <>
      <span className="tool-icon think-icon">
        <Icon name="brain" size={14} />
      </span>
      <span className={item.streaming ? 'tool-title shimmer' : 'tool-title'}>{label}</span>
      <span className="tool-meta">{item.streaming ? <Elapsed since={item.ts} /> : item.endedAt ? <span className="num">{shortDuration(item.endedAt - item.ts)}</span> : null}</span>
      {canOpen && <Icon name="caret-right" size={10} className="row-caret" />}
    </>
  );

  return (
    <div className="think" data-open={open || undefined}>
      {canOpen ? (
        <button type="button" className="row-btn think-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="row-btn think-row" data-static>
          {head}
        </div>
      )}
      {show && (
        <Collapse open={open}>
          <div className="think-body" inert={item.more} aria-busy={item.more}>
            <Markdown text={item.text} streaming={item.streaming} />
          </div>
        </Collapse>
      )}
    </div>
  );
});
