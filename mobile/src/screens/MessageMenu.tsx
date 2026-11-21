import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '@m/lib/back';
import { renderMarkdown } from '@m/lib/md';
import { holder, type Hold } from '@m/lib/held';
import { haptic, shareText } from '@m/lib/native';
import { setState } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';

/**
 * A message held (the system's long press, as `contextmenu`): it stands out where it is, and a small
 * menu under the finger offers Copy, Select text and Share (Android's share sheet). The text is the
 * message's own (an answer's markdown, whole: a shortened one is fetched first). Select text opens the
 * message in a sheet where the system's own selection works: a long press there picks words with
 * Android's handles and its Copy, Share and Select all.
 */
interface Held {
  el: HTMLElement;
  x: number;
  y: number;
  text: () => string | Promise<string>;
  /** The text is markdown (an answer): the sheet shows it as the chat does. */
  md: boolean;
  at: number;
}

// One hold at a time; each its own (lib/held.ts): what the menu does after a wait checks it still holds that one.
const holds = holder<Held>((prev, next) => {
  prev?.value.el.removeAttribute('data-held');
  next?.value.el.setAttribute('data-held', '');
});

const done = (text: string, level: 'success' | 'error' = 'success') => setState({ toast: { text, level, at: Date.now() } });

/** Opens the menu for a message (from its `onContextMenu`); `as`: how the sheet of Select text shows it. */
export function holdMessage(e: React.MouseEvent, el: HTMLElement | null, text: () => string | Promise<string>, as: 'md' | 'plain' = 'plain') {
  if (!el) return;
  e.preventDefault();
  // A long press already selected words: the system's own menu is in charge.
  if (String(window.getSelection() ?? '').trim()) window.getSelection()?.removeAllRanges();
  haptic('select');
  holds.hold({ el, x: e.clientX, y: e.clientY, text, md: as === 'md', at: Date.now() });
}

/** Lets go of one hold (or whatever is held): a newer one stays. */
const let_go = (h?: Hold<Held>) => void holds.release(h);

/** The message in a sheet, its words selectable with the system's handles (and nothing else in the way). */
function SelectSheet({ open, text, md, onClose }: { open: boolean; text: string; md: boolean; onClose: () => void }) {
  const html = useMemo(() => (md ? renderMarkdown(text, false) : ''), [md, text]);
  // Closing: what was picked goes with the sheet.
  useEffect(() => {
    if (!open) window.getSelection()?.removeAllRanges();
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} label="Select text" className="select-sheet">
      {md ? <div className="md select-text no-drag" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="select-text select-plain no-drag">{text}</div>}
    </Sheet>
  );
}

export function MessageMenu() {
  const hold = useSyncExternalStore(holds.subscribe, holds.current);
  const h = hold?.value ?? null;
  const [busy, setBusy] = useState(false);
  const [select, setSelect] = useState<{ text: string; md: boolean; open: boolean } | null>(null);
  useEffect(() => (hold ? pushBack(() => (let_go(hold), true)) : undefined), [hold]);
  useEffect(() => setBusy(false), [hold]);
  const run = async (what: 'copy' | 'share' | 'select') => {
    if (!hold || !h || busy) return;
    setBusy(true);
    let text = '';
    try {
      text = await h.text();
    } catch {
      if (!holds.holds(hold)) return;
      haptic('deny');
      done('Could not read the message', 'error');
      return let_go(hold);
    }
    // Let go of (Back) or replaced by another message while it was fetched: nothing opens, nothing else closes.
    if (!holds.holds(hold)) return;
    if (what === 'copy') {
      try {
        await navigator.clipboard.writeText(text);
        haptic('success');
        done('Copied');
      } catch {
        haptic('deny');
        done('Could not copy it', 'error');
      }
    } else if (what === 'select') {
      haptic('tap');
      setSelect({ text, md: h.md, open: true });
    } else {
      haptic('tap');
      if (!(await shareText(text))) done('Nothing here can share it', 'error');
    }
    let_go(hold);
  };
  const W = 212;
  const H = 162;
  const left = h ? Math.min(innerWidth - W - 12, Math.max(12, h.x - W / 2)) : 0;
  const below = h ? h.y + 14 + H < innerHeight - 24 : true;
  const top = h ? (below ? h.y + 14 : Math.max(12, h.y - 14 - H)) : 0;
  return (
    <>
      {createPortal(
        <AnimatePresence>
          {h && (
            <div className="msg-layer" key={h.at}>
              <motion.div className="msg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onClick={() => let_go(hold!)} onContextMenu={(e) => (e.preventDefault(), let_go(hold!))} />
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
                  <Icon name="copy" size={20} />
                </button>
                <button type="button" role="menuitem" className="msg-item" disabled={busy} onClick={() => void run('select')}>
                  <span>Select text</span>
                  <Icon name="select" size={20} />
                </button>
                <button type="button" role="menuitem" className="msg-item" disabled={busy} onClick={() => void run('share')}>
                  <span>Share</span>
                  <Icon name="share" size={20} />
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
      {select && <SelectSheet open={select.open} text={select.text} md={select.md} onClose={() => setSelect((s) => (s ? { ...s, open: false } : s))} />}
    </>
  );
}
