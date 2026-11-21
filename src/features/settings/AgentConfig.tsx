import { useEffect, useState } from 'react';
import type { AgentConfigFile, ConfigPermissions, ProviderId } from '@shared/protocol';
import { CodeBlock } from '@/components/CodeBlock';
import { Icon, type IconName } from '@/icons';
import { bridge } from '@/lib/bridge';
import { relPath } from '@/lib/format';
import { useStore } from '@/state/store';
import { CodeChip } from './parts';

/**
 * The agents' own settings files as the bridge reads them (`config.read`): permission
 * rules and hooks per scope, read-only. Shared by Permissions and Hooks.
 */

const cache = new Map<string, AgentConfigFile[]>();

/** Config files for a provider and folder. Cached per pair and refreshed on every mount. */
export function useAgentConfig(provider: ProviderId, cwd: string | null): { files?: AgentConfigFile[]; error?: string } {
  const ready = useStore((s) => s.ready);
  const key = `${provider}\u0000${cwd ?? ''}`;
  const [state, setState] = useState<{ key: string; files?: AgentConfigFile[]; error?: string }>(() => ({ key, files: cache.get(key) }));

  useEffect(() => {
    if (!ready) return;
    let live = true;
    bridge
      .call('config.read', { provider, cwd: cwd ?? undefined })
      .then((files) => {
        cache.set(key, files);
        if (live) setState({ key, files });
      })
      .catch((err: Error) => live && setState({ key, files: cache.get(key), error: err.message || String(err) }));
    return () => {
      live = false;
    };
  }, [ready, provider, cwd, key]);

  return state.key === key ? state : { files: cache.get(key) };
}

export const SCOPE_NAME: Record<AgentConfigFile['scope'], string> = { user: 'User', project: 'Project', local: 'Local' };

export const SCOPE_HELP: Record<AgentConfigFile['scope'], string> = {
  user: 'Every project on this computer',
  project: 'This project, shared with the team',
  local: 'This project, only you',
};

/** Scope name, what it covers, and the file path as a copyable chip. */
export function FileHead({ file, cwd }: { file: AgentConfigFile; cwd: string | null }) {
  const home = useStore((s) => s.home);
  return (
    <div className="cfg-head">
      <div className="cfg-head-text">
        <span className="cfg-scope">{SCOPE_NAME[file.scope]}</span>
        <span className="cfg-scope-help">{SCOPE_HELP[file.scope]}</span>
      </div>
      <CodeChip text={relPath(file.path, cwd, home)} label="Copy path" />
    </div>
  );
}

const KINDS: { id: 'allow' | 'ask' | 'deny'; label: string; icon: IconName }[] = [
  { id: 'allow', label: 'Allow', icon: 'check-circle' },
  { id: 'ask', label: 'Ask', icon: 'question' },
  { id: 'deny', label: 'Deny', icon: 'prohibit' },
];

const ruleCount = (p?: ConfigPermissions) => (p ? p.allow.length + p.ask.length + p.deny.length : 0);

/** One settings file's allow / ask / deny rules. */
export function RuleFile({ file, cwd }: { file: AgentConfigFile; cwd: string | null }) {
  const p = file.permissions;
  const extras = !!p?.defaultMode || !!p?.additionalDirectories.length;
  return (
    <div className="cfg-file">
      <FileHead file={file} cwd={cwd} />
      {!file.exists ? (
        <p className="cfg-empty">This file does not exist.</p>
      ) : file.error ? (
        <p className="cfg-empty" data-tone="error">
          <Icon name="warning" size={14} />
          {file.error}
        </p>
      ) : !ruleCount(p) && !extras ? (
        <p className="cfg-empty">No rules in this file</p>
      ) : (
        <div className="cfg-rules">
          {KINDS.map(({ id, label, icon }) =>
            p && p[id].length ? (
              <div key={id} className="cfg-kind" data-kind={id}>
                <span className="cfg-kind-label">
                  <Icon name={icon} size={14} />
                  {label}
                </span>
                <ul className="cfg-chips" aria-label={`${label} rules`}>
                  {p[id].map((rule, i) => (
                    <li key={`${rule}-${i}`} className="rule-chip" data-kind={id}>
                      {rule}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {p?.defaultMode && (
            <div className="cfg-kind">
              <span className="cfg-kind-label">
                <Icon name="shield" size={14} />
                Mode
              </span>
              <ul className="cfg-chips">
                <li className="rule-chip">{p.defaultMode}</li>
              </ul>
            </div>
          )}
          {!!p?.additionalDirectories.length && (
            <div className="cfg-kind">
              <span className="cfg-kind-label">
                <Icon name="folder" size={14} />
                Folders
              </span>
              <ul className="cfg-chips">
                {p.additionalDirectories.map((d) => (
                  <li key={d} className="rule-chip">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A config file shown as text: Codex's TOML, OpenCode's JSON with comments. */
export function TomlFile({ file }: { file: AgentConfigFile }) {
  const home = useStore((s) => s.home);
  const jsonc = file.format === 'jsonc';
  const agent = jsonc ? 'OpenCode' : 'Codex';
  return (
    <div className="cfg-file">
      <div className="cfg-head">
        <div className="cfg-head-text">
          <span className="cfg-scope">{jsonc ? (file.scope === 'project' ? 'Project config' : 'User config') : 'Config file'}</span>
          <span className="cfg-scope-help">{jsonc ? 'Permissions, MCP servers, models and everything else OpenCode reads' : 'Approval policy, sandbox and everything else Codex reads'}</span>
        </div>
        <CodeChip text={relPath(file.path, null, home)} label="Copy path" />
      </div>
      {!file.exists ? (
        <p className="cfg-empty">No config file yet. {agent} runs with its defaults.</p>
      ) : file.error ? (
        <p className="cfg-empty" data-tone="error">
          <Icon name="warning" size={14} />
          {file.error}
        </p>
      ) : !file.raw?.trim() ? (
        <p className="cfg-empty">The file is empty.</p>
      ) : (
        <div className="cfg-code">
          <CodeBlock code={file.raw} lang={jsonc ? 'json' : 'toml'} title={jsonc ? relPath(file.path, null, home).split(/[\/]/).pop() : 'config.toml'} maxHeight={420} />
          <p className="cfg-note">{file.truncated ? 'Showing the first 64 KB. ' : ''}Values that look like secrets are hidden.</p>
        </div>
      )}
    </div>
  );
}
