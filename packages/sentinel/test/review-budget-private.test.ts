import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../dist/review/providers/budget.js';

test('the review budget database and SQLite siblings stay private, including an older permissive file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-review-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'review-budget.sqlite');
  writeFileSync(path, '', { mode: 0o644 });
  const ledger = await BudgetLedger.open(path);
  t.after(() => ledger.close());
  ledger.createEnvelope({
    id: 'private-review',
    runId: 'run',
    providerId: 'provider',
    bindingDigest: 'sha256:' + 'a'.repeat(64),
    admissionDigest: 'sha256:' + 'b'.repeat(64),
    receiptDigest: null,
    maxTokens: 100,
    maxCostNanos: null,
    currency: null,
    accountingBasis: 'subscription-quota',
    createdAt: '2026-10-28T00:00:00Z',
  });
  const files = readdirSync(dir).filter((name) => name.startsWith('review-budget.sqlite'));
  assert.ok(files.includes('review-budget.sqlite'));
  for (const file of files) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600, file);
});

test('a newly created review budget database starts at 0600', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-review-budget-new-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'review-budget.sqlite');
  const ledger = await BudgetLedger.open(path);
  t.after(() => ledger.close());
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
