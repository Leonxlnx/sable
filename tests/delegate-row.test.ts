import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { worksInBackground } from '@shared/background';
import { agentLine, delegateWord, isAgentLive } from '@/features/timeline/agent-line';
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
