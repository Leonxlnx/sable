import { putAway } from '@/lib/dissolve';
import { reducedMotion } from '@/lib/motion';

/**
 * An answered card leaves in the frame of the answer, and the dock closes in that same frame.
 *
 * It used to wait for the bridge to take the request away (the pressed button for some hundred
 * ms), then fade where it stood, and only once it had gone did the dock lose its height: the task
 * strip hung in mid-air over the empty place before it came down. Now a dead copy of the card,
 * held by its lower edge, sinks and fades (`putAway`) while the card itself is out of the layout at
 * once, so the strip and the conversation start their glide (SessionView.tsx, Timeline.tsx) on the
 * frame the copy starts to go. Should the answer not be taken, the card comes back.
 */
export function leaveCard(requestId: string) {
  if (reducedMotion()) return;
  const slot = document.querySelector<HTMLElement>(`.pd-slot[data-req="${CSS.escape(requestId)}"]`);
  if (!slot) return;
  putAway(slot, 0, 8, 150, { anchor: 'bottom' });
  slot.style.display = 'none';
  window.setTimeout(() => slot.isConnected && (slot.style.display = ''), 4000);
}
