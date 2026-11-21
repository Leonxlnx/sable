import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '@m/lib/back';
import { haptic, shareText } from '@m/lib/native';
import { setState } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { SNAP } from '@m/ui/motion';

/**
 * A message held (the system's long press, as `contextmenu`): it stands out where it is, and a small
 * menu under the finger offers Copy and Share (Android's share sheet). The text is the message's
 * own (an answer's markdown, whole: a shortened one is fetched first).
 */
interface Held {
  el: HTMLElement;
  x: number;
  y: number;
  text: () => string | Promise<string>;
  at: number;
}

let held: Held | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());

const done = (text: string, level: 'success' | 'error' = 'success') => setState({ toast: { text, level, at: Date.now() } });

/** Opens the menu for a message (from its `onContextMenu`). */
export function holdMessage(e: React.MouseEvent, el: HTMLElement | null, text: () => string | Promise<string>) {
  if (!el) return;
  e.preventDefault();
  // A long press already selected words: the system's own menu is in charge.
  if (String(window.getSelection() ?? '').trim()) window.getSelection()?.removeAllRanges();
  haptic('select');
  held?.el.removeAttribute('data-held');
  el.setAttribute('data-held', '');
  held = { el, x: e.clientX, y: e.clientY, text, at: Date.now() };
  emit();
}

const let_go = () => {
  held?.el.removeAttribute('data-held');
  held = null;
  emit();
};

export function MessageMenu() {
  const h = useSyncExternalStore(
    (l) => (subs.add(l), () => void subs.delete(l)),
    () => held,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => (h ? pushBack(() => (let_go(), true)) : undefined), [h]);
  useEffect(() => setBusy(false), [h]);
  const run = async (what: 'copy' | 'share') => {
    if (!h || busy) return;
    setBusy(true);
    let text = '';
    try {
      text = await h.text();
    } catch {
      haptic('deny');
      done('Could not read the message', 'error');
      return let_go();
    }
    if (what === 'copy') {
      try {
        await navigator.clipboard.writeText(text);
        haptic('success');
        done('Copied');
      } catch {
        haptic('deny');
        done('Could not copy it', 'error');
      }
    } else {
      haptic('tap');
      if (!(await shareText(text))) done('Nothing here can share it', 'error');
    }
    let_go();
  };
  const W = 212;
  const H = 112;
  const left = h ? Math.min(innerWidth - W - 12, Math.max(12, h.x - W / 2)) : 0;
  const below = h ? h.y + 14 + H < innerHeight - 24 : true;
  const top = h ? (below ? h.y + 14 : Math.max(12, h.y - 14 - H)) : 0;
  return createPortal(
    <AnimatePresence>
      {h && (
        <div className="msg-layer" key={h.at}>
          <motion.div className="msg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onClick={let_go} onContextMenu={(e) => (e.preventDefault(), let_go())} />
          <motion.div
            className="msg-menu"
            role="menu"
            style={{ left, top, transformOrigin: `${Math.round(h.x - left)}px ${below ? 0 : H}px` }}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
            transition={SNAP}
          >
            <button type="button" role="menuitem" className="msg-item" disabled={busy} onClick={() => void run('copy')}>
              <span>Copy</span>
              <Icon name="copy" size={19} />
            </button>
            <button type="button" role="menuitem" className="msg-item" disabled={busy} onClick={() => void run('share')}>
              <span>Share</span>
              <Icon name="share" size={19} />
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
