/**
 * A command step that outlives its own time limit is said to be not answering (the live line),
 * instead of counting on quietly for hours; the frames of widgets let the wheel through while the
 * conversation scrolls.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '@shared/protocol';

vi.stubGlobal('window', globalThis);

const { stallAt, STALL_GRACE_MS } = await import('../src/features/timeline/stall');
const { trackFrame, readerScrolls, framesPassThrough, SCROLL_REST_MS } = await import('../src/features/genui/frames');

const bash = (over: Partial<ToolItem> = {}): ToolItem => ({ id: 'b', type: 'tool', ts: 1000, name: 'Bash', kind: 'bash', title: 'Run command', status: 'running', detail: {}, ...over }) as ToolItem;

describe('a command past its own time limit', () => {
  it("Claude Code's Bash: 2 minutes unless the call names a limit", () => {
    expect(stallAt(bash())).toBe(1000 + 120_000 + STALL_GRACE_MS);
    expect(stallAt(bash({ input: { command: 'pnpm test', timeout: 600_000 } }))).toBe(1000 + 600_000 + STALL_GRACE_MS);
  });

  it("another agent's command: its own timeout_ms, else 10 minutes", () => {
    expect(stallAt(bash({ name: 'commandExecution', input: { timeout_ms: 5_000 } }))).toBe(1000 + 5_000 + STALL_GRACE_MS);
    expect(stallAt(bash({ name: 'commandExecution' }))).toBe(1000 + 600_000 + STALL_GRACE_MS);
  });

  it('never for one in the background, one that ended, or a step that is not a command', () => {
    expect(stallAt(bash({ input: { run_in_background: true } }))).toBe(0);
    expect(stallAt(bash({ detail: { background: true } }))).toBe(0);
    expect(stallAt(bash({ status: 'done' }))).toBe(0);
    expect(stallAt(bash({ kind: 'read' }))).toBe(0);
  });
});

describe('widget frames while the conversation scrolls', () => {
  it('let the pointer through, and take it again once the scroll rests', async () => {
    vi.useFakeTimers();
    const frame = { style: { pointerEvents: '' } } as unknown as HTMLIFrameElement;
    const forget = trackFrame(frame);
    readerScrolls();
    expect(framesPassThrough()).toBe(true);
    expect(frame.style.pointerEvents).toBe('none');
    // A frame that mounts mid-scroll arrives already transparent.
    const late = { style: { pointerEvents: '' } } as unknown as HTMLIFrameElement;
    const forgetLate = trackFrame(late);
    expect(late.style.pointerEvents).toBe('none');
    vi.advanceTimersByTime(SCROLL_REST_MS - 10);
    readerScrolls();
    vi.advanceTimersByTime(SCROLL_REST_MS - 10);
    expect(frame.style.pointerEvents).toBe('none');
    vi.advanceTimersByTime(20);
    expect(framesPassThrough()).toBe(false);
    expect(frame.style.pointerEvents).toBe('');
    expect(late.style.pointerEvents).toBe('');
    forget();
    forgetLate();
    vi.useRealTimers();
  });
});
