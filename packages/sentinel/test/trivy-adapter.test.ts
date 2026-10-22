// The Trivy adapter without an engine: which files are sent and why not, the job the shim reads, what a run's
// outputs establish (over synthetic engine reports and run records), and the owner-confirmed bundle acquisition over
// a fake registry. The real engine is exercised by trivy-conformance.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRIVY_ADAPTER, TRIVY_CHECKS_BUNDLE, TRIVY_ENGINE, TRIVY_SUPPORT, TRIVY_WORKER_DIGEST, acquireChecksBundle, buildTrivyJob,
  checksAcquisitionIntent, loadChecksBundle, normalizeTrivyRun, notRunResult, trivyKindOf, CHECKS_BLOB_HOST,
  TRIVY_COVERAGE_REASONS, TRIVY_REFUSAL_REASONS, TRIVY_ENGINE_FAILURES, TRIVY_ERROR_CODES, TRIVY_WORKER_BYTES,
} from '../dist/adapters/trivy/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { TRIVY_LAYOUT, capturedTree, sha } from './iac-helpers.ts';
import { cannotBeKubernetes } from '../dist/adapters/trivy/normalize.js';

function scratch(t: { after(fn: () => void): void }, label = 'trivy') {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `sentinel-${label}-`));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const code = (fn: () => unknown) => Promise.resolve().then(fn).then(() => 'no error', (e: any) => e.code ?? e.message);
const FAKE_BUNDLE = { schema: 'sentinel-trivy-checks/draft-1', name: 'trivy-checks', version: TRIVY_CHECKS_BUNDLE.version, commit: TRIVY_CHECKS_BUNDLE.commit,
  repository: TRIVY_CHECKS_BUNDLE.repository, manifest: TRIVY_CHECKS_BUNDLE.manifest, layer: TRIVY_CHECKS_BUNDLE.layer, size: TRIVY_CHECKS_BUNDLE.size,
  created: TRIVY_CHECKS_BUNDLE.created, acquiredAt: '2026-10-22T00:00:00.000000000Z' } as const;

test('the pins name the official release, image, and checks bundle, and only configuration scanning', () => {
  assert.equal(TRIVY_ENGINE.version, '0.76.1');
  assert.match(TRIVY_ADAPTER.image, /^ghcr\.io\/aquasecurity\/trivy@sha256:[0-9a-f]{64}$/);
  assert.equal(TRIVY_ADAPTER.command.at(-1), `/input/${TRIVY_WORKER_DIGEST.slice(7)}`);
  assert.equal(TRIVY_SUPPORT.mode, 'misconfiguration-only');
  assert.equal(TRIVY_SUPPORT.graph, 'paths-only');
  const args = TRIVY_ADAPTER.command.join(' ');
  assert.doesNotMatch(args, /vuln|secret|license/);
});

test('native amd64 qualification is bound to the measured CI revision and actual outcome architecture', t => {
  assert.deepEqual(TRIVY_SUPPORT.platforms.map(p => [p.architecture, p.state]), [['arm64', 'measured'], ['amd64', 'measured']]);
  const amd64 = TRIVY_SUPPORT.platforms.find(p => p.architecture === 'amd64')!;
  assert.ok(amd64.evidence.includes('https://github.com/zalos/farsight/actions/runs/39817213827/job/119958735627'));
  assert.ok(amd64.evidence.includes('0d6daa8cd369835fe6ec8ec5a89b4d25cb23edc5'));
  const result = run(t, REPORT, {}, { arch: 'amd64' });
  assert.deepEqual(result.platform, { architecture: 'amd64', state: 'measured' });
  assert.ok(result.findings.length > 0);
  const elsewhere = run(t, REPORT, {}, { arch: 'riscv64' });
  assert.deepEqual(elsewhere.platform, { architecture: 'riscv64', state: 'refused' });
  assert.equal(elsewhere.findings.length, 0);
});

test('which files are Trivy inputs, by the engine’s own name rules', () => {
  const kinds = Object.fromEntries(['Dockerfile', 'a/Dockerfile.prod', 'a/app.dockerfile', 'a/Containerfile', 'a/DOCKERFILE', 'a/Dockerfile.dev.x',
    'infra/main.tf', 'infra/x.tf.json', 'infra/terraform.tfvars', 'k/pod.yaml', 'k/pod.yml', 'k/pod.json', 'README.md'].map(p => [p, trivyKindOf(p) ?? null]));
  assert.deepEqual(kinds, {
    Dockerfile: 'dockerfile', 'a/Dockerfile.prod': 'dockerfile', 'a/app.dockerfile': 'dockerfile', 'a/Containerfile': 'dockerfile', 'a/DOCKERFILE': 'dockerfile',
    'a/Dockerfile.dev.x': null, 'infra/main.tf': 'terraform', 'infra/x.tf.json': 'terraform', 'infra/terraform.tfvars': 'terraform-variables',
    'k/pod.yaml': 'kubernetes-candidate', 'k/pod.yml': 'kubernetes-candidate', 'k/pod.json': null, 'README.md': null,
  });
});

test('the job sends supported files with their paths, and records every file it does not send', t => {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), { ...TRIVY_LAYOUT, 'docs/notes.md': { text: 'notes\n' }, 'infra/.terraform/modules/x/main.tf': { text: 'locals {}\n' },
    'odd path/Dockerfile': { text: 'FROM scratch\n' }, 'big/Dockerfile': { text: 'FROM scratch\n#' + 'x'.repeat(1_048_576) } });
  const bundlePath = join(dir, 'bundle.tar.gz');
  writeFileSync(bundlePath, 'not used here');
  const built = buildTrivyJob(tree, { bundle: FAKE_BUNDLE, path: bundlePath }, dir);
  assert.deepEqual(built.job.unsent.map(u => `${u.relativePath}:${u.reason}`), [
    'big/Dockerfile:too-large', 'docs/notes.md:not-configuration', 'infra/.terraform/modules/x/main.tf:dependency-cache',
    'infra/network/terraform.tfvars:variables-file', 'odd path/Dockerfile:path-unsupported',
  ]);
  assert.equal(built.job.targets.length, 8);
  const text = readFileSync(built.inputs[2]!.path, 'utf8');
  assert.match(text, /^sentinel-trivy-job\/1\nS 100\nB [0-9a-f]{64}\nT 0 [0-9a-f]{64} config\/settings\.yaml\n/);
  assert.equal(built.inputs[0]!.id, TRIVY_WORKER_DIGEST);
  assert.equal(built.inputs[1]!.id, TRIVY_CHECKS_BUNDLE.layer);
  assert.equal(built.jobDigest, sha(Buffer.from(text)));
  // Without the bundle nothing is sent, nothing runs, and every configuration file says why.
  const none = buildTrivyJob(tree, null, dir);
  assert.equal(none.jobDigest, null);
  assert.equal(none.inputs.length, 0);
  const r = notRunResult(none.job, TRIVY_ADAPTER.id);
  assert.equal(r.attempt, 'not-run');
  assert.deepEqual(r.coverage.filter(c => c.status === 'bundle-missing').map(c => c.relativePath).sort(), Object.keys(TRIVY_LAYOUT).filter(p => !p.endsWith('.tfvars')).sort());
  assert.equal(row(r, 'big/Dockerfile'), 'unsupported:tooLarge');
  // A bundle other than the pinned one, a duplicate, or bytes that are not the captured artifact are refused.
  return Promise.all([
    code(() => buildTrivyJob(tree, { bundle: { ...FAKE_BUNDLE, layer: sha('other') }, path: bundlePath }, dir)).then(c => assert.equal(c, 'sentinel.trivy.bundleInvalid')),
    code(() => buildTrivyJob([tree[0]!, tree[0]!], null, dir)).then(c => assert.equal(c, 'sentinel.trivy.targetInvalid')),
    (() => { writeFileSync(tree[0]!.path, 'changed'); return code(() => buildTrivyJob(tree, { bundle: FAKE_BUNDLE, path: bundlePath }, dir)).then(c => assert.equal(c, 'sentinel.trivy.targetInvalid')); })(),
  ]);
});

// ---- normalization over synthetic engine output ------------------------------------------------------------------

function run(t: { after(fn: () => void): void }, report: unknown, record: Record<string, unknown> = {}, opts: { arch?: string; mutate?: string; state?: string; layout?: Record<string, string | { text: string | Buffer }> } = {}) {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), opts.layout ?? TRIVY_LAYOUT);
  const bundlePath = join(dir, 'b');
  writeFileSync(bundlePath, 'x');
  const built = buildTrivyJob(tree, { bundle: FAKE_BUNDLE, path: bundlePath }, dir);
  const reportBytes = Buffer.from(JSON.stringify(report));
  const recordBytes = Buffer.from(JSON.stringify({
    schema: 'sentinel-trivy-run/draft-1', job: built.jobDigest, exitCode: 0, timedOut: false, stdoutTruncated: false, engineOutput: sha(reportBytes), failure: null,
    bundle: { layer: TRIVY_CHECKS_BUNDLE.layer, fromDisk: true, fellBack: false, checks: 580 }, detected: 5,
    scanned: ['services/api/Dockerfile', 'services/worker/hardened.Dockerfile', 'services/legacy/Containerfile', 'deploy/pod.yaml', 'infra/storage', 'infra/storage/main.tf', 'infra/network'],
    unparsed: [], moduleFailed: ['infra/network/main.tf'], ...record,
  }));
  const bytes = new Map([[sha(reportBytes), reportBytes], [sha(recordBytes), recordBytes]]);
  const outcome: any = { state: opts.state ?? 'succeeded', adapter: { id: 'iac-trivy' }, container: { image: { architecture: opts.arch ?? 'arm64' } }, outputs: [
    { id: sha(reportBytes), mediaType: 'application/vnd.trivy.report+json' }, { id: sha(recordBytes), mediaType: 'application/vnd.sentinel.trivy-run+json' }] };
  const byArtifact = new Map(tree.map(x => [x.artifact, readFileSync(x.path)]));
  return normalizeTrivyRun({ job: built.job, jobDigest: built.jobDigest!, outcome, outputBytes: id => bytes.get(id)!,
    targetBytes: a => (opts.mutate && byArtifact.get(a)?.toString().includes(opts.mutate) ? Buffer.from('changed') : byArtifact.get(a)) });
}
const fail = (id: string, start = 0, end = 0, extra: Record<string, unknown> = {}) => ({ ID: id, Severity: 'HIGH', Status: 'FAIL', Namespace: `builtin.x.${id}`,
  Message: 'quotes the file: sentinel-fixture-privileged', CauseMetadata: { StartLine: start, EndLine: end }, ...extra });
const REPORT = { SchemaVersion: 2, Trivy: { Version: '0.76.1' }, Results: [
  { Target: 't/services/api/Dockerfile', Class: 'config', Type: 'dockerfile', Misconfigurations: [fail('DS-0002'), fail('DS-0025', 2, 2), { ...fail('DS-0001'), Status: 'PASS' }] },
  { Target: 't/deploy/pod.yaml', Class: 'config', Type: 'kubernetes', Misconfigurations: [fail('KSV-0017', 7, 10)] },
  { Target: 't/infra/storage/main.tf', Class: 'config', Type: 'terraform', Misconfigurations: [fail('AWS-0086', 6, 6)] },
] };
const row = (r: any, p: string) => { const c = r.coverage.find((x: any) => x.relativePath === p); return `${c.status}:${c.limitations.map((l: string) => l.split('.').pop()).join(',')}`; };

test('findings keep a check, a captured location and the bundle; coverage needs the engine’s own scan evidence', t => {
  const r = run(t, REPORT);
  assert.deepEqual(r.findings.map(f => `${f.checkId}@${f.relativePath}:${f.lines ? `${f.lines.start}-${f.lines.end}` : '-'}`),
    ['AWS-0086@infra/storage/main.tf:6-6', 'DS-0002@services/api/Dockerfile:-', 'DS-0025@services/api/Dockerfile:2-2', 'KSV-0017@deploy/pod.yaml:7-10']);
  assert.ok(r.findings.every(f => f.bundle === TRIVY_CHECKS_BUNDLE.layer && f.artifact !== null));
  assert.doesNotMatch(JSON.stringify(r), /quotes the file/);
  assert.equal(row(r, 'services/worker/hardened.Dockerfile'), 'complete:');
  assert.equal(row(r, 'services/legacy/Containerfile'), 'partial:inlineIgnore');
  assert.equal(row(r, 'config/settings.yaml'), 'not-applicable:notRecognized');
  assert.equal(row(r, 'infra/storage/locals.tf'), 'complete:');
  assert.equal(row(r, 'infra/network/main.tf'), 'partial:remoteModuleUnresolved,variablesNotRead');
  // At exit 0, a Dockerfile the engine never reported scanning is an omission, not a pass.
  const omitted = run(t, REPORT, { scanned: ['deploy/pod.yaml', 'infra/storage', 'infra/storage/main.tf', 'infra/network'] });
  assert.equal(row(omitted, 'services/worker/hardened.Dockerfile'), 'error:notReported');
  assert.ok(omitted.refused.some(x => x.reasonCode === 'sentinel.trivy.refused.notScanned' && x.relativePath === 'services/api/Dockerfile'));
  assert.equal(row(run(t, REPORT, { unparsed: ['deploy/pod.yaml'] }), 'deploy/pod.yaml'), 'error:parseFailed');
});

test('a run that did not evaluate the pinned bundle, failed, was truncated or ran elsewhere counts nothing', t => {
  for (const bundle of [{ fromDisk: false, fellBack: true, checks: 563 }, { fromDisk: true, fellBack: true, checks: 580 }, { fromDisk: true, fellBack: false, checks: null }]) {
    const r = run(t, REPORT, { bundle: { layer: TRIVY_CHECKS_BUNDLE.layer, ...bundle } });
    assert.equal(r.findings.length, 0);
    assert.ok(r.coverage.filter(c => c.kind !== null && c.status !== 'not-applicable').every(c => c.reasonCode === 'sentinel.trivy.coverage.bundleNotLoaded'));
  }
  const failed = run(t, REPORT, { exitCode: 1, failure: { category: 'engineError', exitCode: 1 } });
  assert.equal(failed.engineFailure, 'sentinel.trivy.engine.engineError');
  assert.equal(failed.findings.length, 0);
  assert.equal(run(t, REPORT, { exitCode: 2, failure: { category: 'words from stderr', exitCode: 2 } }).engineFailure, 'sentinel.trivy.engine.unknown');
  assert.equal(row(run(t, REPORT, { stdoutTruncated: true }), 'deploy/pod.yaml'), 'error:outputTruncated');
  const elsewhere = run(t, REPORT, {}, { arch: 'riscv64' });
  assert.equal(elsewhere.platform.state, 'refused');
  assert.equal(elsewhere.findings.length, 0);
  assert.equal(row(run(t, REPORT, {}, { state: 'timed-out' }), 'deploy/pod.yaml'), 'error:attemptTimedOut');
  assert.equal(row(run(t, REPORT, {}, { mutate: 'privileged' }), 'deploy/pod.yaml'), 'error:inputMismatch');
  return Promise.all([
    code(() => run(t, REPORT, { job: sha('another job') })).then(c => assert.equal(c, 'sentinel.trivy.outputInvalid')),
    code(() => run(t, REPORT, { bundle: { layer: sha('another bundle'), fromDisk: true, fellBack: false, checks: 580 } })).then(c => assert.equal(c, 'sentinel.trivy.outputInvalid')),
    code(() => run(t, { ...REPORT, Trivy: { Version: '0.75.0' } })).then(c => assert.equal(c, 'sentinel.trivy.outputInvalid')),
  ]);
});

test('a result naming another file, a check not from the bundle, a bad location or a bad severity is refused', t => {
  const r = run(t, { SchemaVersion: 2, Trivy: { Version: '0.76.1' }, Results: [
    { Target: 't/../escape/Dockerfile', Class: 'config', Type: 'dockerfile', Misconfigurations: [fail('DS-0002')] },
    { Target: 't/services/api/Dockerfile', Class: 'config', Type: 'dockerfile', Misconfigurations: [
      fail('DS-0002', 0, 0, { Namespace: 'user.custom' }), fail('DS-0025', 3, 99), fail('DS-0026', 0, 0, { Severity: 'SEVERE' }), fail('ds 1')] },
    { Target: 't/deploy/pod.yaml', Class: 'config', Type: 'dockerfile', Misconfigurations: [fail('KSV-0017')] },
  ] });
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.refused.map(x => x.reasonCode.split('.').pop()).sort(), ['locationInvalid', 'malformed', 'malformed', 'malformed', 'notFromBundle', 'unknownTarget']);
});

// ---- acquisition ---------------------------------------------------------------------------------------------------

function spentReceipt(dir: string, intent = checksAcquisitionIntent()) {
  const book = new ReceiptBook(join(dir, 'receipts'));
  const binding = { intent, stateDigest: sha('state'), policyRevision: sha('policy') };
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, binding, { now: new Date(), ttlMs: 60_000 });
  return book.consume(r.id, binding, new Date());
}
function fakeRegistry(layer: Buffer, override: Partial<{ redirect: string | null; manifest: Buffer }> = {}) {
  const manifest = override.manifest ?? Buffer.from(JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: 'application/vnd.cncf.openpolicyagent.layer.v1.tar+gzip', digest: sha(layer), size: layer.length,
    annotations: { 'org.opencontainers.image.title': 'bundle.tar.gz' } }], annotations: { 'org.opencontainers.image.revision': TRIVY_CHECKS_BUNDLE.commit, 'org.opencontainers.image.version': TRIVY_CHECKS_BUNDLE.version, 'org.opencontainers.image.created': TRIVY_CHECKS_BUNDLE.created } }));
  const calls: { url: string; auth: boolean }[] = [];
  const transport = async (url: string, init: any) => {
    calls.push({ url, auth: Boolean(init.headers?.Authorization) });
    if (url.includes('/token?')) return new Response(JSON.stringify({ token: 'anonymous.pull.token' }), { status: 200 });
    if (url.includes('/manifests/')) return new Response(manifest, { status: 200 });
    if (url.includes('/blobs/')) {
      if (override.redirect === null) return new Response(layer, { status: 200 });
      return new Response(null, { status: 307, headers: { location: override.redirect ?? `${CHECKS_BLOB_HOST}blob?sig=x` } });
    }
    return new Response(layer, { status: 200 });
  };
  return { transport, calls };
}

test('acquisition needs the owner’s receipt for exactly the pinned bundle, and checks every byte against the pins', async t => {
  const dir = scratch(t, 'acq');
  const layer = Buffer.from('a synthetic bundle');
  assert.equal(loadChecksBundle(join(dir, 'checks')), null, 'nothing acquired: a missing bundle, not an error');
  // The fake layer cannot match the real pins: the digest check is what refuses it, after the manifest check.
  const pinnedManifest = fakeRegistry(layer);
  assert.equal(await code(() => acquireChecksBundle({ dir: join(dir, 'checks'), receipt: {}, transport: pinnedManifest.transport })), 'sentinel.trivy.acquisitionUnauthorized');
  assert.equal(pinnedManifest.calls.length, 0, 'nothing is fetched before authority is checked');
  const other = spentReceipt(dir, { ...checksAcquisitionIntent(), input: sha('another bundle') });
  assert.equal(await code(() => acquireChecksBundle({ dir: join(dir, 'checks'), receipt: other, transport: pinnedManifest.transport })), 'sentinel.trivy.acquisitionUnauthorized');
  const receipt = spentReceipt(dir);
  assert.equal(await code(() => acquireChecksBundle({ dir: join(dir, 'checks'), receipt, transport: pinnedManifest.transport })), 'sentinel.trivy.acquisitionFailed', 'the manifest bytes are not the pinned manifest');
  assert.equal(await code(() => acquireChecksBundle({ dir: join(dir, 'checks'), receipt, transport: pinnedManifest.transport })), 'sentinel.trivy.acquisitionUnauthorized', 'one confirmation, one acquisition');
  assert.ok(pinnedManifest.calls.every(c => !c.url.startsWith(CHECKS_BLOB_HOST) || !c.auth), 'no credential is sent to the blob host');
});

test('a stored bundle that is not the pinned one, or not private, is refused before a scan', t => {
  const dir = join(scratch(t, 'load'), 'checks');
  mkdirSync(dir, { mode: 0o700 });
  const hex = TRIVY_CHECKS_BUNDLE.layer.slice(7);
  writeFileSync(join(dir, `${hex}.json`), JSON.stringify(FAKE_BUNDLE), { mode: 0o600 });
  writeFileSync(join(dir, `${hex}.tar.gz`), Buffer.alloc(TRIVY_CHECKS_BUNDLE.size), { mode: 0o600 });
  return Promise.all([
    code(() => loadChecksBundle(dir)).then(c => assert.equal(c, 'sentinel.trivy.bundleInvalid', 'right size, wrong bytes')),
    (() => { writeFileSync(join(dir, `${hex}.json`), JSON.stringify({ ...FAKE_BUNDLE, version: '2.2.0' }), { mode: 0o600 }); return code(() => loadChecksBundle(dir)).then(c => assert.equal(c, 'sentinel.trivy.bundleInvalid')); })(),
  ]);
});

test('every reason the adapter or its worker can record is a catalog word, and the catalog has no others', () => {
  const worker = [...TRIVY_WORKER_BYTES.toString('utf8').matchAll(/'(sentinel\.trivy\.[a-zA-Z]+)'/g)].map(m => m[1]!);
  const codes = new Set([...TRIVY_COVERAGE_REASONS, ...TRIVY_REFUSAL_REASONS, ...TRIVY_ENGINE_FAILURES, ...TRIVY_ERROR_CODES, ...worker]);
  for (const c of codes) assert.ok(STRINGS[c]?.define, `${c} is in the catalog with a definition`);
  assert.deepEqual(Object.keys(STRINGS).filter(k => k.startsWith('sentinel.trivy.')).sort(), [...codes].sort());
});

test('an unlogged YAML file is not applicable only when the engine’s Kubernetes rule provably cannot match it', () => {
  const yes = (t: string) => cannotBeKubernetes(Buffer.from(t));
  assert.equal(yes('name: settings\nitems: [1]\n'), true);
  assert.equal(yes('apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n'), false);
  assert.equal(yes('apiVersion: v1\nkind: Pod\n"meta\\u0064ata": {}\n'), false, 'an escape could spell a key');
  assert.equal(yes('{"apiVersion": "v1", "kind": "Pod", "metadata": {}}\n'), false);
});

function utf16(text: string, bigEndian: boolean): Buffer {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return bigEndian ? bytes.swap16() : bytes;
}

test('UTF-16 BOM documents cannot make an unreported Kubernetes manifest not applicable', t => {
  for (const bigEndian of [false, true]) {
    const manifest = utf16('apiVersion: v1\nkind: Pod\nmetadata:\n  name: synthetic\n', bigEndian);
    assert.equal(cannotBeKubernetes(manifest), false);
    assert.equal(cannotBeKubernetes(utf16('name: settings\nitems: [1]\n', bigEndian)), true, 'a decoded non-manifest still cannot match');
    assert.equal(cannotBeKubernetes(utf16('apiVersion: v1\nkind: Pod\n"meta\\u0064ata": {}\n', bigEndian)), false, 'escaped keys remain uncertain');
    assert.equal(cannotBeKubernetes(manifest.subarray(0, manifest.length - 1)), false, 'malformed UTF-16 cannot prove absence');
    const r = run(t, { SchemaVersion: 2, Trivy: { Version: '0.76.1' }, Results: [] }, { scanned: [] }, {
      layout: { 'hidden/.git/pod.yaml': { text: manifest } },
    });
    assert.equal(row(r, 'hidden/.git/pod.yaml'), 'error:notReported');
  }
});
