import { expect, it } from 'vitest';
import type { ToolItem } from '@shared/protocol';
import { CUT_AT, cutItem } from '../server/core/trim';

it.each(['command', 'monitor'] as const)('keeps the full result until the background %s ends', (kind) => {
  const step: ToolItem = {
    id: 'step', ts: 1, type: 'tool', name: 'Bash', kind: 'bash', title: 'Watch the build', status: 'done', detail: {},
    result: { text: 'x'.repeat(CUT_AT + 1) },
    task: { id: 'task', kind, state: 'running', since: 1 },
  };
  expect(cutItem(step) === step).toBe(true);
  expect(cutItem({ ...step, task: { ...step.task!, state: 'done' } })).toHaveProperty('more', true);
});
