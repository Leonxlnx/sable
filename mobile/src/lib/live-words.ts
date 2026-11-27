import { useEffect, useState } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { workCounts, workLabel } from '@shared/work-label';
import { activityLine, doingLine, doingOf } from './note-live';
import { onScreen } from './screen';

/**
 * What a chat at work says about itself wherever it is listed (2.21: home's live rows, the chat's
 * header), from the bridge's reading of the running turn (`SessionMeta.live`, kinds and counts only):
 * what it does now in a few words ("Editing 3 files", "Running a command"), since when its turn runs,
 * its steps, the checkpoints it closed and the open one's steps. Without that reading (an older
 * desktop) the activity line's verb and no counts. Its own turn over and sub-agents or commands still
 * at work: what still works ("2 sub-agents working").
 */
export interface LiveWords {
  line: string;
  /** When the turn began (epoch ms), when the bridge said. */
  since?: number;
  steps: number;
  /** Checkpoints closed so far. */
  done: number;
  /** Steps of the open checkpoint. */
  open: number;
}

export function liveWords(s: Pick<SessionMeta, 'status' | 'activity' | 'live' | 'background' | 'commands' | 'serving' | 'until' | 'tracked' | 'trackedSince' | 'trackedTitle'>): LiveWords {
  const own = s.status === 'running' || s.status === 'starting';
  if (!own) {
    // The shared words (a single tracked job by its own title, "2 jobs running"), and since when the
    // work runs where the bridge says it: tracked jobs carry their start (`trackedSince`); sub-agents
    // and commands have none in the list, so a clock beside them would be the phone's own guess.
    const c = workCounts(s);
    const since = c.jobs > 0 && !c.agents && !c.commands && s.until?.phase !== 'checking' ? s.trackedSince : undefined;
    return { line: workLabel(s) ?? 'Working', ...(since ? { since } : {}), steps: 0, done: 0, open: 0 };
  }
  if (s.status === 'starting') return { line: 'Starting', steps: 0, done: 0, open: 0 };
  const l = s.live;
  if (!l) return { line: activityLine(s.activity), steps: 0, done: 0, open: 0 };
  return { line: doingLine(doingOf(l)), since: l.startedAt, steps: l.steps, done: l.checkpoints, open: l.checkpointSteps };
}

/** "4 steps", or "Checkpoint 3 · 2 steps" once one closed: how far the turn has come. */
export function stepsWords(w: LiveWords): string {
  if (!w.steps) return '';
  if (!w.done) return `${w.steps} ${w.steps === 1 ? 'step' : 'steps'}`;
  return `${w.done} ${w.done === 1 ? 'checkpoint' : 'checkpoints'} · ${w.steps} steps`;
}

/** A clock for a running turn: "0:42", "12:05", "1:02:10". */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** One clock a second while `on` and the screen is in view (lib/screen.ts: the page may be held visible off screen). */
export function useSecond(on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setT(Date.now());
    const id = window.setInterval(() => onScreen() && setT(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return t;
}
