import type { AgentLeg, NoticeItem, ProviderId, SessionMeta, TimelineItem } from '../../shared/protocol';
import { worksInBackground } from '../../shared/background';

/**
 * Switching a chat's agent in place (`session.switchAgent`): pure helpers for the agents a chat has
 * run with (`SessionMeta.agents`), the switch lines in its timeline and the handover the next
 * message carries. Each agent keeps its own conversation: switching back resumes it, and only what
 * happened since it was left is handed over.
 */

/** The current agent's entry as it stands now, covering the conversation up to `knows`. */
export function legOf(meta: SessionMeta, knows: string | undefined): AgentLeg {
  const leg: AgentLeg = { provider: meta.provider, model: meta.model, mode: meta.mode };
  if (meta.providerSessionId) leg.providerSessionId = meta.providerSessionId;
  leg.cwd = meta.cwd;
  if (meta.effort) leg.effort = meta.effort;
  if (meta.accountId) leg.accountId = meta.accountId;
  if (meta.speed) leg.speed = meta.speed;
  if (meta.ultracode) leg.ultracode = true;
  if (meta.options && Object.keys(meta.options).length) leg.options = { ...meta.options };
  if (meta.usage.contextTokens !== undefined || meta.usage.contextWindow !== undefined) leg.context = { tokens: meta.usage.contextTokens, window: meta.usage.contextWindow };
  if (knows) leg.knows = knows;
  return leg;
}

/** The entries with `leg` in place of its agent's (one entry per agent). */
export function withLeg(legs: AgentLeg[] | undefined, leg: AgentLeg): AgentLeg[] {
  const out = (legs ?? []).filter((l) => l.provider !== leg.provider);
  out.push(leg);
  return out;
}

const isRoot = (i: TimelineItem) => !i.parentId;

/** The latest switch line in the timeline. */
export function lastSwitch(items: TimelineItem[]): NoticeItem | undefined {
  return items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.agentSwitch && isRoot(i));
}

/**
 * The switch line a switch to `target` undoes: the latest switch, from `target` to the agent the
 * chat runs with now, with nothing sent since. Undefined when the switch is a new one.
 */
export function undoableSwitch(items: TimelineItem[], current: ProviderId, target: ProviderId): NoticeItem | undefined {
  const last = lastSwitch(items);
  if (!last?.agentSwitch || last.agentSwitch.to !== current || last.agentSwitch.from !== target) return undefined;
  const at = items.indexOf(last);
  return items.slice(at + 1).some((i) => isRoot(i) && i.type === 'user') ? undefined : last;
}

/** The root item before `id` (undefined when it is the first, or not there). */
export function rootBefore(items: TimelineItem[], id: string): string | undefined {
  const at = items.findIndex((i) => i.id === id);
  for (let i = at - 1; i >= 0; i--) if (isRoot(items[i])) return items[i].id;
  return undefined;
}

/** The items after `since` (all of them when it is absent, or no longer there). */
export function itemsSince(items: TimelineItem[], since: string | undefined): TimelineItem[] {
  if (!since) return items;
  const at = items.findIndex((i) => i.id === since);
  return at < 0 ? items : items.slice(at + 1);
}

/**
 * The agents that worked in `range` (someone sent them a message), oldest first: the agent before
 * each switch line, and `current` after the last one. Used to name them in a handover.
 */
export function workedIn(range: TimelineItem[], before: ProviderId): ProviderId[] {
  const out: ProviderId[] = [];
  let active = before;
  let sent = false;
  const close = () => {
    if (sent && !out.includes(active)) out.push(active);
    sent = false;
  };
  for (const it of range) {
    if (!isRoot(it)) continue;
    if (it.type === 'user') sent = true;
    else if (it.type === 'notice' && it.agentSwitch) {
      active = it.agentSwitch.from;
      close();
      active = it.agentSwitch.to;
    }
  }
  close();
  return out;
}

/** Sub-agents or workflows still running in the background (they live in the agent's process). */
export function backgroundRunning(items: TimelineItem[]): boolean {
  return items.some(worksInBackground);
}
