import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UserItem } from '@shared/protocol';
import { stripWrappers } from '@shared/synthetic';
import { CopyButton } from '@/components/CopyButton';
import { ImageView } from '@/components/ImageView';
import { Icon } from '@/icons';
import { formatBytes } from '@/lib/format';
import { rewindTo } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Popover, PopoverClose, PopoverContent, PopoverTrigger, Switch, Tip } from '@/ui';
import { fieldBeat } from '@/art/events';
import { landInTimeline } from '@/features/composer/flight';
import { parseReview } from '@/features/review/model';
import { ReviewComments } from '@/features/review/ReviewMessage';
import { afterSend, sendInAir } from '@/features/composer/settle';
import { EASE_OUT, play, reducedMotion, uiZoom } from '@/lib/motion';
import { MessageAgain } from './Again';
import { useTimeline } from './ctx';
import { Stamp } from './Stamp';
import { MOVE_GLIDE_MS, endShift, glideOffset, isLongMessage, rowLeft, rowMoved, willMove } from './user-card';

/** How far the conversation will scroll this frame to keep its end (its own pixels; user-card.ts `endShift`). */
function shiftOf(el: HTMLElement, stuck: boolean): number {
  const sc = el.closest<HTMLElement>('.tl-scroll');
  return sc ? endShift(stuck, sc.scrollHeight, sc.clientHeight, sc.scrollTop) : 0;
}

/** The steer key's arrow (composer/SendKey.tsx `steer`), drawn small: up and leaning into the turn. */
function SteerMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g transform="rotate(45 8 8)" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 12.75V3.75" />
        <path d="M4.25 7.5 8 3.75l3.75 3.75" />
      </g>
    </svg>
  );
}

/** The person's message: their words on the right in the composer's material, with its time, copy and rewind on hover. */
export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  const { sessionId, stuck } = useTimeline();
  const canRewind = useStore((s) => !!s.data[sessionId]?.caps?.features.rewind);
  const idle = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'idle' || st === 'error';
  });
  const [open, setOpen] = useState(false);
  const [restore, setRestore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The hover actions (time, copy, again, rewind) are not part of the frames a sent message lands
  // in: a row that mounts while a send is in the air builds them once it has landed.
  const [actions, setActions] = useState(() => !sendInAir());
  useEffect(() => (actions ? undefined : afterSend(() => setActions(true))), [actions]);

  const queued = item.state === 'queued';
  const images = item.attachments?.filter((a) => a.kind === 'image' && a.dataUrl) ?? [];
  const files = item.attachments?.filter((a) => !(a.kind === 'image' && a.dataUrl)) ?? [];
  // A review sent from the review bar: what was typed, then the comments as a short list. Wrappers
  // the agent's harness added to the words (a reminder) are not shown.
  const text = useMemo(() => stripWrappers(item.text), [item.text]);
  const review = useMemo(() => parseReview(text), [text]);
  const words = review ? review.lead : text;
  const long = isLongMessage(words);

  // The message sent from the composer (or a queue row) lands here: it flies in as this bubble and the two swap.
  const root = useRef<HTMLDivElement>(null);
  const queuedNow = useRef(queued);
  queuedNow.current = queued;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // A steered message the agent has just taken is put back where the agent took it (the bridge
    // takes its row out and adds it again, user-card.ts): the same message moving, not a new one.
    // It glides from where it stood and plays no entrance a second time (timeline.css
    // `.user[data-moved]`); the take's own beat, which the row that left could not play, plays here.
    const was = item.steered ? rowMoved(item.id, performance.now()) : null;
    if (was) {
      el.setAttribute('data-moved', '');
      const card = el.querySelector<HTMLElement>('.user-card');
      const now = card?.getBoundingClientRect();
      const z = uiZoom();
      const dx = now ? (was.left - now.left) / z : 0;
      const dy = now ? glideOffset(was.top, now.top, shiftOf(el, stuck.current) * z) / z : 0;
      // The whole row travels (its mark beside the card with it), from where the card stood.
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) play(el, [{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` }, { transform: 'translate(0px, 0px)' }], { duration: MOVE_GLIDE_MS, easing: EASE_OUT });
      if (was.queued && !queued) fieldBeat('pulse', card, 0.6);
    } else if (item.text) landInTimeline(el, item.text, { steer: item.steered, session: sessionId, ts: item.ts });
    if (!item.steered) return;
    // Only a steered message ever moves: where its card stands is read as its row leaves.
    return () => {
      const card = el.querySelector('.user-card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      if (r.width) rowLeft(item.id, { left: r.left, top: r.top, queued: queuedNow.current }, performance.now());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The agent takes a waiting steer: the bridge moves it to where it was taken, and the window makes
  // that one update (store.ts, `moved`). The row stays this element, so nothing is entered twice, but
  // its card would stand in its new place within a frame. Where it stands is read the moment the store
  // says so, before the list is laid out again, and the row glides from there.
  const stoodAt = useRef<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!item.steered || !queued) return;
    return useStore.subscribe((s, prev) => {
      const roots = s.data[sessionId]?.roots;
      const before = prev.data[sessionId]?.roots;
      if (!willMove(item.id, before, roots)) return;
      const r = root.current?.querySelector('.user-card')?.getBoundingClientRect();
      if (r?.width) stoodAt.current = { left: r.left, top: r.top };
    });
  }, [queued, item.steered, item.id, sessionId]);
  useLayoutEffect(() => {
    const was = stoodAt.current;
    const el = root.current;
    if (!was || !el) return;
    stoodAt.current = null;
    const now = el.querySelector('.user-card')?.getBoundingClientRect();
    if (!now) return;
    const z = uiZoom();
    const dx = (was.left - now.left) / z;
    const dy = glideOffset(was.top, now.top, shiftOf(el, stuck.current) * z) / z;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) play(el, [{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` }, { transform: 'translate(0px, 0px)' }], { duration: MOVE_GLIDE_MS, easing: EASE_OUT });
  });

  // A steer the agent has just taken: the card comes out of its waiting tone into the turn, and
  // the light answers once from it.
  const wasQueued = useRef(queued);
  useEffect(() => {
    if (wasQueued.current && !queued && item.steered) {
      const card = root.current?.querySelector('.user-card');
      play(card, [{ opacity: 0.6, transform: 'scale(0.985)', offset: 0 }, { opacity: 1, transform: 'scale(1.012)', offset: 0.45 }, { opacity: 1, transform: 'scale(1)' }], { duration: 420, easing: EASE_OUT });
      // A light runs down the wire, from the message into the turn, as the wire lets go (timeline.css).
      const wire = root.current?.querySelector<HTMLElement>('.user-wire');
      if (wire && !reducedMotion()) {
        const light = document.createElement('b');
        wire.appendChild(light);
        // Down the rule from the message into the turn.
        const run = play(light, [{ transform: 'translateY(-8px)', opacity: 0 }, { opacity: 0.9, offset: 0.2 }, { opacity: 0.9, offset: 0.7 }, { transform: `translateY(${wire.offsetHeight}px)`, opacity: 0 }], { duration: 420, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'both' });
        const gone = () => light.remove();
        if (run) run.finished.then(gone, gone);
        else gone();
      }
      fieldBeat('pulse', card, 0.6);
    }
    wasQueued.current = queued;
  }, [queued, item.steered]);

  const rewind = async () => {
    setBusy(true);
    const ok = await rewindTo(sessionId, item.id, restore);
    setBusy(false);
    if (ok) setOpen(false);
  };

  return (
    <div className="user" ref={root} data-queued={queued || undefined} data-open={open || undefined} data-steered={item.steered || undefined}>
      {item.steered && (
        // Steered into a running turn: a hairline ties the message to the turn it went into.
        <span className="user-wire" aria-hidden>
          <i />
        </span>
      )}
      {actions && (
        <div className="user-actions">
          {!queued && <Stamp ts={item.ts} prefix={item.steered ? 'Steered' : undefined} className="user-stamp" />}
          {text && <CopyButton text={text} label="Copy message" />}
          <MessageAgain item={item} />
          {canRewind && idle && !queued && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <IconButton icon="rewind" label="Rewind to here" size={14} tipSide="top" />
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" width={288} className="pop-pad rewind">
                <div className="rewind-title">Rewind to here</div>
                <p className="rewind-desc">The conversation goes back to just before this message. Everything after it is removed.</p>
                <label className="rewind-opt">
                  <span className="grow">
                    <span className="rewind-opt-name">Restore files</span>
                    <span className="rewind-opt-hint">Undo edits made after this point</span>
                  </span>
                  <Switch checked={restore} onChange={setRestore} label="Restore files" />
                </label>
                <div className="rewind-foot">
                  <PopoverClose asChild>
                    <button type="button" className="btn btn-sm btn-ghost">
                      Cancel
                    </button>
                  </PopoverClose>
                  <button type="button" className="btn btn-sm" onClick={rewind} disabled={busy}>
                    <Icon name="rewind" size={13} />
                    Rewind
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}
      {item.steered && (
        // Steered into a running turn: a small mark beside the card, the steer key's own arrow
        // leaning into the turn, named on hover. The card itself stays a plain message.
        <Tip label={queued ? 'Sent while it worked, not taken yet' : 'Sent while it worked'} side="left">
          <span className="user-steer" tabIndex={0} role="img" aria-label={queued ? 'Sent while it worked, not taken yet' : 'Sent while it worked'} data-waiting={queued || undefined}>
            <SteerMark />
          </span>
        </Tip>
      )}
      <div className="user-card">
        {item.steered ? null : item.remote ? (
          // Sent from elsewhere (Remote Control in the Claude app or on claude.ai).
          <span className="user-mark">
            <Icon name="phone" size={11} />
            From the Claude app
          </span>
        ) : (
          queued && (
            <span className="user-mark" data-waiting>
              <Icon name="queue" size={11} />
              Queued
            </span>
          )
        )}
        {images.length > 0 && (
          <div className="user-images">
            {images.map((a) => (
              <ImageView key={a.id} src={a.dataUrl!} alt={a.name} className="user-thumb">
                <img src={a.dataUrl} alt="" loading="lazy" />
              </ImageView>
            ))}
          </div>
        )}
        {words && (
          <div className="user-text" data-clipped={(long && !expanded) || undefined}>
            {words}
          </div>
        )}
        {review && <ReviewComments review={review} />}
        {long && (
          <button type="button" className="user-more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Show more'}
            <Icon name={expanded ? 'caret-up' : 'caret-down'} size={11} weight="bold" />
          </button>
        )}
        {files.length > 0 && (
          <div className="user-files">
            {files.map((a) => (
              <span key={a.id} className="user-file" title={a.path ?? a.name}>
                <Icon name={a.kind === 'image' ? 'image' : a.kind === 'text' ? 'clipboard' : 'file-text'} size={14} />
                <span className="truncate">{a.name}</span>
                {a.size != null && <span className="user-file-size">{formatBytes(a.size)}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
