import { expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TimelineItem } from '../shared/protocol';
import { READ, SessionFiles } from '../server/core/session-file';
import { cutItem, cutItems, LIGHT, OLD } from '../server/core/trim';
import { figuresOf, isBackgroundCommand, outcomeOf } from '../src/features/rail/agents-model';
import { agentLine, agentTask, agentType } from '../src/features/timeline/agent-line';
import { foldedTurn } from '../src/features/timeline/changes';
import { marksOf } from '../src/features/timeline/nav-model';
import { errorText, hasDetails, hasThumbnail, rowText, thinkingRow } from '../src/features/timeline/step-row';
import { groupTurns, shapeOf } from '../src/features/timeline/turns';
import { lastDevUrl } from '../src/lib/dev-url';
import { previewTargets } from '../src/lib/links';

function row(it: TimelineItem) {
  if (it.type === 'thinking') return [it.id, it.parentId, it.ts, it.endedAt, thinkingRow(it, true), thinkingRow(it, false)];
  if (it.type === 'user') return [it.id, it.ts, it.text, it.state, it.remote, it.steered, it.attachments?.map(a => [a.id, a.name, a.kind, a.size, a.path, hasThumbnail(a, it.more)])];
  if (it.type !== 'tool') return it;
  const r = it.result;
  return [it.id, it.parentId, it.ts, it.endedAt, it.waitedMs, it.name, it.kind, it.title, it.status,
    rowText(it, 'C:/w', ''), errorText(it), hasDetails(it), it.task, it.handed, it.check, it.workflow,
    r?.exitCode, r?.interrupted, r?.isError, r?.count, r?.file?.numLines, r?.links?.length, r?.answers,
    r?.diff?.map(d => [d.path, d.oldPath, d.status, d.additions, d.deletions, d.binary]),
    isBackgroundCommand(it),
    it.kind === 'agent' && [agentTask(it), agentType(it), agentLine(it, 0), outcomeOf(it), figuresOf(it)],
    it.kind === 'bash' && (lastDevUrl(it.output, it.detail.command) ?? lastDevUrl(r?.text, it.detail.command)),
    it.kind === 'bash' && previewTargets([it.output, r?.text], 6),
  ];
}

function turns(items: TimelineItem[]) {
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const roots = items.filter(i => !i.parentId);
  const children: Record<string, string[]> = {};
  for (const item of items) if (item.parentId) (children[item.parentId] ??= []).push(item.id);
  const layout = groupTurns(roots.map(i => i.id), roots.map(shapeOf).join(''), false);
  return { layout, marks: marksOf(layout.groups, byId, new WeakMap()),
    totals: layout.groups.flatMap(g => g.kind === 'turn' ? [foldedTurn(byId, children, g)] : []) };
}

export function expectSameRows(items: TimelineItem[]) {
  const rows = items.map(it => cutItem(it, OLD));
  rows.forEach((it, i) => {
    expect(row(it), it.id).toEqual(row(items[i]));
    expect(cutItem(cutItem(items[i]), OLD), it.id).toEqual(it);
  });
  expect(turns(rows)).toEqual(turns(items));

  // Run the same Demo and synthetic corpora through the indexed reader. Compare
  // the stored projections directly, before the socket has a chance to cut again.
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-cut-corpus-'));
  const file = path.join(dir, 'corpus.json'), threshold = READ.inWorkerAbove;
  try {
    const lines = items.map(i => JSON.stringify(i));
    writeFileSync(file, '{"gen":42,"items":[\n' + lines.join(',\n') + '\n],"todos":[]}');
    const expected = cutItems(lines.map(s => JSON.parse(s)));
    READ.inWorkerAbove = 1;
    const loaded = new SessionFiles(() => file).load('corpus');
    expect(loaded.unreadable).toBeUndefined();
    expect(loaded.items.map(it => {
      const { [LIGHT]: _, ...row } = it as TimelineItem & { [LIGHT]?: unknown };
      return row;
    })).toStrictEqual(expected);
  } finally {
    READ.inWorkerAbove = threshold;
    rmSync(dir, { recursive: true, force: true });
  }
}
