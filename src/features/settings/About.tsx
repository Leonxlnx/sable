import type { ProviderId } from '@shared/protocol';
import { DitherField } from '@/art/DitherField';
import { LogoMark, ProviderMark, PROVIDER_NAME, Wordmark } from '@/art/Logo';
import { connectableAgents, planLabel, signedInAccount } from '@/features/connect/plan';
import { checkForUpdate, installUpdate, setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Spinner } from '@/ui';
import { tildePath } from '@/lib/format';
import { Card, CodeChip, Row } from './parts';

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function About() {
  const version = useStore((s) => s.version);
  const platform = useStore((s) => s.platform);
  const home = useStore((s) => s.home);
  const dataDir = useStore((s) => s.dataDir);
  const providers = useStore((s) => s.providers);
  const conn = useStore((s) => s.conn);
  const setUi = useStore((s) => s.setUi);
  // Whatever agents the bridge reports, Claude Code and Codex first.
  const agents: ProviderId[] = [...connectableAgents(providers), ...(Object.keys(providers) as ProviderId[]).filter((id) => !connectableAgents(providers).includes(id))];

  return (
    <div className="set-stack">
      <div className="about-hero card">
        <div className="about-light">
          <DitherField variant="streak" palette="mono" focus={[0.5, 1.05]} gain={0.9} cell={5} opacity={0.75} speed={0.6} />
        </div>
        <div className="about-veil" />
        <LogoMark size={48} />
        <Wordmark className="about-word" />
        <span className="about-ver num">Version {version || 'unknown'}</span>
        <p className="about-line">Claude Code and Codex in one place: every session, step and change in one timeline.</p>
      </div>

      <Updates />

      <Card title="Agents">
        {agents.map((id) => {
          const p = providers[id];
          const plan = planLabel(signedInAccount(p)?.auth);
          return (
            <Row
              key={id}
              label={
                <span className="prov-label">
                  <ProviderMark provider={id} size={15} />
                  {PROVIDER_NAME[id]}
                </span>
              }
            >
              <span className="about-val num">{!p ? 'Checking' : !p.installed ? 'Not installed' : [plan, p.version && `Version ${p.version}`].filter(Boolean).join(' · ') || 'Installed'}</span>
            </Row>
          );
        })}
      </Card>

      <Card title="This computer">
        <Row label="Data" help="Sessions, projects and settings are stored here, on this computer only.">
          {/* The real folder (SABLE_HOME moves it), shown with ~ for the home folder; copy gives the full path. */}
          <CodeChip text={dataDir || '~/.sable'} shown={dataDir ? tildePath(dataDir, home) : '~/.sable'} />
        </Row>
        <Row label="Platform">
          <span className="about-val">{PLATFORM[platform] ?? (platform || 'Unknown')}</span>
        </Row>
        <Row label="Bridge">
          <span className="about-val about-conn" data-conn={conn}>
            <span className="cc-dot" />
            {conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting' : 'Disconnected'}
          </span>
        </Row>
      </Card>

      <Card>
        <Row label="Welcome">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setUi({ settings: null });
              void setSettings({ onboarded: false });
            }}
          >
            Show the welcome again
          </button>
        </Row>
      </Card>
    </div>
  );
}

/** Updates of the desktop app: where it stands, and the one thing to do next. Hidden where Sable cannot update itself. */
function Updates() {
  const u = useStore((s) => s.update);
  if (!u || u.status === 'unsupported') return null;
  const value =
    u.status === 'checking' ? (
      <span className="about-val about-upd">
        <Spinner size={13} />
        Checking
      </span>
    ) : u.status === 'downloading' ? (
      <span className="about-val about-upd">
        <span className="num">Downloading {u.latest} · {Math.round((u.progress ?? 0) * 100)}%</span>
        <span className="meter about-upd-meter" aria-hidden>
          <span className="meter-fill" style={{ '--p': u.progress ?? 0 } as React.CSSProperties} />
        </span>
      </span>
    ) : u.status === 'ready' ? (
      u.pending ? (
        <span className="about-val">Restarts when the agents finish</span>
      ) : (
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void installUpdate()}>
          Restart to update to {u.latest}
        </button>
      )
    ) : (
      <span className="about-val about-upd">
        <span className={u.status === 'error' ? 'about-upd-error' : undefined}>{u.status === 'error' ? u.error || 'The check failed' : 'Up to date'}</span>
        <button type="button" className="btn btn-sm" onClick={() => void checkForUpdate()}>
          {u.status === 'error' ? 'Try again' : 'Check now'}
        </button>
      </span>
    );
  return (
    <Card>
      <Row label="Updates" help="New versions download in the background and install when you restart.">
        {value}
      </Row>
    </Card>
  );
}
