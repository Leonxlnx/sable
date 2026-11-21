/**
 * An error's detail as a person reads it. The agents pass an API failure on as it came off the
 * wire: `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
 * The card says what the service said ("Overloaded") and the status; the raw line stays one hover
 * away. Anything that is not a status with a JSON body is shown as it is.
 */
export interface ErrorDetail {
  /** What to show. */
  text: string;
  /** The HTTP status, when the line named one. */
  status?: string;
  /** The line as it came, when `text` is a reading of it. */
  raw?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function readErrorDetail(detail: string): ErrorDetail {
  const at = detail.indexOf('{');
  if (at < 0 || !detail.trimEnd().endsWith('}')) return { text: detail };
  let body: unknown;
  try {
    body = JSON.parse(detail.slice(at));
  } catch {
    return { text: detail };
  }
  if (!body || typeof body !== 'object') return { text: detail };
  const b = body as { error?: unknown; message?: unknown; detail?: unknown };
  const inner = b.error && typeof b.error === 'object' ? (b.error as { message?: unknown }) : undefined;
  const said = str(inner?.message) ?? str(b.message) ?? str(b.error) ?? str(b.detail);
  if (!said || said.length > 400) return { text: detail };
  const status = /\b([45]\d\d)\b/.exec(detail.slice(0, at))?.[1];
  return { text: said, status, raw: detail };
}
