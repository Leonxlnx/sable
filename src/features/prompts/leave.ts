import { putAway } from '@/lib/dissolve';
import { reducedMotion } from '@/lib/motion';
import { cueCardLeft } from '@/features/session/dock-glide';

/** The requests whose card the person's answer has taken out of the dock (bounded: the newest few). */
const out = new Set<string>();

/** Whether this request's card already left with the person's answer (PromptDock: its end then changes nothing). */
export const leftByAnswer = (requestId: string) => out.has(requestId);

/**
 * An answered card leaves in the frame of the answer, and the dock closes in that same frame.
 *
 * It used to wait for the bridge to take the request away (the pressed button for some hundred
 * ms), then fade where it stood, and only once it had gone did the dock lose its height: the task
 * strip hung in mid-air over the empty place before it came down. Now a dead copy of the card,
 * held by its lower edge, sinks and fades (`putAway`) while the card itself is out of the layout at
 * once. The conversation's end, which comes down into the card's room, is told (`cueCardLeft`): it
 * stands where it was drawn until the window draws on time again, then glides (Timeline.tsx). Should
 * the answer not be taken, the card comes back.
 */
export function leaveCard(requestId: string, back?: () => void) {
  const slot = document.querySelector<HTMLElement>(`.pd-slot[data-req="${CSS.escape(requestId)}"]`);
  // Still there after a while: the answer was not taken (the connection went). The card stands
  // again, and `back` lets it be answered again (it had locked itself against a second answer).
  window.setTimeout(() => {
    out.delete(requestId);
    if (slot && !slot.isConnected) return;
    if (slot) slot.style.display = '';
    back?.();
  }, RETURN_MS);
  if (!slot || reducedMotion()) return;
  putAway(slot, 0, 8, 150, { anchor: 'bottom' });
  slot.style.display = 'none';
  out.add(requestId);
  if (out.size > 16) out.delete(out.values().next().value as string);
  cueCardLeft();
}

/** How long an answered card stays away before it is taken as not answered. */
export const RETURN_MS = 4000;
