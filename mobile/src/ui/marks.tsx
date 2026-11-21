import type { CSSProperties } from 'react';
import type { ProviderId } from '@shared/protocol';

/** Sable's mark, agent marks and the small status marks, as on the desktop (src/art/Logo.tsx). */

const MARK_PATH = 'M0 0H4V2H3V3H2V4H0Z M3 3H4V4H3Z';
const MARK_CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [2, 2], [2, 0], [0, 2], [1, 1], [3, 3], [3, 1], [1, 3],
  [1, 0], [3, 0], [1, 2], [0, 1], [2, 1], [0, 3],
];
const TILE_ORDER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

const FILLED = new Set(MARK_CELLS.map(([c, r]) => `${c},${r}`));

export function LogoMark({ size = 22, cells = false, className }: { size?: number; cells?: boolean; className?: string }) {
  const cell = Math.max(2, Math.round((size * (window.devicePixelRatio || 1)) / 6)) / (window.devicePixelRatio || 1);
  const at = (size - cell * 4) / 2;
  return (
    <svg className={`logo-mark ${className ?? ''}`} viewBox={`0 0 ${size} ${size}`} width={size} height={size} shapeRendering="crispEdges" aria-hidden>
      {cells ? (
        <g fill="currentColor">
          {MARK_CELLS.map(([c, r], i) => (
            // Each cell reaches half a pixel under a filled neighbour, so no hairline seam shows between them.
            <rect
              key={i}
              style={{ '--i': i, '--d': TILE_ORDER[r][c] } as CSSProperties}
              x={at + c * cell}
              y={at + r * cell}
              width={cell + (FILLED.has(`${c + 1},${r}`) ? 0.5 : 0)}
              height={cell + (FILLED.has(`${c},${r + 1}`) ? 0.5 : 0)}
            />
          ))}
        </g>
      ) : (
        <path d={MARK_PATH} transform={`translate(${at} ${at}) scale(${cell})`} fill="currentColor" />
      )}
    </svg>
  );
}

const CLAUDE_PATH =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const CODEX_PATH =
  'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z';

export const PROVIDER_NAME: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', demo: 'Demo' };
export const SHORT_NAME: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', demo: 'Demo' };

export function ProviderMark({ provider, size = 16, className }: { provider: ProviderId; size?: number; className?: string }) {
  const common = { width: size, height: size, className: `pmark ${className ?? ''}`, 'data-provider': provider, 'aria-hidden': true } as const;
  if (provider === 'claude')
    return (
      <svg {...common} viewBox="0 0 24 24">
        <path d={CLAUDE_PATH} fill="currentColor" />
      </svg>
    );
  if (provider === 'codex')
    return (
      <svg {...common} viewBox="-0.9 -0.9 25.8 25.8">
        <path d={CODEX_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
      </svg>
    );
  if (provider === 'opencode')
    return (
      <svg {...common} viewBox="0 0 24 24">
        <path fillRule="evenodd" clipRule="evenodd" d="M4 2h16v20H4V2zm4 4v12h8V6H8z" fill="currentColor" />
        <rect x="8" y="12" width="8" height="6" fill="currentColor" opacity="0.5" />
      </svg>
    );
  return (
    <svg {...common} viewBox="0 0 24 24">
      <g fill="currentColor">
        <rect x="3" y="3" width="10.6" height="10.6" rx="3" />
        <rect x="15.6" y="3" width="5.4" height="5.4" rx="1.7" opacity="0.75" />
        <rect x="3" y="15.6" width="5.4" height="5.4" rx="1.7" opacity="0.75" />
        <rect x="15.6" y="15.6" width="5.4" height="5.4" rx="1.7" opacity="0.4" />
      </g>
    </svg>
  );
}

/**
 * The race glyph, as the desktop's (src/features/race/RaceMark.tsx): one start and two lanes that
 * leave it side by side, each with its node at the end. Plain line art on a 16 px grid.
 */
export function RaceGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg className="race-glyph" viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="13" r="1.5" />
      <path className="race-glyph-l" d="M7.1 11.8 4.75 8.6V5.6" />
      <path className="race-glyph-r" d="M8.9 11.8 11.25 8.6V5.6" />
      <circle cx="4.75" cy="3.9" r="1.5" />
      <circle cx="11.25" cy="3.9" r="1.5" />
    </svg>
  );
}

/** The working indicator: the mark's cells lit one after another in dither order. */
export function Tiles({ size = 14 }: { size?: number }) {
  return (
    <span className="tiles" style={{ '--s': `${size}px` } as CSSProperties} role="status" aria-label="Working">
      {MARK_CELLS.map(([c, r], i) => (
        <i key={i} style={{ gridColumn: c + 1, gridRow: r + 1, '--d': TILE_ORDER[r][c] } as CSSProperties} />
      ))}
    </span>
  );
}

export function Ring({ size = 12 }: { size?: number }) {
  return (
    <svg className="ring" viewBox="0 0 12 12" width={size} height={size} role="status" aria-label="Working">
      <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.5" />
      <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" pathLength={360} strokeDasharray="100 360" />
    </svg>
  );
}

export type Tone = 'working' | 'awaiting' | 'unread' | 'error' | 'idle';

export function StatusMark({ tone, size = 12 }: { tone: Tone; size?: number }) {
  if (tone === 'working') return <Ring size={size} />;
  if (tone === 'idle') return null;
  const r = tone === 'unread' ? 3 : 3.5;
  return (
    <svg className="smark" data-tone={tone} viewBox="0 0 12 12" width={size} height={size} role="img" aria-label={tone === 'awaiting' ? 'Waiting for you' : tone === 'error' ? 'Error' : 'Unread'}>
      {tone === 'awaiting' && <circle cx="6" cy="6" r="5.5" fill="currentColor" fillOpacity="0.16" />}
      <circle cx="6" cy="6" r={r} fill="currentColor" />
    </svg>
  );
}
