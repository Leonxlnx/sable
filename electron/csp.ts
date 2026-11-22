/**
 * The Content-Security-Policy of every page the app's server sends in the desktop app (passed to
 * startServer, which adds it to each response: set by the server itself, no response waits on the
 * main process for its headers). `appOrigin`: the app's own origin (`http://127.0.0.1:<port>`).
 */
export function pageHeaders(appOrigin: string, pathname: string): Record<string, string> {
  // The page only loads its own code; agent output may show images (data, blob, https) and nothing else.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${appOrigin.replace(/^http/, 'ws')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    // The panel browser is a <webview>; its pages run in a separate guest and are not framed by the app.
    // The only frame the app embeds is its own widget page (generative UI), sandboxed without same-origin.
    "frame-src 'self'",
    // Nothing frames the app: not another local site (a framed app would open a bridge of its own and
    // could be clicked through), not the app itself. The Browser tab shows pages in a <webview>, a top
    // level of its own, so a page of the app opened there is not framed either.
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  // The widget page runs code an agent wrote: no network of any kind, inline code only, and it can
  // frame nothing but its own srcdoc child, which inherits this policy. It is framed BY the app, and
  // holds nothing worth framing (no bridge, no network): no frame-ancestors here, so its inherited
  // policy can never refuse the srcdoc child its place.
  const widgetCsp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
  ].join('; ');
  return { 'content-security-policy': pathname === '/widget-frame.html' ? widgetCsp : csp };
}
