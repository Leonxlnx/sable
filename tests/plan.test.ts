import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '../shared/protocol';
import { connectableAgents, planBeside, planLabel } from '../src/features/connect/plan';

const auth = (plan?: string, method?: string) => ({ loggedIn: true, plan, method });

describe('planLabel', () => {
  it('names the subscription in plain words', () => {
    expect(planLabel(auth('max', 'claude.ai'))).toBe('Max plan');
    expect(planLabel(auth('pro', 'chatgpt'))).toBe('Pro plan');
    expect(planLabel(auth('claude_max'))).toBe('Max plan');
    expect(planLabel(auth('chatgptPlus'))).toBe('Plus plan');
    expect(planLabel(auth('Max 20x'))).toBe('Max 20x plan');
    expect(planLabel(auth('max20x'))).toBe('Max 20x plan');
    expect(planLabel(auth('team'))).toBe('Team plan');
    expect(planLabel(auth('Enterprise plan'))).toBe('Enterprise plan');
  });

  it('says API key for key sign-ins and falls back to the kind of sign-in', () => {
    expect(planLabel(auth(undefined, 'apiKey'))).toBe('API key');
    expect(planLabel(auth('pro', 'api_key'))).toBe('API key');
    expect(planLabel(auth(undefined, 'claude.ai'))).toBe('Claude subscription');
    expect(planLabel(auth(undefined, 'chatgpt'))).toBe('ChatGPT subscription');
    expect(planLabel(auth(undefined, 'something'))).toBeUndefined();
  });

  it('has nothing to say when signed out or local', () => {
    expect(planLabel({ loggedIn: false, plan: 'max' })).toBeUndefined();
    expect(planLabel(auth('Whatever', 'local'))).toBeUndefined();
    expect(planLabel(undefined)).toBeUndefined();
  });
});

describe('connectableAgents', () => {
  it('lists Claude Code and Codex first, then reported agents that need an account', () => {
    const p = (id: string, method?: string) => ({ id, name: id, installed: true, auth: { loggedIn: true, method } }) as unknown as ProviderInfo;
    expect(connectableAgents({ demo: p('demo', 'local') })).toEqual(['claude', 'codex']);
    expect(connectableAgents({ codex: p('codex'), claude: p('claude') })).toEqual(['claude', 'codex']);
  });
});

describe('planBeside', () => {
  it('says the plan beside a name only when it adds something', () => {
    // The Demo agent's only account goes by the agent's name and its plan is called the same.
    expect(planBeside('Demo', 'Demo')).toBeUndefined();
    expect(planBeside('Demo', 'Demo plan')).toBeUndefined();
    expect(planBeside('Max', 'Max plan')).toBeUndefined();
    expect(planBeside('Claude Code', 'Max')).toBe('Max');
    expect(planBeside('Work', 'Max plan')).toBe('Max plan');
    expect(planBeside(undefined, 'Pro')).toBe('Pro');
    expect(planBeside('Demo', undefined)).toBeUndefined();
  });
});
