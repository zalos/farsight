// The pinned OSV-Scanner itself, in full offline mode, through PR 07's isolated execution service only (no host
// fallback, no pull, no network). Runs with SENTINEL_ISOLATION=1; inputs are the original synthetic fixtures and
// synthetic advisory snapshots, under their real names only in a temporary captured tree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import {
  OSV_ADAPTER,
  OSV_MEASURED_ARCHITECTURES,
  buildOsvAdapter,
  runOsvAttempt,
  explainAdvisoryChanges,
} from '../dist/adapters/osv/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { capturedTree, syntheticSnapshot, storedZip, sha } from './osv-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip =
  !enabled &&
  'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned OSV-Scanner image installed';
const QUALIFY = process.env.SENTINEL_OSV_QUALIFY?.replace(/^linux\//, '');
const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 86_400_000;

// A variant whose engine refuses its arguments (OSV-Scanner exits 127): the worker sends a diagnostic and then its
// result, and the failure must arrive as the engine's own (not a protocol violation) and count nothing.
const BAD_ARGS = buildOsvAdapter({
  id: 'advisories-osv-badargs',
  engineArgs: ['scan', 'source', '--offline', '--no-such-sentinel-flag'],
});

let root: { root: string; work: string };
let store: any;
let service: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  root = scratch('osv');
  store = await storeIn(root.root);
  service = await createExecutionService(store, {
    scratchRoot: root.work,
    registry: createAdapterRegistry([OSV_ADAPTER, BAD_ARGS.definition]),
    containers: true,
  });
});
after(async () => {
  if (enabled) {
    await store.close();
    removeScratch(root.root);
  }
});

const snapshots = (ids: number[], age = '2026-10-21T00:00:00.000000000Z') => [
  syntheticSnapshot(join(root.root, `db-${n}`), 'npm', ids, age),
  syntheticSnapshot(join(root.root, `db-${n}`), 'Maven', ids, age),
];
const run = (targets: any[], snaps: any[], maxDatabaseAgeMs = 7 * DAY) =>
  runOsvAttempt(service, {
    attemptId: `att-osv-${n++}`,
    work: { id: 'work-osv', revision: 1 },
    targets,
    snapshots: snaps,
    scratch: root.root,
    policy: { now: NOW, maxDatabaseAgeMs },
    ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}),
  });
const row = (r: any, p: string) => {
  const c = r.coverage.find((x: any) => x.relativePath === p);
  return `${c.status}:${c.limitations.map((l: string) => l.split('.').pop()).join(',')}`;
};

test(
  'lockfiles match completely, a Maven manifest says what it cannot know, an SBOM is assessed as listed',
  { skip },
  async () => {
    const t0 = Date.now();
    const r = await run(capturedTree(join(root.root, `tree-${n++}`)), snapshots([1, 2, 3, 5]));
    const wall = Date.now() - t0;
    assert.equal(r.attempt, 'succeeded');
    assert.equal(r.engineExit, 1, 'advisories found');
    assert.equal(r.engineFailure, null);
    assert.equal(r.platform.state, QUALIFY && !OSV_MEASURED_ARCHITECTURES.has(QUALIFY) ? 'candidate' : 'measured');
    assert.equal(row(r, 'web/package-lock.json'), 'complete:');
    assert.equal(row(r, 'web/pnpm-lock.yaml'), 'complete:');
    assert.equal(row(r, 'api/pom.xml'), 'partial:versionsUnknown,transitivesNotResolved');
    assert.equal(row(r, 'api/target/bom.cdx.json'), 'complete:');
    const pom = Object.fromEntries(
      r.components
        .filter((c: any) => c.relativePath === 'api/pom.xml')
        .map((c: any) => [c.name.split(':')[1], `${c.certainty}/${c.assessed}`]),
    );
    assert.deepEqual(pom, {
      'fixture-direct': 'declared-exact/true',
      'fixture-property': 'declared-property/true',
      'fixture-ranged': 'declared-range/false',
      'fixture-managed': 'unknown-managed/false',
    });
    assert.ok(r.components.filter((c: any) => c.kind !== 'maven-pom').every((c: any) => c.assessed));
    const found = new Set(
      r.findings.map(
        (f: any) =>
          `${f.name}@${f.version} ${f.advisories.ids.join(',')} ${f.occurrences.map((o: any) => o.relativePath).join('+')}`,
      ),
    );
    assert.deepEqual(
      found,
      new Set([
        'sentinel-fixture-alpha@1.0.0 SENTINEL-FIXTURE-2026-0001 web/package-lock.json+web/pnpm-lock.yaml',
        'org.example.sentinel:fixture-direct@1.4.0 SENTINEL-FIXTURE-2026-0002 api/pom.xml+api/target/bom.cdx.json',
        'org.example.sentinel:fixture-transitive@0.9.2 SENTINEL-FIXTURE-2026-0005 api/target/bom.cdx.json',
      ]),
      'one finding per component and advisory, across every file that names it',
    );
    assert.ok(
      r.refused.some(
        (x: any) => x.reasonCode === 'sentinel.osv.refused.versionUnverified' && x.relativePath === 'api/pom.xml',
      ),
      'a match on a range lower bound is refused',
    );
    assert.ok(!JSON.stringify(r).includes('made-up flaw'), 'advisory text is not kept');
    console.log(`# osv conformance: ${r.components.length} components, ${r.findings.length} findings, ${wall} ms`);
  },
);

test('same source, a new advisory snapshot: a new assessment explained by the database change', { skip }, async () => {
  const tree = capturedTree(join(root.root, `tree-${n++}`));
  const before = await run(tree, snapshots([1, 2, 3, 5]));
  const afterRun = await run(tree, snapshots([1, 2, 3, 4, 5]));
  const changes = explainAdvisoryChanges(before, afterRun);
  assert.deepEqual(
    changes.map((c: any) => `${c.change}:${c.because}`),
    ['new:advisory-database-changed'],
  );
  const gamma = afterRun.findings.find((f: any) => f.name === 'sentinel-fixture-gamma')!;
  assert.deepEqual(gamma.advisories.ids, ['SENTINEL-FIXTURE-2026-0004']);
  assert.notEqual(changes[0]!.from.database, changes[0]!.to.database);
  assert.deepEqual(changes[0]!.from.artifacts, changes[0]!.to.artifacts, 'the captured bytes did not change');
  const alpha = (r: any) => r.findings.find((f: any) => f.name === 'sentinel-fixture-alpha');
  assert.equal(alpha(before).key, alpha(afterRun).key, 'the same component and advisory');
  assert.notEqual(alpha(before).id, alpha(afterRun).id, 'but a new assessment against the new snapshot');
});

test(
  'an absent snapshot is an explicit gap, a stale one is not complete, and a broken one counts nothing',
  { skip },
  async () => {
    const tree = capturedTree(join(root.root, `tree-${n++}`));
    const npmOnly = await run(tree, [snapshots([1])[0]!]);
    assert.equal(row(npmOnly, 'api/pom.xml'), 'database-absent:databaseAbsent');
    assert.equal(
      row(npmOnly, 'api/target/bom.cdx.json'),
      'database-absent:databaseAbsent',
      'an SBOM can name either ecosystem',
    );
    assert.equal(row(npmOnly, 'web/package-lock.json'), 'complete:');
    const stale = await run(tree, snapshots([1, 2, 3, 5], '2026-09-01T00:00:00.000000000Z'));
    assert.equal(row(stale, 'web/package-lock.json'), 'database-stale:databaseStale');
    assert.equal(stale.databases[0]!.freshness, 'stale');
    assert.ok(
      stale.findings.length > 0,
      'findings from a stale snapshot are still evidence; coverage says it is stale',
    );
    // A snapshot that is not a readable archive. The engine still exits 1 when another ecosystem matched, and lists the
    // npm packages with no advisories: only its own report of which databases it loaded tells the truth.
    const good = snapshots([1, 2, 3, 5]);
    const broken = Buffer.from('not a zip archive');
    writeFileSync(good[0]!.path, broken);
    const brokenNpm = {
      path: good[0]!.path,
      snapshot: { ...good[0]!.snapshot, sha256: sha(broken), size: broken.length },
    };
    const r = await run(tree, [brokenNpm, good[1]!]);
    assert.equal(r.engineExit, 1, 'the engine reports success for the run as a whole');
    assert.equal(row(r, 'web/package-lock.json'), 'error:databaseNotLoaded');
    assert.equal(row(r, 'web/pnpm-lock.yaml'), 'error:databaseNotLoaded');
    assert.equal(row(r, 'api/pom.xml'), 'partial:versionsUnknown,transitivesNotResolved', 'the Maven file was matched');
    assert.ok(
      r.components.filter((c: any) => c.ecosystem === 'npm').every((c: any) => !c.assessed),
      'no npm component counts as assessed',
    );
    assert.ok(!r.findings.some((f: any) => f.ecosystem === 'npm'));
  },
);

test('a package the engine silently drops from matching keeps every file short of complete', { skip }, async () => {
  // One locked package without a resolved source: the engine lists it but does not match it, and says only how many.
  const lock = JSON.stringify({
    name: 'sentinel-fixture-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'sentinel-fixture-app', version: '1.0.0' },
      'node_modules/sentinel-fixture-alpha': {
        version: '1.0.0',
        resolved: 'https://registry.example.invalid/sentinel-fixture-alpha-1.0.0.tgz',
        integrity: 'sha512-AAAA',
      },
      'node_modules/sentinel-fixture-local': { version: '0.0.1' },
    },
  });
  const tree = capturedTree(join(root.root, `tree-${n++}`), {}, { 'web/package-lock.json': lock });
  const r = await run(tree, snapshots([1]));
  assert.equal(row(r, 'web/package-lock.json'), 'partial:componentsSkipped');
  assert.ok(
    r.findings.some((f: any) => f.name === 'sentinel-fixture-alpha'),
    'what was matched still stands',
  );
});

test('changing or deleting the caller’s files after the worker copied them changes nothing', { skip }, async () => {
  const tree = capturedTree(join(root.root, `tree-${n++}`));
  const lock = tree.find((t) => t.relativePath === 'web/package-lock.json')!;
  const pom = tree.find((t) => t.relativePath === 'api/pom.xml')!;
  const pending = run(tree, snapshots([1, 2, 3, 5]));
  writeFileSync(lock.path, '{"lockfileVersion":3,"packages":{}}');
  rmSync(pom.path);
  const r = await pending;
  assert.equal(row(r, 'web/package-lock.json'), 'complete:');
  assert.ok(
    r.findings.some((f: any) =>
      f.occurrences.some((o: any) => o.relativePath === 'web/package-lock.json' && o.artifact === lock.artifact),
    ),
  );
  assert.ok(r.components.some((c: any) => c.relativePath === 'api/pom.xml'));
});

test(
  'a file the engine does not treat as a dependency input is not sent; a zip is never a target',
  { skip },
  async () => {
    const tree = capturedTree(
      join(root.root, `tree-${n++}`),
      { 'web/package-lock.json': 'package-lock-json.fixture' },
      { 'web/README.md': 'not a manifest\n', 'web/vendor.zip': storedZip([]).toString('latin1') },
    );
    const r = await run(tree, snapshots([1]));
    assert.equal(row(r, 'web/README.md'), 'not-applicable:notDependencyFile');
    assert.equal(row(r, 'web/vendor.zip'), 'not-applicable:notDependencyFile');
  },
);

test(
  'an engine that fails reports a diagnostic and a result in order, with its cause, and counts nothing',
  { skip },
  async () => {
    const r = await runOsvAttempt(service, {
      attemptId: `att-osv-${n++}`,
      work: { id: 'work-osv', revision: 1 },
      targets: capturedTree(join(root.root, `tree-${n++}`), { 'web/package-lock.json': 'package-lock-json.fixture' }),
      snapshots: snapshots([1]),
      scratch: root.root,
      policy: { now: NOW, maxDatabaseAgeMs: 7 * DAY },
      adapter: BAD_ARGS,
      ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}),
    });
    assert.equal(r.attempt, 'succeeded', 'no protocol violation: the frames carry distinct sequence numbers');
    assert.equal(r.engineExit, 127);
    assert.equal(r.engineFailure, 'sentinel.osv.engine.engineError', 'the cause is kept');
    assert.equal(r.platform.state, QUALIFY && !OSV_MEASURED_ARCHITECTURES.has(QUALIFY) ? 'candidate' : 'measured');
    assert.deepEqual(r.findings, []);
    assert.equal(row(r, 'web/package-lock.json'), 'error:engineFailed');
  },
);
