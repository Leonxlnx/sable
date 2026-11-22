import { DEFAULT_ACCOUNT, type Capabilities, type ProviderId } from '@shared/protocol';

/**
 * What each agent last said it offers, kept per browser so the composer's last line stands
 * complete in its first frame: a chat that opens, or home right after start-up, names its mode,
 * model and effort from here until the agent answers again (the same answer, nearly always, so
 * nothing changes on screen when it does). Only what those chips read is kept: the models with
 * their levels and speeds, the modes, and which features the agent has. Commands, skills, tools
 * and servers are not: a remembered answer never fills a menu of things to run.
 */

const KEY = 'sable.capsSeen.v1';
/** A long model list is cut here (an agent with hundreds of models keeps what its menu shows first). */
const MAX_MODELS = 80;

type Seen = Pick<Capabilities, 'models' | 'modes' | 'features' | 'skillTrigger'>;

let all: Record<string, Seen> | null = null;
/** One object per key, so a selector that returns it never asks for a render of its own. */
const built = new Map<string, Capabilities>();

const keyOf = (provider: ProviderId, accountId: string | undefined) => `${provider}@${accountId && accountId !== DEFAULT_ACCOUNT ? accountId : ''}`;

function read(): Record<string, Seen> {
  if (all) return all;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    all = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Seen>) : {};
  } catch {
    all = {};
  }
  return all;
}

const usable = (s: Seen | undefined): s is Seen => !!s && Array.isArray(s.models) && Array.isArray(s.modes) && !!s.features && typeof s.features === 'object';

/** The agent's last known answer for this account (any account of the agent when this one never asked); undefined when the agent was never seen. */
export function seenCaps(provider: ProviderId, accountId: string | undefined): Capabilities | undefined {
  const store = read();
  let key = keyOf(provider, accountId);
  if (!usable(store[key])) {
    const head = `${provider}@`;
    const other = Object.keys(store).find((k) => k.startsWith(head) && usable(store[k]));
    if (!other) return undefined;
    key = other;
  }
  const have = built.get(key);
  if (have) return have;
  const s = store[key];
  const caps: Capabilities = { models: s.models, modes: s.modes, commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: s.skillTrigger === '$' ? '$' : '/', features: s.features };
  built.set(key, caps);
  return caps;
}

/** Keeps an agent's answer for the next first frame; writes only when what the chips read changed. */
export function rememberCaps(provider: ProviderId, accountId: string | undefined, caps: Capabilities) {
  if (!caps.models.length && !caps.modes.length) return;
  const store = read();
  const key = keyOf(provider, accountId);
  const next: Seen = { models: caps.models.slice(0, MAX_MODELS), modes: caps.modes, features: caps.features, skillTrigger: caps.skillTrigger };
  let text: string;
  try {
    text = JSON.stringify(next);
    if (usable(store[key]) && JSON.stringify(store[key]) === text) return;
  } catch {
    return;
  }
  // A copy of its own: later changes to the live answer never reach what is kept.
  all = { ...store, [key]: JSON.parse(text) as Seen };
  built.delete(key);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode or a full store: the answer is still kept for this run */
  }
}

/** For tests: forget what was read. */
export function resetSeenCaps() {
  all = null;
  built.clear();
}
