// The shipped scanner adapter ids are one list (docs/proposals/sentinel-v2 K-2): adapters/drivers/canonical.ts
// exports it, and it must name exactly what productionDrivers registers, each with its adapter's own default id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionDrivers, SCANNER_ADAPTER_IDS, SECRETS_ADAPTER_ID } from '../dist/adapters/drivers/index.js';
import { PATTERN_ADAPTER } from '../dist/adapters/pattern/adapter.js';
import { OSV_ADAPTER } from '../dist/adapters/osv/adapter.js';
import { TRIVY_ADAPTER } from '../dist/adapters/trivy/adapter.js';
import { ZIZMOR_ADAPTER } from '../dist/adapters/zizmor/adapter.js';
import { GITLEAKS_ADAPTER } from '../dist/adapters/gitleaks/adapter.js';

test('the scanner adapter ids are the ones the production drivers register, in a fixed order', () => {
  assert.deepEqual(SCANNER_ADAPTER_IDS, [
    'pattern-semgrep',
    'advisories-osv',
    'iac-trivy',
    'ci-zizmor',
    'secrets-gitleaks',
  ]);
  assert.ok(Object.isFrozen(SCANNER_ADAPTER_IDS));
  assert.deepEqual(
    [...productionDrivers({ maxAdvisoryAgeMs: 86400000 }).keys()].sort(),
    [...SCANNER_ADAPTER_IDS].sort(),
  );
  assert.deepEqual(
    [PATTERN_ADAPTER, OSV_ADAPTER, TRIVY_ADAPTER, ZIZMOR_ADAPTER, GITLEAKS_ADAPTER].map((a) => a.id),
    SCANNER_ADAPTER_IDS,
  );
  assert.equal(SECRETS_ADAPTER_ID, GITLEAKS_ADAPTER.id);
});
