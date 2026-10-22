// The OSV adapter without a container: pins, job building, the bounded POM reading, normalization over synthetic
// engine output shaped like OSV-Scanner 2.7.0's, the change explanation, and acquisition through a fake transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import {
  OSV_ADAPTER, OSV_ENGINE, OSV_ENGINE_ARGS, OSV_SUPPORT, OSV_WORKER_DIGEST, buildOsvJob, dependencyKindOf, pomDeclarations,
  normalizeOsvRun, explainAdvisoryChanges, acquireAdvisorySnapshots, acquisitionIntent, loadAdvisorySnapshot, OsvError,
  OSV_ERROR_CODES, OSV_COVERAGE_REASONS, OSV_REFUSAL_REASONS, OSV_ENGINE_FAILURES, MAX_ACQUISITION_BYTES,
} from '../dist/adapters/osv/index.js';
import { OSV_WORKER_BYTES } from '../dist/adapters/osv/adapter.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { FIXTURES, capturedTree, syntheticSnapshot, sha } from './osv-helpers.ts';

const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { assert.ok(e instanceof OsvError, String(e)); return (e as OsvError).code; } return assert.fail('expected an OsvError'); };
function scratch(t: { after(fn: () => void): void }, label = 'osv') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `sentinel-${label}-`)));
  chmodSync(d, 0o700);
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 86_400_000;

test('the adapter is pinned to the official release and image, offline, with the worker named by digest', () => {
  assert.equal(OSV_ENGINE.version, '2.7.0');
  assert.equal(OSV_ADAPTER.image, 'ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0');
  assert.deepEqual([...OSV_ADAPTER.command], ['/bin/sh', `/input/${OSV_WORKER_DIGEST.slice(7)}`]);
  assert.equal(sha(OSV_WORKER_BYTES), OSV_WORKER_DIGEST);
  assert.ok(OSV_ENGINE_ARGS.includes('--offline'));
  assert.ok(!OSV_ENGINE_ARGS.some(a => /download|data-source|maven-registry|call-analysis/.test(a)), 'nothing that reaches a network or runs builds');
  const shim = OSV_WORKER_BYTES.toString('utf8');
  assert.doesNotMatch(shim, /cat "\$W\/err\.txt"|>&2 <|err\.txt" >&2|curl|wget|nc /, 'engine stderr never leaves the container, and nothing fetches');
  assert.equal(createAdapterRegistry([OSV_ADAPTER]).get('advisories-osv').kind, 'external');
  assert.equal(OSV_SUPPORT.mode, 'full-offline');
  assert.equal(OSV_SUPPORT.reachability, 'not-assessed');
  assert.deepEqual(OSV_SUPPORT.platforms.map((p: any) => `${p.platform}:${p.state}`), ['linux/arm64:measured', 'linux/amd64:unmeasured']);
});

test('fixtures are original, synthetic and stored under non-manifest names', () => {
  for (const f of readdirSync(join(FIXTURES, 'inputs'))) assert.match(f, /\.fixture$/, f);
  const lock = readFileSync(join(FIXTURES, 'inputs', 'package-lock-json.fixture'), 'utf8');
  assert.ok(Object.keys(JSON.parse(lock).packages).filter(k => k).every(k => k.startsWith('node_modules/sentinel-fixture-')));
  for (const f of readdirSync(join(FIXTURES, 'advisories'))) {
    const a = JSON.parse(readFileSync(join(FIXTURES, 'advisories', f), 'utf8'));
    assert.match(a.id, /^SENTINEL-FIXTURE-/);
    assert.match(a.affected[0].package.name, /^(sentinel-fixture-|org\.example\.sentinel:)/);
  }
});

test('a job sends dependency files whose ecosystem has a snapshot, and names every other file as a gap', t => {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), undefined, { 'web/README.md': 'readme\n' });
  const npm = syntheticSnapshot(join(dir, 'db'), 'npm', [1], '2026-10-21T00:00:00.000Z');
  const built = buildOsvJob(tree, [npm], dir);
  assert.deepEqual(built.job.targets.map(x => `${x.index}:${x.relativePath}:${x.kind}`), ['0:web/package-lock.json:npm-package-lock', '1:web/pnpm-lock.yaml:npm-pnpm-lock']);
  assert.deepEqual(built.job.unsent.map(u => `${u.relativePath}:${u.reason}`), ['api/pom.xml:database-absent', 'api/target/bom.cdx.json:database-absent', 'web/README.md:not-dependency-file']);
  const text = readFileSync(built.inputs[1]!.path, 'utf8');
  assert.doesNotMatch(text, /web\/|api\//, 'real relative paths never enter the container');
  assert.match(text, /^sentinel-osv-job\/1\nS 100\nD npm [0-9a-f]{64}\nT 0 package-lock\.json [0-9a-f]{64}\nT 1 pnpm-lock\.yaml [0-9a-f]{64}\n$/);
  assert.equal(built.inputs[0]!.id, OSV_WORKER_DIGEST);
  assert.equal(dependencyKindOf('a/b/app.cdx.json'), 'cyclonedx-sbom');
  assert.equal(dependencyKindOf('package.json'), undefined, 'a manifest without resolved versions is not an input');
  writeFileSync(npm.path, 'altered');
  return code(() => buildOsvJob(tree, [npm], scratch(t))).then(c => assert.equal(c, 'sentinel.osv.snapshotInvalid'));
});

test('the POM reading says how each version was declared, and nothing more', () => {
  const pom = pomDeclarations(readFileSync(join(FIXTURES, 'inputs', 'pom-xml.fixture')));
  assert.deepEqual(Object.fromEntries(pom), {
    'org.example.sentinel:fixture-direct': '1.4.0', 'org.example.sentinel:fixture-property': '${fixture.version}',
    'org.example.sentinel:fixture-ranged': '[1.0,2.0)', 'org.example.sentinel:fixture-managed': null,
  });
  const managed = pomDeclarations(Buffer.from('<project><dependencyManagement><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>9</version></dependency></dependencies></dependencyManagement><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId></dependency></dependencies></project>'));
  assert.deepEqual(Object.fromEntries(managed), { 'g:a': null }, 'a managed version is not read as declared here');
});

// ---- normalization over synthetic engine output ------------------------------------------------------------------

function run(t: { after(fn: () => void): void }, engine: unknown, record: Record<string, unknown> = {}, opts: { arch?: string; maxAge?: number; mutate?: string; dbAge?: string } = {}) {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'));
  const snaps = [syntheticSnapshot(join(dir, 'db'), 'npm', [1, 2, 3, 5], opts.dbAge ?? '2026-10-21T00:00:00.000Z'), syntheticSnapshot(join(dir, 'db'), 'Maven', [1, 2, 3, 5], opts.dbAge ?? '2026-10-21T00:00:00.000Z')];
  const built = buildOsvJob(tree, snaps, dir);
  const engineBytes = Buffer.from(JSON.stringify(engine));
  const recordBytes = Buffer.from(JSON.stringify({ schema: 'sentinel-osv-run/draft-1', job: built.jobDigest, exitCode: 1, timedOut: false, stdoutTruncated: false, engineOutput: sha(engineBytes), failure: null, loaded: ['npm', 'Maven'], ...record }));
  const bytes = new Map([[sha(engineBytes), engineBytes], [sha(recordBytes), recordBytes]]);
  const outcome: any = { state: 'succeeded', adapter: { id: 'advisories-osv' }, container: { image: { architecture: opts.arch ?? 'arm64' } }, outputs: [
    { id: sha(engineBytes), mediaType: 'application/vnd.osv.scan+json' }, { id: sha(recordBytes), mediaType: 'application/vnd.sentinel.osv-run+json' }] };
  const byArtifact = new Map(tree.map(x => [x.artifact, readFileSync(x.path)]));
  return normalizeOsvRun({ job: built.job, jobDigest: built.jobDigest, outcome, policy: { now: NOW, maxDatabaseAgeMs: opts.maxAge ?? 7 * DAY },
    outputBytes: id => bytes.get(id)!, targetBytes: a => (opts.mutate && byArtifact.get(a)?.toString().includes(opts.mutate) ? Buffer.from('changed') : byArtifact.get(a)) });
}
const pkg = (ecosystem: string, name: string, version: string, ids: string[] = []) => ({
  package: { name, version, ecosystem, purl: `pkg:x/${name}@${version}` },
  ...(ids.length ? { vulnerabilities: ids.map(id => ({ id, modified: '2026-10-01T00:00:00Z', summary: 'untrusted advisory text' })), groups: [{ ids, aliases: ['ALIAS-1'] }] } : {}),
});
const ENGINE = { results: [
  { source: { path: '/tmp/sentinel-osv/t/0/package-lock.json', type: 'lockfile' }, packages: [pkg('npm', 'sentinel-fixture-alpha', '1.0.0', ['SENTINEL-FIXTURE-2026-0001']), pkg('npm', 'sentinel-fixture-beta', '2.1.0')] },
  { source: { path: '/tmp/sentinel-osv/t/1/pnpm-lock.yaml', type: 'lockfile' }, packages: [pkg('npm', 'sentinel-fixture-alpha', '1.0.0', ['SENTINEL-FIXTURE-2026-0001'])] },
  { source: { path: '/tmp/sentinel-osv/t/2/pom.xml', type: 'lockfile' }, packages: [pkg('Maven', 'org.example.sentinel:fixture-direct', '1.4.0', ['SENTINEL-FIXTURE-2026-0002']), pkg('Maven', 'org.example.sentinel:fixture-ranged', '1.0', ['SENTINEL-FIXTURE-2026-0003'])] },
  { source: { path: '/tmp/sentinel-osv/t/3/sentinel.cdx.json', type: 'sbom' }, packages: [pkg('Maven', 'org.example.sentinel:fixture-transitive', '0.9.2')] },
] };
const row = (r: any, p: string) => { const c = r.coverage.find((x: any) => x.relativePath === p); return `${c.status}:${c.reasonCode.split('.').pop()}`; };

test('findings are once per component and advisory, keyed by the snapshot, with no advisory text kept', t => {
  const r = run(t, ENGINE);
  const alpha = r.findings.find((f: any) => f.name === 'sentinel-fixture-alpha')!;
  assert.deepEqual(alpha.occurrences.map((o: any) => o.relativePath), ['web/package-lock.json', 'web/pnpm-lock.yaml']);
  assert.deepEqual(alpha.advisories, { ids: ['SENTINEL-FIXTURE-2026-0001'], aliases: ['ALIAS-1'], modified: '2026-10-01T00:00:00Z' });
  assert.equal(alpha.certainty, 'resolved-lockfile');
  assert.ok(!r.findings.some((f: any) => f.name.endsWith('fixture-ranged')), 'a range lower-bound match is not a finding');
  assert.ok(r.refused.some((x: any) => x.reasonCode === 'sentinel.osv.refused.versionUnverified'));
  assert.doesNotMatch(JSON.stringify(r), /untrusted advisory text/);
  assert.equal(row(r, 'web/package-lock.json'), 'complete:complete');
  assert.equal(row(r, 'api/pom.xml'), 'partial:versionsUnknown');
});

test('a failed engine, an unloaded database, a stale snapshot, a changed copy and an unmeasured platform each count nothing or less', t => {
  const failed = run(t, ENGINE, { exitCode: 127, failure: { category: 'engineError', exitCode: 127 } });
  assert.equal(failed.engineFailure, 'sentinel.osv.engine.engineError');
  assert.equal(failed.components.length, 0, 'the JSON of a failed run (packages, no advisories) is never read');
  assert.ok(failed.coverage.every((c: any) => c.status === 'error'));
  assert.equal(run(t, ENGINE, { exitCode: 2, failure: { category: 'leaked words', exitCode: 2 } }).engineFailure, 'sentinel.osv.engine.unknown');
  const unloaded = run(t, ENGINE, { loaded: ['Maven'] });
  assert.equal(row(unloaded, 'web/package-lock.json'), 'error:databaseNotLoaded');
  assert.ok(!unloaded.findings.some((f: any) => f.ecosystem === 'npm'));
  const stale = run(t, ENGINE, {}, { dbAge: '2026-09-01T00:00:00.000Z' });
  assert.equal(row(stale, 'web/package-lock.json'), 'database-stale:databaseStale');
  assert.equal(stale.databases[0]!.freshness, 'stale');
  const changed = run(t, ENGINE, {}, { mutate: 'fixture-app' });
  assert.equal(row(changed, 'web/package-lock.json'), 'error:inputMismatch');
  assert.ok(changed.refused.some((x: any) => x.reasonCode === 'sentinel.osv.refused.inputMismatch'));
  const local = structuredClone(ENGINE);
  local.results[0]!.packages[1]!.package.purl = 'pkg:npm/sentinel-fixture-beta@2.1.0?source=LOCAL';
  const skipped = run(t, local);
  assert.equal(row(skipped, 'web/package-lock.json'), 'partial:componentsSkipped');
  assert.equal(skipped.components.find((c: any) => c.name === 'sentinel-fixture-beta')!.assessed, false, 'a component the engine would not match is not assessed');
  const amd = run(t, ENGINE, {}, { arch: 'amd64' });
  assert.equal(amd.platform.state, 'refused');
  assert.equal(amd.findings.length, 0);
  return code(() => run(t, ENGINE, { job: sha('another job') })).then(c => assert.equal(c, 'sentinel.osv.outputInvalid'));
});

test('a change is explained by the snapshot when the captured bytes did not change, by the source otherwise', t => {
  const before = run(t, ENGINE);
  const added = structuredClone(ENGINE);
  added.results[0]!.packages[1] = pkg('npm', 'sentinel-fixture-beta', '2.1.0', ['SENTINEL-FIXTURE-2026-0009']);
  const nextSnapshot = run(t, added, {}, { dbAge: '2026-10-22T00:00:00.000Z' });
  const changes = explainAdvisoryChanges(before, nextSnapshot);
  assert.deepEqual(changes.map(c => `${c.change}:${c.because}`), ['new:advisory-database-changed']);
  const removedComponent = structuredClone(ENGINE);
  removedComponent.results[0]!.packages.shift();
  removedComponent.results[1]!.packages.shift();
  const moved = explainAdvisoryChanges(before, run(t, removedComponent));
  assert.deepEqual(moved.map(c => `${c.change}:${c.because}`), ['resolved:source-changed']);
});

// ---- acquisition ---------------------------------------------------------------------------------------------------

function book(t: { after(fn: () => void): void }) { return new ReceiptBook(join(scratch(t, 'trust'), 'receipts')); }
function spend(b: ReceiptBook, request: { ecosystems: ('npm' | 'Maven')[]; maxBytesPerEcosystem: number }) {
  const intent = acquisitionIntent(request);
  const r = issueReceipt(b, { channel: 'owner-cli', principal: 'owner' }, { intent, stateDigest: sha('state'), policyRevision: sha('policy') }, { now: new Date(), ttlMs: 60_000 });
  return b.consume(r.id, { intent, stateDigest: sha('state'), policyRevision: sha('policy') }, new Date());
}
function fakeOrigin(files: Record<string, Buffer>, override: Partial<{ md5: string | null; url: string; length: number; status: number }> = {}) {
  const calls: string[] = [];
  const transport = async (url: string) => {
    calls.push(url);
    const eco = /\/(npm|Maven)\/all\.zip$/.exec(url)![1]!;
    const body = files[eco]!;
    const headers = new Headers({ 'content-length': String(override.length ?? body.length), 'last-modified': 'Wed, 21 Oct 2026 16:48:16 GMT', etag: '"e"' });
    const md5 = override.md5 === undefined ? createHash('md5').update(body).digest('base64') : override.md5;
    if (md5) headers.set('x-goog-hash', `crc32c=AAAAAA==, md5=${md5}`);
    const res = new Response(body, { status: override.status ?? 200, headers });
    Object.defineProperty(res, 'url', { value: override.url ?? url });
    return res;
  };
  return { transport, calls };
}

test('acquisition fetches only allowlisted archives, after the owner confirmed exactly this request', async t => {
  const dir = join(scratch(t, 'adv'), 'snapshots');
  const files = { npm: Buffer.from('synthetic npm archive'), Maven: Buffer.from('synthetic maven archive') };
  const request = { ecosystems: ['npm', 'Maven'] as ('npm' | 'Maven')[], maxBytesPerEcosystem: 1024 };
  const b = book(t);
  const origin = fakeOrigin(files);
  assert.equal(await code(() => acquireAdvisorySnapshots(request, { dir, receipt: undefined, transport: origin.transport })), 'sentinel.osv.acquisitionUnauthorized');
  const other = spend(b, { ecosystems: ['npm'], maxBytesPerEcosystem: 1024 });
  assert.equal(await code(() => acquireAdvisorySnapshots(request, { dir, receipt: other, transport: origin.transport })), 'sentinel.osv.acquisitionUnauthorized', 'a receipt for another request');
  assert.deepEqual(origin.calls, [], 'nothing was fetched without authority');
  const snaps = await acquireAdvisorySnapshots(request, { dir, receipt: spend(b, request), transport: origin.transport, now: () => NOW });
  assert.deepEqual(origin.calls, ['https://osv-vulnerabilities.storage.googleapis.com/Maven/all.zip', 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip']);
  assert.deepEqual(snaps.map(s => `${s.ecosystem}:${s.sha256 === sha(files[s.ecosystem])}:${s.sourceLastModified}`), ['Maven:true:2026-10-21T16:48:16.000000000Z', 'npm:true:2026-10-21T16:48:16.000000000Z']);
  for (const s of snaps) {
    assert.equal(statSync(join(dir, `${s.sha256.slice(7)}.zip`)).mode & 0o777, 0o600);
    assert.equal(loadAdvisorySnapshot(dir, s.sha256).snapshot.sha256, s.sha256);
  }
  writeFileSync(join(dir, `${snaps[0]!.sha256.slice(7)}.zip`), 'tampered archive bytes', { mode: 0o600 });
  assert.equal(await code(() => loadAdvisorySnapshot(dir, snaps[0]!.sha256)), 'sentinel.osv.snapshotInvalid');
});

test('acquisition refuses other sources, oversize or redirected responses, and bytes that fail the origin checksum', async t => {
  const files = { npm: Buffer.from('synthetic npm archive'), Maven: Buffer.from('m') };
  const b = book(t);
  const req = (max = 1024) => ({ ecosystems: ['npm'] as ('npm' | 'Maven')[], maxBytesPerEcosystem: max });
  const dir = () => join(scratch(t, 'adv'), 's');
  assert.equal(await code(() => acquireAdvisorySnapshots({ ecosystems: ['PyPI' as any], maxBytesPerEcosystem: 1 }, { dir: dir(), receipt: undefined })), 'sentinel.osv.acquisitionRefused');
  assert.equal(await code(() => acquireAdvisorySnapshots(req(MAX_ACQUISITION_BYTES + 1), { dir: dir(), receipt: undefined })), 'sentinel.osv.acquisitionRefused', 'no multi-gigabyte bound');
  assert.equal(await code(() => acquireAdvisorySnapshots(req(4), { dir: dir(), receipt: spend(b, req(4)), transport: fakeOrigin(files).transport })), 'sentinel.osv.acquisitionRefused', 'declared over the bound');
  assert.equal(await code(() => acquireAdvisorySnapshots(req(4), { dir: dir(), receipt: spend(b, req(4)), transport: fakeOrigin(files, { length: 3 }).transport })), 'sentinel.osv.acquisitionRefused', 'over the bound while streaming');
  assert.equal(await code(() => acquireAdvisorySnapshots(req(), { dir: dir(), receipt: spend(b, req()), transport: fakeOrigin(files, { md5: null }).transport })), 'sentinel.osv.acquisitionFailed', 'no origin checksum');
  assert.equal(await code(() => acquireAdvisorySnapshots(req(), { dir: dir(), receipt: spend(b, req()), transport: fakeOrigin(files, { md5: createHash('md5').update('x').digest('base64') }).transport })), 'sentinel.osv.acquisitionFailed', 'checksum mismatch');
  assert.equal(await code(() => acquireAdvisorySnapshots(req(), { dir: dir(), receipt: spend(b, req()), transport: fakeOrigin(files, { url: 'https://elsewhere.example/npm/all.zip' }).transport })), 'sentinel.osv.acquisitionFailed', 'a redirected response');
  const d = dir();
  await code(() => acquireAdvisorySnapshots(req(), { dir: d, receipt: spend(b, req()), transport: fakeOrigin(files, { md5: createHash('md5').update('x').digest('base64') }).transport }));
  assert.deepEqual(readdirSync(d), [], 'a failed download leaves nothing behind');
});

test('every OSV reason code is a catalog entry with both registers and a definition', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const shimCodes = [...OSV_WORKER_BYTES.toString('utf8').matchAll(/'(sentinel\.osv\.[A-Za-z.]*[A-Za-z])'/g)].map(m => m[1]!);
  assert.ok(shimCodes.length >= 4);
  for (const key of [...OSV_ERROR_CODES, ...OSV_COVERAGE_REASONS, ...OSV_REFUSAL_REASONS, ...OSV_ENGINE_FAILURES, ...shimCodes]) {
    const e = STRINGS[key];
    assert.ok(e && e.hud && e.professional && e.define, key);
  }
});
