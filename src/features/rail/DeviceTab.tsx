import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { DeviceFrame, DeviceInfo, DeviceKey, DeviceStatus } from '@shared/protocol';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { reducedMotion } from '@/lib/motion';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSep, MenuTrigger, Spinner, Tip } from '@/ui';
import './device.css';

/**
 * The side panel's Device tab: an Android phone or emulator, live. The screen is fetched a few
 * times a second only while this tab is on screen (nothing at rest); a click on it taps, a drag
 * swipes, a long press holds, and typing goes to the focused field. Back, home and recent sit
 * under it; the app's log opens below on demand. Everything goes through the bridge's device
 * service (server/services/device.ts), the same one the agents' device_* tools use.
 */

// The calls this tab makes (no store state: the tab owns what it shows).
const api = {
  list: () => bridge.call('device.list', {}, 20_000),
  use: (serial: string | null) => bridge.call('device.use', { serial }, 20_000),
  start: (avd?: string) => bridge.call('device.start', avd ? { avd } : {}, 30_000),
  stop: (serial: string) => bridge.call('device.stop', { serial }, 45_000),
  shot: (serial: string) => bridge.call('device.screenshot', { serial }, 20_000),
  tap: (serial: string, x: number, y: number, hold?: number) => bridge.call('device.tap', { serial, x, y, ...(hold ? { hold } : {}) }, 15_000),
  swipe: (serial: string, x1: number, y1: number, x2: number, y2: number, ms: number) => bridge.call('device.swipe', { serial, x1, y1, x2, y2, ms }, 15_000),
  type: (serial: string, text: string) => bridge.call('device.type', { serial, text }, 20_000),
  key: (serial: string, key: DeviceKey) => bridge.call('device.key', { serial, key }, 15_000),
  packages: (serial: string) => bridge.call('device.packages', { serial }, 20_000),
  logs: (serial: string, pkg?: string) => bridge.call('device.logs', { serial, ...(pkg ? { package: pkg } : {}), lines: 300 }, 25_000),
};

/** The gap between the starts of two frames: at most three a second. */
const FRAME_GAP = 333;
/** How often the list of devices is asked for while the tab shows (phones come and go). */
const LIST_EVERY = 5_000;

const toast = (text: string) => useStore.getState().toast(text, 'error');
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Ready devices first, then ones starting, then the rest. */
const order = (d: DeviceInfo) => (d.state === 'device' ? 0 : d.state === 'booting' ? 1 : 2);

export function DeviceTab({ active }: { active: boolean }) {
  const open = useStore((s) => s.ui.railOpen);
  const shown = active && open;
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const refresh = useCallback(() => {
    api.list().then(
      (s) => {
        setStatus(s);
        setFailed(null);
      },
      (err) => setFailed(errText(err)),
    );
  }, []);

  // The list while the tab shows, and whatever the bridge reports (an emulator started, booted or stopped).
  useEffect(() => {
    if (!shown) return;
    refresh();
    const t = window.setInterval(() => !document.hidden && refresh(), LIST_EVERY);
    const off = bridge.on((e) => {
      if (e.type === 'device.updated') setStatus(e.status);
    });
    return () => {
      window.clearInterval(t);
      off();
    };
  }, [shown, refresh]);

  const devices = [...(status?.devices ?? [])].sort((a, b) => order(a) - order(b));
  const device = devices.find((d) => d.serial === status?.preferred) ?? devices[0];
  const ready = device?.state === 'device' ? device : undefined;
  const avd = status?.avds[0];

  const pick = (serial: string) => {
    api.use(serial).then(setStatus, (err) => toast(errText(err)));
  };

  const start = async (name?: string) => {
    setStarting(true);
    try {
      const { serial } = await api.start(name);
      setStatus(await api.use(serial));
    } catch (err) {
      toast(errText(err));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (serial: string) => {
    try {
      await api.stop(serial);
      refresh();
    } catch (err) {
      toast(errText(err));
    }
  };

  return (
    <div className="rail-col dv-col">
      <div className="dv-bar">
        <Picker devices={devices} current={device} status={status} onPick={pick} onStart={(n) => void start(n)} onStop={(s) => void stop(s)} />
        <Tip label={logOpen ? 'Hide log' : 'Show log'}>
          <button type="button" className="icon-btn dv-log-toggle" aria-label={logOpen ? 'Hide log' : 'Show log'} aria-pressed={logOpen} data-active={logOpen || undefined} disabled={!ready} onClick={() => setLogOpen((v) => !v)}>
            <Icon name="terminal" size={15} />
          </button>
        </Tip>
      </div>
      <div className="dv-view">
        {failed && !status ? (
          <p className="rail-empty">{failed}</p>
        ) : !status ? (
          <div className="rail-loading">
            <Spinner />
          </div>
        ) : !status.adb ? (
          <p className="rail-empty">Android SDK not found. Set ANDROID_HOME to its folder.</p>
        ) : ready ? (
          <Screen key={ready.serial} device={ready} shown={shown} />
        ) : device?.state === 'booting' || starting ? (
          <div className="rail-loading dv-booting">
            <Spinner />
            <span>Starting {device?.name ?? avd ?? 'the emulator'}</span>
          </div>
        ) : device?.state === 'unauthorized' ? (
          <p className="rail-empty">Allow USB debugging on {device.name}.</p>
        ) : device ? (
          <p className="rail-empty">
            {device.name} is {device.state}.
          </p>
        ) : (
          <div className="rail-empty dv-none">
            <p>{status.error ?? 'No device connected.'}</p>
            {avd && (
              <button type="button" className="btn btn-sm" onClick={() => void start(avd)}>
                <Icon name="play" size={13} />
                Start emulator
              </button>
            )}
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>{logOpen && ready && <DeviceLog key={ready.serial} device={ready} shown={shown} onClose={() => setLogOpen(false)} />}</AnimatePresence>
    </div>
  );
}

/** The device in front, as a menu: the others, and the emulators to start or stop. */
function Picker({
  devices,
  current,
  status,
  onPick,
  onStart,
  onStop,
}: {
  devices: DeviceInfo[];
  current?: DeviceInfo;
  status: DeviceStatus | null;
  onPick: (serial: string) => void;
  onStart: (avd: string) => void;
  onStop: (serial: string) => void;
}) {
  const running = new Set(devices.filter((d) => d.kind === 'emulator').map((d) => d.name));
  const idle = (status?.avds ?? []).filter((a) => !running.has(a));
  const emulators = devices.filter((d) => d.kind === 'emulator' && d.state !== 'offline');
  const label = current ? current.name : 'No device';
  return (
    <Menu>
      <MenuTrigger className="dv-pick" aria-label={`Device: ${label}`} disabled={!status?.adb}>
        <Icon name="device" size={15} />
        <span className="dv-pick-name truncate">{label}</span>
        {current && current.state !== 'device' && <span className="dv-pick-state">{current.state === 'booting' ? 'Starting' : current.state === 'unauthorized' ? 'Not allowed' : 'Offline'}</span>}
        <Icon name="caret-down" size={11} weight="bold" className="dv-pick-caret" />
      </MenuTrigger>
      <MenuContent align="start" width={260}>
        {devices.length > 0 && <MenuLabel>Devices</MenuLabel>}
        {devices.map((d) => (
          <MenuItem key={d.serial} icon="device" checked={d.serial === current?.serial} hint={d.state === 'device' ? undefined : d.state === 'booting' ? 'Starting' : d.state === 'unauthorized' ? 'Not allowed' : 'Offline'} onSelect={() => onPick(d.serial)}>
            {d.name}
          </MenuItem>
        ))}
        {(idle.length > 0 || emulators.length > 0) && devices.length > 0 && <MenuSep />}
        {idle.map((a) => (
          <MenuItem key={a} icon="play" onSelect={() => onStart(a)}>
            Start {a}
          </MenuItem>
        ))}
        {emulators.map((d) => (
          <MenuItem key={`stop:${d.serial}`} icon="stop" onSelect={() => onStop(d.serial)}>
            Stop {d.name}
          </MenuItem>
        ))}
        {!devices.length && !idle.length && <MenuLabel>No device connected</MenuLabel>}
      </MenuContent>
    </Menu>
  );
}

// ── the screen ──

interface Touch {
  id: number;
  /** Where the finger went down and where it is, in the picture's CSS pixels. */
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
  moved: boolean;
}

/** Further than this (CSS pixels) and a press becomes a swipe. */
const SLOP = 6;
/** Held longer than this without moving, a press is a long press. */
const LONG = 450;

function Screen({ device, shown }: { device: DeviceInfo; shown: boolean }) {
  const serial = device.serial;
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const kick = useRef<() => void>(() => {});

  // Frames: one at a time, at most three a second, only while the tab is on screen and the window is visible.
  useEffect(() => {
    if (!shown) return;
    let stopped = false;
    let timer = 0;
    let busy = false;
    const next = (wait: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, wait);
    };
    const tick = async () => {
      if (stopped || busy) return;
      if (document.hidden) return;
      busy = true;
      const t0 = performance.now();
      try {
        const f: DeviceFrame = await api.shot(serial);
        if (stopped) return;
        // Decoded off screen first, so the picture never flashes empty between frames.
        const next = new Image();
        next.src = f.data;
        await next.decode().catch(() => {});
        if (stopped || !img.current) return;
        img.current.src = f.data;
        setSize((s) => (s && s.width === f.width && s.height === f.height ? s : { width: f.width, height: f.height }));
        setError(null);
      } catch (err) {
        if (!stopped) setError(errText(err));
      } finally {
        busy = false;
      }
      if (!stopped) next(Math.max(40, FRAME_GAP - (performance.now() - t0)));
    };
    const onVisible = () => !document.hidden && next(0);
    document.addEventListener('visibilitychange', onVisible);
    kick.current = () => next(120);
    next(0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      kick.current = () => {};
    };
  }, [shown, serial]);

  // The picture fits the view, whole, at the device's own proportions.
  useLayoutEffect(() => {
    const el = view.current;
    if (!el || !size) return;
    const measure = () => {
      const pad = 16;
      const w = el.clientWidth - pad * 2;
      const h = el.clientHeight - pad * 2;
      if (w <= 0 || h <= 0) return;
      const s = Math.min(w / size.width, h / size.height);
      setFit({ w: Math.floor(size.width * s), h: Math.floor(size.height * s) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

  // ── touch ──

  const touch = useRef<Touch | null>(null);
  const [dot, setDot] = useState<{ x: number; y: number; down: boolean } | null>(null);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const rippleId = useRef(0);

  /** CSS pixels on the picture to device pixels. */
  const toDevice = (x: number, y: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !size) return null;
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    const w = r.width / z;
    const h = r.height / z;
    return { x: Math.round(Math.max(0, Math.min(w - 1, x)) * (size.width / w)), y: Math.round(Math.max(0, Math.min(h - 1, y)) * (size.height / h)) };
  };

  const local = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  };

  const act = (p: Promise<unknown>) => {
    p.then(
      () => kick.current(),
      (err) => toast(errText(err)),
    );
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !size) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    touch.current = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, t0: performance.now(), moved: false };
    setDot({ ...p, down: true });
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    const p = local(e);
    t.x = p.x;
    t.y = p.y;
    if (!t.moved && Math.hypot(p.x - t.x0, p.y - t.y0) > SLOP) t.moved = true;
    setDot({ ...p, down: true });
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    touch.current = null;
    setDot(null);
    if (e.type === 'pointercancel') return;
    const held = performance.now() - t.t0;
    const a = toDevice(t.x0, t.y0);
    if (!a) return;
    if (t.moved) {
      const b = toDevice(t.x, t.y);
      if (b) act(api.swipe(serial, a.x, a.y, b.x, b.y, Math.round(Math.max(80, Math.min(1500, held)))));
      return;
    }
    if (!reducedMotion()) {
      const id = ++rippleId.current;
      setRipples((r) => [...r.slice(-3), { id, x: t.x0, y: t.y0 }]);
    }
    act(held > LONG ? api.tap(serial, a.x, a.y, Math.round(Math.min(2000, held))) : api.tap(serial, a.x, a.y));
  };

  // ── keys ──

  const typed = useRef('');
  const flushTimer = useRef(0);
  const flush = () => {
    window.clearTimeout(flushTimer.current);
    const text = typed.current;
    typed.current = '';
    if (text) act(api.type(serial, text));
  };

  const KEYMAP: Partial<Record<string, DeviceKey>> = { Enter: 'enter', Backspace: 'delete', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = KEYMAP[e.key];
    if (key) {
      e.preventDefault();
      e.stopPropagation();
      flush();
      act(api.key(serial, key));
      return;
    }
    if (e.key.length === 1 && e.key >= ' ' && e.key <= '~') {
      e.preventDefault();
      e.stopPropagation();
      typed.current += e.key;
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(flush, 140);
    }
  };

  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  const press = (key: DeviceKey) => act(api.key(serial, key));

  return (
    <div className="dv-stage">
      <div className="dv-fit" ref={view}>
        {error && !size ? (
          <p className="rail-empty">{error}</p>
        ) : (
          <div
            className="dv-screen"
            ref={box}
            data-ready={(!!size && !!fit) || undefined}
            style={fit ? { width: fit.w, height: fit.h } : undefined}
            tabIndex={0}
            role="application"
            aria-label={`Screen of ${device.name}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey}
            onBlur={flush}
          >
            <img ref={img} alt="" draggable={false} />
            {dot && <span className="dv-touch" style={{ transform: `translate(${dot.x}px, ${dot.y}px)` }} aria-hidden />}
            {ripples.map((r) => (
              <span key={r.id} className="dv-ripple" style={{ left: r.x, top: r.y }} aria-hidden onAnimationEnd={() => setRipples((list) => list.filter((x) => x.id !== r.id))} />
            ))}
            {!size && (
              <span className="dv-wait">
                <Spinner />
              </span>
            )}
          </div>
        )}
      </div>
      <div className="dv-keys" role="toolbar" aria-label="Device keys">
        <IconButton icon="caret-left" label="Back" size={15} onClick={() => press('back')} />
        <IconButton icon="circle" label="Home" size={14} onClick={() => press('home')} />
        <IconButton icon="square" label="Recent apps" size={13} onClick={() => press('recent')} />
      </div>
    </div>
  );
}

// ── the log ──

/** The app last picked per device, while the window lives. */
const lastPackage = new Map<string, string>();
const LOG_EVERY = 2_000;

/** The level a logcat line ("11-19 00:12:03.120 E/Tag( 123): ...") carries. */
const levelOf = (line: string) => /^\S+\s+\S+\s+([VDIWEF])\//.exec(line)?.[1] ?? '';

function DeviceLog({ device, shown, onClose }: { device: DeviceInfo; shown: boolean; onClose: () => void }) {
  const serial = device.serial;
  const [pkg, setPkg] = useState<string | undefined>(() => lastPackage.get(serial));
  const [packages, setPackages] = useState<string[] | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [note, setNote] = useState<string | undefined>();
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!shown) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const r = await api.logs(serial, pkg);
          if (stopped) return;
          setLines((was) => (was.length === r.lines.length && was[was.length - 1] === r.lines[r.lines.length - 1] ? was : r.lines));
          setNote(r.note);
        } catch (err) {
          if (!stopped) setNote(errText(err));
        }
      }
      if (!stopped) timer = window.setTimeout(tick, LOG_EVERY);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [serial, pkg, shown]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const choose = (p: string | undefined) => {
    if (p) lastPackage.set(serial, p);
    else lastPackage.delete(serial);
    stick.current = true;
    setLines([]);
    setPkg(p);
  };

  const send = () => {
    const problems = lines.filter((l) => /^[EF]$/.test(levelOf(l)));
    const pickLines = (problems.length ? problems : lines).slice(-30);
    if (!pickLines.length) return;
    focusComposer(`From the log of ${pkg ?? device.name}:\n\`\`\`\n${pickLines.join('\n')}\n\`\`\`\n`, { append: true });
  };

  return (
    <motion.div className="dv-log" initial={{ height: 0, opacity: 0 }} animate={{ height: 220, opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reducedMotion() ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }}>
      <div className="dv-log-bar">
        <Menu onOpenChange={(o) => o && !packages && void api.packages(serial).then((r) => setPackages(r.packages), (err) => toast(errText(err)))}>
          <MenuTrigger className="dv-log-pick" aria-label={`Log of ${pkg ?? 'all apps'}`}>
            <span className="truncate">{pkg ?? 'All apps'}</span>
            <Icon name="caret-down" size={10} weight="bold" />
          </MenuTrigger>
          <MenuContent align="start" width={280}>
            <MenuItem checked={!pkg} onSelect={() => choose(undefined)}>
              All apps
            </MenuItem>
            {packages === null ? (
              <MenuLabel>Loading</MenuLabel>
            ) : packages.length ? (
              <>
                <MenuSep />
                {packages.map((p) => (
                  <MenuItem key={p} checked={p === pkg} onSelect={() => choose(p)}>
                    {p}
                  </MenuItem>
                ))}
              </>
            ) : null}
          </MenuContent>
        </Menu>
        <span className="dv-log-note truncate">{note ?? ''}</span>
        <button type="button" className="btn btn-sm btn-ghost dv-log-send" disabled={!lines.length} onClick={send}>
          <Icon name="chat" size={14} />
          Send to chat
        </button>
        <IconButton icon="x" label="Hide log" size={13} onClick={onClose} />
      </div>
      <div
        className="dv-log-list scroll"
        ref={list}
        role="log"
        aria-label="Device log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 ? (
          <p className="dv-log-empty">{note ? '' : 'Nothing logged yet.'}</p>
        ) : (
          lines.map((l, i) => (
            <div key={`${i}:${l.slice(0, 40)}`} className="dv-log-row" data-level={levelOf(l) || undefined}>
              {/* The date is today's: the time is enough in a narrow panel. */}
              {l.replace(/^\d\d-\d\d /, '')}
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}
