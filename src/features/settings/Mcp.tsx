import { useMemo, useState } from 'react';
import type { McpServerInfo } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { plural } from '@/lib/format';
import { fuzzy } from '@/lib/fuzzy';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { Card, CodeChip, Empty, SearchField, Skeleton, useContextTarget, useProviderCaps, Scope } from './parts';

const STATUS: Record<McpServerInfo['status'], { word: string; tone: string }> = {
  connected: { word: 'Connected', tone: 'green' },
  'needs-auth': { word: 'Needs sign-in', tone: 'amber' },
  failed: { word: 'Failed', tone: 'red' },
  pending: { word: 'Starting', tone: 'grey' },
  disabled: { word: 'Disabled', tone: 'grey' },
  configured: { word: 'Configured', tone: 'grey' },
};

const ORDER: McpServerInfo['status'][] = ['failed', 'needs-auth', 'connected', 'pending', 'configured', 'disabled'];

export function Mcp() {
  const { provider, cwd, sessionId } = useContextTarget();
  const caps = useProviderCaps(provider, cwd, sessionId);
  const [fresh, setFresh] = useState<{ sessionId: string; servers: McpServerInfo[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const toast = useStore((s) => s.toast);

  const servers = (fresh && fresh.sessionId === sessionId ? fresh.servers : caps?.mcpServers) ?? [];
  const shown = useMemo(() => {
    const list = query ? servers.filter((s) => fuzzy(query, `${s.name} ${s.scope ?? ''} ${(s.tools ?? []).map((t) => t.name).join(' ')}`)) : servers;
    return [...list].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  }, [servers, query]);

  const refresh = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      // No action exists for this read-only query yet, so the bridge is called directly.
      setFresh({ sessionId, servers: await bridge.call('session.mcp', { sessionId }) });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const connected = servers.filter((s) => s.status === 'connected').length;

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        {caps && servers.length > 0 && (
          <span className="set-context num">
            {provider === 'opencode' ? `${plural(servers.length, 'server')} configured` : `${connected} of ${plural(servers.length, 'server')} connected`}
          </span>
        )}
        <span className="grow" />
        <Scope provider={provider} cwd={cwd} />
        {sessionId && <IconButton icon="refresh" label="Check servers again" className={loading ? 'cc-spin' : undefined} disabled={loading} onClick={() => void refresh()} />}
      </div>

      {servers.length > 5 && <SearchField value={query} onChange={setQuery} placeholder="Search servers and tools" count={shown.length} />}

      <Card>
        {!caps ? (
          <Skeleton rows={3} />
        ) : !servers.length ? (
          <Empty>No MCP servers are configured for {PROVIDER_NAME[provider]} here.</Empty>
        ) : !shown.length ? (
          <Empty>No server matches “{query}”.</Empty>
        ) : (
          <div className="xlist">
            {shown.map((s) => (
              <Server key={s.name} server={s} />
            ))}
          </div>
        )}
      </Card>

      <p className="set-foot-note">
        Servers are configured in the agent's own config:{' '}
        {provider === 'codex' ? (
          <CodeChip text="~/.codex/config.toml" />
        ) : provider === 'claude' ? (
          <>
            <CodeChip text="claude mcp add" /> or a project's <CodeChip text=".mcp.json" />
          </>
        ) : provider === 'opencode' ? (
          <>
            <CodeChip text="~/.config/opencode/opencode.json" /> or a project's <CodeChip text="opencode.json" />, under <CodeChip text="mcp" copy={false} />. OpenCode does not say which of them started.
          </>
        ) : (
          'the demo agent ships a fixed set.'
        )}
      </p>
    </div>
  );
}

function Server({ server }: { server: McpServerInfo }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[server.status];
  const tools = server.tools ?? [];
  const canOpen = tools.length > 0 || !!server.error;
  return (
    <div className="xrow" data-open={open || undefined} data-status={server.status}>
      <button type="button" className="xrow-head" aria-expanded={canOpen ? open : undefined} disabled={!canOpen} onClick={() => setOpen(!open)}>
        <Icon name="mcp" size={15} className="xrow-icon" />
        <span className="xrow-name">
          <span className="truncate">{server.name}</span>
        </span>
        <span className="xrow-desc">
          {server.status === 'failed' && server.error ? server.error : tools.length ? plural(tools.length, 'tool') : server.version ? `Version ${server.version}` : 'No tools reported'}
        </span>
        <span className="mcp-status" data-tone={st.tone}>
          <span className="cc-dot" />
          {st.word}
        </span>
        <Icon name="caret-down" size={12} className="xrow-caret" style={{ visibility: canOpen ? 'visible' : 'hidden' }} />
      </button>
      <Collapse open={open}>
        <div className="xrow-detail">
          {server.error && <p className="mcp-error">{server.error}</p>}
          {tools.length > 0 && (
            <ul className="mcp-tools" data-compact={tools.every((t) => !t.description) || undefined}>
              {tools.map((t) => (
                <li key={t.name}>
                  <code className="mcp-tool-name">{t.name}</code>
                  {t.description && <span className="mcp-tool-desc">{t.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Collapse>
    </div>
  );
}
