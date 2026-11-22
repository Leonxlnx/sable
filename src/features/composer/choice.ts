import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_ACCOUNT, STANDARD_SPEED, type Capabilities, type Effort, type ModeInfo, type ModelInfo, type ProviderId, type SpeedInfo } from '@shared/protocol';
import { defaultableSpeeds, isPaidSpeed, modelNameById, modelSpeeds, offeredSpeeds, speedFor, visibleModels } from '@/lib/models';
import { useLimitsReport } from '@/state/hooks';
import { homeAccountId, setEffort as setSessionEffort, setMode as setSessionMode, setModel as setSessionModel, setSettings, setSpeed as setSessionSpeed } from '@/state/actions';
import { useShallow } from 'zustand/react/shallow';
import { useCapsState } from '@/state/hooks';
import { useStore } from '@/state/store';
import { rememberCaps, seenCaps } from './caps-seen';

// ── the effort last used with each model (per browser), so picking a model brings it back ──

const EFFORT_KEY = 'sable.modelEffort.v1';
let remembered: Record<string, Effort> | null = null;

function efforts(): Record<string, Effort> {
  if (remembered) return remembered;
  try {
    remembered = JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, Effort>;
  } catch {
    remembered = {};
  }
  return remembered;
}

export function rememberedEffort(provider: ProviderId, model: ModelInfo): Effort | undefined {
  const e = efforts()[`${provider}:${model.id}`];
  return e && model.efforts?.includes(e) ? e : undefined;
}

function remember(provider: ProviderId, modelId: string, effort: Effort) {
  const next = { ...efforts(), [`${provider}:${modelId}`]: effort };
  remembered = next;
  try {
    localStorage.setItem(EFFORT_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

export interface Choice {
  provider: ProviderId;
  /** The account the caps come from (the session's, or the home choice). */
  accountId: string | undefined;
  caps: Capabilities | undefined;
  /** The caps are still on their way (show a placeholder); false once they arrived or failed for good. */
  capsPending: boolean;
  /** What the model menu lists: the visible models plus the one in use. */
  models: ModelInfo[];
  model?: ModelInfo;
  modelId?: string;
  /** The model's display name ("Fable 5.2"; an alias reads as what it resolves to). */
  modelLabel?: string;
  effort?: Effort;
  /** The effort was picked (not the model's default standing in). */
  effortChosen: boolean;
  mode?: ModeInfo;
  /** Picks a model with an effort: the one given, else the one last used with it, else the current one when it fits. */
  pickModel: (id: string, effort?: Effort) => void;
  setEffort: (e: Effort) => void;
  /** Home only: back to the model's default effort. */
  clearEffort?: () => void;
  setMode: (id: string) => void;
  /** The session this choice is for (null on home). */
  sessionId: string | null;
  /** Speeds offered beyond standard (empty: no Speed row); a paid one only in a session with extra usage on. */
  speeds: SpeedInfo[];
  /** The speed in use (`standard` when none beyond it is on). */
  speed: string;
  setSpeed: (id: string) => void;
}

const NO_MODELS: ModelInfo[] = [];

/** A session's choices picked here and not yet confirmed by the bridge. */
interface Picked {
  model?: string;
  effort?: Effort;
  mode?: string;
}

/** What this agent offers under this account in some folder already asked about (the first found; undefined when none). */
export function capsFromAnywhere(all: Record<string, Capabilities>, provider: ProviderId, accountId: string | undefined): Capabilities | undefined {
  const head = `${provider}:`;
  const extra = accountId && accountId !== DEFAULT_ACCOUNT ? `@${accountId}` : '';
  for (const key in all) {
    if (!key.startsWith(head)) continue;
    // Keys read `provider:folder` or `provider:folder@account` (state/store.ts `capsKey`).
    if (extra ? key.endsWith(extra) : !/@[\w-]+$/.test(key)) return all[key];
  }
  return undefined;
}

/**
 * What the composer would use: the session's current model/effort/mode, or on the
 * home screen the choices for the next session (same rules as `homeChoice()`).
 */
export function useChoice(sessionId: string | null): Choice {
  const { caps: ownCaps, failed: capsFailed } = useCapsState(sessionId);
  // The fields a choice reads, compared shallowly: usage ticks while streaming change the session, not these.
  const meta = useStore(
    useShallow((s) => {
      const m = sessionId ? s.sessions[sessionId] : undefined;
      return m ? { provider: m.provider, accountId: m.accountId, model: m.model, effort: m.effort, mode: m.mode, speed: m.speed } : undefined;
    }),
  );
  const homeProvider = useStore((s) => s.ui.homeProvider);
  const provider = meta?.provider ?? homeProvider;
  const accountId = useStore((s) => (meta ? meta.accountId : homeAccountId(provider, s)));
  // A chat's own folder is new to the agent, and asking what it offers there takes as long as an
  // agent start: until that answers, the same agent and account's answer from any other folder
  // (the same models, modes and efforts) fills the controls. They never fall back to skeletons
  // under a card that showed them a moment ago on the home screen.
  const lentCaps = useStore((s) => (ownCaps ? undefined : capsFromAnywhere(s.providerCaps, provider, accountId)));
  const told = ownCaps ?? lentCaps;
  // Before the agent has answered at all (a chat that opens right after start-up, home's first
  // frame): what it said last time (caps-seen.ts). The last line then names the mode, the model
  // and the effort at once; an agent never seen on this machine has nothing here yet.
  const caps = told ?? seenCaps(provider, accountId);
  useEffect(() => {
    if (told) rememberCaps(provider, accountId, told);
  }, [told, provider, accountId]);
  const capsPending = !caps && !capsFailed;
  const homeModel = useStore((s) => s.ui.homeModel[provider] ?? s.settings.defaultModels[provider]);
  const homeMode = useStore((s) => s.ui.homeMode[provider] ?? s.settings.defaultModes[provider]);
  const homeEffort = useStore((s) => s.ui.homeEffort[provider] ?? s.settings.defaultEfforts[provider]);
  const visibility = useStore((s) => s.settings.modelVisibility);
  // Home: the speed new sessions start with (the agent's default in settings).
  const homeSpeed = useStore((s) => s.settings.defaultSpeeds?.[provider]);

  // What was just picked in a session and is still on its way to the bridge. The chips show it at
  // once (a label never waits on a round trip, and Shift+Tab pressed twice moves two modes on); it
  // is dropped when the session says the same, or after a few seconds when it never does.
  const [picked, setPicked] = useState<Picked | null>(null);
  useEffect(() => setPicked(null), [sessionId]);
  useEffect(() => {
    if (!picked) return;
    if (!meta) return setPicked(null);
    const left: Picked = {};
    if (picked.model !== undefined && picked.model !== meta.model) left.model = picked.model;
    if (picked.effort !== undefined && picked.effort !== meta.effort) left.effort = picked.effort;
    if (picked.mode !== undefined && picked.mode !== meta.mode) left.mode = picked.mode;
    const n = Object.keys(left).length;
    if (n !== Object.keys(picked).length) return setPicked(n ? left : null);
    const t = window.setTimeout(() => setPicked(null), 4000);
    return () => window.clearTimeout(t);
  }, [picked, meta]);

  const all = caps?.models ?? NO_MODELS;
  const modelId = meta ? (picked?.model ?? meta.model) : (homeModel ?? all.find((m) => m.isDefault)?.id ?? all[0]?.id);
  const model = all.find((m) => m.id === modelId);
  const models = useMemo(() => visibleModels(provider, all, visibility, modelId), [provider, all, visibility, modelId]);
  const modeId = meta ? (picked?.mode ?? meta.mode) : (homeMode ?? caps?.modes[0]?.id);
  const mode = caps?.modes.find((m) => m.id === modeId);
  // No choice anywhere and no model default means the agent picks: show none rather than invent one.
  let effort = meta ? (picked?.effort ?? meta.effort) : homeEffort;
  const effortChosen = !!(effort && model?.efforts?.includes(effort));
  if (model?.efforts?.length && (!effort || !model.efforts.includes(effort))) effort = model.defaultEffort;
  if (model && !model.efforts?.length) effort = undefined;

  const write = useCallback(
    (id: string | undefined, e: Effort | undefined) => {
      if (sessionId) {
        if (id || e) setPicked((p) => ({ ...p, ...(id ? { model: id } : null), ...(e ? { effort: e } : null) }));
        if (id) void setSessionModel(sessionId, id).then(() => e && setSessionEffort(sessionId, e));
        else if (e) void setSessionEffort(sessionId, e);
        return;
      }
      const s = useStore.getState();
      s.setUi({
        ...(id ? { homeModel: { ...s.ui.homeModel, [provider]: id } } : {}),
        ...(e ? { homeEffort: { ...s.ui.homeEffort, [provider]: e } } : {}),
      });
    },
    [sessionId, provider],
  );

  const pickModel = useCallback(
    (id: string, chosen?: Effort) => {
      const next = all.find((m) => m.id === id);
      const fits = (e: Effort | undefined) => (e && next?.efforts?.includes(e) ? e : undefined);
      const e = fits(chosen) ?? (next ? rememberedEffort(provider, next) : undefined) ?? fits(effort) ?? next?.defaultEffort;
      if (chosen && fits(chosen)) remember(provider, id, chosen);
      write(id === modelId ? undefined : id, e && e !== effort ? e : id !== modelId ? e : undefined);
    },
    [all, provider, effort, modelId, write],
  );

  const setEffort = useCallback(
    (e: Effort) => {
      if (modelId) remember(provider, modelId, e);
      write(undefined, e);
    },
    [provider, modelId, write],
  );

  const setMode = useCallback(
    (id: string) => {
      if (sessionId) {
        setPicked((p) => ({ ...p, mode: id }));
        void setSessionMode(sessionId, id);
      } else {
        const s = useStore.getState();
        s.setUi({ homeMode: { ...s.ui.homeMode, [provider]: id } });
      }
    },
    [sessionId, provider],
  );

  const clearEffort = useCallback(() => {
    const s = useStore.getState();
    const next = { ...s.ui.homeEffort };
    delete next[provider];
    s.setUi({ homeEffort: next });
  }, [provider]);

  // A paid speed (Claude's fast mode, billed as extra usage) is listed only in a session whose
  // account has extra usage on; home sets the default for new sessions, which a paid speed never is.
  const report = useLimitsReport(provider, accountId);
  const extraOn = !!report?.extra?.enabled;
  const speeds = useMemo(() => (sessionId ? offeredSpeeds(model, extraOn) : defaultableSpeeds(model)), [sessionId, model, extraOn]);
  const raw = speedFor(model, meta ? meta.speed : homeSpeed);
  // A paid speed already on stays visible (so it can be turned off) even if the report has not arrived.
  const speed = speeds.some((s) => s.id === raw) || (meta && isPaidSpeed(modelSpeeds(model).find((s) => s.id === raw))) ? raw : STANDARD_SPEED;
  const shownSpeeds = useMemo(() => (speed !== STANDARD_SPEED && !speeds.some((s) => s.id === speed) ? [...speeds, ...modelSpeeds(model).filter((s) => s.id === speed)] : speeds), [speeds, speed, model]);
  const setSpeed = useCallback(
    (id: string) => {
      if (sessionId) void setSessionSpeed(sessionId, id);
      else void setSettings({ defaultSpeeds: { ...useStore.getState().settings.defaultSpeeds, [provider]: id === STANDARD_SPEED ? undefined : id } });
    },
    [sessionId, provider],
  );

  const modelLabel = modelNameById(modelId, all);
  // One object per distinct choice, so memoized controls skip renders when only the draft changed.
  return useMemo(
    () => ({ provider, accountId, sessionId, caps, capsPending, models, model, modelId, modelLabel, effort, effortChosen, mode, pickModel, setEffort, clearEffort: sessionId ? undefined : clearEffort, setMode, speeds: shownSpeeds, speed, setSpeed }),
    [provider, accountId, caps, capsPending, models, model, modelId, modelLabel, effort, effortChosen, mode, pickModel, setEffort, clearEffort, sessionId, setMode, shownSpeeds, speed, setSpeed],
  );
}
