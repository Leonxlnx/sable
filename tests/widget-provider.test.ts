import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type BridgeEvent, type TimelineItem, type ToolItem } from '@shared/protocol';
import { groupTurns, shapeOf } from '@/features/timeline/turns';
import { widgetSource } from '@/features/genui/partial';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import { describeTool, peekPartialInput } from '../server/providers/claude-tools';
import { draftItem } from '../server/providers/codex-map';
import { CodexProvider } from '../server/providers/codex';
import { DemoProvider } from '../server/providers/demo';
import { WIDGET_DESCRIPTION, WIDGET_FENCE_HINT, WIDGET_SERVER, WIDGET_SHOWN, WIDGET_TOOL, WIDGET_TOOL_ID, dynamicToolAnswer, isWidgetTool, widgetResult } from '../server/providers/widget-tool';

const ctx = (settings: Partial<AppSettings>) => ({ emit: () => {}, log: () => {}, settings: () => ({ ...DEFAULT_SETTINGS, replyFirst: false, ...settings }) });
const meta = { cwd: process.cwd(), model: '', mode: 'default' };

describe('Claude: the show_widget tool', () => {
  it('is offered through an in-process MCP server, allowed without asking, while the setting is on', () => {
    const opts = new ClaudeProvider(ctx({})).agentOptions(meta, {});
    const server = opts.mcpServers?.[WIDGET_SERVER] as { type: string; name: string; instance: unknown } | undefined;
    expect(server?.type).toBe('sdk');
    expect(server?.name).toBe(WIDGET_SERVER);
    expect(server?.instance).toBeTruthy();
    expect(opts.allowedTools).toContain(WIDGET_TOOL_ID);
    expect(WIDGET_TOOL_ID).toBe('mcp__sable__show_widget');
  });

  it('is absent when generative UI is off', () => {
    // The same server carries the Browser tab tools: with those off too, there is no server at all.
    const opts = new ClaudeProvider(ctx({ generativeUi: false })).agentOptions({ ...meta, options: { browserTab: false } }, {});
    expect(opts.mcpServers?.[WIDGET_SERVER]).toBeUndefined();
    expect(opts.allowedTools ?? []).not.toContain(WIDGET_TOOL_ID);
    const browserOnly = new ClaudeProvider(ctx({ generativeUi: false })).agentOptions(meta, {});
    expect(browserOnly.allowedTools ?? []).not.toContain(WIDGET_TOOL_ID);
  });

  it('gives every agent process its own server instance (an instance serves one process)', () => {
    const p = new ClaudeProvider(ctx({}));
    const a = p.agentOptions(meta, {}).mcpServers?.[WIDGET_SERVER] as { instance: unknown };
    const b = p.agentOptions(meta, {}).mcpServers?.[WIDGET_SERVER] as { instance: unknown };
    expect(a.instance).not.toBe(b.instance);
  });

  it('turns a call of the tool into a widget item, with the title peeked while it streams', () => {
    expect(describeTool(WIDGET_TOOL_ID, { title: 'Latency by route', code: '<svg/>' })).toEqual({ kind: 'widget', title: 'Latency by route', detail: {} });
    expect(describeTool(WIDGET_TOOL_ID, {}).kind).toBe('widget');
    const partial = '{"title":"Latency by route","code":"<div class=\\"x\\">';
    expect(describeTool(WIDGET_TOOL_ID, peekPartialInput(partial)).title).toBe('Latency by route');
    expect(widgetSource(undefined, partial)).toEqual({ title: 'Latency by route', code: '<div class="x">', final: false });
  });
});

describe('Codex: the show_widget dynamic tool', () => {
  it('is defined for new threads while the setting is on, and not when it is off', () => {
    const on = new CodexProvider(ctx({})).dynamicTools();
    expect(on).toHaveLength(1);
    expect(on![0]).toMatchObject({ type: 'function', name: WIDGET_TOOL, description: WIDGET_DESCRIPTION });
    expect(((on![0] as { inputSchema: unknown }).inputSchema as { required: string[] }).required).toEqual(['title', 'code']);
    expect(new CodexProvider(ctx({ generativeUi: false })).dynamicTools()).toBeUndefined();
  });

  it('answers item/tool/call for the widget, and refuses other names', () => {
    expect(dynamicToolAnswer({ tool: 'show_widget', arguments: { title: 'T', code: '<p>x</p>' } })).toEqual({ contentItems: [{ type: 'inputText', text: WIDGET_SHOWN }], success: true });
    expect(dynamicToolAnswer({ tool: 'show_widget', arguments: { title: 'T', code: '' } }).success).toBe(false);
    expect(dynamicToolAnswer({ tool: 'rm_rf', arguments: {} }).success).toBe(false);
    expect(widgetResult({ code: 'x'.repeat(200_001) }).ok).toBe(false);
  });

  it('maps a dynamicToolCall item of the tool to a widget item', () => {
    const d = draftItem({ type: 'dynamicToolCall', id: 'c1', namespace: null, tool: 'show_widget', arguments: { title: 'Request path', code: '<svg></svg>' }, status: 'completed', contentItems: [{ type: 'inputText', text: 'ok' }], success: true } as never) as ToolItem;
    expect(d).toMatchObject({ type: 'tool', name: WIDGET_TOOL, kind: 'widget', title: 'Request path', status: 'done', input: { title: 'Request path', code: '<svg></svg>' } });
    const other = draftItem({ type: 'dynamicToolCall', id: 'c2', namespace: null, tool: 'lookup', arguments: {}, status: 'completed', contentItems: null, success: true } as never) as ToolItem;
    expect(other.kind).toBe('other');
  });

  it('adds one line to the developer instructions while on (the fenced-block path for threads without the tool)', async () => {
    const rpc = { request: async () => ({ config: { developer_instructions: null } }) };
    const on = new CodexProvider(ctx({ conciseReplies: false }));
    (on as unknown as { client: () => Promise<unknown> }).client = async () => rpc;
    expect(await on.developerInstructions('C:/proj')).toBe(WIDGET_FENCE_HINT);
    const off = new CodexProvider(ctx({ conciseReplies: false, generativeUi: false }));
    (off as unknown as { client: () => Promise<unknown> }).client = async () => rpc;
    expect(await off.developerInstructions('C:/proj')).toBeUndefined();
  });

  it('recognizes the tool under either agent', () => {
    expect(['show_widget', 'mcp__sable__show_widget', 'sable.show_widget'].every(isWidgetTool)).toBe(true);
    expect(isWidgetTool('show_widgets')).toBe(false);
  });
});

describe('timeline: a widget is part of the answer, never a folded step', () => {
  /** The pieces that are not steps, in order: texts, and what never folds (widgets, plans, errors). */
  const inView = (seg: { flow: { kind: string; id?: string }[] }) => seg.flow.filter((c) => c.kind === 'text' || c.kind === 'show').map((c) => c.id);
  const t = (ids: string) => {
    const parts = ids.split(/\s+/);
    return groupTurns(
      parts.map((p) => p.slice(1)),
      parts.map((p) => p[0]).join(''),
      false,
    );
  };
  it('keeps a widget in its place between the texts; the steps and the note along the way fold', () => {
    const g = t('U1 w2 t3 g4 w5 t6 T7').groups[0];
    if (g.kind !== 'turn') throw new Error('expected a turn');
    const s = g.segments[0];
    expect(inView(s)).toEqual(['3', '4', '6']);
    expect(s.notes).toEqual(['3']);
    expect(s.answer).toBe('6');
    expect(s.work).toEqual(['2', '5']);
    expect(s.steps).toBe(2);
  });
  it('keeps a widget that ends the turn, and one inside a failed turn', () => {
    const g = t('U1 w2 t3 g4 T5').groups[0];
    if (g.kind !== 'turn') throw new Error('expected a turn');
    expect(inView(g.segments[0])).toEqual(['3', '4']);
    const f = t('U1 g2 e3 F4').groups[0];
    if (f.kind !== 'turn') throw new Error('expected a turn');
    // The widget, then the error where it happened: neither folds.
    expect(inView(f.segments[0])).toEqual(['2', '3']);
    expect(f.segments[0].errors).toEqual(['3']);
  });
  it('reduces a widget tool item to "g"', () => {
    expect(shapeOf({ id: 'x', ts: 0, type: 'tool', name: WIDGET_TOOL_ID, kind: 'widget', title: 'T', status: 'running', detail: {} })).toBe('g');
  });
});

describe('demo: widgets stream like a real agent sends them', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('streams the input as partial JSON, then completes it as a widget', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-widget-'));
    const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
    cleanup = async () => {
      await app.dispose();
      rmSync(home, { recursive: true, force: true });
    };
    const events: BridgeEvent[] = [];
    app.subscribe((e) => events.push(structuredClone(e)));
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: snap.session.id, text: 'show me a latency chart' });
    const start = Date.now();
    while ((rt.turnActive || rt.meta.status === 'running') && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 5));
    const widget = rt.items.find((i): i is ToolItem => i.type === 'tool' && i.kind === 'widget');
    expect(widget).toBeTruthy();
    expect(widget!.status).toBe('done');
    expect((widget!.input as { code: string }).code).toContain('<script>');
    const deltas = events.filter((e) => e.type === 'item.delta' && e.id === widget!.id && e.field === 'inputText');
    expect(deltas.length).toBeGreaterThan(10);
    // The first chunks carry the title before any code.
    const first = (deltas[0] as Extract<BridgeEvent, { type: 'item.delta' }>).delta;
    expect(first.startsWith('{"title":')).toBe(true);
    const shape = rt.items.map((i: TimelineItem) => shapeOf(i)).join('');
    expect(shape).toContain('g');
  });
});
