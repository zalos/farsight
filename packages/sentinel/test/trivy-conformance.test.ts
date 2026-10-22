// The pinned Trivy itself, `config` only, through PR 07's isolated execution service only (no host fallback, no pull,
// no network). Runs with SENTINEL_ISOLATION=1 and SENTINEL_TRIVY_CHECKS_DIR naming a folder the owner acquired the
// pinned checks bundle into (scripts/acquire-trivy-checks.mjs); with isolation on and no bundle, the suite fails
// rather than skips. Inputs are the original synthetic fixtures under their real names in a temporary captured tree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { TRIVY_ADAPTER, buildTrivyAdapter, loadChecksBundle, runTrivyAttempt } from '../dist/adapters/trivy/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { IAC_FIXTURES, TRIVY_LAYOUT, capturedTree } from './iac-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker, the pinned Trivy image installed and SENTINEL_TRIVY_CHECKS_DIR';
const QUALIFY = process.env.SENTINEL_IAC_QUALIFY?.replace(/^linux\//, '');
// A variant whose worker drops the cached bundle before the engine runs: the engine's silent fallback to its
// compiled-in checks must be caught, never counted.
const NO_DISK = buildTrivyAdapter({ id: 'iac-trivy-nodisk', engineArgs: ['config', '--skip-check-update', '--disable-telemetry', '--skip-version-check', '--format', 'json', '--misconfig-scanners=dockerfile', '--ignorefile=', '--exit-code', '0', '--debug', '--cache-dir=/tmp/sentinel-trivy/elsewhere'] });

// A variant whose engine refuses its arguments: the worker reports a diagnostic and then its result, and the failure
// must arrive as an engine failure (not a protocol violation) that counts nothing.
// A variant whose report bound is far below what the engine writes.
const TINY = buildTrivyAdapter({ id: 'iac-trivy-tiny', maxOutputBytes: 100 });
const BAD_ARGS = buildTrivyAdapter({ id: 'iac-trivy-badargs', engineArgs: ['config', '--no-such-sentinel-flag'] });

let root: { root: string; work: string };
let store: any;
let service: any;
let bundle: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  const dir = process.env.SENTINEL_TRIVY_CHECKS_DIR;
  assert.ok(dir, 'SENTINEL_TRIVY_CHECKS_DIR must name the owner-acquired bundle folder when SENTINEL_ISOLATION=1');
  bundle = loadChecksBundle(join(dir, 'checks'));
  assert.ok(bundle, 'the pinned checks bundle has been acquired');
  root = scratch('trivy');
  store = await storeIn(root.root);
  service = await createExecutionService(store, { scratchRoot: root.work, registry: createAdapterRegistry([TRIVY_ADAPTER, NO_DISK.definition, BAD_ARGS.definition, TINY.definition]), containers: true });
});
after(async () => { if (enabled) { await store.close(); removeScratch(root.root); } });

const run = (targets: any[], extra: Record<string, unknown> = {}) => runTrivyAttempt(service, {
  attemptId: `att-trivy-${n++}`, work: { id: 'work-trivy', revision: 1 }, targets, bundle, scratch: root.root,
  ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}), ...extra,
});
const row = (r: any, p: string) => { const c = r.coverage.find((x: any) => x.relativePath === p); return `${c.status}:${c.limitations.map((l: string) => l.split('.').pop()).join(',')}`; };
const checks = (r: any, p: string) => r.findings.filter((f: any) => f.relativePath === p).map((f: any) => f.checkId).sort();

test('positives, a negative, recognition and Terraform limits, from the pinned bundle only', { skip }, async () => {
  const t0 = Date.now();
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), TRIVY_LAYOUT));
  const wall = Date.now() - t0;
  assert.equal(r.attempt, 'succeeded');
  assert.equal(r.engineExit, 0);
  assert.equal(r.platform.state, QUALIFY ? 'candidate' : 'measured');
  assert.ok(r.bundle.checksLoaded > 500, 'the engine loaded the pinned bundle from disk');
  console.log(`# trivy conformance: ${r.findings.length} findings, ${r.refused.length} refused, ${wall} ms`);
  for (const c of r.coverage) console.log(`# ${c.relativePath} ${c.status} ${c.limitations.join(',')} [${checks(r, c.relativePath).join(' ')}]`);
  assert.deepEqual(r.refused, []);
  assert.equal(row(r, 'services/api/Dockerfile'), 'complete:');
  assert.ok(checks(r, 'services/api/Dockerfile').includes('DS-0002'), 'running as root');
  assert.equal(row(r, 'services/worker/hardened.Dockerfile'), 'complete:');
  assert.deepEqual(checks(r, 'services/worker/hardened.Dockerfile'), [], 'the hardened file is a true negative');
  assert.equal(row(r, 'services/legacy/Containerfile'), 'partial:inlineIgnore');
  assert.ok(!checks(r, 'services/legacy/Containerfile').includes('DS-0002'), 'the engine honoured the ignore, which the coverage says');
  assert.equal(row(r, 'deploy/pod.yaml'), 'complete:');
  assert.ok(checks(r, 'deploy/pod.yaml').includes('KSV-0017'), 'a privileged container');
  assert.equal(row(r, 'config/settings.yaml'), 'not-applicable:notRecognized');
  assert.equal(row(r, 'infra/storage/main.tf'), 'complete:');
  assert.equal(row(r, 'infra/storage/locals.tf'), 'complete:', 'assessed as part of its module folder');
  assert.ok(checks(r, 'infra/storage/main.tf').length > 0, 'an open bucket');
  assert.equal(row(r, 'infra/network/main.tf'), 'partial:remoteModuleUnresolved,variablesNotRead');
  assert.equal(row(r, 'infra/network/terraform.tfvars'), 'not-applicable:variablesFile');
  const located = r.findings.find((f: any) => f.relativePath === 'deploy/pod.yaml' && f.lines);
  assert.ok(located.lines.start >= 1 && located.lines.end <= 11, 'lines are within the captured file');
  assert.ok(r.findings.every((f: any) => f.artifact === null || /^sha256:/.test(f.artifact)));
  assert.ok(!JSON.stringify(r).includes('sentinel-fixture-privileged'), 'the engine message quoting the file is not kept');
});

test('a file the engine reports as unparseable, and one it never reports at exit 0, are gaps', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), {
    'empty/Dockerfile': { text: '' }, 'odd/Dockerfile.dev': { text: 'FROM alpine:3.20\nUSER 10001\n' }, 'notes/README.md': { text: 'not configuration\n' },
    // The engine skips any folder named .git by default, silently and at exit 0.
    'vendor/.git/images/Dockerfile': 'trivy/dockerfile-root.fixture',
  }));
  assert.equal(row(r, 'vendor/.git/images/Dockerfile'), 'error:notReported', 'an omission is a gap, not a pass');
  assert.deepEqual(r.findings.filter((f: any) => f.relativePath.startsWith('vendor/')), []);
  assert.equal(r.engineExit, 0, 'the engine reports success for the run as a whole');
  assert.equal(row(r, 'empty/Dockerfile'), 'error:parseFailed');
  assert.equal(row(r, 'odd/Dockerfile.dev'), 'complete:');
  assert.equal(row(r, 'notes/README.md'), 'not-applicable:notConfiguration');
});

test('the engine falling back to its compiled-in checks counts nothing', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), { 'Dockerfile': 'trivy/dockerfile-root.fixture' }), { adapter: NO_DISK });
  assert.equal(r.findings.length, 0);
  assert.equal(row(r, 'Dockerfile'), 'error:bundleNotLoaded');
});

test('no acquired bundle: nothing runs and every configuration file is a gap', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), TRIVY_LAYOUT), { bundle: null });
  assert.equal(r.attempt, 'not-run');
  assert.equal(row(r, 'services/api/Dockerfile'), 'bundle-missing:bundleMissing');
  assert.equal(row(r, 'config/settings.yaml'), 'bundle-missing:bundleMissing');
});

test('changing or deleting the caller’s files after the worker copied them changes nothing', { skip }, async () => {
  const tree = capturedTree(join(root.root, `tree-${n++}`), { 'services/api/Dockerfile': 'trivy/dockerfile-root.fixture', 'deploy/pod.yaml': 'trivy/k8s-privileged-pod.fixture' });
  const pending = run(tree);
  writeFileSync(tree[0]!.path, 'FROM scratch\n');
  rmSync(tree[1]!.path);
  const r = await pending;
  assert.ok(checks(r, 'services/api/Dockerfile').includes('DS-0002'));
  assert.equal(row(r, 'deploy/pod.yaml'), 'complete:');
});

test('an engine that fails reports a diagnostic and a result in order, and counts nothing', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), { 'Dockerfile': 'trivy/dockerfile-root.fixture' }), { adapter: BAD_ARGS });
  assert.equal(r.attempt, 'succeeded', 'no protocol violation');
  assert.equal(r.engineFailure, 'sentinel.trivy.engine.engineError');
  assert.equal(r.findings.length, 0);
  assert.equal(row(r, 'Dockerfile'), 'error:engineFailed');
});

test('SOL: a captured folder named like one the engine skips is still scanned; what it cannot reach stays a gap', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), {
    'dev/pod.yaml': 'trivy/k8s-privileged-pod.fixture', 'normal/pod.yaml': 'trivy/k8s-privileged-pod.fixture',
    'proc/Dockerfile': 'trivy/dockerfile-root.fixture', 'sys/main.tf': 'trivy/tf-open-bucket.fixture',
    // The engine always skips folders named .git: a manifest there is an omission, not an unrecognized file.
    'tools/.git/deploy/pod.yaml': 'trivy/k8s-privileged-pod.fixture', 'tools/.git/deploy/settings.yaml': 'trivy/k8s-not-a-manifest.fixture',
    'root.tf': 'trivy/tf-open-bucket.fixture',
  }));
  assert.deepEqual(checks(r, 'dev/pod.yaml'), checks(r, 'normal/pod.yaml'), 'the same findings in dev/ as anywhere else');
  assert.ok(checks(r, 'dev/pod.yaml').includes('KSV-0017'));
  assert.equal(row(r, 'dev/pod.yaml'), 'complete:');
  assert.ok(checks(r, 'proc/Dockerfile').includes('DS-0002'));
  assert.ok(checks(r, 'sys/main.tf').length > 0);
  assert.equal(row(r, 'root.tf'), 'complete:', 'a root module reports as the root folder');
  assert.equal(row(r, 'tools/.git/deploy/pod.yaml'), 'error:notReported');
  assert.equal(row(r, 'tools/.git/deploy/settings.yaml'), 'not-applicable:notRecognized', 'the near neighbour: provably not a manifest');
  assert.deepEqual(r.refused, []);
});

test('SOL: an over-long report is a truncation gap bound to the bytes actually published, not an invalid output', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), { 'deploy/pod.yaml': 'trivy/k8s-privileged-pod.fixture' }), { adapter: TINY });
  assert.equal(r.attempt, 'succeeded');
  assert.equal(r.findings.length, 0);
  assert.equal(row(r, 'deploy/pod.yaml'), 'error:outputTruncated');
});

test('UTF-16 LE and BE BOM manifests omitted by the engine are gaps, with scanned controls', { skip }, async () => {
  const text = readFileSync(join(IAC_FIXTURES, 'trivy/k8s-privileged-pod.fixture'), 'utf8');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.from(le).swap16();
  const targets = capturedTree(join(root.root, `tree-${n++}`), {
    'normal/le.yaml': { text: le }, 'normal/be.yaml': { text: be },
    'hidden/.git/le.yaml': { text: le }, 'hidden/.git/be.yaml': { text: be },
  });
  const r = await run(targets);
  assert.equal(r.engineExit, 0);
  for (const encoding of ['le', 'be']) {
    assert.equal(row(r, `normal/${encoding}.yaml`), 'complete:');
    assert.ok(checks(r, `normal/${encoding}.yaml`).includes('KSV-0017'));
    assert.equal(row(r, `hidden/.git/${encoding}.yaml`), 'error:notReported');
    assert.deepEqual(checks(r, `hidden/.git/${encoding}.yaml`), []);
  }
});
