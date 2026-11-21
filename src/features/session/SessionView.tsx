import { useEffect, useRef, useState } from 'react';
import { Backdrop } from '@/art/Backdrop';
import { Composer } from '@/features/composer/Composer';
import { PromptDock } from '@/features/prompts/PromptDock';
import { Timeline } from '@/features/timeline/Timeline';
import { afterSend } from '@/features/composer/settle';
import { EASE_OUT, play } from '@/lib/motion';
import { useStore } from '@/state/store';
import { DOCK_GLIDE_MS } from './dock-glide';
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
    let was = 0;
    let strip: Element | null = null;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      host.style.setProperty('--dock-h', `${h}px`);
      // A card arriving under the task strip, or leaving: the strip stood at the dock's upper edge
      // and jumped the card's height in one frame. It glides there instead (the conversation does
      // the same, Timeline.tsx). Only a strip that was already in view, never one that is entering.
      const now = el.querySelector(':scope > .dock-inner > .pd-slot[data-slot="tasks"]');
      const d = h - was;
      if (was && now && now === strip && Math.abs(d) > 24 && Math.abs(d) < 900) play(now, [{ translate: `0 ${d}px` }, { translate: '0 0' }], { duration: DOCK_GLIDE_MS, easing: EASE_OUT });
      was = h;
      strip = now;
    });
    ro.observe(el);
    return () => ro.disconnect();
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
