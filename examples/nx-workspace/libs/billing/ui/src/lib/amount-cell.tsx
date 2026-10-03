import { formatMoney } from '@nxw/shared/util';

/** One amount, right-aligned, in the account's currency. */
export function AmountCell({ cents }: { cents: number }) {
  return <span style={{ textAlign: 'right' }}>{formatMoney(cents / 100)}</span>;
}
