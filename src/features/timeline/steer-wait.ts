/**
 * A message steered into a running turn that the agent has not taken yet: what the one line under
 * its card says (User.tsx `SteerWait`; the phone's `SteerNote` in mobile/src/screens/Timeline.tsx
 * reads the same model). Pure: the line is a function of the card, the steps under way and the time.
 *
 * The agent takes a steered message between two steps, so the message waits on whatever step runs in
 * the foreground: the line names it and says how long it has run. Where the bridge can interrupt for
 * the message (`UserItem.steerWait`: Claude Code) the line offers "Send now", and when the bridge
 * will send by itself (`steerWait.autoAt`, `AppSettings.steerAfterMs`) it counts down to that. When
 * the bridge tried and the message still waits, it says why in the bridge's own words
 * (`steerWait.reason`: a recall the agent did not answer, a refusal, the limit of its own tries).
 */
import { runsTask, worksInBackground } from '@shared/background';
import type { TimelineItem, ToolItem, UserItem } from '@shared/protocol';

/** The card the line stands under: a root message steered into a turn and not taken yet. */
export const waitsAsSteer = (it: TimelineItem | undefined): it is UserItem => !!it && it.type === 'user' && !it.parentId && it.steered === true && it.state === 'queued';

/** How far back from the conversation's end the running turn is looked through. */
const LOOK = 600;

/**
 * The steps a steer waits on, the newest first: root steps of the running turn that are under way
 * (running, pending, or waiting for an approval). Not a turn check, not work that goes on in the
 * background (a sub-agent sent there, a workflow, a command or monitor that outlived its step): the
 * agent reads messages while those run. The walk ends where the turn began: at the turn before it,
 * or at the newest message the agent took (it takes one between steps, so nothing before it runs).
 */
export function foregroundSteps(item: (id: string) => TimelineItem | undefined, roots: readonly string[]): ToolItem[] {
  const out: ToolItem[] = [];
  for (let i = roots.length - 1, n = 0; i >= 0 && n < LOOK; i--, n++) {
    const it = item(roots[i]);
    if (!it) continue;
    if (it.type === 'turn' || (it.type === 'user' && it.state !== 'queued')) break;
    if (it.type !== 'tool' || it.parentId || it.check) continue;
    if (it.status !== 'running' && it.status !== 'pending' && it.status !== 'awaiting') continue;
    if (worksInBackground(it) || runsTask(it)) continue;
    out.push(it);
  }
  return out;
}

/**
 * The steps the line names: the one the bridge says the message waits on (`steerWait.stepId`) first,
 * then what the window finds under way by the same rule. The bridge's word wins where both know one.
 */
export function waitingOn(item: (id: string) => TimelineItem | undefined, roots: readonly string[], stepId?: string): ToolItem[] {
  const found = foregroundSteps(item, roots);
  const named = stepId ? item(stepId) : undefined;
  if (named?.type !== 'tool') return found;
  return [named, ...found.filter((s) => s.id !== named.id)];
}

/**
 * The earliest time the bridge sends by itself among the steers that wait in the running turn. Its
 * send at that first time delivers every waiting message it may still interrupt for, oldest first,
 * so each of their lines counts down to it: a second message sent ten seconds later goes with the
 * first, not ten seconds on. A card whose own tries are spent is left out of that send and does not
 * count down to it (`steerWaitLine`, `capped`).
 */
export function firstAutoAt(item: (id: string) => TimelineItem | undefined, roots: readonly string[]): number | undefined {
  let at: number | undefined;
  for (let i = roots.length - 1, n = 0; i >= 0 && n < LOOK; i--, n++) {
    const it = item(roots[i]);
    if (!it) continue;
    if (it.type === 'turn') break;
    const own = waitsAsSteer(it) ? it.steerWait?.autoAt : undefined;
    if (typeof own === 'number' && Number.isFinite(own) && (at === undefined || own < at)) at = own;
  }
  return at;
}

/**
 * "8s", "1m 12s", "1h 5m": whole seconds, in the live line's words. One difference: a whole minute
 * keeps its seconds ("2m 0s", where the live line says "2m"), so this clock, which stands in a room
 * of its own on a right-aligned line, never drops four characters for one second and takes them back.
 */
export function waitedWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The widest a clock of this size gets ("59s" under a minute, "9m 59s" under ten, …). The line
 * stands on the card's right edge, so a clock that grew and shrank by its own words would push the
 * label left and right as it ticks: the clock keeps room for its widest form (at most one character
 * more than it shows, within a minute or an hour) and the label never moves.
 */
export function waitedRoom(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return '59s';
  if (s < 600) return '9m 59s';
  if (s < 3600) return '59m 59s';
  return `${'9'.repeat(String(Math.floor(s / 3600)).length)}h 59m`;
}

/** "0:24", "1:54": what is left until the bridge sends by itself, rounded up to whole seconds. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * How long after its own time the bridge's send may still be under way (it recalls the message,
 * interrupts, waits for the old turn to settle, then delivers). Past that the line stops saying
 * "Sending" and offers the action again, so a try that did not deliver never leaves the card stuck.
 */
export const AUTO_GRACE_MS = 15_000;

/** The longest reason the line takes from the bridge; a longer one is cut (it is an error's own text). */
const REASON_MAX = 160;

/**
 * Why a message still waits, in the bridge's words (`steerWait.reason` on a waiting card, and on a
 * queued message that came back from one): one line, bounded; '' when the bridge gave none.
 */
export function waitReason(wait: UserItem['steerWait']): string {
  const raw = wait?.reason;
  if (typeof raw !== 'string') return '';
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1).trimEnd()}…` : one;
}

export interface SteerWaitInput {
  /** The waiting card. */
  item: Pick<UserItem, 'ts' | 'steerWait'>;
  /** What it waits on (`waitingOn`), the step to name first. */
  steps: readonly Pick<ToolItem, 'title' | 'ts'>[];
  /** The agent's name ("Claude Code"), for a wait on no step that is known. */
  agent?: string;
  /** When the bridge sends the waiting messages by itself (`firstAutoAt`); absent: the card's own time. */
  autoAt?: number;
  now: number;
  /** "Send now" was pressed and the bridge has not answered yet. */
  sending?: boolean;
}

export interface SteerWaitLine {
  /**
   * `waiting`: on a step; `countdown`: the bridge sends by itself soon; `sending`: on its way;
   * `held`: the bridge tried, said why it did not go (`why`) and has no time of its own to try again.
   */
  phase: 'waiting' | 'countdown' | 'sending' | 'held';
  /** Why it still waits, in the bridge's words, before the label ("Claude did not confirm withdrawal."); '' with none. */
  why: string;
  /** The words: "Waiting for Run the build", "Sends in", "Sending"; '' where the reason says it all (`held`). */
  label: string;
  /** The figure after the words ("2m 10s", "0:24"); empty when there is none. */
  clock: string;
  /** The widest form of that figure at its size (the room the clock keeps); empty with no figure. */
  room: string;
  /** "Send now" stands in the line: the bridge can interrupt for this message. */
  action: boolean;
  /** It stands there but cannot be pressed now (the send is under way). */
  disabled: boolean;
  /** The action's tooltip: what pressing it costs. */
  cost: string;
}

/** What the action costs, in plain words. */
function costOf(steps: number): string {
  return steps > 1 ? 'Interrupts the running steps' : steps === 1 ? 'Interrupts the running step' : 'Interrupts what the agent is doing';
}

/** The line under a waiting steer, for this moment. */
export function steerWaitLine({ item, steps, agent, autoAt: first, now, sending }: SteerWaitInput): SteerWaitLine {
  // The bridge marks a steer it can interrupt for; without the mark the line only says what it waits on.
  const action = !!item.steerWait;
  const cost = costOf(steps.length);
  if (sending) return { phase: 'sending', why: '', label: 'Sending', clock: '', room: '', action, disabled: true, cost };
  const why = waitReason(item.steerWait);
  const own = item.steerWait?.autoAt;
  // A card with a reason and no time of its own is one the bridge no longer interrupts for by itself
  // (its tries are spent: "Automatic interruption limit reached."). Its sibling's automatic send
  // leaves it out, so it never borrows that countdown (`first`); only its own press sends it.
  const capped = !!why && !(typeof own === 'number' && Number.isFinite(own));
  const autoAt = action && !capped ? (first ?? own) : undefined;
  // The countdown shows only while the bridge has a time for this card; a reason stands before it.
  if (typeof autoAt === 'number' && Number.isFinite(autoAt)) {
    const left = autoAt - now;
    if (left > 0) {
      const clock = countdown(left);
      return { phase: 'countdown', why, label: 'Sends in', clock, room: clock, action, disabled: false, cost };
    }
    if (left > -AUTO_GRACE_MS) return { phase: 'sending', why: '', label: 'Sending', clock: '', room: '', action, disabled: true, cost };
  }
  // The bridge tried and the message still waits: its reason stands where the countdown stood, and
  // "Send now" stays (the reason lives on `steerWait`, which is the bridge's mark that it can).
  if (why) return { phase: 'held', why, label: '', clock: '', room: '', action, disabled: false, cost };
  const lead = steps[0];
  const label = lead ? `Waiting for ${lead.title.trim() || 'the running step'}${steps.length > 1 ? ` and ${steps.length - 1} more` : ''}` : `Waiting for ${agent ? `${agent}’s` : 'the'} next step`;
  // A step's own time; with no step known, how long the message has waited.
  const ran = now - (lead ? lead.ts : item.ts);
  const timed = Number.isFinite(ran) && ran >= 1000;
  return { phase: 'waiting', why: '', label, clock: timed ? waitedWords(ran) : '', room: timed ? waitedRoom(ran) : '', action, disabled: false, cost };
}

/** The whole line as one sentence, for a screen reader that asks for it. */
export const steerWaitSpoken = (line: Pick<SteerWaitLine, 'label' | 'clock'> & { why?: string }): string => [line.why, line.label, line.clock].filter(Boolean).join(' ');

// ── Settings › General: "Interrupt for a waiting message" (`AppSettings.steerAfterMs`) ──

/** The choices, in the order they stand. `0` is the bridge's "never by itself"; "At once" stores 1 ms. */
export const STEER_AFTER = [
  { id: 'now', ms: 1, label: 'At once' },
  { id: '30s', ms: 30_000, label: 'After 30 seconds' },
  { id: '2m', ms: 120_000, label: 'After 2 minutes' },
  { id: 'never', ms: 0, label: 'Never' },
] as const;

export type SteerAfter = (typeof STEER_AFTER)[number]['id'];

/** What a choice stores. */
export const steerAfterMs = (id: SteerAfter): number => STEER_AFTER.find((o) => o.id === id)?.ms ?? 30_000;

/** The choice a stored value shows as: absent is 30 seconds, 0 (or less) is never, anything else the nearest. */
export function steerAfterChoice(ms: number | undefined): SteerAfter {
  if (ms === undefined || !Number.isFinite(ms)) return '30s';
  if (ms <= 0) return 'never';
  let best: (typeof STEER_AFTER)[number] = STEER_AFTER[0];
  for (const o of STEER_AFTER) if (o.ms > 0 && Math.abs(o.ms - ms) < Math.abs(best.ms - ms)) best = o;
  return best.id;
}
