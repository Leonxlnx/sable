import { randomUUID } from 'node:crypto';
import type { BridgeEvent, PermissionRequest, ProviderId, Question, SessionMeta, TimelineItem, ToolItem, UserItem } from '../../shared/protocol';
import { agentToolId, AGENT_TOOLS, describeAgentCall, type AgentCall } from '../providers/agent-tool';
import type { Provider } from '../providers/types';
import { delegateAnswer, MAX_DELEGATE_RESULT } from './delegate-result';
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
  ownsRow = () => true;
  readonly promptLifetime = new AbortController();

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
    if (this.under && !this.readOnly && !this.ownsRow()) return;
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
    if (!this.ownsRow() || this.promptLifetime.signal.aborted || signal?.aborted) return Promise.resolve(null);
    if (this.readOnly) {
      const deny = req.options.find((o) => o.tone === 'deny');
      return Promise.resolve(deny ? { optionId: deny.id, message: READ_ONLY_DENIAL } : null);
    }
    return this.parent.requestPermission({ ...req, delegateId: this.under, itemId: req.itemId ? this.pid(req.itemId) : this.under }, signal ? AbortSignal.any([signal, this.promptLifetime.signal]) : this.promptLifetime.signal);
  }

  override ask(questions: Question[], itemId?: string, signal?: AbortSignal): Promise<Record<string, string[]> | null> {
    // A read-only run works on its own: its questions are not put to the user.
    if (!this.ownsRow() || this.readOnly || this.promptLifetime.signal.aborted || signal?.aborted) return Promise.resolve(null);
    return this.parent.ask(questions, itemId ? this.pid(itemId) : this.under, signal ? AbortSignal.any([signal, this.promptLifetime.signal]) : this.promptLifetime.signal, this.under);
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

export const DELEGATE_STEER_RESULT = 'The person sent a message, so this call returns early. The sub-agent keeps working in the background. Its report will be delivered to you when it finishes. Answer the person now, then carry on. Do not start the same task again.';
export const DELEGATE_BACKGROUND_RESULT = 'The sub-agent is working in the background. Its report will be delivered to you when it finishes. Carry on. Do not start the same task again.';

/** What a read-only child is told when it asks for more than reading. */
export const READ_ONLY_DENIAL = 'This is a read-only review: nothing may be changed and nothing beyond reading is allowed. Go on without it and write your findings as your answer.';

export interface SubAgentOptions {
  /**
   * Read-only (a turn check): every permission the child asks for is denied at once and its
   * questions go unanswered, so it can read but never change anything, and the user is never asked.
   */
  readOnly?: boolean;
}

/** Runs `call` as a sub-agent of `parent`, nested under `itemId`; resolves with the child's answer or a background acknowledgment. */
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
  // Older harnesses can omit both the call id and its start frame. The child still has an owner.
  const deliveryId = randomUUID();
  const anonymous = !itemId && !opts.readOnly;
  if (anonymous) itemId = `delegate-${deliveryId}`;
  if (itemId && !opts.readOnly) {
    const row = parent.get<ToolItem>(itemId);
    if (parent.delegates.has(itemId) || row && (row.delegateDeliveryId || row.delegateReport || !['running', 'pending', 'awaiting'].includes(row.status))) {
      return { ok: false, text: 'This delegate call already has an owner.' };
    }
  }
  const generation = parent.processGeneration;
  const callerSession = parent.meta.providerSessionId ?? (!opts.readOnly && !call.background ? parent.handle?.delegateDestination?.() : undefined);
  const callerCheckpoint = parent.handle?.delegateCheckpoint?.();
  if (itemId && !opts.readOnly && !parent.get(itemId)) {
    const name = parent.meta.provider === 'claude' ? agentToolId(call.agent) : AGENT_TOOLS[call.agent] ?? 'delegate';
    parent.add<ToolItem>({ type: 'tool', id: itemId, name, ...describeAgentCall(call.agent, call), input: call, status: 'running' });
  }
  const child = new ChildRuntime(meta, parent, itemId, !!opts.readOnly);
  let finished!: (error?: string) => void;
  const ended = new Promise<string | undefined>((resolve) => (finished = resolve));
  let workEnded = false;
  let rootEnded = false;
  let receivers: Promise<void> | undefined;
  let receiverFailure: string | undefined;
  child.onTurnEnd = (_rt, error) => {
    if (rootEnded) return;
    rootEnded = true;
    receivers = child.handle?.waitForReceivers?.()?.then(() => {
      if (itemId && !opts.readOnly && child.ownsRow()) parent.patch<ToolItem>(itemId, { delegateReceiversPending: undefined });
    }, err => { receiverFailure = (err as Error).message; });
    if (receivers && itemId && !opts.readOnly && child.ownsRow()) {
      parent.patch<ToolItem>(itemId, { delegateReceiversPending: true });
      void parent.persistDelegate?.().catch(err => deps.log('receiver checkpoint failed', err));
    }
    finished(error);
  };
  type Result = { ok: boolean; text: string };
  let release!: (result: Result) => void;
  const answer = new Promise<Result>(resolve => { release = resolve; });
  let detached = false;
  let stopped = false;
  let byPerson = false;
  let quitting = false;
  let saved!: () => void;
  const resultSaved = new Promise<void>(resolve => { saved = resolve; });
  let retry: NodeJS.Timeout | undefined;
  let hardClose: Promise<void> | undefined;
  let retirement: NodeJS.Timeout | undefined;
  let retireRetry: NodeJS.Timeout | undefined;
  let abandoned = false;
  let revoked = false;
  let cleanupDone!: () => void;
  const cleanup = new Promise<void>(resolve => { cleanupDone = resolve; });
  const interrupt = () => {
    const handle = child.handle;
    if (!handle) return;
    void handle.interrupt().catch(err => deps.log('sub-agent interrupt failed', err));
    void handle.interruptReceivers?.().catch(err => deps.log('sub-agent receiver interrupt failed', err));
  };
  const escalate = () => {
    const handle = child.handle;
    if (!handle) {
      // Closing an isolated app-server also breaks a stuck thread/start or attach.
      void provider.terminateOpeningDelegate?.().catch(err => deps.log('sub-agent open cancellation failed', err));
      return;
    }
    hardClose = Promise.resolve().then(async () => {
      if (handle.terminateDelegate) await handle.terminateDelegate();
      else await handle.close();
      finished();
      if (revoked) {
        clearTimeout(retirement);
        clearInterval(retireRetry);
        clearTimeout(retry);
        release({ ok: false, text: 'The delegate was removed from the conversation.' });
        cleanupDone();
      }
    }).catch(err => {
      deps.log('sub-agent termination failed', err);
      if (!abandoned && !workEnded) retry = setTimeout(escalate, 1500);
    });
  };
  const stop = (person: boolean) => {
    if (workEnded) return;
    byPerson ||= person;
    if (rootEnded && !receivers) return;
    if (person && itemId && !opts.readOnly && child.ownsRow()) {
      parent.patch<ToolItem>(itemId, { delegateCaller: undefined, delegateReport: 'stopping' });
      void parent.persistDelegate?.().catch(err => deps.log('sub-agent stop save failed', err));
    }
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', aborted);
    child.stopRequested = true;
    child.promptLifetime.abort();
    interrupt();
    retry = setTimeout(() => {
      interrupt();
      retry = setTimeout(escalate, 1500);
    }, 1500);
  };
  const aborted = () => {
    if (opts.readOnly || parent.stopRequested) stop(parent.stopRequested);
    else if (!rootEnded) detach(false);
  };
  const detach = (steered = true) => {
    if (!itemId || detached || stopped || workEnded || rootEnded && !receivers || opts.readOnly) return;
    detached = true;
    signal?.removeEventListener('abort', aborted);
    parent.patch<ToolItem>(itemId, { status: 'running', delegateCaller: undefined, delegateReport: 'working', result: { agent: { background: 'running' } } });
    void parent.persistDelegate?.().catch(err => deps.log('sub-agent ownership save failed', err));
    release({ ok: true, text: steered ? DELEGATE_STEER_RESULT : DELEGATE_BACKGROUND_RESULT });
  };
  const quit = () => {
    quitting = true;
    if (itemId && !workEnded && !byPerson && child.ownsRow()) {
      parent.patch<ToolItem>(itemId, { delegateReport: 'working', delegateCaller: undefined });
    }
    stop(false);
    return resultSaved;
  };
  const revoke = () => {
    revoked = true;
    stop(true);
    if (workEnded) escalate(); // Its result may be saved while the transport is still closing.
    // A handle can be stuck opening or inside close itself. Keep a timer after its row is gone.
    retireRetry = setInterval(escalate, 4500);
    retirement = setTimeout(() => {
      abandoned = true;
      clearInterval(retireRetry);
      clearTimeout(retry);
      deps.log('deleted delegate cleanup deadline; exit unconfirmed', meta.id);
      finished();
      release({ ok: false, text: 'The chat was deleted. Delegate process exit could not be confirmed.' });
      cleanupDone();
    }, 8500);
  };
  const owner = { detach, callerGone: () => detach(false), stop, revoke, quit, ended: cleanup };
  if (itemId && !opts.readOnly) {
    const id = itemId;
    parent.delegates.set(id, owner);
    child.ownsRow = () => parent.delegates.get(id) === owner;
    parent.patch<ToolItem>(id, { delegateDeliveryId: deliveryId, delegateCaller: generation });
  }
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted || parent.stopRequested && !opts.readOnly) stop(parent.stopRequested);
  const steerWaiting = itemId && parent.steeredDelegateSteps.delete(itemId);
  if (call.background) detach(false);
  else if (steerWaiting || parent.hasUnreadSteer) detach();
  if (itemId && !opts.readOnly && !detached && !stopped) void parent.persistDelegate?.().catch(err => deps.log('sub-agent ownership save failed', err));
  async function run(): Promise<Result> {
    try {
      if (stopped) return { ok: false, text: 'Stopped before the sub-agent started.' };
      child.handle = await provider.open(child, { loadTranscript: false });
      if (stopped) return { ok: false, text: 'Stopped before the sub-agent started.' };
      const task: UserItem = child.add<UserItem>({ type: 'user', text: call.prompt, state: 'sent' });
      await child.handle.send(task);
      const error = await ended;
      if (receivers) await receivers;
      const answer = [...child.items].reverse().find((i): i is Extract<TimelineItem, { type: 'text' }> => i.type === 'text' && !i.parentId && !!i.text.trim());
      const quitResult = quitting && rootEnded && (error || answer && !answer.streaming || child.items.some(i => i.type === 'turn' && !i.parentId && i.stopReason !== 'interrupted'));
      if ((stopped && !quitResult) || child.items.some(i => i.type === 'notice' && i.variant === 'interrupted')) {
        stopped = true;
        return { ok: false, text: 'The sub-agent stopped before it finished.' };
      }
      if (child.items.some(i => i.type === 'notice' && i.early)) return { ok: false, text: 'The sub-agent lost its process before it finished.' };
      if (quitting) stopped = false;
      if (receiverFailure) return { ok: false, text: receiverFailure };
      return delegateAnswer(answer?.text, error);
    } catch (err) {
      deps.log('sub-agent failed', (err as Error).message);
      return { ok: false, text: `The sub-agent could not run: ${(err as Error).message}` };
    } finally {
      signal?.removeEventListener('abort', aborted);
      child.promptLifetime.abort();
      child.cancelPrompts();
      workEnded = true;
    }
  }
  void run().then(async result => {
    clearTimeout(retry);
    if (result.text.length > MAX_DELEGATE_RESULT + 11) result.text = result.text.slice(0, MAX_DELEGATE_RESULT) + '\n\n(cut off)';
    try {
      if (itemId && !opts.readOnly && child.ownsRow() && (!quitting || rootEnded)) {
        const pending = quitting || detached || generation !== parent.processGeneration;
        const outcome = stopped ? 'stopped' : result.ok ? 'done' : 'failed';
        parent.patch<ToolItem>(itemId, {
          delegateReceiversPending: undefined,
          status: stopped ? 'cancelled' : result.ok ? 'done' : 'error', endedAt: Date.now(),
          delegateReport: byPerson ? 'stopped' : pending ? 'pending' : undefined,
          delegateCaller: !byPerson && !pending ? generation : undefined,
          delegateAttempt: !byPerson && !pending ? { provider: parent.meta.provider, account: parent.meta.accountId, session: callerSession, after: callerCheckpoint, tool: itemId } : undefined,
          result: { text: result.text, isError: !result.ok, ...(pending ? { agent: { background: outcome } } : {}) },
        });
        if (pending && !byPerson) parent.pendingDelegateReports.add(itemId);
        const prepared = pending && !byPerson ? parent.stageDelegateReports?.() : undefined;
        await parent.persistDelegate?.();
        prepared?.();
        if (pending && !byPerson && child.ownsRow()) parent.onDelegateReport?.();
      }
    } catch (err) {
      if (child.ownsRow()) parent.notice('error', 'Could not save the sub-agent result', String(err));
    } finally {
      saved();
      try {
        if (hardClose) await hardClose;
        else await child.handle?.close();
      } catch (err) { deps.log('sub-agent close failed', err); }
      if (itemId && parent.delegates.get(itemId) === owner) {
        parent.delegates.delete(itemId);
        parent.handle?.delegateEnded?.();
      }
      clearTimeout(retirement);
      clearInterval(retireRetry);
      cleanupDone();
      release(anonymous && !detached ? { ...result, text: `${result.text}\n\n[Sable delegate receipt ${deliveryId}]` } : result);
    }
  });
  return answer;
}

/** The tool step a call belongs to: the newest running step of that tool in the parent not yet claimed. */
export function claimStep(parent: SessionRuntime, isTool: (it: ToolItem) => boolean, claimed?: Set<string>): string | undefined {
  for (let i = parent.items.length - 1; i >= 0; i--) {
    const it = parent.items[i];
    if (it.type === 'tool' && !it.parentId && !it.delegateDeliveryId && !parent.delegates.has(it.id) && !claimed?.has(it.id) && (it.status === 'running' || it.status === 'pending') && isTool(it)) {
      claimed?.add(it.id);
      return it.id;
    }
  }
  return undefined;
}
