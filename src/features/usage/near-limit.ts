import { DEFAULT_ACCOUNT, type AccountInfo, type ProviderId, type RateLimit } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { accountName, limitLevel, type LimitLevel } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { windowPhrase } from './LimitReset';

/**
 * In-app warnings as an account nears its plan limits: one toast when a window reaches 80%, a
 * stronger one when it is used up. Once per crossing: nothing repeats while the window stays
 * there, and a window that cools below 70% (or resets) can warn again. Claude Code and Codex alike.
 */

const STAY_BELOW = 70;

type Tone = Exclude<LimitLevel, undefined>;
const rank = (t: LimitLevel) => (t === 'cap' ? 2 : t === 'near' ? 1 : 0);

/** The last tone announced per account (`accountKey`) since it was last quiet. */
const announced = new Map<string, Tone>();

/** The live windows, tightest first (a reset that has passed no longer counts, as in `limitLevel`). */
function liveWindows(limits: RateLimit[] | undefined, now: number): RateLimit[] {
  return (limits ?? []).filter((l) => !(l.resetsAt && l.resetsAt <= now)).sort((a, b) => b.percent - a.percent);
}

function announce(provider: ProviderId, info: { name?: string; accounts?: AccountInfo[] } | undefined, account: AccountInfo | undefined, window: RateLimit, tone: Tone) {
  const who = (info?.accounts?.length ?? 0) > 1 ? accountName(account) : undefined;
  const subject = `${info?.name ?? PROVIDER_NAME[provider]}${who ? ` (${who})` : ''}`;
  const text =
    tone === 'cap' ? `${subject} has used up ${windowPhrase(window)}` : `${subject} is at ${Math.round(window.percent)}% of ${windowPhrase(window)}`;
  useStore.getState().toast(text, tone === 'cap' ? 'error' : 'warn');
}

function check() {
  const s = useStore.getState();
  const now = Date.now();
  for (const provider of Object.keys(s.providers) as ProviderId[]) {
    const info = s.providers[provider];
    const accounts: (AccountInfo | undefined)[] = info?.accounts?.length ? info.accounts : [undefined];
    for (const account of accounts) {
      const key = accountKey(provider, account?.id ?? DEFAULT_ACCOUNT);
      // The same read `useLimitLevel` uses: an empty answer does not erase what the bridge remembers.
      const known = s.limitReports[key]?.limits;
      const limits = known?.length ? known : s.limits[key];
      const windows = liveWindows(limits, now);
      const before = announced.get(key);
      const level = limitLevel(limits, now);

      if (!level) {
        if (before && (before === 'cap' || (windows[0]?.percent ?? 0) < STAY_BELOW)) announced.delete(key);
        continue;
      }
      // Already said this, or something worse: nothing new to tell.
      if (before && rank(before) >= rank(level)) continue;
      announced.set(key, level);
      const top = windows[0];
      if (top) announce(provider, info, account, top, level);
    }
  }
}

/** Starts the warnings (once, from the app shell). Returns the function that stops them. */
export function watchLimitWarnings(): () => void {
  check();
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.limits !== prev.limits || s.limitReports !== prev.limitReports || s.providers !== prev.providers) check();
  });
  return () => {
    unsubscribe();
    announced.clear();
  };
}
