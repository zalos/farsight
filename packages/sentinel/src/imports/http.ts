// HTTP/1.x message heads as a report recorded them: a request or status line and its header lines, CRLF-separated and
// ending in an empty line. A head that is folded (obsolete line folding), truncated, uses a bare CR or LF, carries a
// control character, or names an unsupported version is not read further: its Set-Cookie lines stay unknown. Nothing
// here contacts the target; a URL is only compared as text.
import { ImportBudget, type ImportUnknownCode } from './types.js';

export interface HeaderLine { readonly name: string; readonly lower: string; readonly value: string }
export type Head<T> = { readonly ok: true; readonly start: T; readonly headers: readonly HeaderLine[] } | { readonly ok: false; readonly code: ImportUnknownCode };
export interface StatusLine { readonly version: '1.0' | '1.1'; readonly status: number }
export interface RequestLine { readonly method: string; readonly target: string; readonly version: '1.0' | '1.1' }

export const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A field value: visible ASCII, obs-text, space and tab; no other control character. */
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\uffff]*$/;
const STATUS = /^HTTP\/([0-9])(?:\.([0-9]))? ([0-9]{3})(?: [\t\x20-\x7e\x80-\uffff]*)?$/;
const REQUEST = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+) ([\x21-\x7e]+) HTTP\/([0-9])\.([0-9])$/;

export function validFieldValue(v: string): boolean { return FIELD_VALUE.test(v); }

function version(major: string, minor: string | undefined): '1.0' | '1.1' | undefined {
  return major === '1' && (minor === '0' || minor === '1') ? `1.${minor}` as '1.0' | '1.1' : undefined;
}

export function parseStatusLine(line: string): StatusLine | ImportUnknownCode {
  const m = STATUS.exec(line);
  if (!m) return /^HTTP\/[0-9]/.test(line) ? 'sentinel.import.statusMalformed' : 'sentinel.import.headerMalformed';
  const v = version(m[1]!, m[2]);
  if (!v) return 'sentinel.import.versionUnsupported';
  const status = Number(m[3]);
  if (status < 100 || status > 599) return 'sentinel.import.statusMalformed';
  return { version: v, status };
}

export function parseRequestLine(line: string): RequestLine | ImportUnknownCode {
  const m = REQUEST.exec(line);
  if (!m) return 'sentinel.import.requestMalformed';
  const v = version(m[3]!, m[4]!);
  if (!v) return 'sentinel.import.versionUnsupported';
  return { method: m[1]!, target: m[2]!, version: v };
}

/** Splits one recorded head into its first line and header lines; any irregularity is an unknown, not a guess. */
export function parseHead<T>(text: string, first: (line: string) => T | ImportUnknownCode, budget: ImportBudget): Head<T> {
  budget.work(Math.ceil(text.length / 64) + 1);
  if (!text.endsWith('\r\n\r\n')) return { ok: false, code: 'sentinel.import.headerTruncated' };
  const lines = text.slice(0, -4).split('\r\n');
  budget.count('headerLines', lines.length);
  for (const line of lines) {
    if (line.includes('\r') || line.includes('\n')) return { ok: false, code: 'sentinel.import.headerMalformed' };
    if (Buffer.byteLength(line, 'utf8') > budget.limits.headerLineBytes) return { ok: false, code: 'sentinel.import.headerMalformed' };
  }
  const start = first(lines[0]!);
  if (typeof start === 'string') return { ok: false, code: start as ImportUnknownCode };
  const headers: HeaderLine[] = [];
  for (const line of lines.slice(1)) {
    budget.work();
    if (line === '') return { ok: false, code: 'sentinel.import.headerMalformed' };
    if (line[0] === ' ' || line[0] === '\t') return { ok: false, code: 'sentinel.import.headerFolded' };
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon) : '';
    if (!TOKEN.test(name)) return { ok: false, code: 'sentinel.import.headerMalformed' };
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
    if (!validFieldValue(value)) return { ok: false, code: 'sentinel.import.headerMalformed' };
    headers.push({ name, lower: name.toLowerCase(), value });
  }
  return { ok: true, start: start as T, headers };
}

/**
 * The origin an absolute http(s) request target names, as text; undefined for an origin-form target (`/path`), a
 * target with user information, or anything else. Never dereferenced.
 */
export function originOf(target: string): string | undefined {
  if (!/^https?:\/\/[^\s/?#@]+(?:[/?#][\x21-\x7e]*)?$/i.test(target)) return undefined;
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;
  return url.origin;
}

/** A canonical origin as a manifest must state it: `scheme://host[:port]`, exactly as URL serializes it. */
export function isCanonicalOrigin(origin: string): boolean {
  return typeof origin === 'string' && origin.length <= 512 && originOf(origin) === origin;
}

/** A supplied Host must agree with the recorded absolute target. Missing Host is allowed for absolute-form claims;
 * origin-form needs exactly one. Duplicate or contradictory Host is conservative report inconsistency, not an RFC
 * invalidity judgment. This only compares report fields and never reads an origin from the caller's manifest. */
export function hostAgrees(headers: readonly HeaderLine[], target: string, required: boolean): boolean {
  const hosts = headers.filter(h => h.lower === 'host');
  if (hosts.length === 0) return !required;
  if (hosts.length !== 1) return false;
  let absolute: URL;
  try { absolute = new URL(target); } catch { return false; }
  const host = hosts[0]!.value;
  if (!/^[\x21-\x7e]+$/.test(host) || /[/?#@\\]/.test(host)) return false;
  // Compare canonical authorities (case and default ports), without accepting path/userinfo normalization.
  const origin = originOf(`${absolute.protocol}//${host}`);
  return origin !== undefined && origin === absolute.origin;
}
