import { db } from './db';

/**
 * Region-based tax lookup keyed by the customer's country.
 * @business Tax is charged by the customer's country: VAT in the EU,
 * 20% in the UK, none for US customers (handled by TaxJar downstream).
 * @tag tax
 */
export async function computeTax(customerId: string, subtotal: number) {
  const customer = await db.customers.findOne({ id: customerId });
  const rate = RATES[customer?.country ?? 'US'] ?? 0;
  return Math.round(subtotal * rate * 100) / 100;
}

/**
 * Human-readable tax treatment for a country — shown on the invoice PDF and
 * in the audit log.
 * @business How tax is handled for this customer, in plain English.
 * @see computeTax
 * @since 1.2
 */
export function taxTreatment(country: string): string {
  // @business Pick the wording that matches the customer's tax region —
  // EU VAT, UK VAT, or none charged here.
  switch (country) {
    // @business EU member states: VAT at the local rate
    case 'DE':
    case 'FR':
      return `VAT ${RATES[country] * 100}%`;
    case 'GB': // @business United Kingdom: standard-rate VAT
      return 'UK VAT 20%';
    default: // @business US and the rest of the world: no VAT charged here
      return 'no VAT (handled downstream)';
  }
}

/**
 * Raw decimal tax rate for a country.
 * @deprecated Prefer {@link taxTreatment} for display and {@link computeTax}
 * for amounts; direct rate access is slated for removal in 2.0.
 * @since 0.9
 */
export function taxRateFor(country: string): number {
  return RATES[country] ?? 0;
}

const RATES: Record<string, number> = { US: 0.0, DE: 0.19, GB: 0.2, FR: 0.2 };
