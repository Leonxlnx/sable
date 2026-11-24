import { useEffect, useRef, useState } from 'react';
import { Backdrop } from '@/art/Backdrop';
import { Composer } from '@/features/composer/Composer';
import { PromptDock } from '@/features/prompts/PromptDock';
import { Timeline } from '@/features/timeline/Timeline';
import { afterSend } from '@/features/composer/settle';
import { useStore } from '@/state/store';
import { ConversationFind } from './FindBar';
import { useStaged } from './staged';
import './session.css';

/**
 * One conversation: the timeline. The band of light under it lives one level up (`SessionLight`),
 * like the dock (`SessionDock`): moving between sessions dissolves the conversation while the
 * light and the composer stay where they are.
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  // Only what the view needs: usage ticks while streaming must not re-render the whole view.
  const status = useStore((s) => s.sessions[sessionId]?.status);
  // Under a first message in the air only the conversation mounts; the find bar follows the landing.
  const extras = useStaged('landed');
  if (!status) return null;
  return (
    <div className="session" data-status={status}>
      <Timeline sessionId={sessionId} />
      {extras && <ConversationFind sessionId={sessionId} />}
    </div>
  );
}

/**
 * A low band of light under the conversation that breathes with the agent (a little brighter and
 * faster while it works, amber while it waits on you). One instance for every session (App keeps
 * it mounted across switches): a switch changes its colour and pace, the field is never rebuilt.
 */
export function SessionLight({ sessionId }: { sessionId: string }) {
  const provider = useStore((s) => s.sessions[sessionId]?.provider);
  const status = useStore((s) => s.sessions[sessionId]?.status);

  // The band is not needed for the first paint: it starts in idle time and fades in, and after a
  // sent message has landed (its field starting up is not part of the send's frames).
  const [light, setLight] = useState(false);
  useEffect(() => {
    let t = 0;
    let id = 0;
    const off = afterSend(() => {
      if (typeof requestIdleCallback !== 'function') t = window.setTimeout(() => setLight(true), 120);
      else id = requestIdleCallback(() => setLight(true), { timeout: 180 });
    });
    return () => {
      off();
      window.clearTimeout(t);
      if (id) cancelIdleCallback(id);
    };
  }, []);

  if (!provider || !status) return null;
  return <div className="session-light" data-status={status}>{light && <Backdrop surface="session" provider={provider} status={status} />}</div>;
}

/**
 * How high above the dock's bottom edge the composer's cove begins (the pane's lower edge plus its
 * `--cove-cut`), read from the layout, never from a drawn box: the composer may be gliding in. The
 * conversation ends there (timeline.css `.tl-scroll` clip): nothing of it shows in the cove round
 * the send key or beside the pane's lower corners. 0 when there is no composer.
 */
function coveTop(dock: HTMLElement): number {
  const card = dock.querySelector<HTMLElement>('.cmp-card');
  if (!card) return 0;
  let top = 0;
  for (let n: HTMLElement | null = card; n && n !== dock; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;
  const cut = parseFloat(getComputedStyle(card).getPropertyValue('--cove-cut')) || 0;
  return Math.max(0, dock.offsetHeight - top - card.offsetHeight) + cut;
}

/**
 * What waits above the conversation's end: the prompt cards and the composer. One instance for
 * every session (App keeps it mounted across switches); its contents follow the session.
 */
export function SessionDock({ sessionId }: { sessionId: string }) {
  const dock = useRef<HTMLDivElement>(null);
  const exists = useStore((s) => !!s.sessions[sessionId]);
  // The first message from home: the card flying to the dock stands in for the composer, which
  // mounts a frame after the conversation (its own task), the prompt cards after the landing.
  const composer = useStaged('soon');
  const cards = useStaged('landed');

  // The timeline pads its end by the dock's height so nothing hides behind the glass. Set on the
  // stage body, which holds both the conversation and the dock.
  useEffect(() => {
    const el = dock.current;
    const host = el?.closest<HTMLElement>('.stage-body');
    if (!el || !host) return;
    // The task strip is the composer's own (Composer.tsx `TaskSlot`): a card arriving above it
    // moves nothing of the stack, which stands on the dock's bottom edge.
    const ro = new ResizeObserver(() => {
      host.style.setProperty('--dock-h', `${el.offsetHeight}px`);
      host.style.setProperty('--dock-cut', `${coveTop(el)}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      // No dock, no cove: a view without one (a race) keeps its whole conversation.
      host.style.removeProperty('--dock-cut');
    };
  }, [exists]);

  if (!exists) return null;
  return (
    <div className="dock" ref={dock}>
      <div className="dock-inner">
        {cards && <PromptDock key={`p:${sessionId}`} sessionId={sessionId} />}
        {composer && <Composer key={sessionId} sessionId={sessionId} variant="session" autoFocus />}
      </div>
    </div>
  );
}
