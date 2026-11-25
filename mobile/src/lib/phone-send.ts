import type { RpcMethods } from '@shared/protocol';
import { conn } from './conn';
import { clearThrough, draftsReady } from './drafts';
import { epoch, still } from './epoch';
import { isTransport } from './errors';
import { onForget } from './forget';
import { durable, readPref } from './native';
import { receipt, transition, type Press, type SendEvent, type Submission } from './submit';

const KEY = 'sable.outgoing';
let entries: Submission[] = [];
// Only a revision survives final settlement. A rolled-back WebView draft can never
// offer the original composition as a fresh send after its native receipt is gone.
let cleared: Record<string, number> = {};
let loaded = false;
let writing: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export const outgoing = () => entries;
export function onOutgoing(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function publish(next: Submission[]) {
  entries = next;
  listeners.forEach(fn => fn());
}

function current(e: number) {
  if (!still(e)) throw new Error('The computer was forgotten.');
}

function serial<T>(e: number, fn: () => Promise<T>): Promise<T> {
  const task = writing.then(async () => {
    current(e);
    if (!loaded) {
      const [raw] = await Promise.all([readPref(KEY), draftsReady()]);
      current(e);
      const saved: { entries: Submission[]; cleared: Record<string, number> } = raw === null ? { entries: [], cleared: {} } : JSON.parse(raw);
      const recovered = saved.entries.map(s => transition(s, { type: 'lost' })!);
      cleared = saved.cleared;
      for (const [sid, revision] of Object.entries(cleared)) clearThrough(sid, revision, true);
      loaded = true;
      publish(recovered);
    }
    return fn();
  });
  writing = task.catch(() => {});
  return task;
}

async function change(e: number, expected: Submission | undefined, event: SendEvent) {
  return serial(e, async () => {
    const id = event.type === 'press' ? event.press.packet.submitId : expected?.packet.submitId;
    const before = entries.find(s => s.packet.submitId === id);
    // Refusals and retries belong to one attempt. A matching durable receipt
    // owns the entire submission, even if a concurrent query advanced its state.
    if (before !== expected && event.type !== 'accepted') return;
    const after = transition(before, event);
    if (after === before) return;
    const next = entries.slice();
    if (!before && after) next.push(after);
    else if (before && after) next[next.indexOf(before)] = after;
    else if (before) next.splice(next.indexOf(before), 1);
    const nextCleared = event.type === 'press' ? {
      ...cleared, [event.press.source]: Math.max(cleared[event.press.source] ?? -1, event.press.revision),
    } : cleared;
    try {
      await durable(KEY, JSON.stringify({ entries: next, cleared: nextCleared }));
    } catch (err) {
      // Leave the disk checkpoint for recovery and make the interrupted attempt actionable now.
      if (still(e) && before?.state === 'sending') publish(entries.map(s => s === before ? transition(s, { type: 'lost' })! : s));
      throw err;
    }
    current(e);
    cleared = nextCleared;
    if (event.type === 'press') clearThrough(event.press.source, event.press.revision);
    publish(next);
    return after;
  });
}

type Answer = RpcMethods['session.send']['result'];

async function ask(e: number, entry: Submission) {
  current(e);
  const { sessionId, submitId } = entry.packet;
  const answer = await conn.call('session.submission', { sessionId, submitId });
  current(e);
  const result = receipt(submitId, answer);
  if (result === 'accepted') {
    await change(e, entry, { type: 'accepted' });
    return { answer };
  }
  if (result === 'lost') throw new Error('The desktop did not confirm this submission ID.');
  await change(e, entry, { type: 'refused' });
  return { ready: entries.find(s => s.packet.submitId === submitId && s.state === 'refused') };
}

async function transmit(e: number, entry: Submission): Promise<Answer> {
  current(e);
  let reply: Answer | undefined;
  let failure: unknown;
  try { reply = await conn.call('session.send', entry.packet); }
  catch (err) { failure = err; }
  current(e);
  // An RPC error can follow the bridge checkpoint. Only a definite refusal, or a call
  // that never left this phone, is safe to offer without first checking the receipt.
  const event = isTransport(failure) && failure.transport === 'unsent' ? 'refused' : receipt(entry.packet.submitId, reply);
  const remaining = await change(e, entry, { type: event });
  if (event === 'accepted') return reply!;
  if (event === 'lost' && remaining) {
    const status = await ask(e, remaining).catch(() => undefined);
    current(e);
    if (status?.answer) return status.answer;
  }
  throw failure ?? new Error(reply?.error ?? 'The desktop has not confirmed this message.');
}

export async function sendPress(press: Press, e: number, staged?: () => void) {
  if (!loaded) {
    await serial(e, async () => {});
  }
  if (cleared[press.source] >= press.revision) throw new Error('This composition was already submitted. Check its status before sending again.');
  const entry = await change(e, undefined, { type: 'press', press });
  if (!entry) throw new Error('That message is already pending.');
  current(e);
  try {
    staged?.();
  } catch (err) {
    await change(e, entry, { type: 'refused' });
    throw err;
  }
  return transmit(e, entry);
}

export async function retryPress(entry: Submission): Promise<Answer | undefined> {
  const e = epoch();
  if (entry.state === 'sending') return;
  const status = entry.state === 'unsure' ? await ask(e, entry) : { ready: entry };
  if (status.answer) return status.answer;
  const ready = status.ready;
  if (!ready) return;
  const sending = await change(e, ready, { type: 'retry' });
  if (sending) return transmit(e, sending);
}

export const discardPress = (entry: Submission) => change(epoch(), entry, { type: 'discard' });

export async function recoverOutgoing() {
  const e = epoch();
  await serial(e, async () => {});
  for (const entry of entries) {
    if (!still(e) || conn.state !== 'open') return;
    if (entry.state !== 'sending') await ask(e, entry).catch(() => {});
  }
}

onForget(async () => {
  await writing;
  loaded = false;
  cleared = {};
  publish([]);
});
const recover = () => { void recoverOutgoing().catch(() => {}); };
conn.onOpen(recover);
recover();
