import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { AccountCap, AccountFolder, AuthState, ProviderId, RateLimit } from '../../shared/protocol';
import { capPercent, capReached, isSessionWindow, windowForModel } from '../core/limit-policy';
import { USE_FIRST_SESSION_CEILING, useFirst } from '../../shared/use-first';

/**
 * Finding config folders people already keep for an agent ("~/.claude-work",
 * "~/.claude-accounts/studio"), choosing which account to continue with at a limit, and naming a new
 * account after its sign-in. Folders are judged by the names in their listing only: no file in
 * them is ever opened (some hold sign-ins). Whether one is signed in is asked of the agent's CLI.
 */

const MARKERS: Partial<Record<ProviderId, string[]>> = {
  claude: ['projects', 'settings.json', '.claude.json', 'plugins', 'todos', 'statsig', 'history.jsonl', 'shell-snapshots', 'ide'],
  codex: ['config.toml', 'sessions', 'history.jsonl', 'log', 'version.json'],
};

const PREFIX: Partial<Record<ProviderId, string>> = { claude: 'claude', codex: 'codex' };

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function looksLike(provider: ProviderId, dir: string): boolean {
  const markers = MARKERS[provider];
  if (!markers) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => markers.includes(n));
}

/**
 * Config folders of `provider` under `home`: `.claude-*` / `.claude_*` / `.claude.*` folders and the
 * folders inside `.claude-accounts` (the same for Codex), minus the agent's own (`.claude`) and
 * folders in `exclude` (accounts already registered).
 */
export function findAccountFolders(provider: ProviderId, home: string, exclude: string[] = []): AccountFolder[] {
  const prefix = PREFIX[provider];
  if (!prefix) return [];
  const skip = new Set(exclude.map(norm));
  skip.add(norm(path.join(home, `.${prefix}`)));
  const out: AccountFolder[] = [];
  const consider = (dir: string, name: string) => {
    if (skip.has(norm(dir)) || out.some((f) => norm(f.dir) === norm(dir))) return;
    if (looksLike(provider, dir)) out.push({ dir, name });
  };
  const group = `.${prefix}-accounts`;
  for (const name of listDirs(home)) {
    if (name === group) {
      for (const inner of listDirs(path.join(home, name))) consider(path.join(home, name, inner), inner);
    } else if (new RegExp(`^\\.${prefix}[-_.].+`).test(name)) {
      consider(path.join(home, name), name.slice(1));
    }
  }
  return out.slice(0, 12);
}

/** A label for a registered folder: ".claude-work" → "Work", "studio" → "Studio". */
export function folderLabel(provider: ProviderId, dir: string): string {
  const prefix = PREFIX[provider] ?? '';
  const base = path.basename(path.resolve(dir)).replace(/^\./, '');
  const bare = base.replace(new RegExp(`^${prefix}[-_.]?`, 'i'), '') || base;
  return capital(bare.replace(/[-_]+/g, ' ').trim()).slice(0, 60) || 'Folder';
}

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * What a new account is called once it signs in: the name part of its email ("ada" from
 * ada@example.com), or the whole email when another account already has that name, or the
 * organisation when there is no email. Undefined when the sign-in says nothing usable.
 */
export function labelFromAuth(auth: AuthState, taken: string[]): string | undefined {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const email = auth.email?.trim();
  if (email) {
    const local = email.split('@')[0];
    const name = /^[a-z]+$/i.test(local) ? capital(local.toLowerCase()) : local;
    if (name && !used.has(name.toLowerCase())) return name.slice(0, 60);
    if (!used.has(email.toLowerCase())) return email.slice(0, 60);
  }
  const org = auth.org?.trim();
  if (org && !/'s organi[sz]ation$/i.test(org) && !used.has(org.toLowerCase())) return org.slice(0, 60);
  return undefined;
}

export interface NextCandidate {
  id: string;
  signedIn: boolean;
  isDefault?: boolean;
  limits?: RateLimit[];
  /** False when the account has no plan limits (an API key): always has room. */
  planLimits?: boolean;
  /** The "use up to" set for the account: an account past it is not taken. */
  cap?: AccountCap;
  /** The account's plan ("Ultra", "Max"), to prefer one of the same size. */
  plan?: string;
  /** Plan size in units of Pro (`planWeight`), for `useFirst`. */
  weight?: number;
}

/** A window that is used up and has not reset yet (with `model`: only the shared windows and that model's own). */
export function atCap(limits: RateLimit[] | undefined, now = Date.now(), model?: string): boolean {
  return (limits ?? []).some((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now) && (model === undefined || windowForModel(l, model)));
}

/** Options of `pickNextAccount`. */
export interface NextOptions {
  /** The chat's model (its effective one: `effectiveModel`): other models' windows do not count. */
  model?: string;
  /** The current account's plan, to prefer one of the same size. */
  plan?: string;
  /** A move by a cap: the person's order after `current`, same plan first. */
  byCap?: boolean;
  /** Earliest expiry first (`shared/use-first.ts`). */
  useFirst?: boolean;
  /** `accountsBy: 'manual'`: the person's saved order decides, from the top (review wave 7, #15). */
  manual?: boolean;
  /** Accounts never taken (those that already refused this message). */
  except?: Iterable<string>;
}

/**
 * The account to continue with when `current` is at a limit or past its cap: another signed-in
 * account that is neither at a limit nor past its own cap, one on the same plan as `opts.plan`
 * first, then the one with the most room (unknown limits count as half used), the default account
 * winning a tie. With `opts.model`, a full window of another model does not count. With
 * `opts.byCap` (a move by a cap: "Ultra1 up to 95%, then Ultra2") the person's own order decides
 * instead of room: the next account after `current` in the list (same plan first, wrapping round).
 * With `opts.manual` the first in the person's order. With `opts.useFirst` (and neither of those)
 * the one whose unused week ends soonest among those that take work now (`shared/use-first.ts`), so
 * the least quota expires unused; when none takes work now, only one whose week was never read (and
 * whose 5-hour window has room) may be taken by the room rule, never one it holds or counts spent.
 * Never one without plan limits (an API key, billed per token), nor one in `opts.except`. Undefined
 * when none has room.
 */
export function pickNextAccount(current: string, accounts: NextCandidate[], now = Date.now(), opts: NextOptions = {}): string | undefined {
  const used = (a: NextCandidate) => {
    if (a.planLimits === false) return 0;
    const live = (a.limits ?? []).filter((l) => !(l.resetsAt && l.resetsAt <= now) && (opts.model === undefined || windowForModel(l, opts.model)));
    return live.length ? Math.max(...live.map((l) => l.percent)) : 50;
  };
  const tier = (a: NextCandidate) => (opts.plan && a.plan?.toLowerCase() === opts.plan.toLowerCase() ? 0 : 1);
  const at = accounts.findIndex((a) => a.id === current);
  // Places after the current account in the list, wrapping round (the current one itself is never taken).
  const after = (a: NextCandidate) => (accounts.indexOf(a) - at + accounts.length) % accounts.length;
  const except = new Set(opts.except ?? []);
  let ok = accounts.filter(
    // Never an account without plan limits (an API key): Sable does not start paying per token by itself.
    (a) => a.id !== current && !except.has(a.id) && a.signedIn && a.planLimits !== false && !atCap(a.limits, now, opts.model) && !capReached(a.limits, a.cap, opts.model, now),
  );
  if (opts.manual && !opts.byCap) return ok[0]?.id;
  if (opts.useFirst && !opts.byCap) {
    const ranks = useFirst(ok, now, opts.model);
    const first = ranks.find((r) => r.state === 'now');
    if (first) return first.id;
    // None takes work now: only an account whose week is unread can still be the one, when its 5-hour window has room.
    const unread = new Set(ranks.filter((r) => r.state === 'unknown').map((r) => r.id));
    ok = ok.filter((a) => {
      if (!unread.has(a.id)) return false;
      const five = (a.limits ?? []).find((l) => isSessionWindow(l) && !(l.resetsAt && l.resetsAt <= now));
      return !five || five.percent < Math.min(USE_FIRST_SESSION_CEILING, capPercent(a.cap?.session));
    });
  }
  ok.sort((a, b) => tier(a) - tier(b) || (opts.byCap ? after(a) - after(b) : used(a) - used(b) || Number(!!b.isDefault) - Number(!!a.isDefault)));
  return ok[0]?.id;
}
