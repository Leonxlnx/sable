import { useMemo } from 'react';
import { DEFAULT_ACCOUNT, type ProviderId, type RateLimit } from '@shared/protocol';
import { windowForModel } from '@shared/limit-windows';
import { modelNameById } from '@/lib/models';
import type { LimitLevel } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { clock } from './format';

export { windowModel } from '@shared/limit-windows';

/**
 * Which windows limit which model. A plan has windows for every model (the 5-hour one, the week of
 * all models, Codex's primary and secondary) and windows of one model (Claude's week of Opus or of
 * Fable, a Codex model's own limit). A session is held back only by the first kind and by the
 * window of its own model: another model's window at its cap stops sub-agents on that model, not
 * the chat.
 */

/** Whether a window holds back a model (by its id or its name); a window of every model always does. The bridge's rule (shared/limit-windows.ts). */
export function appliesTo(l: RateLimit, model: { id?: string; name?: string }): boolean {
  return windowForModel(l, model);
}

export interface ModelLimits {
  /** At or near its cap and holding back this model, tightest first. */
  own: RateLimit[];
  /** At or near its cap but another model's: shown, never as this session's level. */
  other: RateLimit[];
  /** This model's level: the windows of every model and its own. */
  level: LimitLevel;
  /** Another model's window is used up. */
  otherCap: boolean;
}

const NEAR = 80;
const live = (l: RateLimit, now: number) => !(l.resetsAt && l.resetsAt <= now);

export function modelLimits(limits: RateLimit[] | undefined, model: { id?: string; name?: string }, now = Date.now()): ModelLimits {
  const own: RateLimit[] = [];
  const other: RateLimit[] = [];
  for (const l of limits ?? []) {
    if (!live(l, now) || l.percent < NEAR) continue;
    (appliesTo(l, model) ? own : other).push(l);
  }
  const tight = (a: RateLimit, b: RateLimit) => b.percent - a.percent;
  own.sort(tight);
  other.sort(tight);
  const level: LimitLevel = own.some((l) => l.percent >= 100) ? 'cap' : own.length ? 'near' : undefined;
  return { own, other, level, otherCap: other.some((l) => l.percent >= 100) };
}

/** "Weekly · Fable" → "Fable weekly limit", "Weekly · all models" → "Weekly limit", "5-hour limit" as it is. */
export function limitTitle(label: string | undefined): string {
  if (!label) return 'Plan limit';
  const week = /^weekly\s*·\s*(.+)$/i.exec(label);
  if (week) return /^all models$/i.test(week[1].trim()) ? 'Weekly limit' : `${week[1].trim()} weekly limit`;
  const scoped = /^(.+?)\s*·\s*(.+)$/.exec(label);
  if (scoped) return `${scoped[1]} ${/limit$/i.test(scoped[2]) ? scoped[2].toLowerCase() : `${scoped[2].toLowerCase()} limit`}`;
  return /limit$/i.test(label) ? label : `${label} limit`;
}

/** "Fable weekly limit reached · resets Sat 00:00", "5-hour limit at 86% · resets 14:20". */
export function limitLine(l: Pick<RateLimit, 'label' | 'percent' | 'resetsAt'>, now = Date.now()): string {
  const state = l.percent >= 100 ? 'reached' : `at ${Math.round(l.percent)}%`;
  return `${limitTitle(l.label)} ${state}${l.resetsAt && l.resetsAt > now ? ` · resets ${clock(l.resetsAt, now)}` : ''}`;
}

const NO_LIMITS: RateLimit[] = [];

/** One session's account and model with the limits that matter to it. Re-renders only when they change. */
export function useSessionLimits(sessionId: string | undefined): (ModelLimits & { provider?: ProviderId; accountId: string; model?: string; modelId?: string }) | undefined {
  const provider = useStore((s) => (sessionId ? s.sessions[sessionId]?.provider : undefined));
  const accountId = useStore((s) => (sessionId ? s.sessions[sessionId]?.accountId : undefined)) ?? DEFAULT_ACCOUNT;
  const modelId = useStore((s) => (sessionId ? s.sessions[sessionId]?.model : undefined));
  const models = useStore((s) => (sessionId ? s.data[sessionId]?.caps?.models : undefined));
  const limits = useStore((s) => {
    if (!provider) return NO_LIMITS;
    const key = accountKey(provider, accountId);
    const known = s.limitReports[key]?.limits;
    return known?.length ? known : (s.limits[key] ?? NO_LIMITS);
  });
  return useMemo(() => {
    if (!provider) return undefined;
    const name = modelNameById(modelId, models);
    return { ...modelLimits(limits, { id: modelId, name }), provider, accountId, model: name, modelId };
  }, [provider, accountId, modelId, models, limits]);
}
