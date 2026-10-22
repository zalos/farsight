// The Gitleaks adapter's pure parts (PR 11): pins, the shim build, the job, and the normaliser over synthetic
// outcomes. These always run; secrets-conformance.test.ts runs the pinned engine itself in a real container.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import {
  GITLEAKS_ADAPTER, GITLEAKS_CONFIG, GITLEAKS_ENGINE, GITLEAKS_REPORT_TEMPLATE, GITLEAKS_RULE_IDS, GITLEAKS_WORKER_BYTES, GITLEAKS_WORKER_DIGEST,
  OBSERVATION_MESSAGE, buildGitleaksAdapter, buildSecretsJob, lineSpan, normalizeSecretsRun, readReport, toolAllowlisted, GITLEAKS_MAX_FILE_BYTES,
} from '../dist/adapters/gitleaks/index.js';
import { VALUE, absent, captured, sha, treeFiles } from './secrets-helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'sentinel-secrets-unit-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(root, `d${n++}`); mkdirSync(d, { mode: 0o700 }); return d; };

test('the pins: the official release, its image index, its default rules, and a shim that the adapter digest covers', () => {
  assert.equal(GITLEAKS_ENGINE.version, '8.30.1');
  assert.equal(GITLEAKS_ENGINE.license, 'MIT');
  assert.match(GITLEAKS_ENGINE.image, /^ghcr\.io\/gitleaks\/gitleaks@sha256:[0-9a-f]{64}$/);
  assert.equal(GITLEAKS_RULE_IDS.size, 222);
  assert.ok(GITLEAKS_RULE_IDS.has('github-pat') && [...GITLEAKS_RULE_IDS].every(id => /^[a-z0-9][a-z0-9-]*$/.test(id)));
  assert.equal(GITLEAKS_ADAPTER.isolation, 'container');
  assert.deepEqual([...GITLEAKS_ADAPTER.command], ['/bin/sh', `/input/${GITLEAKS_WORKER_DIGEST.slice(7)}`]);
  assert.equal(sha(GITLEAKS_WORKER_BYTES), GITLEAKS_WORKER_DIGEST);
  const shim = GITLEAKS_WORKER_BYTES.toString('utf8');
  assert.ok(shim.includes(GITLEAKS_CONFIG) && shim.includes(GITLEAKS_REPORT_TEMPLATE), 'the shim carries the pinned configuration and template');
  assert.doesNotMatch(GITLEAKS_CONFIG, /allowlist|paths|regexes|stopwords|disabledRules/);
  assert.deepEqual([...GITLEAKS_REPORT_TEMPLATE.matchAll(/\{\{\.(\w+)\}\}/g)].map(m => m[1]), ['RuleID', 'StartLine', 'EndLine', 'File'], 'the template names rule, lines and file only');
  assert.doesNotMatch(shim, /baseline|--no-git|curl|wget|apk /);
  assert.match(shim, /--ignore-gitleaks-allow --redact=100/);
  assert.match(shim, / --exit-code 2 /, 'leaks are exit 2, distinct from an engine error (1)');
  const variant = buildGitleaksAdapter({ id: 'secrets-gitleaks-variant', engineArgs: ['--exit-code', '0'] });
  assert.notEqual(variant.workerDigest, GITLEAKS_WORKER_DIGEST);
  assert.notEqual(createAdapterRegistry([variant.definition]).get('secrets-gitleaks-variant').digest, createAdapterRegistry([GITLEAKS_ADAPTER]).get('secrets-gitleaks').digest);
  assert.throws(() => buildGitleaksAdapter({ engineArgs: ['--config', '/x; rm'] }));
});

test('the job: shim, job, contents in order; unsent files are skipped scopes with their reasons', () => {
  const big = Buffer.alloc(GITLEAKS_MAX_FILE_BYTES + 1, 0x61);
  const targets = captured(dir(), treeFiles({ 'web/package-lock.json': '{}\n', 'assets/logo.png': 'x', 'big.bin.txt': big, 'odd\nname.txt': 'x', 'same/copy.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n` }));
  const built = buildSecretsJob({ snapshotId: 'snap-1', sourceId: 'src-1', targets }, dir());
  assert.equal(built.inputs[0]!.id, GITLEAKS_WORKER_DIGEST);
  assert.equal(built.inputs[1]!.id, built.jobDigest);
  const text = readFileSync(built.inputs[1]!.path, 'utf8');
  assert.ok(text.startsWith('sentinel-gitleaks-job/1\n') && text.endsWith('\n'));
  absent(text, 'the job file');
  assert.deepEqual(built.job.files.map(f => f.relativePath), ['.gitleaksignore', 'config/service.env', 'notes/allowed.md', 'same/copy.env', 'src/clean.ts']);
  assert.deepEqual(built.job.unsent.map(u => `${u.relativePath.replace('\n', '\\n')} ${u.reasonCode}`).sort(), [
    'assets/logo.png sentinel.secrets.toolAllowlisted', 'big.bin.txt sentinel.secrets.fileTooLarge',
    'odd\\nname.txt sentinel.secrets.pathUnsupported', 'web/package-lock.json sentinel.secrets.toolAllowlisted',
  ]);
  // Each distinct content is an input once, after the shim and the job.
  assert.equal(new Set(built.inputs.map(i => i.id)).size, built.inputs.length);
  assert.throws(() => buildSecretsJob({ snapshotId: 'snap-1', sourceId: 'src-1', targets: [{ ...targets[0]!, artifact: sha('other') }] }, dir()), /inputInvalid/);
  assert.throws(() => buildSecretsJob({ snapshotId: 'snap-1', sourceId: 'src-1', targets: [{ ...targets[0]!, relativePath: '../x' }] }, dir()), /inputInvalid/);
});

test('the pinned global allowlist reads the way Gitleaks reads it', () => {
  for (const p of ['package-lock.json', 'web/pnpm-lock.yaml', 'node_modules/x/index.js', 'img/a.PNG', 'go.sum', 'vendor/modules.txt', '.gitleaks.toml']) assert.ok(toolAllowlisted(p), p);
  for (const p of ['src/index.ts', 'config/.env', 'package.json', 'docs/readme.md', 'lockfile.json']) assert.ok(!toolAllowlisted(p), p);
});

test('a report line names a pinned rule, whole lines and a sent file, and nothing else', () => {
  const sent = new Set(['a.env', 'b c\td.env']);
  assert.deepEqual(readReport('F\tgithub-pat\t2\t2\tscan/tree/a.env\nF\tgithub-pat\t1\t3\tscan/tree/b c\td.env\n', sent),
    [{ rule: 'github-pat', start: 2, end: 2, path: 'a.env' }, { rule: 'github-pat', start: 1, end: 3, path: 'b c\td.env' }]);
  assert.deepEqual(readReport('', sent), []);
  const refused = (text: string, code: string) => assert.throws(() => readReport(text, sent), (e: any) => e.code === code);
  refused(`F\t${VALUE}\t2\t2\tscan/tree/a.env\n`, 'sentinel.secrets.reportMalformed');
  refused('F\tnot-a-pinned-rule\t2\t2\tscan/tree/a.env\n', 'sentinel.secrets.reportMalformed');
  refused('F\tgithub-pat\t0\t2\tscan/tree/a.env\n', 'sentinel.secrets.reportMalformed');
  refused('F\tgithub-pat\t3\t2\tscan/tree/a.env\n', 'sentinel.secrets.reportMalformed');
  refused('F\tgithub-pat\t2\t2\tscan/tree/a.env', 'sentinel.secrets.reportMalformed');
  refused('X\tgithub-pat\t2\t2\tscan/tree/a.env\n', 'sentinel.secrets.reportMalformed');
  refused('F\tgithub-pat\t2\t2\tscan/tree/other.env\n', 'sentinel.secrets.unknownFile');
  refused('F\tgithub-pat\t2\t2\t/etc/passwd\n', 'sentinel.secrets.unknownFile');
});

test('a location is whole lines, never a part of one', () => {
  const b = Buffer.from('one\r\ntwo three\nfour');
  assert.deepEqual(lineSpan(b, 1, 1), { startByte: 0, endByte: 3 });
  assert.deepEqual(lineSpan(b, 2, 2), { startByte: 5, endByte: 14 });
  assert.deepEqual(lineSpan(b, 3, 3), { startByte: 15, endByte: 19 });
  assert.deepEqual(lineSpan(b, 1, 3), { startByte: 0, endByte: 19 });
  assert.throws(() => lineSpan(b, 4, 4), (e: any) => e.code === 'sentinel.secrets.locationOutOfRange');
});

// --- the normaliser over synthetic outcomes ---

function synthetic(options: { exitCode?: number; failure?: string | null; report?: string | null; architecture?: string; state?: string; stderr?: string; extraOutput?: boolean; qualify?: string } = {}) {
  const targets = captured(dir(), treeFiles());
  const built = buildSecretsJob({ snapshotId: 'snap-1', sourceId: 'src-1', targets }, dir());
  const report = options.report === undefined ? 'F\tgithub-pat\t2\t2\tscan/tree/config/service.env\nF\tgithub-pat\t1\t1\tscan/tree/notes/allowed.md\n' : options.report;
  const reportBytes = report === null ? undefined : Buffer.from(report);
  const record = Buffer.from(JSON.stringify({ schema: 'sentinel-gitleaks-run/draft-1', job: built.jobDigest, exitCode: options.exitCode ?? 2,
    failure: options.failure ?? null, report: reportBytes ? sha(reportBytes) : null, reportBytes: reportBytes?.length ?? 0, stderrDigest: sha('') }));
  const outputs = [{ id: sha(record), mediaType: 'application/vnd.sentinel.gitleaks-run+json', bytes: record.length, path: '' },
    ...(reportBytes ? [{ id: sha(reportBytes), mediaType: 'application/vnd.sentinel.gitleaks-report', bytes: reportBytes.length, path: '' }] : []),
    ...(options.extraOutput ? [{ id: sha('x'), mediaType: 'text/plain', bytes: 1, path: '' }] : [])];
  const bytes = new Map<string, Uint8Array>([[sha(record), record], ...(reportBytes ? [[sha(reportBytes), reportBytes] as [string, Uint8Array]] : [])]);
  const contents = new Map(targets.map(t => [t.artifact, readFileSync(t.path)]));
  const outcome: any = {
    state: options.state ?? 'succeeded', attemptId: 'attempt-1', adapter: { id: 'secrets-gitleaks', digest: sha('adapter') },
    invocation: { digest: sha('invocation') }, outputs, diagnostics: { text: options.stderr ?? '', bytes: 0, truncated: false },
    container: { id: 'c', image: { reference: GITLEAKS_ENGINE.image, id: GITLEAKS_ENGINE.image.split('@')[1], architecture: options.architecture ?? 'arm64', os: 'linux', env: [] } },
    ...(options.state && options.state !== 'succeeded' ? { code: 'sentinel.execution.workerExited' } : { result: { observations: [] } }),
  };
  return normalizeSecretsRun({ job: built.job, jobDigest: built.jobDigest, outcome, observedAt: '2026-10-22T00:00:00.000Z',
    outputBytes: id => bytes.get(id), targetBytes: a => contents.get(a), ...(options.qualify ? { qualifyingArchitecture: options.qualify } : {}) });
}

test('findings become redacted observations citing whole lines; existing findings stay through ignore lists and allows', () => {
  const r = synthetic();
  assert.equal(r.status, 'complete');
  absent(JSON.stringify(r), 'the scan result');
  assert.deepEqual(r.observations.map(o => `${o.producerRuleId} ${o.evidence[0]!.relativePath} ${o.evidence[0]!.span.startByte}-${o.evidence[0]!.span.endByte}`).sort(),
    ['github-pat config/service.env 43-108', 'github-pat notes/allowed.md 0-63']);
  assert.ok(r.observations.every(o => o.message === OBSERVATION_MESSAGE && o.originalSeverity === 'unrated' && !('quoteDigest' in o.evidence[0]!)));
  assert.equal(r.scanned.length, 4);
  assert.equal(r.audit.engine, 'gitleaks 8.30.1');
  assert.deepEqual(r.platform, { architecture: 'arm64', state: 'measured' });
  // An unmeasured platform of the pinned index counts only under an explicit qualification run, and says so.
  const candidate = synthetic({ architecture: 'amd64', qualify: 'amd64' });
  assert.equal(candidate.status, 'complete');
  assert.deepEqual(candidate.platform, { architecture: 'amd64', state: 'candidate' });
  assert.equal(synthetic({ architecture: 's390x', qualify: 's390x' }).reasonCode, 'sentinel.secrets.platformUnmeasured', 'only a platform the index lists');
});

test('every failure is an error over every target with a coded reason, never zero findings', () => {
  const cases: Array<[Parameters<typeof synthetic>[0], string]> = [
    [{ failure: 'engineError', exitCode: 1, report: null }, 'sentinel.secrets.toolFailed'],
    [{ failure: 'killed', exitCode: 137, report: null }, 'sentinel.secrets.toolTimedOut'],
    [{ failure: 'reportMissing', exitCode: 0, report: null }, 'sentinel.secrets.reportMissing'],
    [{ failure: 'reportTooLarge', report: null }, 'sentinel.secrets.reportTooLarge'],
    [{ exitCode: 0 }, 'sentinel.secrets.reportInconsistent'],
    [{ exitCode: 2, report: '' }, 'sentinel.secrets.reportInconsistent'],
    [{ exitCode: 3, report: '' }, 'sentinel.secrets.toolFailed'],
    [{ report: `F\tgithub-pat\t2\t2\tscan/tree/config/service.env\t${VALUE}\n` }, 'sentinel.secrets.unknownFile'],
    [{ report: 'F\tgithub-pat\t9\t9\tscan/tree/config/service.env\n' }, 'sentinel.secrets.locationOutOfRange'],
    [{ architecture: 'amd64' }, 'sentinel.secrets.platformUnmeasured'],
    [{ architecture: 's390x' }, 'sentinel.secrets.platformUnmeasured'],
    [{ extraOutput: true }, 'sentinel.secrets.outputRefused'],
    [{ state: 'failed', stderr: 'sentinel-gitleaks-worker/1 sentinel.secrets.inputInvalid\n' }, 'sentinel.secrets.inputInvalid'],
    [{ state: 'failed', stderr: `something quoting ${VALUE}\n` }, 'sentinel.execution.workerExited'],
    [{ state: 'timed-out' }, 'sentinel.secrets.toolTimedOut'],
  ];
  for (const [options, code] of cases) {
    const r = synthetic(options);
    absent(JSON.stringify(r), `the result for ${code}`);
    assert.equal(r.status, 'error', code);
    assert.equal(r.reasonCode, code);
    assert.equal(r.observations.length, 0);
    assert.equal(r.scanned.length, 0);
    assert.equal(r.skipped.length, 4);
    assert.ok(r.skipped.every(s => s.reasonCode === code));
  }
});
