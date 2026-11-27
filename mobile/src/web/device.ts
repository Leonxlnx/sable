/**
 * What a browser is, in the words a person uses for it: "iPad · Safari", "Mac · Chrome", "Windows PC ·
 * Edge", "Android tablet · Chrome". The name a web pairing asks with (the pairing screen lets the person
 * change it first); the desktop shows it on its Allow card, its device row and "From iPad · Safari" on a
 * message. Read from the user agent (an iPad's Safari says "Macintosh" and has a touch screen). Pure.
 */
export function deviceLabel(ua: string, touchPoints = 0): string {
  const device = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
    ? 'iPad'
    : /iPhone|iPod/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux PC'
                : '';
  const browser = /EdgiOS|EdgA|Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|OPT\//.test(ua)
      ? 'Opera'
      : /FxiOS|Firefox\//.test(ua)
        ? 'Firefox'
        : /SamsungBrowser/.test(ua)
          ? 'Samsung Internet'
          : /CriOS|Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  return [device, browser].filter(Boolean).join(' · ') || 'Web browser';
}

/** A name the person typed, as the desktop will keep it: one line, no edges, at most 40 characters. */
export function cleanDeviceName(name: string): string {
  // Control characters, invisible marks and direction overrides go (by code point), and < > as the desktop drops them.
  const hidden = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
  const kept = [...name].filter((ch) => !hidden(ch.codePointAt(0) ?? 0) && ch !== '<' && ch !== '>').join('');
  return kept.replace(/\s+/g, ' ').trim().slice(0, 40).trim();
}
