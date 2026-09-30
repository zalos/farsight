// provenance.js — stub. Pass P3 builds the one metric chip + popover
// component (formula · scope · as-of · origin · uncertainty · evidence) that
// every surface must use to print a number; until then no module may render
// a metric, which is why this stub exports the seam and nothing else.

import { esc } from './store.js';

/**
 * P3 seam: the only sanctioned way to print a metric. Until core/metrics.ts
 * exists there are no MetricValue objects, so this renders an explicit
 * not-yet marker rather than a bare number — a count without provenance is
 * the failure mode P3 closes (G6/F3).
 * @group Provenance
 */
export function metricChip(metricValue) {
  if (!metricValue) return '<span class="metric-chip metric-pending" title="provenance popovers ship in pass P3">—</span>';
  // P3: value + scope chip + popover with numerator/denominator/evidence
  return '<span class="metric-chip">' + esc(String(metricValue.value)) + '</span>';
}
