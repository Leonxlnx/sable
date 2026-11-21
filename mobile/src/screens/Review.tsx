import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { orderComments, quoteLines, rangeLabel, type ReviewComment } from '@desk/features/review/model';
import { fit } from '@m/lib/fit';
import { discardComments, dropComment, leadOf, sendReview, setLead, useComments } from '@m/lib/comments';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { setState, useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';

/**
 * A chat's review written on the phone: the comments wait per chat (lib/comments.ts) and go as one
 * message, the desktop's own review message. Where they show: a line above the chat's prompt bar,
 * the pane at the foot of its changes, and the review sheet (what was typed first, every comment,
 * Send review, Discard).
 */

export const commentCount = (n: number) => `${n} ${n === 1 ? 'comment' : 'comments'}`;
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const toast = (text: string, level: 'info' | 'success' | 'error') => setState({ toast: { text, level, at: Date.now() } });

/** Sends the chat's review. `back`: it went out from the chat's changes, so the chat comes forward to show it. */
export async function sendNow(sid: string, back: boolean): Promise<boolean> {
  haptic('send');
  try {
    await sendReview(sid);
    haptic('success');
    if (back) nav.toChat(sid);
    return true;
  } catch (err) {
    haptic('deny');
    const msg = (err as Error).message;
    toast(/connection to the desktop was lost|did not answer in time/i.test(msg) ? 'The connection dropped while sending' : msg, 'error');
    return false;
  }
}

/** Above the chat's prompt bar while comments wait: the count opens the review, Send sends it. */
export function ReviewLine({ sid }: { sid: string }) {
  const n = useComments(sid).length;
  const online = useStore((s) => s.conn === 'open');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <AnimatePresence initial={false}>
        {n > 0 && (
          <motion.div
            key="review"
            className="waiting-line rv-line glass-liquid"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={SNAP}
          >
            <button type="button" className="rv-line-open" aria-haspopup="dialog" onClick={() => (haptic('tap'), setOpen(true))}>
              <Icon name="comment" size={18} />
              <span className="waiting-text">
                Review <span className="rv-line-n num">· {commentCount(n)}</span>
              </span>
            </button>
            <button
              type="button"
              className="waiting-go"
              disabled={!online || busy}
              onClick={async () => {
                setBusy(true);
                await sendNow(sid, false);
                setBusy(false);
              }}
            >
              {busy ? <span className="dots" aria-label="Sending" /> : 'Send'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <ReviewSheet sid={sid} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const MAX_LEAD = 132;

/**
 * Everything the review will say: words typed above the comments (they go first, as on the desktop),
 * then each comment under its file and lines (the first line it quotes, in code) with a key to take
 * it out. Send review, or Discard (asked once more).
 */
export function ReviewSheet({ sid, open, onClose, back }: { sid: string; open: boolean; onClose: () => void; back?: boolean }) {
  const comments = useComments(sid);
  const list = useMemo(() => orderComments(comments), [comments]);
  const online = useStore((s) => s.conn === 'open');
  const [lead, setLeadText] = useState(() => leadOf(sid));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setLeadText(leadOf(sid));
    setConfirm(false);
  }, [open, sid]);
  // The last comment taken out: nothing left to send.
  useEffect(() => {
    if (open && !list.length && !busy) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, list.length]);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 3200);
    return () => clearTimeout(t);
  }, [confirm]);
  useLayoutEffect(() => {
    fit(area.current, MAX_LEAD);
  }, [lead, open]);

  const send = async () => {
    setBusy(true);
    const ok = await sendNow(sid, !!back);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Review" className="rvs">
      <textarea
        ref={area}
        className="rvs-lead"
        rows={1}
        value={lead}
        placeholder="Add a message"
        aria-label="Message above the comments"
        onChange={(e) => {
          setLeadText(e.target.value);
          setLead(sid, e.target.value);
        }}
      />
      <ul className="rvs-list" aria-label={commentCount(list.length)}>
        <AnimatePresence initial={false}>
          {list.map((c) => (
            <motion.li key={c.id} className="rvs-item" initial={false} exit={{ opacity: 0, height: 0 }} transition={SNAP}>
              <CommentSummary c={c} onRemove={() => (haptic('tap'), dropComment(sid, c.id))} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="sheet-foot rvs-foot">
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!online || busy || !list.length} onClick={() => void send()}>
          {busy ? <span className="dots" aria-label="Sending" /> : online ? 'Send review' : 'Offline'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-block rvs-discard"
          disabled={busy}
          onClick={() => {
            if (!confirm) return void (haptic('tap'), setConfirm(true));
            haptic('warning');
            discardComments(sid);
            onClose();
          }}
        >
          {confirm ? `Discard ${commentCount(list.length)}` : 'Discard'}
        </button>
      </div>
    </Sheet>
  );
}

/** One comment as the sheet lists it: its file (the folder dim, giving way first) and lines, the first line it quotes, its words. */
function CommentSummary({ c, onRemove }: { c: ReviewComment; onRemove: () => void }) {
  const at = c.path.lastIndexOf('/');
  const range = rangeLabel(c.lines);
  const first = quoteLines(c.lines)[0] ?? '';
  return (
    <div className="rvs-c">
      <div className="rvs-c-body">
        <div className="rv-where">
          {at >= 0 && <span className="rv-dir">{c.path.slice(0, at + 1)}</span>}
          <span className="rv-name">{c.path.slice(at + 1)}</span>
          {range && <span className="rv-lines num">{upper(range)}</span>}
        </div>
        <div className="rvs-quote" data-t={first[0] === '+' ? '+' : first[0] === '-' ? '-' : undefined}>
          {first.slice(1) || ' '}
        </div>
        <div className="rvs-text">{c.text}</div>
      </div>
      <button type="button" className="icon-btn sm rvs-x" aria-label="Remove comment" onClick={onRemove}>
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
