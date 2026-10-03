/** An amount as money in words a person reads: 1234.5 → "$1,234.50". */
export function formatMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
