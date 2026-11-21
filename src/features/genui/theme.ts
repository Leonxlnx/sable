import interUrl from '@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url';
import monoUrl from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';

/**
 * What a widget frame looks like before the widget adds any CSS of its own: Sable's tokens as CSS
 * variables, and quiet defaults for every plain element, so bare HTML already reads as part of the
 * app. The token values are read from the running app, so the frame follows tokens.css.
 */

/** Tokens copied into the frame under their own names. */
const TOKENS = [
  '--sheet',
  '--panel',
  '--panel-2',
  '--panel-3',
  '--panel-4',
  '--fill-1',
  '--fill-2',
  '--fill-3',
  '--fill-4',
  '--line',
  '--line-2',
  '--line-3',
  '--text',
  '--text-2',
  '--text-3',
  '--text-4',
  '--text-inverse',
  '--red',
  '--amber',
  '--green',
  '--focus',
  '--focus-field',
  '--r-xs',
  '--r-sm',
  '--r-md',
  '--r-lg',
  '--r-xl',
  '--t-micro',
  '--t-small',
  '--t-ui',
  '--t-body',
  '--t-lead',
  '--t-h3',
  '--t-h2',
  '--ease',
  '--ease-out',
  '--dither-50',
  '--dither-25',
  '--dither-fade',
  '--dither-edge',
  '--dither-tone-size',
  '--dither-fade-size',
];

const FALLBACK: Record<string, string> = {
  '--panel': '#121214',
  '--panel-2': '#18181b',
  '--panel-3': '#1f1f23',
  '--line': 'rgb(255 255 255 / 0.06)',
  '--line-2': 'rgb(255 255 255 / 0.09)',
  '--line-3': 'rgb(255 255 255 / 0.15)',
  '--text': '#f2f1ee',
  '--text-2': '#aeada9',
  '--text-3': '#7a7975',
  '--text-4': '#54534f',
  '--text-inverse': '#0a0a0b',
};

const CHECK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
const CARET = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6.5l3.5 3.5 3.5-3.5' fill='none' stroke='%237a7975' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

const RULES = `
:root{--surface:var(--panel);--surface-2:var(--panel-2);--surface-3:var(--panel-3);--accent:var(--text);--good:var(--green);--bad:var(--red);--warn:var(--amber);
--series-1:#f2f1ee;--series-2:rgb(242 241 238/.62);--series-3:rgb(242 241 238/.38);--series-4:rgb(242 241 238/.2);
--font-sans:'Inter Variable','Inter',ui-sans-serif,system-ui,'Segoe UI',sans-serif;--font-mono:'Geist Mono Variable','Geist Mono',ui-monospace,'Cascadia Code',Consolas,monospace;color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
:where(html){background:transparent;-webkit-text-size-adjust:100%;height:auto;overflow:hidden}
:where(body){margin:0;padding:16px 18px;background:transparent;color:var(--text);font-family:var(--font-sans);font-size:13.5px;line-height:1.55;font-weight:400;font-optical-sizing:auto;font-feature-settings:'cv05';letter-spacing:-.003em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-synthesis:none;overflow-wrap:break-word;height:auto;min-height:0}
::selection{background:rgb(242 241 238/.22)}
:where(h1,h2,h3,h4,h5,h6){margin:0 0 .5em;color:var(--text);font-weight:600;line-height:1.25;letter-spacing:-.016em;text-wrap:balance}
:where(h1){font-size:20px;letter-spacing:-.022em}:where(h2){font-size:16.5px}:where(h3){font-size:14px;letter-spacing:-.01em}:where(h4,h5,h6){font-size:13px;color:var(--text-2);font-weight:560}
:where(* + h1,* + h2){margin-top:1.1em}:where(* + h3,* + h4){margin-top:.9em}
:where(p){margin:0 0 .75em}:where(p:last-child,ul:last-child,ol:last-child,table:last-child,pre:last-child,blockquote:last-child){margin-bottom:0}
:where(small,.muted){color:var(--text-2)}:where(.dim){color:var(--text-3)}:where(small){font-size:12px}
:where(strong,b){font-weight:580;color:var(--text)}
:where(a){color:var(--text);text-decoration:underline;text-decoration-color:rgb(242 241 238/.36);text-underline-offset:3px}
:where(ul,ol){margin:0 0 .75em;padding-left:1.35em}:where(li+li){margin-top:.25em}:where(li)::marker{color:var(--text-3)}
:where(hr){border:0;height:1px;background:var(--line-2);margin:14px 0}
:where(blockquote){margin:0 0 .75em;padding-left:12px;border-left:2px solid var(--line-3);color:var(--text-2)}
:where(code,kbd,samp,pre){font-family:var(--font-mono);font-size:12px;font-variant-ligatures:none}
:where(:not(pre)>code,kbd){padding:.12em .38em;border-radius:5px;background:var(--fill-2);box-shadow:inset 0 0 0 1px var(--line)}
:where(pre){margin:0 0 .75em;padding:10px 12px;border-radius:var(--r-md);border:1px solid var(--line);background:rgb(0 0 0/.3);overflow:auto;line-height:18px;color:var(--text-2)}
:where(img,video,canvas){max-width:100%}:where(img,video){height:auto}:where(img){max-height:440px;object-fit:contain}
:where(svg:not([fill])){fill:var(--text-2)}:where(svg){overflow:visible;max-width:100%}
:where(table){width:100%;border-collapse:collapse;font-size:13px;margin:0 0 .75em}
:where(th){text-align:left;font-weight:500;color:var(--text-2);font-size:12px;padding:7px 10px;border-bottom:1px solid var(--line-2);white-space:nowrap}
:where(td){padding:7px 10px;border-top:1px solid var(--line);vertical-align:top}
:where(tbody tr:first-child td){border-top:0}
:where(th.num,td.num){text-align:right}
:where(.num){font-variant-numeric:tabular-nums}
:where(button,.btn){display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:0;border-radius:var(--r-sm);font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;color:var(--text);background-color:var(--fill-2);box-shadow:inset 0 0 0 1px var(--line);cursor:default;transition:background-color 100ms var(--ease),color 100ms var(--ease),scale 80ms var(--ease-out);-webkit-tap-highlight-color:transparent}
:where(button:hover,.btn:hover){background-color:var(--fill-3)}
:where(button:active,.btn:active){background-color:var(--fill-4);scale:.97;transition-duration:100ms,100ms,70ms}
:where(button.primary,.btn.primary){background-color:var(--text);color:var(--text-inverse);font-weight:580;box-shadow:none}
:where(button.primary:hover,.btn.primary:hover){background-color:#fff}
:where(button.primary:active,.btn.primary:active){background-color:#e4e2dd}
:where(button.ghost,.btn.ghost){background-color:transparent;box-shadow:none;color:var(--text-2)}
:where(button.ghost:hover,.btn.ghost:hover){background-color:var(--fill-2);color:var(--text)}
:where(button.ghost:active,.btn.ghost:active){background-color:var(--fill-3)}
:where(button[aria-pressed=true],button[aria-selected=true],button.selected){background-color:var(--fill-4);color:var(--text)}
:where(button:disabled){opacity:.4;pointer-events:none}
:where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=submit],[type=button]),select,textarea){height:30px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r-sm);background-color:rgb(0 0 0/.28);color:var(--text);font:inherit;font-size:13px;outline:none;min-width:0}
:where(textarea){height:auto;min-height:72px;padding:8px 10px;resize:vertical;line-height:1.5}
:where(select){appearance:none;padding-right:28px;background-image:${CARET};background-repeat:no-repeat;background-position:right 8px center;background-size:14px}
:where(input,textarea)::placeholder{color:var(--text-4)}
:where(input:hover,select:hover,textarea:hover){border-color:var(--line-3)}
:where(input:focus,select:focus,textarea:focus){border-color:var(--focus-field)}
:where([aria-invalid=true]){border-color:color-mix(in oklab,var(--red) 55%,transparent)}
:where(:focus-visible){outline:1.5px solid var(--focus);outline-offset:2px}
:where(input:focus-visible,select:focus-visible,textarea:focus-visible){outline:none}
:where(input[type=checkbox],input[type=radio]){appearance:none;flex-shrink:0;display:inline-grid;place-content:center;width:16px;height:16px;margin:0;border:1px solid var(--line-3);border-radius:5px;background:transparent;vertical-align:-3px}
:where(input[type=radio]){border-radius:50%}
:where(input[type=checkbox]:checked){background-color:var(--text);border-color:var(--text)}
:where(input[type=checkbox]:checked)::after{content:'';width:12px;height:12px;background:var(--text-inverse);-webkit-mask:${CHECK} center/contain no-repeat;mask:${CHECK} center/contain no-repeat}
:where(input[type=radio]:checked){border-color:var(--text)}
:where(input[type=radio]:checked)::after{content:'';width:8px;height:8px;border-radius:50%;background:var(--text)}
:where(label:has(>input[type=checkbox],>input[type=radio])){display:inline-flex;align-items:center;gap:8px}
:where(input[type=range]){appearance:none;width:100%;height:18px;margin:0;background:transparent}
:where(input[type=range])::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:rgb(255 255 255/.1)}
:where(input[type=range])::-webkit-slider-thumb{appearance:none;width:14px;height:14px;margin-top:-5px;border:0;border-radius:50%;background:var(--text)}
:where(input[type=range]:focus-visible){outline:none}
:where(input[type=range]:focus-visible)::-webkit-slider-thumb{box-shadow:0 0 0 3px var(--focus)}
:where(progress){appearance:none;width:100%;height:4px;border:0;border-radius:99px;background:rgb(255 255 255/.08);overflow:hidden}
:where(progress)::-webkit-progress-bar{background:transparent}:where(progress)::-webkit-progress-value{background:var(--text);border-radius:99px}
:where(details){border-top:1px solid var(--line);padding:8px 0}:where(summary){cursor:default;color:var(--text-2)}:where(summary:hover){color:var(--text)}
:where(.card){background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px}
:where(.row){display:flex;align-items:center;gap:8px;flex-wrap:wrap}
:where(.stack){display:grid;gap:12px}
:where(.grid){display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
:where(.stat){display:grid;gap:2px}:where(.stat-value){font-size:24px;font-weight:600;letter-spacing:-.022em;line-height:1.15;font-variant-numeric:tabular-nums}:where(.stat-label){font-size:12px;color:var(--text-2)}
:where(.meter){position:relative;display:block;height:4px;border-radius:99px;background:rgb(255 255 255/.08);overflow:hidden}:where(.meter>span){position:absolute;inset:0 auto 0 0;width:calc(var(--p,0)*100%);border-radius:inherit;background:var(--text)}
:where(.dither){background-image:var(--dither-50);background-size:var(--dither-tone-size);image-rendering:pixelated}
:where(.dither-25){background-image:var(--dither-25);background-size:var(--dither-tone-size);image-rendering:pixelated}
::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:rgb(255 255 255/.14);border:3px solid transparent;border-radius:99px;background-clip:content-box}::-webkit-scrollbar-corner{background:transparent}
.sable-streaming *,.sable-streaming *::before,.sable-streaming *::after{animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}}
`;

let cssCache: string | undefined;

/** The frame's base stylesheet: tokens from the running app, then the element defaults. */
export function baseCss(): string {
  if (cssCache) return cssCache;
  const vars: string[] = [];
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  for (const name of TOKENS) {
    const v = cs?.getPropertyValue(name).trim() || FALLBACK[name];
    if (v) vars.push(`${name}:${v}`);
  }
  cssCache = `:root{${vars.join(';')}}${RULES}`;
  return cssCache;
}

function toDataUrl(url: string): Promise<string> {
  return fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).replace(/^data:[^;,]*/, 'data:font/woff2'));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        }),
    );
}

let fontsCache: Promise<string> | undefined;

/**
 * The two fonts as @font-face rules with data URLs (a frame may load nothing from the network).
 * Read once from the files the app already loaded; empty when that fails (system fonts then).
 */
export function fontCss(): Promise<string> {
  fontsCache ??= Promise.all([toDataUrl(interUrl).catch(() => ''), toDataUrl(monoUrl).catch(() => '')]).then(([inter, mono]) => {
    const face = (family: string, src: string, weight: string) =>
      src ? `@font-face{font-family:'${family}';font-style:normal;font-display:block;font-weight:${weight};src:url(${src}) format('woff2-variations'),url(${src}) format('woff2')}` : '';
    return face('Inter Variable', inter, '100 900') + face('Geist Mono Variable', mono, '100 900');
  });
  return fontsCache;
}

/** A standalone page for "Save as file": the widget with the same look, outside Sable. */
export function standaloneHtml(title: string, code: string): string {
  const esc = title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc}</title>\n<style>${baseCss()}\nhtml{background:#0c0c0e}body{max-width:760px;margin:24px auto}</style>\n</head>\n<body>\n${code}\n</body>\n</html>\n`;
}
