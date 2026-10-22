#!/usr/bin/env node
// Owner-run qualification of the OSV adapter against the real OSV advisory archives. Never part of a test run or CI.
//
//   node scripts/qualify-osv-database.mjs --acquire --dir <private folder outside any checkout> [--ecosystem npm|Maven ...]
//   node scripts/qualify-osv-database.mjs --scan-only --dir <the same folder>   (reuse stored snapshots; no network)
//
// 1. Acquisition (the only network step): the owner confirms exactly this request (an owner-cli receipt issued here,
//    as the owner command will), then the archives are fetched from the one allowlisted origin, size-bounded and
//    checked against the origin's MD5, and stored by SHA-256 with their provenance.
// 2. Offline scans through PR 07's isolated execution service with those snapshots: the original synthetic fixtures
//    (no false positive expected: their packages are made up) and runtime-only positive controls naming real, known-
//    affected versions in a temporary captured tree. Nothing is installed; no control file is ever committed.
// Prints measurements as JSON. Requires the pinned OSV-Scanner image installed and a qualified container runtime.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const dir = values('--dir')[0];
if ((!flag('--acquire') && !flag('--scan-only')) || !dir || !isAbsolute(dir)) {
  console.error('usage: qualify-osv-database.mjs --acquire|--scan-only --dir <absolute private folder> [--ecosystem npm|Maven ...]');
  process.exit(2);
}
const ecosystems = values('--ecosystem').length ? values('--ecosystem') : ['npm', 'Maven'];
const pkg = fileURLToPath(new URL('../', import.meta.url));
const imp = (p) => import(new URL(`../dist/${p}`, import.meta.url).href);
const { acquireAdvisorySnapshots, acquisitionIntent, loadAdvisorySnapshot, runOsvAttempt, OSV_ADAPTER } = await imp('adapters/osv/index.js');
const { ReceiptBook } = await imp('policy/receipts.js');
const { issueReceipt } = await imp('policy/owner-receipts.js');
const { createAdapterRegistry } = await imp('execution/registry.js');
const { createExecutionService } = await imp('execution/service.js');
const { openStore } = await imp('store/index.js');

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const work = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-osv-qualify-')));
chmodSync(work, 0o700);
const out = { engine: OSV_ADAPTER.image, ecosystems, acquisition: [], scans: [] };
try {
  // 1. Acquisition (or the stored snapshots, with --scan-only).
  let snapshots;
  if (flag('--acquire')) {
    const request = { ecosystems, maxBytesPerEcosystem: 512 * 1024 * 1024 };
    const intent = acquisitionIntent(request);
    const book = new ReceiptBook(join(work, 'trust', 'receipts'));
    const binding = { intent, stateDigest: sha('qualification'), policyRevision: sha('qualification') };
    const receipt = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, binding, { now: new Date(), ttlMs: 600_000 });
    const spent = book.consume(receipt.id, binding, new Date());
    const t0 = Date.now();
    snapshots = await acquireAdvisorySnapshots(request, { dir, receipt: spent });
    out.acquisitionMs = Date.now() - t0;
  } else {
    snapshots = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .filter((s) => ecosystems.includes(s.ecosystem));
  }
  out.acquisition = snapshots.map((s) => ({ ecosystem: s.ecosystem, sha256: s.sha256, bytes: s.size, sourceLastModified: s.sourceLastModified, md5: s.md5 }));
  const loaded = snapshots.map((s) => loadAdvisorySnapshot(dir, s.sha256));

  // 2. Offline scans.
  const store = await openStore(join(work, 'store'));
  const scratch = join(work, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  const service = await createExecutionService(store, { scratchRoot: scratch, registry: createAdapterRegistry([OSV_ADAPTER]), containers: true });
  const tree = (name, files) => {
    const root = join(work, name);
    return Object.entries(files).map(([rel, text]) => {
      const path = join(root, rel);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(path, text, { mode: 0o600 });
      return { relativePath: rel, path, artifact: sha(Buffer.from(text)) };
    });
  };
  const fixtures = (await import(new URL('../test/osv-helpers.ts', import.meta.url).href).catch(() => null));
  const scan = async (label, targets) => {
    const t1 = Date.now();
    const r = await runOsvAttempt(service, { attemptId: `att-qualify-${label}`, work: { id: 'work-qualify', revision: 1 }, targets, snapshots: loaded, scratch: work, policy: { now: new Date(), maxDatabaseAgeMs: 7 * 86_400_000 } });
    out.scans.push({
      label, ms: Date.now() - t1, attempt: r.attempt, platform: r.platform, engineExit: r.engineExit, engineFailure: r.engineFailure,
      databases: r.databases.map((d) => ({ ecosystem: d.ecosystem, freshness: d.freshness, ageHours: Math.round(d.ageMs / 3_600_000) })),
      coverage: r.coverage.map((c) => `${c.relativePath} ${c.status} ${c.limitations.map((l) => l.split('.').pop()).join(',')}`),
      components: r.components.length,
      findings: Object.entries(r.findings.reduce((m, f) => { const k = `${f.ecosystem}:${f.name}@${f.version} (${f.certainty})`; m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, v]) => `${k}: ${v} advisory groups`),
      refused: r.refused.map((x) => x.reasonCode.split('.').pop()),
    });
  };
  if (fixtures) await scan('synthetic-fixtures', fixtures.capturedTree(join(work, 'fixtures')));
  // Runtime-only positive controls: real, long-published affected versions; written here, scanned, deleted.
  await scan('real-controls', tree('controls', {
    'web/package-lock.json': JSON.stringify({ name: 'qualify', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'qualify', version: '1.0.0', dependencies: { lodash: '4.17.11' } },
      'node_modules/lodash': { version: '4.17.11', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.11.tgz', integrity: 'sha512-qualificationcontrolnotverified' } } }),
    'api/pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>q</groupId><artifactId>q</artifactId><version>1</version><dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.9.8</version></dependency></dependencies></project>',
  }));
  // A known-affected package with no registry source: the engine lists it with no advisories and says nothing else.
  await scan('real-local-skip', tree('local', {
    'web/package-lock.json': JSON.stringify({ name: 'qualify', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'qualify', version: '1.0.0' }, 'node_modules/lodash': { version: '4.17.11' },
      'node_modules/minimist': { version: '1.2.0', resolved: 'https://registry.npmjs.org/minimist/-/minimist-1.2.0.tgz', integrity: 'sha512-qualificationcontrolnotverified' } } }),
  }));
  await store.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
