// One Set-Cookie line, read strictly (RFC 6265 §4.1.1) before any attribute is believed. The cookie pair is checked
// first: a token name and a plain or double-quoted value of cookie-octets. A line is never split on commas; a comma is
// accepted only inside a well-formed Expires date, and anywhere else makes the whole line ambiguous (it may be two
// folded cookies). A repeated Domain or Path leaves the cookie's identity ambiguous; a repeated or malformed Secure,
// HttpOnly or SameSite leaves that one property unknown. A deletion (Max-Age not above zero) is not an issued cookie and
// yields no attribute fact; an Expires date alone cannot say whether the line issues or deletes the cookie, since no
// trusted clock is consulted, so its lifetime is recorded as stated. The value itself is never kept: only its length.
import type { ImportUnknownCode } from './types.js';
import { TOKEN } from './http.js';

const COOKIE_OCTETS = '[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]';
const COOKIE_VALUE = new RegExp(`^(?:"${COOKIE_OCTETS}*"|${COOKIE_OCTETS}*)$`);
/** Any CHAR except controls and `;` (av-octet); the comma is checked separately. */
const AV_VALUE = /^[\x20-\x3a\x3c-\x7e]*$/;
const DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12][0-9]|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] GMT$/;
const MAX_AGE = /^-?[0-9]{1,10}$/;

export type AttributeFact =
  | { readonly outcome: 'present'; readonly value?: 'strict' | 'lax' | 'none' }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unknown'; readonly reason: ImportUnknownCode };

export type Lifetime = 'session' | 'max-age' | 'expires-stated' | 'deletion' | 'unknown';

export interface CookieLine {
  readonly ok: true;
  readonly name: string;
  readonly valueBytes: number;
  readonly quoted: boolean;
  readonly domain: string | null;
  readonly path: string | null;
  readonly lifetime: Lifetime;
  readonly secure: AttributeFact;
  readonly httpOnly: AttributeFact;
  readonly sameSite: AttributeFact;
  readonly partitioned: boolean;
  /** Attribute names this reader does not interpret, lower-cased, at most 16. */
  readonly extensions: readonly string[];
}
export type CookieParse = CookieLine | { readonly ok: false; readonly reason: ImportUnknownCode };

const bad = (reason: ImportUnknownCode): CookieParse => ({ ok: false, reason });

export function parseSetCookie(line: string): CookieParse {
  if (typeof line !== 'string' || line.length === 0 || line.length > 16 * 1024) return bad('sentinel.import.cookieMalformed');
  if (!/^[\x20-\x7e]*$/.test(line)) return bad('sentinel.import.cookieMalformed');
  const parts = line.split(';');
  const pair = parts[0]!;
  const eq = pair.indexOf('=');
  if (eq <= 0) return bad(pair.includes(',') ? 'sentinel.import.commaAmbiguous' : 'sentinel.import.cookieMalformed');
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  if (pair.includes(',')) return bad('sentinel.import.commaAmbiguous');
  if (!TOKEN.test(name) || !COOKIE_VALUE.test(value)) return bad('sentinel.import.cookieMalformed');

  const seen = new Map<string, string[]>();
  const valueless = new Set<string>();
  const extensions: string[] = [];
  for (const raw of parts.slice(1)) {
    const av = raw.replace(/^ +| +$/g, '');
    if (av === '') return bad('sentinel.import.cookieMalformed');
    const i = av.indexOf('=');
    const key = (i < 0 ? av : av.slice(0, i)).replace(/ +$/, '').toLowerCase();
    const val = i < 0 ? null : av.slice(i + 1).replace(/^ +/, '');
    if (!key || !TOKEN.test(key)) return bad(av.includes(',') ? 'sentinel.import.commaAmbiguous' : 'sentinel.import.cookieMalformed');
    if (val !== null && !AV_VALUE.test(val)) return bad('sentinel.import.cookieMalformed');
    if (av.includes(',') && !(key === 'expires' && val !== null && DATE.test(val))) return bad('sentinel.import.commaAmbiguous');
    if (val === null) valueless.add(key);
    const list = seen.get(key) ?? [];
    list.push(val ?? '');
    seen.set(key, list);
    if (!['expires', 'max-age', 'domain', 'path', 'secure', 'httponly', 'samesite', 'partitioned'].includes(key)
      && !extensions.includes(key) && extensions.length < 16) extensions.push(key);
  }
  const one = (k: string) => seen.get(k);
  if ((one('domain')?.length ?? 0) > 1 || (one('path')?.length ?? 0) > 1) return bad('sentinel.import.selectorAmbiguous');

  const flag = (k: string): AttributeFact => {
    const v = one(k);
    if (!v) return { outcome: 'absent' };
    if (v.length > 1) return { outcome: 'unknown', reason: 'sentinel.import.attributeDuplicate' };
    if (!valueless.has(k)) return { outcome: 'unknown', reason: 'sentinel.import.attributeMalformed' };
    return { outcome: 'present' };
  };
  const sameSite = ((): AttributeFact => {
    const v = one('samesite');
    if (!v) return { outcome: 'absent' };
    if (v.length > 1) return { outcome: 'unknown', reason: 'sentinel.import.attributeDuplicate' };
    if (valueless.has('samesite')) return { outcome: 'unknown', reason: 'sentinel.import.attributeMalformed' };
    const s = v[0]!.toLowerCase();
    return s === 'strict' || s === 'lax' || s === 'none' ? { outcome: 'present', value: s } : { outcome: 'unknown', reason: 'sentinel.import.sameSiteUnrecognized' };
  })();

  const lifetime = ((): Lifetime => {
    const ma = one('max-age');
    const ex = one('expires');
    if ((ma?.length ?? 0) > 1 || (ex?.length ?? 0) > 1) return 'unknown';
    if (ma) {
      if (!MAX_AGE.test(ma[0]!)) return 'unknown';
      return Number(ma[0]) <= 0 ? 'deletion' : 'max-age';
    }
    if (ex) return DATE.test(ex[0]!) ? 'expires-stated' : 'unknown';
    return 'session';
  })();

  const deleted: AttributeFact = { outcome: 'unknown', reason: 'sentinel.import.deletionCookie' };
  const domain = one('domain')?.[0] ?? null;
  const path = one('path')?.[0] ?? null;
  return {
    ok: true, name, valueBytes: value.length, quoted: value.startsWith('"'),
    domain: domain === null ? null : domain.slice(0, 256), path: path === null ? null : path.slice(0, 1024), lifetime,
    secure: lifetime === 'deletion' ? deleted : flag('secure'),
    httpOnly: lifetime === 'deletion' ? deleted : flag('httponly'),
    sameSite: lifetime === 'deletion' ? deleted : sameSite,
    partitioned: one('partitioned') !== undefined,
    extensions,
  };
}

/** The cookie names in one request Cookie header (`a=1; b=2`); undefined when the header is not that strict shape. */
export function requestCookieNames(value: string): readonly string[] | undefined {
  if (!/^[\x20-\x7e]*$/.test(value) || value.length === 0) return undefined;
  const names: string[] = [];
  for (const pair of value.split('; ')) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || !TOKEN.test(pair.slice(0, eq)) || !COOKIE_VALUE.test(pair.slice(eq + 1))) return undefined;
    names.push(pair.slice(0, eq));
  }
  return names;
}
