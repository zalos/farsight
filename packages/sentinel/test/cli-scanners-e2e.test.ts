// The public command path, using only original inert fixtures, a synthetic offline advisory archive and existing
// pinned Linux images/checks. Nothing in the target workspace is installed or executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scannerFixture } from './cli-scanners-helpers.ts';
import { unlock } from './snapshot-helpers.ts';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const skip =
  process.env.SENTINEL_ISOLATION !== '1' &&
  'requires existing pinned local Linux images and checks; no acquisition during tests';

test('public CLI: explicit adopted assets → canonical four-engine run → retained report', { skip }, (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-cli-scanners-')));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const f = scannerFixture(dir);
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, XDG_STATE_HOME: join(dir, 'state') };
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], {
      cwd: f.ws,
      env,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 << 20,
    });
    let body: any;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      assert.fail(`command ${args[0]} returned no typed result (${r.status})`);
    }
    return { status: r.status, body, stderr: r.stderr };
  };
  assert.equal(cli('init', '--profile', 'scanners').status, 0);
  assert.equal(cli('settings', 'adopt', '--confirm').status, 0);
  assert.equal(cli('rules', 'promote', 'builtin:pattern', '--confirm').status, 0);
  assert.deepEqual(
    [cli('plan').status, cli('plan').body.reasonCode],
    [3, 'sentinel.assets.missing'],
    'missing assets cannot become an unsupported zero-clean run',
  );
  for (const id of ['pattern-semgrep', 'advisories-osv', 'iac-trivy', 'ci-zizmor']) {
    assert.equal(cli('assets', 'adopt-tool', id).status, 4);
    const adopted = cli('assets', 'adopt-tool', id, '--confirm');
    assert.equal(adopted.status, 0, JSON.stringify(adopted.body));
  }
  for (const pack of ['foundation-preview', 'advisories', 'infrastructure', 'ci'])
    assert.equal(cli('rules', 'promote', 'builtin:' + pack, '--confirm').status, 0);
  const dbArgs = [
    'assets',
    'adopt-database',
    'osv:npm',
    '--license',
    'MIT',
    '--manifest',
    f.manifest,
    '--archive',
    f.db.path,
  ];
  assert.equal(cli(...dbArgs).status, 4);
  assert.equal(cli(...dbArgs, '--confirm').status, 0);
  const trivyArgs = [
    'assets',
    'adopt-database',
    'trivy-checks',
    '--manifest',
    f.trivyManifest,
    '--archive',
    f.checks.path,
  ];
  const wrongRights = cli(...trivyArgs, '--license', 'Apache-2.0', '--confirm');
  assert.deepEqual(
    [wrongRights.status, wrongRights.body.reasonCode],
    [3, 'sentinel.assets.invalid'],
    'engine rights cannot replace the pinned checks-bundle rights',
  );
  const trivy = cli(...trivyArgs, '--confirm');
  assert.equal(trivy.status, 0);
  assert.equal(trivy.body.facts.entry.rights.spdx, 'MIT');
  const planned = cli('plan');
  assert.equal(planned.status, 0, JSON.stringify(planned.body));
  assert.equal(planned.body.facts.label, 'deterministic');
  const runId = planned.body.facts.runId;
  const heldArchive = join(
    env.XDG_STATE_HOME,
    'farsight',
    'sentinel',
    'trust',
    'assets',
    'objects',
    f.db.snapshot.sha256.slice(7),
  );
  const heldBytes = readFileSync(heldArchive);
  const before = cli('status', runId, '--limit', '500').body.facts.events.filter(
    (e: any) => e.kind === 'attempt-started',
  ).length;
  rmSync(heldArchive);
  try {
    const refused = cli('run', runId, '--confirm');
    assert.deepEqual([refused.status, refused.body.reasonCode], [3, 'sentinel.assets.missing']);
    assert.equal(
      cli('status', runId, '--limit', '500').body.facts.events.filter((e: any) => e.kind === 'attempt-started').length,
      before,
      'missing held archive starts no scanner attempt',
    );
  } finally {
    writeFileSync(heldArchive, heldBytes, { mode: 0o600 });
  }
  const ran = cli('run', runId, '--confirm');
  assert.equal(ran.status, 2, JSON.stringify(ran.body));
  assert.equal(ran.body.facts.state, 'completed');
  assert.ok(ran.body.facts.observations > 0);
  assert.equal(ran.body.facts.requiredCoverageComplete, false);
  const report = cli('report', runId);
  assert.equal(report.status, 0);
  const doc = report.body.facts.report;
  assert.equal(doc.schema, 'sentinel-scanner-report/draft-1');
  const adapters = new Set(doc.observations.map((o: any) => o.value.adapter));
  for (const id of ['pattern-semgrep', 'advisories-osv', 'iac-trivy', 'ci-zizmor']) assert.ok(adapters.has(id), id);
  assert.ok(doc.coverage.checks.some((c: any) => !c.complete));
  assert.ok(doc.reports.some((r: any) => r.value.coverage?.some((c: any) => c.status === 'partial')));
  assert.ok(
    doc.observations.every((o: any) => o.value.snapshotId === doc.snapshotId && o.value.attemptId === o.attemptId),
  );
  for (const path of Object.keys(f.files)) rmSync(join(f.ws, path), { force: true });
  const regenerated = cli('report', runId).body.facts.report;
  assert.equal(regenerated.planDigest, doc.planDigest);
  assert.equal(regenerated.ledgerSequence, doc.ledgerSequence);
  assert.deepEqual(regenerated.observations, doc.observations);
  assert.deepEqual(regenerated.coverage, doc.coverage);
});
