import { randomUUID } from 'node:crypto';
import type { BridgeEvent, PermissionRequest, ProviderId, Question, SessionMeta, TimelineItem, ToolItem, UserItem } from '../../shared/protocol';
import type { AgentCall } from '../providers/agent-tool';
import type { Provider } from '../providers/types';
import { SessionRuntime, type PermissionAnswer } from './runtime';

/**
 * A sub-agent of another provider, run for a parent session (see `providers/agent-tool.ts`).
 *
 * The child is a session of its own that never shows in the sidebar: everything it writes to its
 * timeline lands in the parent's, nested under the tool step that called it (ids prefixed so they
 * never collide), so the conversation and the Agents tab show its work live. Its permission
 * prompts and questions are asked in the parent session, attached to that step. When its turn
 * ends, its last answer is the result; stopping the parent stops it.
 */
class ChildRuntime extends SessionRuntime {
  private parent!: SessionRuntime;
  private under?: string;
  private readOnly = false;

  constructor(meta: SessionMeta, parent: SessionRuntime, under: string | undefined, readOnly = false) {
    const box: { fwd?: (e: BridgeEvent) => void } = {};
    super(meta, (e) => box.fwd?.(e), () => {});
    this.parent = parent;
    this.under = under;
    this.readOnly = readOnly;
    box.fwd = (e) => this.forward(e);
  }

  private pid = (id: string) => `${this.meta.id}:${id}`;

  private forward(e: BridgeEvent) {
    const p = this.parent;
    switch (e.type) {
      case 'item.added': {
        const it = e.item;
        // The task itself is the step's prompt: no second copy as a message.
        if (it.type === 'user' && !it.parentId) return;
        p.add({ ...it, id: this.pid(it.id), parentId: it.parentId ? this.pid(it.parentId) : this.under } as TimelineItem);
        return;
      }
      case 'item.delta':
        return p.delta(this.pid(e.id), e.field, e.delta);
      case 'item.patch': {
        const patch = { ...e.patch } as Partial<TimelineItem>;
        if (patch.parentId) patch.parentId = this.pid(patch.parentId);
        delete (patch as { id?: string }).id;
        return p.patch(this.pid(e.id), patch);
      }
      case 'item.removed':
        return p.remove(this.pid(e.id));
      default:
        return; // its status, caps and the like are its own
    }
  }

  override requestPermission(req: Omit<PermissionRequest, 'id' | 'sessionId' | 'createdAt'>, signal?: AbortSignal): Promise<PermissionAnswer | null> {
    // Read-only: anything that needs a permission is more than reading, and is turned down at once
    // (with the deny option, so the agent goes on instead of stopping). The user is never asked.
    if (this.readOnly) {
      const deny = req.options.find((o) => o.tone === 'deny');
      return Promise.resolve(deny ? { optionId: deny.id, message: READ_ONLY_DENIAL } : null);
    }
    return this.parent.requestPermission({ ...req, itemId: req.itemId ? this.pid(req.itemId) : this.under }, signal);
  }

  override ask(questions: Question[], itemId?: string, signal?: AbortSignal): Promise<Record<string, string[]> | null> {
    // A read-only run works on its own: its questions are not put to the user.
    if (this.readOnly) return Promise.resolve(null);
    return this.parent.ask(questions, itemId ? this.pid(itemId) : this.under, signal);
  }
}

export interface SubAgentDeps {
  provider: (id: ProviderId, accountId?: string) => Provider;
  accountFor: (id: ProviderId) => string | undefined;
  defaultModel: (id: ProviderId) => string | undefined;
  /** The child's permission mode, from the parent's (full access stays full access). */
  modeFor: (id: ProviderId, parentMode: string) => string;
  log: (...a: unknown[]) => void;
}

const MAX_RESULT = 40_000;

/** What a read-only child is told when it asks for more than reading. */
export const READ_ONLY_DENIAL = 'This is a read-only review: nothing may be changed and nothing beyond reading is allowed. Go on without it and write your findings as your answer.';

export interface SubAgentOptions {
  /**
   * Read-only (a turn check): every permission the child asks for is denied at once and its
   * questions go unanswered, so it can read but never change anything, and the user is never asked.
   */
  readOnly?: boolean;
}

/** Runs `call` as a sub-agent of `parent`, nested under the step `itemId`; resolves with its final answer. */
export async function runSubAgent(
  deps: SubAgentDeps,
  parent: SessionRuntime,
  call: AgentCall,
  itemId: string | undefined,
  signal?: AbortSignal,
  opts: SubAgentOptions = {},
): Promise<{ ok: boolean; text: string }> {
  const accountId = deps.accountFor(call.agent);
  let provider: Provider;
  try {
    provider = deps.provider(call.agent, accountId);
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
  const now = Date.now();
  const meta: SessionMeta = {
    id: `sub-${randomUUID()}`,
    provider: call.agent,
    cwd: parent.meta.cwd,
    title: call.description,
    titleSource: 'user',
    model: call.model ?? deps.defaultModel(call.agent) ?? '',
    // The mode the parent's running work has, not a switch held for its next message (review wave 8, #5).
    mode: deps.modeFor(call.agent, parent.workMode),
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    ...(accountId ? { accountId } : {}),
    // A check reads only: no tools that change or run anything, none of Sable's browser or device tools, no Remote Control.
    ...(opts.readOnly ? { options: { readOnly: true, browserTab: false, device: false, browser: false, computerUse: false, remoteControl: false } } : {}),
  };
  const child = new ChildRuntime(meta, parent, itemId, !!opts.readOnly);
  let finished!: (error?: string) => void;
  const ended = new Promise<string | undefined>((resolve) => (finished = resolve));
  child.onTurnEnd = (_rt, error) => finished(error);
  const stop = () => void child.handle?.interrupt().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    child.handle = await provider.open(child, { loadTranscript: false });
    if (signal?.aborted) return { ok: false, text: 'Stopped before the sub-agent started.' };
    const task: UserItem = child.add<UserItem>({ type: 'user', text: call.prompt, state: 'sent' });
    await child.handle.send(task);
    const error = await ended;
    const answer = [...child.items].reverse().find((i): i is Extract<TimelineItem, { type: 'text' }> => i.type === 'text' && !i.parentId && !!i.text.trim());
    if (error && !answer) return { ok: false, text: `The sub-agent stopped: ${error}` };
    const text = answer?.text.trim() || 'The sub-agent finished without a written answer.';
    return { ok: !error, text: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n\n(cut off)` : text };
  } catch (err) {
    deps.log('sub-agent failed', (err as Error).message);
    return { ok: false, text: `The sub-agent could not run: ${(err as Error).message}` };
  } finally {
    signal?.removeEventListener('abort', stop);
    child.cancelPrompts();
    await Promise.resolve(child.handle?.close()).catch(() => {});
  }
}

/** The tool step a call belongs to: the newest running step of that tool in the parent not yet claimed. */
export function claimStep(parent: SessionRuntime, isTool: (it: ToolItem) => boolean, claimed: Set<string>): string | undefined {
  for (let i = parent.items.length - 1; i >= 0; i--) {
    const it = parent.items[i];
    if (it.type === 'tool' && !claimed.has(it.id) && (it.status === 'running' || it.status === 'pending') && isTool(it)) {
      claimed.add(it.id);
      return it.id;
    }
  }
  return undefined;
}
