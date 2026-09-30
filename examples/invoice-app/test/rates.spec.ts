import { describe, it, expect } from 'vitest';
import { taxRateFor, taxTreatment } from '../src/server/taxEngine';

/**
 * The rate table, without a database. The first case is parametrised on
 * purpose: its title is a template, so the reporter's expanded rows can only
 * meet this node through a pattern, and the `.skip` / `.todo` below it exist
 * but ran nowhere — the three shapes a results report has to survive.
 */

describe('tax rates', () => {
  it.each([
    ['US', 0],
    ['DE', 0.19],
    ['GB', 0.2],
  ])('the %s rate is %d', (country, rate) => {
    expect(taxRateFor(country as string)).toBe(rate);
  });

  it.skip('the FR treatment is confirmed with finance before it is charged', () => {
    expect(taxTreatment('FR')).toBe('VAT 20%');
  });

  it.todo('the table reloads when the tax service publishes a change');
});
