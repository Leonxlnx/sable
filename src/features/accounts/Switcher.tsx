import { useEffect, useRef, useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DEFAULT_ACCOUNT, type AccountInfo, type ProviderId, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { LimitsGlance } from '@/features/usage';
import { clock, isScopedWindow, orderWindows, windowLevel } from '@/features/usage/format';
import { useAccountWindows } from '@/features/usage/Limits';
import { livePercent, tightest } from '@/features/usage/room';
import { useNow } from '@/lib/useNow';
import { Tip } from '@/ui';
import { Icon } from '@/icons';
import { openSettings, setDefaultAccount } from '@/state/actions';
import { accountName, useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { AccountUsed, ManyAccounts, MANY_ACCOUNTS, planOf, usePool } from './ManyAccounts';
import { poolLeftPercent } from '@/features/usage/plans';
import { accountAgents, accountsOf, openAddAccount, planWord } from './model';

/**
 * The sidebar footer's account switcher. The row is one line that fits the narrowest sidebar: the
 * agent's mark, one name (the account's label when the agent has several, its plan otherwise) and
 * what is left of its tightest window as a small ring and figure. The tooltip says it in full
 * (plan, every window, resets, what is left across the agent's accounts). It opens every agent's
 * accounts as rows with the plan and how full each is, the default checked. Pointing at a row (or
 * moving to it with the keys) shows that account's limits beside the menu. Picking one makes it the
 * account new sessions use.
 */
export function AccountSwitcher() {
  const providers = useStore((s) => s.providers);
  const { provider: active, accountId } = useFocusAccount();
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<{ provider: ProviderId; accountId: string } | null>(null);
  const reduce = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);

  // As the menu opens, the account in use takes the focus (pointer or keys alike), so its limits
  // show beside the menu at once. After Radix's own focus on open, at the start of a frame (a focus
  // move forces a style pass, and the menu's styles were just invalidated).
  useEffect(() => {
    if (!open) return;
    let r = requestAnimationFrame(() => {
      r = requestAnimationFrame(() => {
        const pop = contentRef.current;
        if (!pop || pop.dataset.state === 'closed' || document.activeElement?.matches('.acs-row[data-in-use]')) return;
        const row = pop.querySelector<HTMLElement>('.acs-row[data-in-use]') ?? pop.querySelector<HTMLElement>('.acs-row');
        row?.focus({ preventScroll: true });
        // In a long list the account in use may sit below the fold of the list's own scroller.
        const scroller = row?.closest<HTMLElement>('.acs-list');
        if (row && scroller) scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 2);
      });
    });
    return () => cancelAnimationFrame(r);
  }, [open]);

  const agents = accountAgents(providers);
  const signedIn = agents.filter((id) => accountsOf(providers[id]).some((a) => a.auth.loggedIn));
  const focus: ProviderId = signedIn.includes(active) || agents.includes(active) ? active : (signedIn[0] ?? agents[0] ?? active);
  const list = accountsOf(providers[focus]);
  const current = (focus === active ? list.find((a) => a.id === accountId) : undefined) ?? list.find((a) => a.isDefault) ?? list[0];
  const plan = planWord(current);
  const several = list.length > 1;
  const many = agents.reduce((n, id) => n + accountsOf(providers[id]).length, 0) >= MANY_ACCOUNTS;

  const pool = usePool(focus, providers[focus]);
  const on = !!current?.auth.loggedIn;
  const name = triggerName(focus, current, several);
  const described = [PROVIDER_NAME[focus], several && current ? accountName(current) : undefined, on ? (plan ? `${plan} plan` : undefined) : 'not signed in', pool ? `${poolLeftPercent(pool)}% left across its accounts` : undefined].filter(Boolean).join(', ');

  return (
    <RM.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPeek(null);
      }}
      modal={false}
    >
      {/* The row is one name and one mark; who it is in full (plan, every window, its reset) is the tooltip's and the menu's. */}
      <Tip label={<TriggerTip provider={focus} account={current} several={several} plan={plan} pool={pool} />} side="top">
        <RM.Trigger asChild>
          <button type="button" className="acs-trigger" aria-label={`${described}. Accounts`}>
            <span className="acs-trigger-mark" aria-hidden>
              <ProviderMark provider={focus} size={12} />
            </span>
            <span className="acs-trigger-name truncate" data-out={!on || undefined}>
              {name}
            </span>
            {on && current && <LimitRing provider={focus} accountId={current.id} />}
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content
          ref={contentRef}
          className="pop acs-pop"
          data-spot
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: many ? 292 : 268 }}
          loop
        >
          {many && (
            <ManyAccounts
              agents={agents}
              providers={providers}
              inUse={{ provider: focus, accountId: current?.id }}
              onPeek={setPeek}
              onPick={(id, a) => {
                if (!a.auth.loggedIn) return openSettings('accounts');
                void setDefaultAccount(id, a.id);
                useStore.getState().setUi({ homeProvider: id });
                setOpen(false);
              }}
            />
          )}
          {!many && agents.map((id, i) => (
            <RM.Group key={id} className="acs-group">
              {i > 0 && <RM.Separator className="menu-sep" />}
              {accountsOf(providers[id]).map((a, _, all) => (
                <Row
                  key={a.id}
                  provider={id}
                  account={a}
                  single={all.length === 1}
                  inUse={id === focus && a.id === current?.id}
                  onPeek={() => setPeek({ provider: id, accountId: a.id })}
                  onSelect={() => {
                    if (!a.auth.loggedIn) return openSettings('accounts');
                    void setDefaultAccount(id, a.id);
                    useStore.getState().setUi({ homeProvider: id });
                  }}
                />
              ))}
            </RM.Group>
          ))}
          <RM.Separator className="menu-sep" />
          <RM.Item className="menu-item" onFocus={() => setPeek(null)} onSelect={() => openAddAccount(agents.length > 1 ? undefined : focus)}>
            <span className="acs-check-col" aria-hidden>
              <Icon name="plus" size={15} />
            </span>
            <span className="grow">Add account</span>
          </RM.Item>
          <RM.Item className="menu-item" onFocus={() => setPeek(null)} onSelect={() => openSettings('accounts')}>
            <span className="acs-check-col" aria-hidden>
              <Icon name="settings" size={15} />
            </span>
            <span className="grow">Manage accounts</span>
          </RM.Item>

          <AnimatePresence>
            {peek && (
              <motion.div
                key="peek"
                className="acs-peek glass-rim"
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              >
                <Peek key={`${peek.provider}:${peek.accountId}`} provider={peek.provider} accountId={peek.accountId} onOpenUsage={() => setOpen(false)} />
              </motion.div>
            )}
          </AnimatePresence>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

function Row({ provider, account, single, inUse, onPeek, onSelect }: { provider: ProviderId; account: AccountInfo; single: boolean; inUse: boolean; onPeek: () => void; onSelect: () => void }) {
  const plan = planOf(account);
  // An agent's only account goes by the agent's name, and there is no choice to check.
  const label = single ? PROVIDER_NAME[provider] : accountName(account);
  return (
    <RM.Item
      className="menu-item acs-row"
      data-current={account.isDefault || undefined}
      data-in-use={inUse || undefined}
      onFocus={onPeek}
      onSelect={onSelect}
      aria-label={`${PROVIDER_NAME[provider]}, ${label}${plan ? `, ${plan}` : ''}${account.auth.loggedIn ? '' : ', not signed in'}${account.isDefault ? ', default' : ''}`}
    >
      <ProviderMark provider={provider} size={14} className="acs-mark" />
      <span className="acs-name truncate">{label}</span>
      <span className="acs-plan">{account.auth.loggedIn ? plan : 'Sign in'}</span>
      {account.auth.loggedIn ? <AccountUsed provider={provider} accountId={account.id} /> : <span className="acs-used" aria-hidden />}
      <span className="acs-end">{account.isDefault && !single && <Icon name="check" size={14} className="acs-check" />}</span>
    </RM.Item>
  );
}

/** The pointed-at account's limits, beside the menu. Kept mounted per account so it reads once. */
function Peek({ provider, accountId, onOpenUsage }: { provider: ProviderId; accountId: string; onOpenUsage: () => void }) {
  return (
    <div className="acs-peek-in">
      <LimitsGlance provider={provider} accountId={accountId} onOpenUsage={onOpenUsage} />
    </div>
  );
}

/**
 * The row's one name: an agent with several accounts names the one in focus by its label ("Ultra2"),
 * an agent with one by its plan ("Max"), or by the agent when the plan is not known.
 */
function triggerName(provider: ProviderId, account: AccountInfo | undefined, several: boolean): string {
  if (!account) return PROVIDER_NAME[provider];
  if (several) return accountName(account);
  if (!account.auth.loggedIn) return 'Sign in';
  return planWord(account) ?? planOf(account) ?? PROVIDER_NAME[provider];
}

/** The window that leaves the whole plan the least room (a model's own window only when there is no other). */
function planWindow(limits: RateLimit[], now: number): RateLimit | undefined {
  const whole = limits.filter((l) => !isScopedWindow(l));
  return tightest(whole.length ? whole : limits, now);
}

/**
 * What is left of the account's tightest window, as a small ring and its figure ("78%"). Quiet ink;
 * amber from 80% used, red when used up (a model's own window at its cap leaves it quiet: the other
 * models still run). Nothing until the account has figures.
 */
function LimitRing({ provider, accountId }: { provider: ProviderId; accountId: string }) {
  const { limits } = useAccountWindows(provider, accountId);
  const now = useNow();
  const tight = planWindow(limits, now);
  if (!tight) return null;
  const left = 100 - Math.round(livePercent(tight, now));
  const level = windowLevel(tight, now);
  // The arc on the icons' 14 px grid: a hairline track and a 1.5 px arc of what is left.
  const r = 5.25;
  const c = 2 * Math.PI * r;
  return (
    <span className="acs-ring" data-level={level} aria-hidden>
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle className="acs-ring-track" cx="7" cy="7" r={r} />
        {left > 0 && <circle className="acs-ring-arc" cx="7" cy="7" r={r} strokeDasharray={`${(Math.max(left, 4) / 100) * c} ${c}`} />}
      </svg>
      <span className="acs-ring-pct num">{left}%</span>
    </span>
  );
}

/** The trigger's tooltip: who it is in full, then every window with what is left of it and when it resets. */
function TriggerTip({ provider, account, several, plan, pool }: { provider: ProviderId; account: AccountInfo | undefined; several: boolean; plan: string | undefined; pool: ReturnType<typeof usePool> }) {
  const { limits } = useAccountWindows(provider, account?.id ?? DEFAULT_ACCOUNT);
  const now = useNow();
  const on = !!account?.auth.loggedIn;
  const head = [PROVIDER_NAME[provider], account && several ? accountName(account) : undefined, on ? (plan ? `${plan} plan` : undefined) : 'Not signed in'].filter(Boolean).join(' · ');
  const windows = on ? orderWindows(limits) : [];
  return (
    <span className="acs-tip">
      <span className="acs-tip-head">{head}</span>
      {windows.map((l) => (
        <span key={l.id} className="acs-tip-row">
          <span className="acs-tip-label">{l.label}</span>
          <span className="acs-tip-pct num" data-level={windowLevel(l, now)}>
            {100 - Math.round(livePercent(l, now))}% left
          </span>
          <span className="acs-tip-reset num">{l.resetsAt && l.resetsAt > now ? clock(l.resetsAt, now) : ''}</span>
        </span>
      ))}
      {pool && <span className="acs-tip-pool num">{poolLeftPercent(pool)}% left across its accounts</span>}
    </span>
  );
}
