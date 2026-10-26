#!/usr/bin/env node
// Owner-run acquisition of the pinned trivy-checks bundle (PR 13, ADR 33). Never part of a test run. An explicit
// setup step: the owner confirms exactly the pinned bundle (an owner-cli receipt issued here, as the owner command
// will), then the one manifest and layer are fetched by digest from the allowlisted registry, checked against the pins
// and stored with their provenance. Scans read the stored copy with no network.
//
//   node scripts/acquire-trivy-checks.mjs --dir <absolute private folder outside any checkout>
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
if (!args.includes('--dir') || !dir || !isAbsolute(dir)) {
  console.error('usage: acquire-trivy-checks.mjs --dir <absolute private folder>');
  process.exit(2);
}
const imp = (p) => import(new URL(`../dist/${p}`, import.meta.url).href);
const { ReceiptBook } = await imp('policy/receipts.js');
const { issueReceipt } = await imp('policy/owner-receipts.js');
const { ensurePrivateDir } = await imp('policy/user-state.js');
const { acquireChecksBundle, checksAcquisitionIntent, loadChecksBundle } = await imp('adapters/trivy/index.js');
ensurePrivateDir(dir, 'sentinel.policy.trustDirUnsafe');
const existing = loadChecksBundle(join(dir, 'checks'));
if (existing) {
  console.log(JSON.stringify({ acquired: false, bundle: existing.bundle }));
  process.exit(0);
}
const book = new ReceiptBook(join(dir, 'receipts'));
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const intent = checksAcquisitionIntent();
const binding = { intent, stateDigest: sha('owner acquisition'), policyRevision: sha('owner acquisition') };
const receipt = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, binding, {
  now: new Date(),
  ttlMs: 60_000,
});
const spent = book.consume(receipt.id, binding, new Date());
const bundle = await acquireChecksBundle({ dir: join(dir, 'checks'), receipt: spent });
console.log(JSON.stringify({ acquired: true, bundle }));
