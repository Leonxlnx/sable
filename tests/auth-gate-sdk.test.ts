/**
 * The Agent SDK runs its Claude Code process through the account's gate (`spawnClaudeCodeProcess`):
 * a fake CLI that answers the SDK's initialize request, started twice for one config folder, starts
 * one after the other and still answers; closing the query lets it go.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AuthGate, GATE, gateKey } from '../server/core/auth-gate';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

/** Answers every control request with success (initialize gets an empty init), and exits when stdin closes. */
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'control_request') return;
  const response = m.request && m.request.subtype === 'initialize' ? { commands: [], models: [], agents: [], account: {}, output_style: 'default', available_output_styles: [] } : {};
  setTimeout(() => process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } }) + '\\n'), 150);
});
rl.on('close', () => process.exit(0));
`;

describe('the SDK through the gate', () => {
  it('two queries of one account start one after the other and both initialize', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-gate-sdk-'));
    temps.push(dir);
    const cli = path.join(dir, 'cli.js');
    writeFileSync(cli, FAKE);
    const gate = new AuthGate({ ...GATE, settleMs: 100, minLifeMs: 50 });
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, "acc") };
    delete env.SABLE_CLAUDE_BIN;
    const spawn = gate.spawner();
    const exits: Promise<void>[] = [];
    const make = () => {
      const input = (async function* () {
        await new Promise(() => {});
      })();
      return query({ prompt: input as never, options: { cwd: dir, env, pathToClaudeCodeExecutable: cli, executable: 'node', settingSources: [], spawnClaudeCodeProcess: (o) => { const p = spawn(o); exits.push(new Promise((r) => p.on('exit', () => r()))); return p; } } });
    };
    const a = make();
    const b = make();
    const [ia, ib] = await Promise.all([a.initializationResult(), b.initializationResult()]);
    expect(ia).toBeTruthy();
    expect(ib).toBeTruthy();
    const starts = gate.trace.filter((t) => t.kind === 'start' && t.key === gateKey('claude', path.join(dir, 'acc')));
    expect(starts).toHaveLength(2);
    expect(starts[1].at - starts[0].at).toBeGreaterThanOrEqual(150 + 100 - 30);
    a.close();
    b.close();
    // Both let go once asked (they had answered): nothing is left running.
    await Promise.all(exits);
    expect(exits).toHaveLength(2);
  }, 20_000);
});
