import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@shared/protocol';
import { aliasTarget, currentGeneration, effortName, familyOf, isUltraEffort, modelName, modelNameById, visibleModels } from '../src/lib/models';

describe('effort names', () => {
  it('names every level in sentence case, ultra included', () => {
    expect(effortName('minimal')).toBe('Minimal');
    expect(effortName('medium')).toBe('Medium');
    expect(effortName('xhigh')).toBe('Extra high');
    expect(effortName('max')).toBe('Max');
    expect(effortName('ultra')).toBe('Ultra');
    expect(effortName(undefined)).toBeUndefined();
  });

  it('only the ultra level reads as ultra', () => {
    expect(isUltraEffort('ultra')).toBe(true);
    expect(isUltraEffort('max')).toBe(false);
    expect(isUltraEffort(undefined)).toBe(false);
  });
});

// What the agents report today (trimmed).
const CLAUDE: ModelInfo[] = [
  { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', isDefault: true },
  { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { id: 'claude-fable-5-2[1m]', name: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks' },
  { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { id: 'haiku', name: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
];

const CODEX: ModelInfo[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', isDefault: true },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', description: 'GPT-6.1 Terra Codex model.' },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Previous generation workhorse model.' },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Older generation workhorse model.' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' },
];

// The same agent through another CLI build: versioned names, the alias describes itself by name only.
const CLAUDE_B: ModelInfo[] = [
  { id: 'default', name: 'Default (recommended)', description: 'Fable 5.2', isDefault: true },
  { id: 'opus', name: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { id: 'fable', name: 'Fable 5.2', description: 'For your toughest challenges' },
  { id: 'sonnet', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
  { id: 'haiku', name: 'Haiku 5.5', description: 'Fastest for quick answers' },
];

const ids = (ms: ModelInfo[]) => ms.map((m) => m.id);

describe('model names', () => {
  it('reads the versioned name from the description and resolves aliases', () => {
    expect(modelName(CLAUDE[2])).toBe('Fable 5.2');
    expect(modelName(CLAUDE[0])).toBe('Opus 5.5');
    expect(aliasTarget(CLAUDE[0])).toBe('Opus 5.5');
    expect(aliasTarget(CLAUDE[1])).toBeUndefined();
    expect(modelName(CODEX[2])).toBe('GPT-6.1 Terra');
    expect(modelName(CODEX[0])).toBe('GPT-6.1-Sol');
    expect(modelName(CLAUDE_B[0])).toBe('Fable 5.2');
    expect(aliasTarget(CLAUDE_B[0])).toBe('Fable 5.2');
    expect(modelName(CLAUDE_B[1])).toBe('Opus 5.5');
    expect(modelName({ id: 'default', name: 'Default', description: 'Recommended model for your plan' })).toBe('Default');
  });

  it('reads the alias that names its model in a sentence (Claude Code 2.1)', () => {
    const alias: ModelInfo = { id: 'default', name: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', isDefault: true };
    expect(aliasTarget(alias)).toBe('Opus 5.5');
    expect(modelName(alias)).toBe('Opus 5.5');
    const opus: ModelInfo = { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' };
    // Listed beside the model it names, the alias is left out of the menu; in use, it stands in for it.
    expect(ids(visibleModels('claude', [alias, opus], undefined))).toEqual(['opus']);
    expect(visibleModels('claude', [alias, opus], undefined, 'default').map(modelName)).toEqual(['Opus 5.5']);
  });

  it('names a model known only by its id', () => {
    expect(modelNameById('default', CLAUDE)).toBe('Opus 5.5');
    expect(modelNameById('claude-opus-5-5-20261101', CLAUDE)).toBe('Opus 5.5');
    expect(modelNameById('claude-fable-5-2[1m]', [])).toBe('Fable 5.2');
    expect(modelNameById('gpt-6.1-sol', undefined)).toBe('GPT-6.1-Sol');
    expect(modelNameById(undefined, CLAUDE)).toBeUndefined();
  });

  it('splits a name into family and version', () => {
    expect(familyOf('Fable 5.2')).toEqual({ family: 'fable', version: [5, 2] });
    expect(familyOf('GPT-6.1-Sol')).toEqual({ family: 'gpt sol', version: [6, 1] });
    expect(familyOf('GPT-6.1 Terra').family).toBe(familyOf('GPT-5.6-Terra').family);
    expect(familyOf('Demo Large')).toEqual({ family: 'demo large', version: [] });
  });
});

describe('visibleModels', () => {
  it('lists the current generation by default', () => {
    expect(ids(visibleModels('claude', CLAUDE, {}))).toEqual(['opus', 'claude-fable-5-2[1m]', 'sonnet', 'haiku']);
    expect(ids(visibleModels('claude', CLAUDE_B, {}))).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    expect(ids(visibleModels('claude', CLAUDE_B, {}, 'default'))).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(ids(visibleModels('codex', CODEX, {}))).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna']);
    expect(currentGeneration([{ id: 'a', name: 'Demo Large' }, { id: 'b', name: 'Demo Fast' }])).toEqual(new Set(['a', 'b']));
  });

  it('keeps an alias whose model is not listed', () => {
    const list = CLAUDE.filter((m) => m.id !== 'opus');
    expect(ids(visibleModels('claude', list, {}))).toContain('default');
  });

  it('lets overrides win both ways', () => {
    const out = visibleModels('codex', CODEX, { 'codex:gpt-5.6-sol': true, 'codex:gpt-6-luna': false });
    expect(ids(out)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-5.6-sol']);
  });

  it('always lists the model in use', () => {
    expect(ids(visibleModels('codex', CODEX, { 'codex:gpt-6-sol': false }, 'gpt-6-sol'))).toContain('gpt-6-sol');
    // An alias in use stands in for the model it names, so the name is not listed twice.
    const withAlias = visibleModels('claude', CLAUDE, {}, 'default');
    expect(ids(withAlias)).toEqual(['default', 'claude-fable-5-2[1m]', 'sonnet', 'haiku']);
  });

  it('never returns an empty menu', () => {
    const all = Object.fromEntries(CODEX.map((m) => [`codex:${m.id}`, false]));
    expect(visibleModels('codex', CODEX, all).length).toBeGreaterThan(0);
  });
});
