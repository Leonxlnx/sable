import type { BridgeEvent, PhoneItem, PhoneTail, SessionMeta } from '../../shared/protocol';

// Both session lists and incremental patches use these same scalar fields.
function sessionFields(s: Partial<SessionMeta>) {
  return { id: s.id, provider: s.provider, title: s.title, titleSource: s.titleSource, model: s.model,
    mode: s.mode, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, pinned: s.pinned,
    archived: s.archived, unread: s.unread, background: s.background, custom: s.custom };
}
export function webSession(s: SessionMeta): SessionMeta {
  return { ...sessionFields(s), id: s.id, provider: s.provider, title: s.title, titleSource: s.titleSource,
    model: s.model, mode: s.mode, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt,
    cwd: '', usage: { inputTokens: s.usage.inputTokens, outputTokens: s.usage.outputTokens, turns: s.usage.turns } };
}
// Transcript content was explicitly granted. Internal account, sender and native
// delivery metadata from timeline rows are never part of that grant.
export function webItem(i: PhoneItem) {
  const row = { id: i.id, ts: i.ts, parentId: i.parentId, type: i.type, cut: i.cut, kids: i.kids, more: i.more };
  switch (i.type) {
    case 'text': case 'thinking': return { ...row, text: i.text, streaming: i.streaming };
    case 'user': return { ...row, text: i.text, state: i.state, steered: i.steered, attachments: i.attachments };
    case 'notice': return { ...row, variant: i.variant, text: i.text, detail: i.detail };
    case 'turn': return { ...row, durationMs: i.durationMs, stopReason: i.stopReason, error: i.error };
    case 'tool': return { ...row, name: i.name, kind: i.kind, status: i.status, title: i.title, detail: i.detail,
      result: i.result && { text: i.result.text, stderr: i.result.stderr, diff: i.result.diff, isError: i.result.isError },
      output: i.output, pics: i.pics };
  }
}
export function webTail(t: PhoneTail) {
  return { session: webSession(t.session), items: t.items.map(webItem), permissions: t.permissions, questions: t.questions,
    queue: webQueue(t.queue), todos: t.todos.map(t => ({ id: t.id, content: t.content, status: t.status, activeForm: t.activeForm })), suggestion: t.suggestion, total: t.total, seq: t.seq,
    cursor: t.cursor, next: t.next, at: t.at, queueTotal: t.queueTotal, promptsCursor: t.promptsCursor,
    permissionsTotal: t.permissionsTotal, questionsTotal: t.questionsTotal };
}
export function webQueue(rows: PhoneTail['queue']) {
  return rows.map(q => ({ id: q.id, text: q.text, createdAt: q.createdAt, attachments: q.attachments }));
}
// Complex live changes invalidate the bounded page. Their raw payload never goes on the web wire.
export function webEvent(e: BridgeEvent, watched: readonly string[]) {
  switch (e.type) {
    case 'session.added': return { type: e.type, session: webSession(e.session) };
    case 'session.updated': return { type: e.type, id: e.id, patch: sessionFields(e.patch) };
    case 'session.removed': return { type: e.type, id: e.id };
    case 'item.delta': return watched.includes(e.sessionId) && e.field === 'text'
      ? { type: e.type, sessionId: e.sessionId, id: e.id, seq: e.seq, field: e.field, delta: e.delta } : null;
    case 'permission.added': case 'question.added':
      return watched.includes(e.request.sessionId) ? { type: 'phone.stale', sessionId: e.request.sessionId, of: e.type } : null;
    case 'permission.removed': case 'question.removed': case 'queue.updated': case 'todos.updated':
    case 'suggestion': case 'item.added': case 'item.removed': case 'item.patch': case 'timeline.reset':
      return watched.includes(e.sessionId) ? { type: 'phone.stale', sessionId: e.sessionId, of: e.type } : null;
    default: return null;
  }
}
