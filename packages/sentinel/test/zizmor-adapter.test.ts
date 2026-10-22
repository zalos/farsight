// The zizmor adapter without an engine: which files are sent and why not, the job the shim reads, and what a run's
// outputs establish over synthetic reports and run records. The real engine is exercised by zizmor-conformance.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ZIZMOR_ADAPTER, ZIZMOR_ENGINE, ZIZMOR_ONLINE_AUDITS, ZIZMOR_SUPPORT, ZIZMOR_WORKER_BYTES, ZIZMOR_WORKER_DIGEST, buildZizmorJob, ciKindOf,
  normalizeZizmorRun, ZIZMOR_COVERAGE_REASONS, ZIZMOR_REFUSAL_REASONS, ZIZMOR_ENGINE_FAILURES, ZIZMOR_ERROR_CODES,
} from '../dist/adapters/zizmor/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { ZIZMOR_LAYOUT, capturedTree, sha } from './iac-helpers.ts';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'sentinel-zizmor-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const code = (fn: () => unknown) => Promise.resolve().then(fn).then(() => 'no error', (e: any) => e.code ?? e.message);
const row = (r: any, p: string) => { const c = r.coverage.find((x: any) => x.relativePath === p); return `${c.status}:${c.limitations.map((l: string) => l.split('.').pop()).join(',')}`; };

test('the pins name the official release and image; offline, no repository config or ignores', () => {
  assert.equal(ZIZMOR_ENGINE.version, '1.31.1');
  assert.match(ZIZMOR_ADAPTER.image, /^ghcr\.io\/zizmorcore\/zizmor@sha256:[0-9a-f]{64}$/);
  assert.equal(ZIZMOR_ADAPTER.command.at(-1), `/input/${ZIZMOR_WORKER_DIGEST.slice(7)}`);
  const worker = ZIZMOR_WORKER_BYTES.toString('utf8');
  for (const flag of ['--offline', '--no-config', '--no-ignores']) assert.ok(worker.includes(flag), flag);
  assert.match(worker, /unset GH_TOKEN GITHUB_TOKEN ZIZMOR_GITHUB_TOKEN/);
  assert.doesNotMatch(worker, /\$\(bound\)/, 'frame bindings are built in the worker’s own shell');
  assert.deepEqual(ZIZMOR_SUPPORT.onlineAuditsSkipped, ZIZMOR_ONLINE_AUDITS);
});

test('which files are zizmor inputs, by its own collection layout', () => {
  const kinds = Object.fromEntries(['.github/workflows/ci.yml', '.github/workflows/ci.yaml', 'svc/.github/workflows/x.yml', '.github/workflows/sub/x.yml',
    '.github/workflows/ci.json', 'action.yml', 'tools/a/action.yaml', '.github/dependabot.yml', 'x/.github/dependabot.yaml', 'dependabot.yml', 'ci.yml'].map(p => [p, ciKindOf(p) ?? null]));
  assert.deepEqual(kinds, {
    '.github/workflows/ci.yml': 'workflow', '.github/workflows/ci.yaml': 'workflow', 'svc/.github/workflows/x.yml': 'workflow', '.github/workflows/sub/x.yml': null,
    '.github/workflows/ci.json': null, 'action.yml': 'action', 'tools/a/action.yaml': 'action', '.github/dependabot.yml': 'dependabot',
    'x/.github/dependabot.yaml': 'dependabot', 'dependabot.yml': null, 'ci.yml': null,
  });
});

test('the job sends CI files with their paths, and records every file it does not send', t => {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), { ...ZIZMOR_LAYOUT, 'README.md': { text: 'x\n' }, 'odd dir/.github/workflows/x.yml': { text: 'on: push\n' } });
  const built = buildZizmorJob(tree, dir);
  assert.deepEqual(built.job.unsent.map(u => `${u.relativePath}:${u.reason}`), ['README.md:not-ci-configuration', 'odd dir/.github/workflows/x.yml:path-unsupported']);
  assert.equal(built.job.targets.length, 7);
  assert.match(readFileSync(built.inputs[1]!.path, 'utf8'), /^sentinel-zizmor-job\/1\nS 100\nT 0 [0-9a-f]{64} \.github\/actions\/setup\/action\.yml\n/);
  assert.equal(buildZizmorJob(tree.filter(x => x.relativePath === 'README.md'), dir).jobDigest, null, 'nothing to send, nothing runs');
  return code(() => buildZizmorJob([tree[0]!, tree[0]!], dir)).then(c => assert.equal(c, 'sentinel.zizmor.targetInvalid'));
});

// ---- normalization over synthetic engine output ------------------------------------------------------------------

const ROOT = '/tmp/sentinel-zizmor/src/';
const loc = (path: string, start: number, end: number, kind = 'Primary') => ({
  symbolic: { key: { Local: { verbatim_path: ROOT + path } }, annotation: 'quotes the file', kind },
  concrete: { location: { offset_span: { start, end } }, feature: 'quoted feature text' },
});
const finding = (ident: string, severity: string, locations: unknown[], extra: Record<string, unknown> = {}) =>
  ({ ident, desc: 'd', url: 'u', determinations: { confidence: 'High', severity, persona: 'Regular' }, locations, ignored: false, fixes: [], ...extra });
const ALL = Object.keys(ZIZMOR_LAYOUT);
function run(t: { after(fn: () => void): void }, report: unknown, record: Record<string, unknown> = {}, opts: { arch?: string; mutate?: string } = {}) {
  const dir = scratch(t);
  const tree = capturedTree(join(dir, 'tree'), ZIZMOR_LAYOUT);
  const built = buildZizmorJob(tree, dir);
  const reportBytes = Buffer.from(JSON.stringify(report));
  const recordBytes = Buffer.from(JSON.stringify({
    schema: 'sentinel-zizmor-run/draft-1', job: built.jobDigest, exitCode: 14, timedOut: false, stdoutTruncated: false, engineOutput: sha(reportBytes), failure: null,
    version: '1.31.1', registered: ALL, completed: ALL.filter(p => !p.includes('broken') && !p.includes('notes')), skippedAudits: [...ZIZMOR_ONLINE_AUDITS], ...record,
  }));
  const bytes = new Map([[sha(reportBytes), reportBytes], [sha(recordBytes), recordBytes]]);
  const outcome: any = { state: 'succeeded', adapter: { id: 'ci-zizmor' }, container: { image: { architecture: opts.arch ?? 'arm64' } }, outputs: [
    { id: sha(reportBytes), mediaType: 'application/vnd.zizmor.findings+json' }, { id: sha(recordBytes), mediaType: 'application/vnd.sentinel.zizmor-run+json' }] };
  const byArtifact = new Map(tree.map(x => [x.artifact, readFileSync(x.path)]));
  return normalizeZizmorRun({ job: built.job, jobDigest: built.jobDigest!, outcome, outputBytes: id => bytes.get(id)!,
    targetBytes: a => (opts.mutate && byArtifact.get(a)?.toString().includes(opts.mutate) ? Buffer.from('changed') : byArtifact.get(a)) });
}
const REPORT = [
  finding('template-injection', 'High', [loc('.github/workflows/triage.yml', 90, 140, 'Hidden'), loc('.github/workflows/triage.yml', 100, 140), loc('.github/workflows/triage.yml', 90, 93, 'Related')]),
  finding('dependabot-cooldown', 'Medium', [loc('.github/dependabot.yml', 24, 46)]),
];

test('findings keep the audit and byte spans at captured paths; coverage needs the engine’s own completion', t => {
  const r = run(t, REPORT);
  assert.deepEqual(r.findings.map(f => `${f.audit}@${f.primary.relativePath}:${f.primary.span.startByte}-${f.primary.span.endByte}+${f.related.length}`),
    ['dependabot-cooldown@.github/dependabot.yml:24-46+0', 'template-injection@.github/workflows/triage.yml:100-140+1']);
  assert.doesNotMatch(JSON.stringify(r), /quotes the file|quoted feature/);
  assert.equal(row(r, '.github/workflows/triage.yml'), 'partial:onlineAuditsSkipped,offlineDegraded');
  assert.equal(row(r, '.github/dependabot.yml'), 'complete:');
  assert.equal(row(r, '.github/workflows/broken.yml'), 'error:notAudited');
  // At exit 0, a file the engine never collected is an omission, not a pass.
  const omitted = run(t, [], { exitCode: 0, registered: ALL.filter(p => p !== '.github/workflows/build.yaml'), completed: ALL.filter(p => p !== '.github/workflows/build.yaml') });
  assert.equal(row(omitted, '.github/workflows/build.yaml'), 'error:notCollected');
  // Another audit failing to load leaves every audited file short of complete.
  assert.equal(row(run(t, REPORT, { skippedAudits: [...ZIZMOR_ONLINE_AUDITS, 'github-env'] }), '.github/dependabot.yml'), 'partial:auditNotLoaded');
});

test('a report that disagrees with the exit code, or a run that was not offline, counts nothing', t => {
  for (const [report, record] of [[REPORT, { exitCode: 0 }], [[], { exitCode: 14 }], [REPORT, { exitCode: 13 }], [REPORT, { skippedAudits: ['impostor-commit'] }]] as const) {
    const r = run(t, report, record);
    assert.equal(r.findings.length, 0);
    assert.ok(r.coverage.filter(c => c.kind !== null).every(c => c.reasonCode === 'sentinel.zizmor.coverage.reportInconsistent'), JSON.stringify(record));
  }
  const failed = run(t, REPORT, { exitCode: 1, failure: { category: 'engineError', exitCode: 1 } });
  assert.equal(failed.engineFailure, 'sentinel.zizmor.engine.engineError');
  assert.equal(run(t, REPORT, { exitCode: 9, failure: { category: 'stderr words', exitCode: 9 } }).engineFailure, 'sentinel.zizmor.engine.unknown');
  assert.equal(row(run(t, REPORT, { stdoutTruncated: true }), '.github/dependabot.yml'), 'error:outputTruncated');
  assert.equal(run(t, REPORT, {}, { arch: 'amd64' }).platform.state, 'refused');
  assert.equal(row(run(t, REPORT, {}, { mutate: 'cooldown' }), '.github/dependabot.yml'), 'complete:', 'the fixture has no such text: unchanged');
  assert.equal(row(run(t, REPORT, {}, { mutate: 'package-ecosystem' }), '.github/dependabot.yml'), 'error:inputMismatch');
  return Promise.all([
    code(() => run(t, REPORT, { version: '1.30.1' })).then(c => assert.equal(c, 'sentinel.zizmor.outputInvalid')),
    code(() => run(t, REPORT, { job: sha('another') })).then(c => assert.equal(c, 'sentinel.zizmor.outputInvalid')),
  ]);
});

test('a finding outside the sent files, ignored, unaudited, out of bounds or malformed is refused', t => {
  const r = run(t, [
    finding('template-injection', 'High', [loc('../escape.yml', 0, 1)]),
    finding('template-injection', 'High', [loc('.github/workflows/triage.yml', 0, 1)], { ignored: true }),
    finding('template-injection', 'High', [loc('.github/workflows/broken.yml', 0, 1)]),
    finding('template-injection', 'High', [loc('.github/workflows/triage.yml', 0, 999_999)]),
    finding('template-injection', 'High', [loc('.github/workflows/triage.yml', 0, 1, 'Related')]),
    finding('Not An Audit', 'High', [loc('.github/workflows/triage.yml', 0, 1)]),
  ]);
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.refused.map(x => x.reasonCode.split('.').pop()).sort(), ['ignored', 'locationInvalid', 'malformed', 'malformed', 'notAudited', 'unknownPath']);
});

test('every reason the adapter or its worker can record is a catalog word, and the catalog has no others', () => {
  const worker = [...ZIZMOR_WORKER_BYTES.toString('utf8').matchAll(/'(sentinel\.zizmor\.[a-zA-Z]+)'/g)].map(m => m[1]!);
  const codes = new Set([...ZIZMOR_COVERAGE_REASONS, ...ZIZMOR_REFUSAL_REASONS, ...ZIZMOR_ENGINE_FAILURES, ...ZIZMOR_ERROR_CODES, ...worker]);
  for (const c of codes) assert.ok(STRINGS[c]?.define, `${c} is in the catalog with a definition`);
  assert.deepEqual(Object.keys(STRINGS).filter(k => k.startsWith('sentinel.zizmor.')).sort(), [...codes].sort());
});

