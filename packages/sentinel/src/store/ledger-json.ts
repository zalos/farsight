// Canonical JSON and digests for ledger-computed identities (request digests, result digests). Keys are sorted
// by UTF-16 code unit, there is no whitespace, and only JSON values are accepted: a value that would silently
// disappear or change (undefined, a function, NaN, a bigint) is refused rather than encoded.
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON refuses a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const plain = typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (plain) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => {
      if (v === undefined) throw new TypeError('canonical JSON refuses an undefined member');
      return `${JSON.stringify(k)}:${canonicalJson(v)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`canonical JSON refuses a ${typeof value}`);
}

export const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
