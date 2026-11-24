import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DEFAULT_ACCOUNT, type AccountInfo, type ProviderId, type ProviderInfo, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { LimitsGlance } from '@/features/usage';
import { orderWindows, windowLevel } from '@/features/usage/format';
import { useAccountWindows } from '@/features/usage/Limits';
import { useNow } from '@/lib/useNow';
import { Tip } from '@/ui';
import { Icon } from '@/icons';
import { openSettings, refreshLimits, setDefaultAccount } from '@/state/actions';
import { accountName, useFocusAccount } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { AccountUsed, EndsCell, ManyAccounts, MANY_ACCOUNTS, MarkCell, planOf, SignIn, usePool } from './ManyAccounts';
import { useAccountOrder } from './order';
import type { UseFirstRank } from '@shared/use-first';
import { poolUsedPercent } from '@/features/usage/plans';
import { accountUsed, resetsText, usedPercent, usedText } from '@/features/usage/words';
import { accountAgents, accountInUse, accountMark, accountsOf, markWords, openAddAccount, planWord } from './model';
import { signedOut } from '@/lib/sign-in';

/** How long a menu takes to unfold (`--d-open` in ui.css). */
export const OPEN_MS = 130;

/**
 * As the menu opens, the account in use takes the focus, pointer or keys alike, so the highlight
 * lands on it once and its limits show beside the menu at once. It is the menu's first focus: Radix's
 * own (the menu itself, then its first row when the keys opened it) is skipped, or the highlight
 * would show on the first row for two frames and travel on. The list is scrolled to the row before
 * it takes focus, at the start of the next frame (a focus move forces a style pass, and the menu's
 * styles were just invalidated). DropdownMenu.Content hands this to its focus scope; its types
 * leave it out.
 */
const FOCUS_IN_USE = {
  onOpenAutoFocus: (e: Event) => {
    e.preventDefault();
    const pop = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!pop.isConnected || pop.dataset.state === 'closed' || (at && at !== pop && pop.contains(at))) return;
      const row = pop.querySelector<HTMLElement>('.acs-row[data-in-use]') ?? pop.querySelector<HTMLElement>('.acs-row');
      // In a long list the account in use may sit below the fold of the list's own scroller.
      const scroller = row?.closest<HTMLElement>('.acs-list');
      if (row && scroller) scroller.scrollTop = Math.max(0, row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2);
      (row ?? pop).focus({ preventScroll: true });
    });
  },
} as object;

/**
 * The sidebar footer's account switcher. The row is one line that fits the narrowest sidebar: the
 * agent's mark, one name (the account's label when the agent has several, its plan otherwise) and
 * how much of its most used window is used as a short meter and figure, the same figure its row in
 * the menu shows. The tooltip says it in full (plan, every window and its reset, how much of the
 * agent's weeks is used across its accounts: always as used, `usage/words.ts`). It opens every
 * agent's accounts as rows with the plan and how full each is, the account in use checked (the open
 * chat's own; `accountMark` in model.ts). Pointing at a row (or
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
  /** When the menu was opened: the pane beside it comes out once the menu has unfolded. */
  const openedAt = useRef(0);

  // OpenCode is listed once its plan limits are known: one read when it is installed and not read yet.
  const openCodeReady = !!providers.opencode?.installed;
  const openCodeRead = useStore((s) => s.limitReports[accountKey('opencode', DEFAULT_ACCOUNT)]?.readAt !== undefined);
  useEffect(() => {
    if (openCodeReady && !openCodeRead) void refreshLimits('opencode');
  }, [openCodeReady, openCodeRead]);

  const reports = useStore((s) => s.limitReports);
  const agents = accountAgents(providers, (id) => reports[accountKey(id, DEFAULT_ACCOUNT)]?.planLimits === true);
  const signedIn = agents.filter((id) => accountsOf(providers[id]).some((a) => a.auth.loggedIn));
  const focus: ProviderId = signedIn.includes(active) || agents.includes(active) ? active : (signedIn[0] ?? agents[0] ?? active);
  const list = accountsOf(providers[focus]);
  // The account in use: the open chat's own (on home, the one the next chat starts on). The row names it and the menu checks it.
  const current = accountInUse(list, focus === active ? accountId : undefined);
  const plan = planWord(current);
  const several = list.length > 1;
  const many = agents.reduce((n, id) => n + accountsOf(providers[id]).length, 0) >= MANY_ACCOUNTS;
  // One set of columns down the short list: once any agent has several accounts, every row keeps
  // the column of the week's end (empty for an agent's only account), so the figures line up.
  const ends = agents.some((id) => accountsOf(providers[id]).length > 1);
  // The menu unfolds by a clip, which would cut the pane beside it: that pane comes out of the
  // menu's edge when the unfold is done (at once when the menu is already open).
  const peekDelay = reduce ? 0 : Math.max(0, OPEN_MS - (performance.now() - openedAt.current)) / 1000;

  const pool = usePool(focus, providers[focus]);
  const on = !!current?.auth.loggedIn;
  const name = triggerName(focus, current, several);
  // The ring is drawn, not read: its figure goes into the control's name.
  const windows = useAccountWindows(focus, current?.id ?? DEFAULT_ACCOUNT).limits;
  const now = useNow();
  const used = on ? accountUsed(windows, now) : undefined;
  const described = [
    PROVIDER_NAME[focus],
    several && current ? accountName(current) : undefined,
    on ? (plan ? `${plan} plan` : undefined) : current?.auth.checking ? undefined : 'not signed in',
    used ? `${used.limit.label} ${usedText(used.pct)}` : undefined,
    pool ? `${usedText(poolUsedPercent(pool))} across its accounts` : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <RM.Root
      open={open}
      onOpenChange={(o) => {
        if (o) openedAt.current = performance.now();
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
            <span className="acs-trigger-name truncate" data-out={(!on && !current?.auth.checking) || undefined}>
              {name}
            </span>
            {on && current && <LimitMeter provider={focus} accountId={current.id} />}
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
          style={{ width: many || ends ? 292 : 268 }}
          loop
          {...FOCUS_IN_USE}
        >
          {many && (
            <ManyAccounts
              agents={agents}
              providers={providers}
              inUse={{ provider: focus, accountId: current?.id }}
              onPeek={setPeek}
              onPick={(id, a) => {
                if (signedOut(a.auth)) return openSettings('accounts');
                if (!a.auth.loggedIn) return;
                void setDefaultAccount(id, a.id);
                useStore.getState().setUi({ homeProvider: id });
                setOpen(false);
              }}
            />
          )}
          {!many && agents.map((id, i) => (
            <RM.Group key={id} className="acs-group">
              {i > 0 && <RM.Separator className="menu-sep" />}
              <Rows
                provider={id}
                info={providers[id]}
                inUse={id === focus ? current?.id : undefined}
                ends={ends}
                onPeek={(accountId) => setPeek({ provider: id, accountId })}
                onSelect={(a) => {
                  if (signedOut(a.auth)) return openSettings('accounts');
                  // Its sign-in is not known yet: nothing to choose, and nothing to sign in to.
                  if (!a.auth.loggedIn) return;
                  void setDefaultAccount(id, a.id);
                  useStore.getState().setUi({ homeProvider: id });
                }}
              />
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
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1], delay: peekDelay }}
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

/** One agent's accounts in the short list, in the order every list uses (`useAccountOrder`). */
function Rows({ provider, info, inUse, ends, onPeek, onSelect }: { provider: ProviderId; info: ProviderInfo | undefined; inUse: string | undefined; ends: boolean; onPeek: (accountId: string) => void; onSelect: (a: AccountInfo) => void }) {
  const accounts = useMemo(() => accountsOf(info), [info]);
  const { list, rank } = useAccountOrder(provider, accounts);
  const now = useNow();
  return (
    <>
      {list.map((a) => (
        <Row key={a.id} provider={provider} account={a} single={list.length === 1} inUse={a.id === inUse} ends={ends} rank={list.length > 1 ? rank.get(a.id) : undefined} now={now} onPeek={() => onPeek(a.id)} onSelect={() => onSelect(a)} />
      ))}
    </>
  );
}

function Row({ provider, account, single, inUse, ends, rank, now, onPeek, onSelect }: { provider: ProviderId; account: AccountInfo; single: boolean; inUse: boolean; ends: boolean; rank?: UseFirstRank; now: number; onPeek: () => void; onSelect: () => void }) {
  const plan = planOf(account);
  // An agent's only account goes by the agent's name, and there is no choice to check.
  const label = single ? PROVIDER_NAME[provider] : accountName(account);
  const mark = accountMark(account, inUse ? account.id : undefined);
  return (
    <RM.Item
      className="menu-item acs-row"
      data-current={mark === 'here' || undefined}
      data-in-use={inUse || undefined}
      data-out={!account.auth.loggedIn || undefined}
      onFocus={onPeek}
      onSelect={onSelect}
      aria-label={`${PROVIDER_NAME[provider]}, ${label}${plan ? `, ${plan}` : ''}${account.auth.loggedIn ? '' : ', not signed in'}${markWords(mark)}`}
    >
      <ProviderMark provider={provider} size={14} className="acs-mark" />
      <span className="acs-name truncate">{label}</span>
      {account.auth.loggedIn ? (
        <>
          <span className="acs-plan">{plan}</span>
          <AccountUsed provider={provider} accountId={account.id} />
          {ends && <EndsCell rank={rank} now={now} />}
        </>
      ) : (
        <SignIn />
      )}
      {/* The check's column exists only where there is a choice to check (some agent has several accounts). */}
      {ends && <span className="acs-end">{!single && <MarkCell mark={mark} />}</span>}
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
  if (signedOut(account.auth)) return 'Sign in';
  if (!account.auth.loggedIn) return PROVIDER_NAME[provider];
  return planWord(account) ?? planOf(account) ?? PROVIDER_NAME[provider];
}

/**
 * How much of the account's most used window is used, as the one usage meter (shorter) and its
 * figure ("59%"): the same window, drawing and figure as the account's row in the menu and one of
 * the lines beside it. Amber from 80% used, red when used up, on the meter alone. Nothing until the
 * account has figures.
 */
function LimitMeter({ provider, accountId }: { provider: ProviderId; accountId: string }) {
  const { limits } = useAccountWindows(provider, accountId);
  const now = useNow();
  const figure = accountUsed(limits, now);
  if (!figure) return null;
  const used = figure.pct;
  const level = windowLevel(figure.limit, now);
  return (
    <span className="acs-foot-used" aria-hidden>
      <span className="meter acs-meter" data-level={level}>
        <span className="meter-fill" style={{ '--p': Math.max(used, used > 0 ? 3 : 0) / 100 } as CSSProperties} />
      </span>
      <span className="acs-pct num">{used}%</span>
    </span>
  );
}

/** The trigger's tooltip: who it is in full, then every window with how much of it is used and when it resets. */
function TriggerTip({ provider, account, several, plan, pool }: { provider: ProviderId; account: AccountInfo | undefined; several: boolean; plan: string | undefined; pool: ReturnType<typeof usePool> }) {
  const { limits } = useAccountWindows(provider, account?.id ?? DEFAULT_ACCOUNT);
  const now = useNow();
  const on = !!account?.auth.loggedIn;
  const head = [PROVIDER_NAME[provider], account && several ? accountName(account) : undefined, on ? (plan ? `${plan} plan` : undefined) : account?.auth.checking ? undefined : 'Not signed in'].filter(Boolean).join(' · ');
  const windows = on ? orderWindows(limits) : [];
  return (
    <span className="acs-tip">
      <span className="acs-tip-head">{head}</span>
      {windows.map((l) => (
        <span key={l.id} className="acs-tip-row">
          <span className="acs-tip-label">{l.label}</span>
          <span className="acs-tip-pct num" data-level={windowLevel(l, now)}>
            {usedText(usedPercent(l, now))}
          </span>
          <span className="acs-tip-reset num">{resetsText(l.resetsAt, now) ?? ''}</span>
        </span>
      ))}
      {pool && <span className="acs-tip-pool num">{usedText(poolUsedPercent(pool))} across its accounts</span>}
    </span>
  );
}
