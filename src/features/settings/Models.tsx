import { useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import type { Effort, ProviderId } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { Icon, MODE_ICON } from '@/icons';
import { aliasTarget, currentGeneration, defaultableSpeeds, effortName, modelName, visibilityKey, visibleModels } from '@/lib/models';
import { setSettings } from '@/state/actions';
import { useActiveProvider } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Segmented, Switch, Tip } from '@/ui';
import { Card, Empty, ProviderPicker, Row, Skeleton, useInstalled, useProviderCaps } from './parts';
import './models.css';

/** The provider a page starts on: the one in focus, if installed. */
export function useInitialProvider(): ProviderId {
  const active = useActiveProvider();
  const installed = useInstalled();
  return installed.includes(active) ? active : (installed[0] ?? 'demo');
}

/** A compact picker for one value: the current name on a raised button, a plain list with a check. */
function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T | undefined; options: { value: T; label: string; icon?: Parameters<typeof Icon>[0]['name'] }[]; onChange: (v: T) => void }) {
  const cur = options.find((o) => o.value === value);
  return (
    <RM.Root>
      <RM.Trigger asChild>
        <button type="button" className="btn btn-sm mset-pick" aria-label={`${label}: ${cur?.label ?? 'none'}`}>
          {cur?.icon && <Icon name={cur.icon} size={14} />}
          <span className="truncate">{cur?.label ?? 'Choose'}</span>
          <Icon name="caret-updown" size={12} className="mset-caret" />
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content className="pop cm-pop mm-pop" side="bottom" align="end" sideOffset={6} collisionPadding={10} style={{ width: 232 }}>
          {options.map((o) => (
            <RM.Item key={o.value} className="menu-item mm-row" data-current={o.value === value || undefined} onSelect={() => onChange(o.value)}>
              {o.icon && <Icon name={o.icon} size={15} className="mm-lead" />}
              <span className="mm-name truncate">{o.label}</span>
              <span className="mm-check">{o.value === value && <Icon name="check" size={14} />}</span>
            </RM.Item>
          ))}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

export function Models() {
  const [provider, setProvider] = useState<ProviderId>(useInitialProvider());
  const cwd = useStore((s) => s.ui.homeCwd);
  const caps = useProviderCaps(provider, cwd);
  const settings = useStore((s) => s.settings);
  const overrides = settings.modelVisibility ?? {};

  const models = caps?.models ?? [];
  const base = currentGeneration(models);
  const shownFor = (id: string) => overrides[visibilityKey(provider, id)] ?? base.has(id);
  const mine = Object.keys(overrides).filter((k) => k.startsWith(`${provider}:`) && models.some((m) => visibilityKey(provider, m.id) === k));
  const modelId = settings.defaultModels[provider] ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id;
  const model = models.find((m) => m.id === modelId);
  const visible = visibleModels(provider, models, overrides, modelId);
  const effort = settings.defaultEfforts[provider];
  // A saved effort the model does not list stays shown as chosen (a turn that needs it falls back
  // on its own); the saved choice is never rewritten here.
  const listedEfforts = model?.efforts ?? [];
  const efforts = effort && listedEfforts.length && !listedEfforts.includes(effort) ? [...listedEfforts, effort] : listedEfforts;
  // Nothing chosen and no model default: the agent decides, so nothing is selected.
  const effortValue = effort && efforts.includes(effort) ? effort : (model?.defaultEffort ?? null);
  const modeId = settings.defaultModes[provider] ?? caps?.modes[0]?.id;
  // A speed billed outside the plan (Claude's fast mode) is never a default: a session turns it on.
  const listedSpeeds = defaultableSpeeds(model);
  const speed = settings.defaultSpeeds?.[provider];
  // Likewise a saved speed the model does not offer: still shown as chosen, by its id's name.
  const speeds = speed && listedSpeeds.length && !listedSpeeds.some((s) => s.id === speed) ? [...listedSpeeds, { id: speed, name: speed.charAt(0).toUpperCase() + speed.slice(1) }] : listedSpeeds;
  const speedValue = speed && speeds.some((s) => s.id === speed) ? speed : 'standard';
  const customised = !!(settings.defaultModels[provider] || settings.defaultEfforts[provider] || settings.defaultModes[provider] || speed);

  const setShown = (id: string, on: boolean) => {
    const next = { ...overrides };
    const key = visibilityKey(provider, id);
    // Back to the default when the switch agrees with it, so the default can still move on.
    if (on === base.has(id)) delete next[key];
    else next[key] = on;
    void setSettings({ modelVisibility: next });
  };

  const resetVisibility = () => {
    const next = { ...overrides };
    for (const k of Object.keys(next)) if (k.startsWith(`${provider}:`)) delete next[k];
    void setSettings({ modelVisibility: next });
  };

  const patch = <K extends 'defaultModels' | 'defaultEfforts' | 'defaultModes' | 'defaultSpeeds'>(key: K, value: string | undefined) => {
    const next = { ...settings[key] } as Record<string, string | undefined>;
    if (value === undefined) delete next[provider];
    else next[provider] = value;
    void setSettings({ [key]: next });
  };

  const resetDefaults = () => {
    const strip = <T extends object>(o: T) => {
      const n = { ...o } as Record<string, unknown>;
      delete n[provider];
      return n as T;
    };
    void setSettings({ defaultModels: strip(settings.defaultModels), defaultEfforts: strip(settings.defaultEfforts), defaultModes: strip(settings.defaultModes), defaultSpeeds: strip(settings.defaultSpeeds ?? {}) });
  };

  return (
    <div className="set-stack">
      <div className="set-toolbar">
        <ProviderPicker id="set-models-provider" value={provider} onChange={setProvider} />
      </div>

      <Card
        title="Model menu"
        aside={
          mine.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetVisibility}>
              Reset to current generation
            </button>
          )
        }
      >
        {!caps ? (
          <Skeleton rows={4} />
        ) : models.length ? (
          <ul className="mset-list" aria-label={`${PROVIDER_NAME[provider]} models`}>
            {models.map((m) => {
              const target = aliasTarget(m);
              const name = target ? m.name.replace(/\s*\(.*\)\s*$/, '') : (modelName(m) ?? m.id);
              const on = shownFor(m.id);
              return (
                <li key={m.id} className="mset-row" data-off={!on || undefined}>
                  <span className="mset-name truncate">
                    {name}
                    {target && <span className="mset-dim">{target}</span>}
                    {m.group && <span className="mset-dim">{m.group}</span>}
                  </span>
                  <Switch checked={on} onChange={(v) => setShown(m.id, v)} label={`Show ${target ? `${name} (${target})` : name} in the model menu`} />
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{PROVIDER_NAME[provider]} did not report any models.</Empty>
        )}
      </Card>

      <Card
        title="New sessions"
        aside={
          customised && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetDefaults}>
              Use {PROVIDER_NAME[provider]} defaults
            </button>
          )
        }
      >
        {!caps ? (
          <Skeleton rows={3} />
        ) : (
          <>
            {visible.length > 0 && (
              <Row label="Model">
                <Pick label="Model" value={modelId} options={visible.map((m) => ({ value: m.id, label: modelName(m) ?? m.id }))} onChange={(id) => patch('defaultModels', id)} />
              </Row>
            )}
            {efforts.length > 0 && (
              <Row label="Effort">
                <Segmented<Effort> id="set-effort" value={effortValue} onChange={(e) => patch('defaultEfforts', e)} options={efforts.map((e) => ({ value: e, label: effortName(e) }))} />
              </Row>
            )}
            {speeds.length > 0 && (
              <Row label="Speed">
                <Segmented
                  id="set-speed"
                  value={speedValue}
                  onChange={(id) => patch('defaultSpeeds', id === 'standard' ? undefined : id)}
                  options={[{ value: 'standard', label: 'Standard' }, ...speeds.map((s) => ({ value: s.id, label: s.note ? <Tip label={s.note}><span>{s.name}</span></Tip> : s.name }))]}
                />
              </Row>
            )}
            {caps.modes.length > 0 && (
              <Row label="Mode">
                <Pick label="Mode" value={modeId} options={caps.modes.map((m) => ({ value: m.id, label: m.name, icon: MODE_ICON[m.tone] ?? 'shield' }))} onChange={(id) => patch('defaultModes', id)} />
              </Row>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
