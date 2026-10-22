// Money as exact integers of nano-units (nine fractional digits, the DecimalAmount contract's precision). Never a
// binary float: parsing, rate multiplication and rounding are BigInt arithmetic, and cost estimates round up.
const DECIMAL = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,9})?$/;
export const NANOS = 1_000_000_000n;

/** A DecimalAmount as nano-units; null for anything that is not one. */
export function toNanos(amount: unknown): bigint | null {
  if (typeof amount !== 'string' || !DECIMAL.test(amount)) return null;
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole!) * NANOS + BigInt(frac.padEnd(9, '0'));
}

/** Nano-units as the shortest DecimalAmount. */
export function fromNanos(nanos: bigint): string {
  if (nanos < 0n) throw new RangeError('a negative amount');
  const whole = nanos / NANOS;
  const frac = (nanos % NANOS).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The cost of `tokens` at `perMillion` nano-units per million tokens, rounded up to a whole nano-unit. */
export function costOf(tokens: number, perMillionNanos: bigint): bigint {
  const n = BigInt(tokens) * perMillionNanos;
  return (n + 999_999n) / 1_000_000n;
}
