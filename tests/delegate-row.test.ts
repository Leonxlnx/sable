import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { worksInBackground } from '@shared/background';
import { agentLine, delegateRetry, delegateWord, isAgentLive } from '@/features/timeline/agent-line';
import { agentsHeader, liveKey, outcomeOf, overview } from '@/features/rail/agents-model';

// A task handed to the other agent (delegate_to_codex / delegate_to_claude), as the bridge writes its
// row (server/core/sub-agent.ts): what the row says of its report, and that a report that waits is
// never counted as a child that works.
const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const row = (over: Partial<ToolItem> = {}): ToolItem => ({ id: 'd', ts: 1000, type: 'tool', name: 'mcp__sable__delegate_to_codex', kind: 'agent', title: 'Review the token refresh', status: 'done', detail: { subagent: 'Codex' }, ...over });

/** The rows as the bridge leaves them at each stage of a detached child. */
const working = row({ status: 'running', delegateReport: 'working', result: { agent: { background: 'running' } } });
const stopping = row({ status: 'running', delegateReport: 'stopping', result: { agent: { background: 'running' } } });
const pending = row({ endedAt: 9000, delegateReport: 'pending', result: { text: 'Report', agent: { background: 'done' } } });
const failed = row({ status: 'error', endedAt: 9000, delegateReport: 'pending', result: { text: 'It broke', isError: true, agent: { background: 'failed' } } });
const lost = row({ status: 'cancelled', endedAt: 9000, delegateReport: 'pending', result: { text: 'Sable restarted before the sub-agent reported.', isError: true, agent: { background: 'stopped' } } });
const held = (why: 'budget' | 'stop') => ({ ...pending, delegateWait: why });
const delivered = row({ endedAt: 9000, delegateReport: 'delivered', result: { text: 'Report', agent: { background: 'done' } } });
const stopped = row({ status: 'cancelled', endedAt: 9000, delegateReport: 'stopped', result: { text: 'The sub-agent stopped before it finished.', isError: true, agent: { background: 'stopped' } } });
/** A fork's copy: the answer, no delivery fields. */
const history = row({ endedAt: 9000, result: { text: 'Report' } });

describe('where a handed-over task’s report stands', () => {
  it('says Stopping, Report pending, or With your next message, and nothing otherwise', () => {
    expect(delegateWord(stopping)).toBe('Stopping');
    expect(delegateWord(pending)).toBe('Report pending');
    expect(delegateWord(held('budget'))).toBe('With your next message');
    expect(delegateWord(held('stop'))).toBe('With your next message');
    // A hold the bridge lifted (`null` in a patch) is a plain pending report again.
    expect(delegateWord({ ...pending, delegateWait: null })).toBe('Report pending');
    for (const it of [working, delivered, stopped, history, row({ delegateWait: 'budget' })]) expect(delegateWord(it)).toBe('');
  });

  it('stands after how it ended in the conversation’s line', () => {
    expect(agentLine(pending, 5)).toEqual({ state: 'Done', report: 'Report pending', parts: ['5 steps'] });
    expect(agentLine(held('budget'), 5)).toEqual({ state: 'Done', report: 'With your next message', parts: ['5 steps'] });
    expect(agentLine(failed, 2)).toEqual({ state: 'Failed', tone: 'error', report: 'Report pending', parts: ['2 steps'] });
    expect(agentLine(lost, 0)).toMatchObject({ state: 'Interrupted', report: 'Report pending' });
  });

  it('goes once the report is delivered, and a fork’s copy is plain history', () => {
    expect(agentLine(delivered, 5)).toEqual({ state: 'Done', parts: ['5 steps'] });
    expect(agentLine(delivered, 5)).not.toHaveProperty('report');
    expect(agentLine(history, 5)).toEqual({ state: 'Done', parts: ['5 steps', '8s'] });
    expect(agentLine(stopped, 0)).toMatchObject({ state: 'Interrupted' });
    expect(agentLine(stopped, 0)).not.toHaveProperty('report');
  });
});

describe('who counts as working', () => {
  it('a detached child that still works does, also while it is stopping', () => {
    for (const it of [working, stopping]) {
      expect(isAgentLive(it)).toBe(true);
      expect(worksInBackground(it)).toBe(true);
    }
  });

  it('a report that waits does not, by the bridge’s rule and by the window’s', () => {
    for (const it of [pending, failed, lost, held('budget'), held('stop'), delivered, stopped, history]) {
      expect(worksInBackground(it), it.delegateReport).toBe(false);
      expect(isAgentLive(it), it.delegateReport).toBe(false);
    }
    // Even a row whose launch result was never brought up to date.
    expect(isAgentLive({ ...pending, result: { agent: { background: 'running' } } })).toBe(false);
  });

  it('the Agents tab files it under what finished and counts no one working', () => {
    const rows = [working, { ...pending, id: 'p' }, { ...failed, id: 'f' }, { ...held('budget'), id: 'h' }];
    const items: Record<string, TimelineItem> = Object.fromEntries(rows.map((r) => [r.id, r]));
    const ids = rows.map((r) => r.id);
    const live = liveKey(items, ids);
    expect(live).toBe('1000');
    const view = overview(ids, live, items, []);
    expect(view.working).toEqual(['d']);
    expect(view.done).toBe(3);
    expect(view.failed).toBe(1);
    // Nothing left working: the header counts what ended, the failure apart.
    const rest = ids.slice(1);
    const after = overview(rest, liveKey(items, rest), items, []);
    expect(after.working).toEqual([]);
    expect(agentsHeader({ working: after.working.length, running: 0, agentsDone: after.done, agentsFailed: after.failed, commands: 0, commandsFailed: 0 })).toEqual({ label: '2 done', failed: 1 });
    expect(outcomeOf(failed)).toBe('failed');
    expect(outcomeOf(pending)).toBe('done');
  });
});

// A report that went out and whose receipt the bridge looks up or could not find
// (`ToolItem.delegateReceiptState`, scratch/day7/report-fix-r35e.md): the row says so ahead of its
// other words, and for an unknown delivery offers the one decision.
describe('a report whose delivery is not known', () => {
  const TOKEN = '3f2b6c1e-8a4d-4f0b-9c2e-5d7a1b0e6f42';
  const checking = { ...pending, delegateReceiptState: 'checking' as const };
  const unknown = { ...pending, delegateReceiptState: 'unknown' as const, delegateRetryId: TOKEN, delegateWait: null };

  it('says Checking delivery and Delivery unknown ahead of the other words', () => {
    expect(delegateWord(checking)).toBe('Checking delivery');
    expect(delegateWord(unknown)).toBe('Delivery unknown');
    // Ahead of a hold and of a stop: what is not known about the report that went out comes first.
    expect(delegateWord({ ...held('budget'), delegateReceiptState: 'checking' })).toBe('Checking delivery');
    expect(delegateWord({ ...held('stop'), delegateReceiptState: 'unknown' })).toBe('Delivery unknown');
    expect(delegateWord({ ...stopping, delegateReceiptState: 'unknown' })).toBe('Delivery unknown');
    // Decided or found (`null` in a patch): the ordinary word again.
    expect(delegateWord({ ...pending, delegateReceiptState: null })).toBe('Report pending');
    expect(delegateWord({ ...held('budget'), delegateReceiptState: null })).toBe('With your next message');
    expect(delegateWord({ ...delivered, delegateReceiptState: null })).toBe('');
  });

  it('stands after how it ended in the conversation’s line', () => {
    expect(agentLine(checking, 5)).toEqual({ state: 'Done', report: 'Checking delivery', parts: ['5 steps'] });
    expect(agentLine(unknown, 5)).toEqual({ state: 'Done', report: 'Delivery unknown', parts: ['5 steps'] });
    expect(agentLine({ ...failed, delegateReceiptState: 'unknown', delegateRetryId: TOKEN }, 2)).toEqual({ state: 'Failed', tone: 'error', report: 'Delivery unknown', parts: ['2 steps'] });
  });

  it('is never counted as working, in either state', () => {
    for (const it of [checking, unknown]) {
      expect(worksInBackground(it)).toBe(false);
      expect(isAgentLive(it)).toBe(false);
      expect(outcomeOf(it)).toBe('done');
    }
  });

  it('offers the bridge’s own command with the decision’s token, only where there is a decision', () => {
    expect(delegateRetry(unknown)).toBe(`/report-retry ${TOKEN}`);
    // What the bridge's handler takes (server/app.ts): the command and a token, nothing else.
    expect(delegateRetry(unknown)).toMatch(/^\/report-retry\s+([\da-f-]{36})$/i);
    expect(read('server/app.ts')).toContain('/^\\/report-retry\\s+([\\da-f-]{36})$/i.exec(text.trim())');
    // A lookup still running, a decision taken (the token cleared), no receipt in doubt: nothing to press.
    expect(delegateRetry(checking)).toBeNull();
    expect(delegateRetry({ ...checking, delegateRetryId: TOKEN })).toBeNull();
    expect(delegateRetry({ ...unknown, delegateRetryId: null })).toBeNull();
    expect(delegateRetry({ delegateReceiptState: null, delegateRetryId: null })).toBeNull();
    expect(delegateRetry(pending)).toBeNull();
    expect(delegateRetry(history)).toBeNull();
  });

  it('the action sends that command as the composer would and takes no second press meanwhile', () => {
    const again = read('src/features/timeline/ReportAgain.tsx');
    expect(again).toContain("import { sendMessage } from '@/state/actions';");
    expect(again).toMatch(/const command = delegateRetry\(item\);[\s\S]*if \(!command\) return null;/);
    expect(again).toMatch(/if \(sending\) return;\s*setSending\(true\);\s*await sendMessage\(sessionId, command\);\s*setSending\(false\);/);
    expect(again).toMatch(/aria-disabled=\{sending \|\| undefined\}/);
    expect(again).toContain('{DELEGATE_RETRY_LABEL}');
    expect(read('src/features/timeline/delegate-word.ts')).toContain("export const DELEGATE_RETRY_LABEL = 'Send report again';");
    // No action of its own was added for it.
    expect(read('src/state/actions.ts')).not.toMatch(/report-retry|reportRetry|retryReport/);
  });

  it('is drawn on the conversation’s line after the word, and under the row in the Agents tab', () => {
    const block = read('src/features/timeline/Agent.tsx');
    const at = block.indexOf('<ReportAgain sessionId={sessionId} item={item} className="agent-again" />');
    expect(at).toBeGreaterThan(block.indexOf('<span>{line.report}</span>'));
    expect(at).toBeLessThan(block.indexOf('{line.parts.map((p) => ('));
    const tab = read('src/features/rail/AgentsTab.tsx');
    // The row is one button: the action is its sibling, never inside it.
    expect(tab).toMatch(/<\/button>\s*\{\/\*[^*]*\*\/\}\s*\{delegateRetry\(item\) && \(\s*<div className="agx-again">\s*<ReportAgain sessionId=\{sessionId\} item=\{item\} className="agx-goto" \/>\s*<\/div>\s*\)\}\s*<Collapse open=\{open\}>/);
    const css = read('src/features/timeline/timeline.css');
    expect(css).toMatch(/\n\.agent-again \{[^}]*height: 22px;[^}]*font-size: 12px;[^}]*color: var\(--text-2\);/);
    expect(css).toMatch(/\n\.agent-again:focus-visible \{\s*outline: var\(--focus-w\) solid var\(--focus\);/);
    expect(read('src/features/rail/agents.css')).toMatch(/\n\.agx-again \{[^}]*height: var\(--rail-row-h\);[^}]*padding-left: calc\(var\(--agx-inset\) \+ 1px \+ var\(--agx-indent\)\);/);
  });

  it('on the phone the same words lead the row (the model is shared)', () => {
    expect(read('mobile/src/screens/Timeline.tsx')).toMatch(/const report = delegateWord\(it\);/);
    expect(read('src/features/timeline/delegate-word.ts')).not.toMatch(/from '@\//);
  });
});

describe('where the word is drawn', () => {
  it('in the conversation: after the state on the settled line, and "Stopping" on the live row', () => {
    const block = read('src/features/timeline/Agent.tsx');
    expect(block).toMatch(/const stopping = live && delegateWord\(item\) === 'Stopping';/);
    expect(block).toMatch(/\) : stopping \? \(\s*<span>Stopping<\/span>\s*\) : live \? \(/);
    expect(block).toMatch(/\{line\.report && \(\s*<>\s*<span className="agent-dot" aria-hidden>\s*·\s*<\/span>\s*<span>\{line\.report\}<\/span>\s*<\/>\s*\)\}/);
    expect(block.indexOf('{line.report && (')).toBeLessThan(block.indexOf('{line.parts.map((p) => ('));
  });

  it('in the Agents tab: the row’s word, in the quiet tone whatever the outcome, and "Stopping" on the card', () => {
    const tab = read('src/features/rail/AgentsTab.tsx');
    expect(tab).toMatch(/const report = delegateWord\(item\);\s*const word = report \|\| \(outcome === 'done' \? '' : OUTCOME_WORD\[outcome\]\);/);
    expect(tab).toMatch(/<span className="agx-outcome" data-report=\{report \? '' : undefined\}>\{word\}<\/span>/);
    expect(tab).toMatch(/const doing = awaiting \? 'Needs your approval' : stopping \? 'Stopping' : now \|\|/);
    expect(read('src/features/rail/agents.css')).toMatch(/\n\.agx-row \.agx-outcome\[data-report\] \{\s*color: var\(--text-3\);\s*\}/);
  });

  it('on the phone: the same model, the word leading the row’s figures', () => {
    const screen = read('mobile/src/screens/Timeline.tsx');
    expect(screen).toMatch(/import \{ delegateWord \} from '@desk\/features\/timeline\/delegate-word';/);
    expect(screen).toMatch(/const report = delegateWord\(it\);/);
    expect(screen).toMatch(/\{report === 'Stopping' \? 'Stopping' : it\.status === 'error' \? 'Failed' :/);
    expect(screen).toMatch(/\{\[report !== 'Stopping' && report, stats\?\.steps \?/);
    // The model the phone imports brings nothing of the window with it.
    expect(read('src/features/timeline/delegate-word.ts')).not.toMatch(/from '@\//);
  });
});
