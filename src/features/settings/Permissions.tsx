import { useState } from 'react';
import type { ProviderId } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Kbd } from '@/ui';
import { RuleFile, TomlFile, useAgentConfig } from './AgentConfig';
import { useInitialProvider } from './Models';
import { Card, CodeChip, Empty, ModeList, ProviderPicker, Skeleton, useContextTarget, useProviderCaps, Scope } from './parts';

export function Permissions() {
  const [provider, setProvider] = useState<ProviderId>(useInitialProvider());
  const target = useContextTarget();
  const homeCwd = useStore((s) => s.ui.homeCwd);
  const sameAsSession = target.sessionId && target.provider === provider;
  const cwd = sameAsSession ? target.cwd : homeCwd;
  const caps = useProviderCaps(provider, cwd, sameAsSession ? target.sessionId : null);
  const defaults = useStore((s) => s.settings.defaultModes);
  const modeId = defaults[provider] ?? caps?.modes[0]?.id;

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        <ProviderPicker id="set-perm-provider" value={provider} onChange={setProvider} />
      </div>

      <Card title="Default mode for new sessions">
        {!caps ? (
          <Skeleton rows={4} />
        ) : caps.modes.length ? (
          <ModeList
            modes={caps.modes}
            value={modeId}
            onChange={(id) => void setSettings({ defaultModes: { ...defaults, [provider]: id } })}
            label={`Default permission mode for ${PROVIDER_NAME[provider]}`}
          />
        ) : (
          <Empty>{PROVIDER_NAME[provider]} has no permission modes.</Empty>
        )}
      </Card>
      <p className="set-foot-note">Switch the mode of a running session from its composer, or with <Kbd combo="shift+tab" />.</p>

      <Rules provider={provider} cwd={cwd} />
    </div>
  );
}

function Rules({ provider, cwd }: { provider: ProviderId; cwd: string | null }) {
  const { files, error } = useAgentConfig(provider, cwd);
  const aside = provider !== 'codex' ? <Scope cwd={cwd} /> : undefined;

  return (
    <>
      <Card title="Rules" aside={aside}>
        {!files ? (
          error ? <Empty>Could not read the settings files: {error}</Empty> : <Skeleton rows={3} />
        ) : (
          files.map((f) => (f.format !== 'json' ? <TomlFile key={f.path} file={f} /> : <RuleFile key={f.path} file={f} cwd={cwd} />))
        )}
      </Card>
      <p className="set-foot-note">
        {provider === 'claude' ? (
          <>
            Read-only. Edit the files by hand, or run <CodeChip text="/permissions" copy={false} /> in a Claude Code terminal session. The most specific file wins, and deny beats allow.
          </>
        ) : provider === 'codex' ? (
          <>
            Read-only. Set <CodeChip text="approval_policy" copy={false} /> and <CodeChip text="sandbox_mode" copy={false} /> in the file to change what Codex may do without asking.
          </>
        ) : provider === 'opencode' ? (
          <>
            Read-only. Set <CodeChip text="permission" copy={false} /> in <CodeChip text="opencode.json" copy={false} /> to allow, ask or deny what OpenCode may do. Allow all answers every prompt with yes while a chat uses it.
          </>
        ) : (
          'An example of what rules look like. The demo agent does not read any files.'
        )}
      </p>
    </>
  );
}
