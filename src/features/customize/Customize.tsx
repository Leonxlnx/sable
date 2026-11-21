import type { ReactNode } from 'react';
import type { CustomBuild, CustomState } from '@shared/protocol';
import { Card, CodeChip, Row } from '@/features/settings/parts';
import { bridge } from '@/lib/bridge';
import { timeAgo, tildePath } from '@/lib/format';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Spinner, Switch } from '@/ui';
import { customized, customStep, openCustomize, useCustom, useOriginal } from './custom-store';
import './customize.css';

const STEP: Record<NonNullable<CustomBuild['step']>, string> = {
  checking: 'Checking the tools',
  cloning: 'Getting Sable',
  installing: 'Installing',
  building: 'Building',
  rebasing: 'Bringing your changes',
};

const ago = (t: number) => {
  const a = timeAgo(t);
  return a === 'now' ? 'just now' : /\d$/.test(a) ? a : `${a} ago`;
};

/** Settings › Customize: the Customize chat, your styles and your build, and the way back to Sable's own look. */
export function Customize() {
  const c = useCustom();
  const home = useStore((s) => s.home);
  if (!c) {
    return (
      <div className="set-stack">
        <div className="skel cz-skel" />
      </div>
    );
  }
  return (
    <div className="set-stack">
      <Card>
        <Row label="Customize chat" help="An agent that knows Sable changes it for you. Your styles apply as it saves them and stay through updates.">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void openCustomize()}>
            Change Sable with an agent
          </button>
        </Row>
      </Card>

      <Card>
        <StylesRow c={c} />
        {c.build.supported && <BuildRow c={c} />}
        <Row label="Folder">
          <span className="cz-folder">
            <CodeChip text={c.dir} shown={tildePath(c.dir, home)} />
            <button type="button" className="btn btn-sm" onClick={() => void bridge.call('fs.open', { path: c.dir }).catch((err: Error) => useStore.getState().toast(err.message, 'error'))}>
              Open the folder
            </button>
          </span>
        </Row>
      </Card>

      <Card>
        <Row label="Sable's own look" help={c.ignored ? 'This run started with Shift held or --original: nothing of yours is applied.' : 'Hold Shift while Sable starts to leave your changes out for that run.'}>
          <button type="button" className="btn btn-sm" disabled={!customized(c) && !c.build.active} onClick={() => void useOriginal()}>
            Use Sable's own look
          </button>
        </Row>
      </Card>
    </div>
  );
}

function StylesRow({ c }: { c: CustomState }) {
  const s = c.styles;
  const value = !s.exists ? 'None yet' : s.blocked ? 'Not applied' : !s.on ? 'Off' : s.changedAt ? `Changed ${ago(s.changedAt)}` : 'On';
  return (
    <Row label="Your styles" help={s.blocked ? `${s.blocked}. A stylesheet loads nothing from the internet.` : undefined}>
      <span className="cz-val">
        <span className="about-val">{value}</span>
        <Switch label="Your styles" checked={s.exists && s.on} disabled={!s.exists} onChange={(on) => void setSettings({ customStyles: on })} />
      </span>
    </Row>
  );
}

function BuildRow({ c }: { c: CustomState }) {
  const b = c.build;
  const help = b.missing ?? b.error ?? (b.failed && !b.step ? `${b.failed.reason}.` : undefined);
  let value: string;
  let control: ReactNode = null;
  const btn = (label: string, step: Parameters<typeof customStep>[0], primary = false) => (
    <button type="button" className={primary ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => void customStep(step)}>
      {label}
    </button>
  );
  if (b.step) {
    value = STEP[b.step];
    control = <Spinner size={13} />;
  } else if (!b.workspace) {
    value = 'Not set up';
    control = btn('Set up', 'setup');
  } else if (b.builtFor && b.builtFor !== c.version) {
    value = `Your changes were made for ${b.builtFor}`;
    control = btn(`Bring them to ${c.version}`, 'bring');
  } else if (!b.builtFor) {
    value = 'Not built yet';
    control = btn('Build and try it', 'build');
  } else if (b.failed) {
    value = `Did not start ${ago(b.failed.at)}`;
    control = btn('Build and try it', 'build');
  } else {
    value = b.serving ? `On, built ${ago(b.builtAt ?? 0)}` : b.active ? 'On from the next start' : `Off, built ${ago(b.builtAt ?? 0)}`;
    const changed = (b.changedAt ?? 0) > (b.builtAt ?? 0);
    control = (
      <>
        {changed && btn('Build and try it', 'build')}
        <Switch label="Your build" checked={b.active} onChange={(on) => void customStep(on ? 'use-on' : 'use-off')} />
      </>
    );
  }
  return (
    <Row label="Your build" help={help}>
      <span className="cz-val">
        <span className="about-val">{value}</span>
        {control}
      </span>
    </Row>
  );
}
