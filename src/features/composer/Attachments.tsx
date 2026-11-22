import { memo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Attachment } from '@shared/protocol';
import { Icon } from '@/icons';
import { shatter } from './shatter';
import { formatBytes } from '@/lib/format';

const meta = (a: Attachment) => (a.kind === 'file' ? (a.size ? formatBytes(a.size) : 'File') : a.text != null ? `${a.text.replace(/\n$/, '').split('\n').length} lines` : formatBytes(a.size));

/**
 * What will travel with the message: image thumbnails and one-line file chips. Removing one breaks
 * it into dither cells (the house removal effect) while the others close up.
 */
export const AttachmentRow = memo(function AttachmentRow({ items, onRemove }: { items: Attachment[]; onRemove: (id: string) => void }) {
  const reduced = useReducedMotion();
  return (
    <div className="att-row">
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((a) => (
          <motion.div
            key={a.id}
            layout={reduced ? false : 'position'}
            className={a.kind === 'image' ? 'att att-img' : 'att att-file'}
            // A file chip is no button: marked so its icon moves when the chip is pointed at (icons/animated/play.ts).
            data-ai-host={a.kind === 'image' ? undefined : ''}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: reduced ? 0.12 : 0 } }}
            transition={{ type: 'spring', stiffness: 480, damping: 36 }}
            title={a.path ?? a.name}
          >
            {a.kind === 'image' && a.dataUrl ? (
              <img src={a.dataUrl} alt={a.name} draggable={false} />
            ) : (
              <>
                <Icon name={a.kind === 'file' ? 'file' : 'file-text'} size={15} className="att-file-icon" />
                <span className="att-file-name truncate">{a.name}</span>
                <span className="att-file-meta">{meta(a)}</span>
              </>
            )}
            <button
              type="button"
              className="att-x"
              aria-label={`Remove ${a.name}`}
              onClick={(e) => {
                shatter(e.currentTarget.closest('.att'));
                onRemove(a.id);
              }}
            >
              <Icon name="x" size={10} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});
