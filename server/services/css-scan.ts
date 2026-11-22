/**
 * What a stylesheet asks for beyond this computer, read the way the browser reads it: a tokenizer
 * after CSS Syntax Level 3 (comments, strings with their escapes and line continuations, `url(`
 * tokens, escaped identifiers such as `\75 rl(`), so a comment delimiter inside a string or a quote
 * inside a comment hides nothing. Used by `custom.ts` before the person's sheet is served.
 *
 * The rule: every address the sheet can fetch must be a `data:` URI or a path on the app's own origin.
 * Addresses are found in `url()` tokens, in strings inside the functions that take them (`url`, `src`,
 * `image-set`, `image`, `cross-fade`, prefixed or not), and in strings of custom properties (which
 * `var()` can carry into those). A string elsewhere that looks like an address of another place
 * counts too. When in doubt the sheet is refused: an `@import` of any kind, an unfinished comment,
 * string or `url(`, a bad `url(`, or an address whose destination cannot be told.
 */

type Tok =
  | { t: 'ident' | 'func' | 'at' | 'string' | 'url'; v: string }
  | { t: 'punct'; v: '(' | ')' | '[' | ']' | '{' | '}' | ';' | ':' | ',' }
  | { t: 'other' };

class Unsafe extends Error {}

const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isNameStart = (c: string | undefined) => !!c && (/[A-Za-z_]/.test(c) || c.codePointAt(0)! >= 0x80);
const isName = (c: string | undefined) => !!c && (isNameStart(c) || /[0-9-]/.test(c));
const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
/** Characters that end an unquoted url( or make it bad. */
const nonPrintable = (c: string) => {
  const n = c.codePointAt(0)!;
  return n <= 8 || n === 0x0b || (n >= 0x0e && n <= 0x1f) || n === 0x7f;
};

function tokenize(input: string): Tok[] {
  // Preprocessing: newlines normalized, NUL replaced.
  const s = [...input.replace(/\r\n|\r|\f/g, '\n').replace(/\0/g, '�')];
  const out: Tok[] = [];
  let i = 0;
  const at = (k = 0) => s[i + k];
  const validEscape = (k = 0) => at(k) === '\\' && at(k + 1) !== undefined && at(k + 1) !== '\n';
  const startsIdent = (k = 0) => {
    const c = at(k);
    if (c === '-') return isNameStart(at(k + 1)) || at(k + 1) === '-' || validEscape(k + 1);
    if (c === '\\') return validEscape(k);
    return isNameStart(c);
  };
  /** After a backslash (already consumed). */
  const escape = (): string => {
    const c = at();
    if (c === undefined) return '�';
    if (isHex(c)) {
      let hex = '';
      while (hex.length < 6 && at() !== undefined && isHex(at())) hex += s[i++];
      if (isWs(at())) i++;
      const n = parseInt(hex, 16);
      return n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff ? '�' : String.fromCodePoint(n);
    }
    i++;
    return c;
  };
  const name = (): string => {
    let v = '';
    for (;;) {
      if (isName(at())) v += s[i++];
      else if (validEscape()) {
        i++;
        v += escape();
      } else return v;
    }
  };
  const string = (quote: string): string => {
    let v = '';
    for (;;) {
      const c = s[i++];
      if (c === undefined) throw new Unsafe('an unfinished string');
      if (c === quote) return v;
      if (c === '\n') throw new Unsafe('a string broken across lines');
      if (c === '\\') {
        if (at() === undefined) continue;
        if (at() === '\n') {
          i++;
          continue;
        }
        v += escape();
      } else v += c;
    }
  };
  /** An unquoted url( (the `url(` and the whitespace after it consumed). */
  const url = (): string => {
    let v = '';
    for (;;) {
      const c = s[i++];
      if (c === undefined) throw new Unsafe('an unfinished url()');
      if (c === ')') return v;
      if (isWs(c)) {
        while (isWs(at())) i++;
        if (at() === ')') {
          i++;
          return v;
        }
        throw new Unsafe('a url() it cannot read');
      }
      if (c === '"' || c === "'" || c === '(' || nonPrintable(c)) throw new Unsafe('a url() it cannot read');
      if (c === '\\') {
        if (!(at() !== undefined && at() !== '\n')) throw new Unsafe('a url() it cannot read');
        v += escape();
      } else v += c;
    }
  };

  while (i < s.length) {
    const c = at();
    if (c === '/' && at(1) === '*') {
      let j = i + 2;
      while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
      if (j >= s.length) throw new Unsafe('an unfinished comment');
      i = j + 2;
      continue;
    }
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      out.push({ t: 'string', v: string(c) });
      continue;
    }
    if (c === '@' && startsIdent(1)) {
      i++;
      out.push({ t: 'at', v: name() });
      continue;
    }
    if (/[0-9]/.test(c) || ((c === '+' || c === '-' || c === '.') && /[0-9.]/.test(at(1) ?? ''))) {
      // A number with its unit: the unit is a name and nothing that fetches.
      i++;
      while (/[0-9.eE]/.test(at() ?? '')) i++;
      if (startsIdent()) name();
      out.push({ t: 'other' });
      continue;
    }
    if (startsIdent()) {
      const v = name();
      if (at() === '(') {
        i++;
        if (v.toLowerCase() === 'url') {
          while (isWs(at())) i++;
          if (at() === '"' || at() === "'") out.push({ t: 'func', v });
          else out.push({ t: 'url', v: url() });
        } else out.push({ t: 'func', v });
      } else out.push({ t: 'ident', v });
      continue;
    }
    i++;
    if ('()[]{};:,'.includes(c)) out.push({ t: 'punct', v: c as '(' });
    else out.push({ t: 'other' });
  }
  return out;
}

/** The functions whose strings are addresses. */
const URL_FUNCS = /^(?:-webkit-)?(?:url|src|image-set|image|cross-fade)$/i;

/**
 * Whether an address stays on this computer: a `data:` URI or a path on the app's own origin. The URL
 * parser drops tabs and newlines anywhere and spaces and controls at the ends, and treats a backslash
 * as a slash: an address is looked at as it will parse.
 */
function local(address: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = address.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (/^data:/i.test(v)) return true;
  // A scheme of any kind (`https:x` parses as https://x), or a host of its own (`//`, `\\`, `/\`).
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false;
  if (/^[\\/]{2}/.test(v)) return false;
  return true;
}

/** A string anywhere else that names another place. */
const elsewhere = (v: string) => !/^\s*data:/i.test(v) && /(?:^|[^a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}[^\\/\s]/i.test(v.replace(/[\t\n\r]/g, ''));

/**
 * What in the sheet would reach beyond this computer, or why it cannot be told: undefined when
 * nothing does. The answer finishes "It asks for …".
 */
export function remoteRef(css: string): string | undefined {
  let toks: Tok[];
  try {
    toks = tokenize(css);
  } catch (err) {
    if (err instanceof Unsafe) return err.message;
    throw err;
  }
  const short = (v: string) => v.slice(0, 120);
  // Open blocks and functions; whether each one takes addresses.
  const stack: boolean[] = [];
  /** The declaration's property in the innermost `{}`, while in its value. */
  let prop: string | undefined;
  let last: Tok | undefined;
  for (const tok of toks) {
    if (tok.t === 'at') {
      if (/^import$/i.test(tok.v)) return 'another stylesheet (@import)';
    } else if (tok.t === 'url') {
      if (!local(tok.v)) return short(tok.v || 'url()');
    } else if (tok.t === 'string') {
      const inUrl = stack.some(Boolean);
      const custom = !!prop?.startsWith('--');
      if ((inUrl || custom) && !local(tok.v)) return short(tok.v);
      if (elsewhere(tok.v)) return short(tok.v);
    } else if (tok.t === 'func') {
      stack.push(URL_FUNCS.test(tok.v));
    } else if (tok.t === 'punct') {
      if (tok.v === '(' || tok.v === '[') stack.push(false);
      else if (tok.v === ')' || tok.v === ']') stack.pop();
      else if (tok.v === '{') {
        stack.push(false);
        prop = undefined;
      } else if (tok.v === '}') {
        stack.pop();
        prop = undefined;
      } else if (tok.v === ';') prop = undefined;
      else if (tok.v === ':' && last?.t === 'ident' && prop === undefined) prop = last.v;
    }
    last = tok;
  }
  return undefined;
}
