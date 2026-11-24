import { PROVIDER_NAME, ProviderMark } from '@/art/Logo';
import { statusLabel, statusTone } from '@/features/sidebar/status';
import { useStore } from '@/state/store';
import { Tip } from '@/ui';
import type { ProviderId } from '@shared/protocol';
import './work-mark.css';

/**
 * The session header's agent mark, which says when the chat is at work: a thin arc turns round the
 * mark while its turn runs, an /until check runs, or sub-agents, workflows or background commands it
 * started still work (the sidebar's rule, `statusTone` in sidebar/status.ts). Drawn round the mark,
 * out of the layout, so the title and the crumbs never move when a turn starts or ends; it fades in
 * and out by opacity. Ink like the sidebar's working ring, never amber or red. The tooltip says what
 * works ("Editing app.ts · 2 sub-agents", "1 command running").
 */
export function AgentWorkMark({ sessionId, provider }: { sessionId: string; provider: ProviderId }) {
  // Only what the mark shows: activity ticks that leave the words alone render nothing.
  const label = useStore((s) => {
    const m = s.sessions[sessionId];
    return m && statusTone(m) === 'working' ? (statusLabel(m) ?? 'Working') : '';
  });
  const mark = (
    <span className="tb-agent" data-working={label ? '' : undefined} role={label ? 'status' : undefined} aria-label={label || undefined}>
      <ProviderMark provider={provider} size={15} />
      <svg className="tb-agent-arc" viewBox="0 0 22 22" width="22" height="22" aria-hidden>
        <circle cx="11" cy="11" r="10.25" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" />
        <circle cx="11" cy="11" r="10.25" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" pathLength={360} strokeDasharray="70 360" />
      </svg>
    </span>
  );
  // At rest the tooltip names the agent; the element stays the same, so the arc fades rather than pops.
  return <Tip label={label || PROVIDER_NAME[provider]}>{mark}</Tip>;
}
