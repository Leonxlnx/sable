import { useState, type ReactNode } from 'react';
import { Icon } from '@/icons';
import { Modal } from '@/ui';
import './image-view.css';

/**
 * An image in the conversation that opens larger on click: the thumbnail (or the picture itself)
 * is the button, and the larger view is a dialog that fits the picture to the window.
 */
export function ImageView({ src, alt, className, children }: { src: string; alt: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className ? `image-open ${className}` : 'image-open'} onClick={() => setOpen(true)} aria-label={alt ? `Open larger: ${alt}` : 'Open larger'} title={alt || undefined}>
        {children}
      </button>
      {open && <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The larger view: the picture at its own size, scaled down to fit the window and kept in its proportions. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [size, setSize] = useState<[number, number] | null>(null);
  const width = size
    ? `min(${size[0]}px, calc((100 * var(--vh) - 96px) * ${size[0] / size[1]}), calc(100 * var(--vw) - 96px))`
    : undefined;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={alt || 'Image'} bare className="image-view" width={size ? 'auto' : 'min(520px, calc(100 * var(--vw) - 96px))'}>
      <div className="image-view-frame">
        <img
          className="image-view-img"
          src={src}
          alt={alt}
          draggable={false}
          decoding="async"
          style={width ? { width } : undefined}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w > 0 && h > 0) setSize([w, h]);
          }}
        />
        <button type="button" className="image-view-close" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </Modal>
  );
}
