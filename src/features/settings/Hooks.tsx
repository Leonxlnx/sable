import { useMemo, useState } from 'react';
import type { AgentConfigFile, ConfigHook, ProviderId } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { FileHead, useAgentConfig } from './AgentConfig';
import { useInitialProvider } from './Models';
import { Card, CodeChip, Empty, ProviderPicker, Skeleton, useContextTarget, Scope } from './parts';

/** What each Claude Code hook event means, in plain words. */
const EVENTS: Record<string, { label: string; icon: IconName }> = {
  PreToolUse: { label: 'Before a tool runs', icon: 'wrench' },
  PostToolUse: { label: 'After a tool runs', icon: 'check-circle' },
  UserPromptSubmit: { label: 'When you send a prompt', icon: 'chat' },
  Notification: { label: 'When the agent needs you', icon: 'bell' },
  Stop: { label: 'When the agent finishes', icon: 'stop' },
  SubagentStop: { label: 'When a sub-agent finishes', icon: 'agents' },
  PreCompact: { label: 'Before the context is compacted', icon: 'context' },
  SessionStart: { label: 'When a session starts', icon: 'play' },
  SessionEnd: { label: 'When a session ends', icon: 'sign-out' },
};

export function Hooks() {
  const [provider, setProvider] = useState<ProviderId>(useInitialProvider());
  const { cwd } = useContextTarget();

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        <ProviderPicker id="set-hooks-provider" value={provider} onChange={setProvider} />
        <span className="grow" />
        {provider !== 'codex' && provider !== 'opencode' && <Scope cwd={cwd} />}
      </div>
      {provider === 'opencode' ? (
        <div className="card set-card">
          <Empty>
            <span>
              OpenCode has no hooks. It loads plugins from <CodeChip text="~/.config/opencode/plugins" copy={false} /> and from a project's <CodeChip text=".opencode/plugins" copy={false} />.
            </span>
          </Empty>
        </div>
      ) : provider === 'codex' ? (
        <div className="card set-card">
          <Empty>
            <span>
              Codex has no hooks. It can run a <CodeChip text="notify" copy={false} /> command when a turn ends, set in its config file.
            </span>
          </Empty>
        </div>
      ) : (
        <HookFiles provider={provider} cwd={cwd} />
      )}
      <p className="set-foot-note">Hooks are edited in the agent's settings files. Sable shows them here as they are.</p>
    </div>
  );
}

function HookFiles({ provider, cwd }: { provider: ProviderId; cwd: string | null }) {
  const { files, error } = useAgentConfig(provider, cwd);
  if (!files) {
    return <div className="card set-card">{error ? <Empty>Could not read the settings files: {error}</Empty> : <Skeleton rows={3} />}</div>;
  }
  return (
    <div className="card set-card">
      {files.map((f) => (
        <HookFile key={f.path} file={f} cwd={cwd} />
      ))}
    </div>
  );
}

function HookFile({ file, cwd }: { file: AgentConfigFile; cwd: string | null }) {
  const groups = useMemo(() => {
    const by = new Map<string, ConfigHook[]>();
    for (const h of file.hooks ?? []) by.set(h.event, [...(by.get(h.event) ?? []), h]);
    return [...by];
  }, [file.hooks]);

  return (
    <div className="cfg-file">
      <FileHead file={file} cwd={cwd} />
      {!file.exists ? (
        <p className="cfg-empty">This file does not exist.</p>
      ) : file.error ? (
        <p className="cfg-empty" data-tone="error">
          {file.error}
        </p>
      ) : !groups.length ? (
        <p className="cfg-empty">No hooks in this file</p>
      ) : (
        <div className="hook-events">
          {groups.map(([event, hooks]) => {
            const meta = EVENTS[event];
            return (
              <section key={event} className="hook-event" aria-label={event}>
                <header className="hook-event-head">
                  <Icon name={meta?.icon ?? 'hook'} size={15} className="hook-event-icon" />
                  <span className="hook-event-label">{meta?.label ?? event}</span>
                  <code className="hook-event-key">{event}</code>
                </header>
                <ul className="hook-list">
                  {hooks.map((h, i) => (
                    <li key={i} className="hook-row">
                      {h.matcher && (
                        <span className="hook-matcher" title="Runs for tools matching this pattern">
                          {h.matcher}
                        </span>
                      )}
                      {h.type !== 'command' && <span className="hook-type">{h.type}</span>}
                      <code className="hook-cmd">{h.command || '(empty)'}</code>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
