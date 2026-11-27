import type { AppSettings, WebState } from '@shared/protocol';

/**
 * What Settings › Phone › Web access shows for a state (pure; `WebAccess.tsx` draws it). In order and
 * nothing more: the switch, the network it serves on, the address, setting up a device (the certificate,
 * then pairing), a device asking, the paired devices, the steer switch, and the notices.
 */

/**
 * The root's SHA-256 ("AB:CD:…", 32 bytes) as four lines of eight pairs: how a tablet's certificate
 * details show it, so the two can be compared line by line. Anything else: no lines.
 */
export function fingerprintLines(fp: string | undefined): string[] {
  const bytes = (fp ?? '').toUpperCase().split(':');
  if (bytes.length !== 32 || !bytes.every((b) => /^[0-9A-F]{2}$/.test(b))) return [];
  return [0, 8, 16, 24].map((i) => bytes.slice(i, i + 8).join(' '));
}

/** The top bar mark's words: "Test iPad is connected", "Test iPad and Kitchen iPad are connected", "3 web devices are connected". */
export function connectedWords(labels: string[]): string {
  if (labels.length === 1) return `${labels[0]} is connected`;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]} are connected`;
  return `${labels.length} web devices are connected`;
}

/** "9:41": what is left of an offer's ten minutes. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "14:02" today, "Tue 14:02" within the week, "3 Nov" before. */
export function sinceWords(ts: number, now: number): string {
  const at = new Date(ts);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  if (now - ts < 6 * 86_400_000) return `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "now", "5m ago", "on 3 Nov" (as Settings › Phone says it). */
function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `on ${new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

export interface WebSection {
  on: boolean;
  /** The switch may be used: the web client is in this build, or web access is on (it can always go off). */
  switchable: boolean;
  /** The switch row's one line. */
  status?: string;
  /** The networks to choose from (only while on). */
  networks?: { id: string; name: string; address: string; chosen: boolean }[];
  /** Under "Network": why nothing is served on the chosen one. */
  networkHelp?: string;
  /** While it listens: the address to open on the tablet and its QR. */
  address?: { link: string; shown: string; qr?: { qr: string; size: number } };
  /** While it listens: setting up a device. */
  setup?: { caUrl: string; fingerprint: string[]; pairing?: { link: string; qr: string; size: number; left: string } };
  request?: { id: string; name: string; address: string };
  devices: { id: string; name: string; line: string; online: boolean }[];
  /** The steer switch (only while on). */
  steer?: boolean;
  /** The root was replaced: every device must install the new one. */
  replacement?: string;
  /** A removal is in effect but not on disk yet. */
  unsaved: boolean;
  error?: string;
}

type WebSettings = Pick<AppSettings, 'webRemote' | 'webNetwork' | 'webSteerDanger'>;

export function webSection(s: WebState, settings: WebSettings, now: number): WebSection {
  const on = settings.webRemote === true;
  const assets = s.assets !== false;
  const networks = s.networks ?? [];
  const chosenId = settings.webNetwork;
  const chosen = networks.find((n) => n.id === chosenId);
  const listening = on && s.listening && !!s.port && !!s.addresses[0];

  let status: string | undefined;
  if (!assets && !on) status = 'Not included in this version';
  else if (!on) status = 'Paired browsers connect over your home network';
  else if (!assets) status = 'Not included in this version';
  else if (chosen && !listening && !s.error) status = 'Starting';

  let networkHelp: string | undefined;
  if (on && assets) {
    if (!networks.length) networkHelp = 'No home network is connected';
    else if (chosenId && !chosen) networkHelp = 'The chosen network is not connected';
  }

  // The bridge's own words, unless a line above already says it: no network chosen or connected, or no client in this build.
  const said = !assets || !chosen || /Select an available|home network changed|assets are unavailable/i.test(s.error ?? '');
  const unsaved = s.revocationDurable === false;
  const error = on && !said && !unsaved ? s.error : undefined;

  const origin = listening ? `https://${s.addresses[0]}:${s.port}` : undefined;
  const pairing = listening && s.pairing && s.pairing.expiresAt > now ? s.pairing : undefined;
  const since = new Map(s.clients.map((c) => [c.id, c.since]));

  return {
    on,
    switchable: assets || on,
    status,
    networks: on && assets ? networks.map((n) => ({ ...n, chosen: n.id === chosenId })) : undefined,
    networkHelp,
    // While a pairing code is open it is the only code on the page (the address's own would open the page unpaired).
    address: origin ? { link: `${origin}/`, shown: origin, qr: !pairing && s.addressQr?.link === `${origin}/` ? s.addressQr : undefined } : undefined,
    setup: origin
      ? {
          caUrl: `${origin}/ca.cer`,
          fingerprint: fingerprintLines(s.caFingerprint),
          pairing: pairing ? { link: pairing.link, qr: pairing.qr, size: pairing.size, left: countdown(pairing.expiresAt - now) } : undefined,
        }
      : undefined,
    request: listening && s.request ? { id: s.request.id, name: s.request.name, address: s.request.address } : undefined,
    // Listed while off too: a lost tablet can be revoked without turning web access on.
    devices: s.devices.map((d) => {
      const at = since.get(d.id);
      const line = d.online ? (at ? `Connected since ${sinceWords(at, now)}` : 'Connected') : d.lastSeen ? `Last seen ${ago(d.lastSeen, now)}` : `Paired ${ago(d.pairedAt, now)}`;
      return { id: d.id, name: d.name, line, online: !!d.online };
    }),
    steer: on && assets ? settings.webSteerDanger === true : undefined,
    replacement: s.caReplacement || undefined,
    unsaved,
    error,
  };
}
