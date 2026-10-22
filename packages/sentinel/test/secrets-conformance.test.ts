// The pinned Gitleaks itself, through PR 07's isolated execution service only (no host fallback, no pull, no network).
// Runs with SENTINEL_ISOLATION=1; there a missing runtime or image is a failure, never a skip. Inputs are original
// synthetic files under their real names in a temporary captured tree; the synthetic value is assembled at run time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import {
  GITLEAKS_ADAPTER, GITLEAKS_PRODUCTION_BUILD, GITLEAKS_ENGINE, buildGitleaksAdapter, runSecretsAttempt, normalizeSecretsRun, buildSecretsJob,
} from '../dist/adapters/gitleaks/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { VALUE, absent, captured, sha, treeFiles } from './secrets-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned Gitleaks image installed';
// On a platform of the pinned index that is not yet measured (CI's linux/amd64), results are candidates, never measured.
const QUALIFY = process.env.SENTINEL_GITLEAKS_QUALIFY?.replace(/^linux\//, '');

const VARIANTS = {
  // Gitleaks refuses an unknown flag: an engine error.
  engineError: buildGitleaksAdapter({ id: 'secrets-gitleaks-engine-error', engineArgs: ['--sentinel-no-such-flag'] }),
  // The last --exit-code wins: findings with exit 0, which must not read as clean.
  inconsistent: buildGitleaksAdapter({ id: 'secrets-gitleaks-inconsistent', engineArgs: ['--exit-code', '0'] }),
  // A template that adds a field: every line is malformed.
  malformed: buildGitleaksAdapter({ id: 'secrets-gitleaks-malformed', template: '{{range .}}F\t{{.RuleID}}\textra\t{{.StartLine}}\t{{.EndLine}}\t{{.File}}\n{{end}}' }),
  // A report bound smaller than any finding line.
  tooLarge: buildGitleaksAdapter({ id: 'secrets-gitleaks-too-large', maxReportBytes: 10 }),
};

let root: { root: string; work: string };
let store: any;
let service: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  root = scratch('secrets');
  store = await storeIn(root.root);
  service = await createExecutionService(store, { scratchRoot: root.work,
    registry: createAdapterRegistry([GITLEAKS_ADAPTER, ...Object.values(VARIANTS).map(v => v.definition)]), containers: true });
});
after(async () => { if (enabled) { await store.close(); removeScratch(root.root); } });

async function run(files: Record<string, string | Buffer>, adapter = GITLEAKS_PRODUCTION_BUILD) {
  const i = n++;
  const targets = captured(join(root.root, `tree-${i}`), files);
  const t0 = Date.now();
  const r = await runSecretsAttempt(service, { attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    snapshotId: 'snap-synthetic', sourceId: 'src-synthetic', targets, scratch: root.root, adapter, ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}) });
  absent(JSON.stringify(r), 'the scan result');
  return { r, ms: Date.now() - t0 };
}
const found = (r: any) => r.observations.map((o: any) => `${o.producerRuleId} ${o.evidence[0].relativePath}:${o.evidence[0].span.startByte}`).sort();

test('positive: each leaking line is one redacted observation; a root ignore list and inline allows suppress nothing', { skip }, async t => {
  const { r, ms } = await run(treeFiles());
  assert.equal(r.status, 'complete', r.reasonCode);
  assert.deepEqual(found(r), ['github-pat config/service.env:43', 'github-pat notes/allowed.md:0']);
  assert.equal(r.platform.state, QUALIFY ? 'candidate' : 'measured');
  assert.equal(r.audit.exitCode, 2);
  assert.equal(r.audit.image, GITLEAKS_ENGINE.image);
  assert.equal(r.scanned.length, 4);
  t.diagnostic(`positive ${ms} ms, ${r.platform.architecture} ${r.platform.state}, image ${r.audit.imageId}, worker ${r.audit.worker.slice(7, 19)}`);
});

test('negative: a clean tree is complete with no observations and exit 0', { skip }, async () => {
  const { r } = await run(treeFiles({ 'config/service.env': 'NOTHING=here\n', 'notes/allowed.md': 'plain\n' }));
  assert.equal(r.status, 'complete', r.reasonCode);
  assert.equal(r.observations.length, 0);
  assert.equal(r.audit.exitCode, 0);
});

test('omissions are explicit: an allowlisted path, a file name the job cannot carry; odd names that it can are scanned', { skip }, async () => {
  const { r } = await run(treeFiles({
    'web/package-lock.json': `{"token":"${VALUE}"}\n`, 'odd\nname.env': `T=${VALUE}\n`,
    'with space/and\ttab ü.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, ' leading.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,
  }));
  assert.equal(r.status, 'partial', r.reasonCode);
  assert.deepEqual(r.skipped.map((s: any) => s.reasonCode).sort(), ['sentinel.secrets.pathUnsupported', 'sentinel.secrets.toolAllowlisted']);
  assert.deepEqual(found(r), [' leading.env:0', 'config/service.env:43', 'notes/allowed.md:0', 'with space/and\ttab ü.env:0'].map(x => `github-pat ${x}`).sort());
});

test('the allowlist is the engine’s: sent anyway, Gitleaks itself skips the lockfile', { skip }, async () => {
  // A job built without the coordinator's allowlist step, so the engine's own behaviour is what is measured.
  const i = n++;
  const targets = captured(join(root.root, `tree-${i}`), { 'web/package-lock.json': `{"token":"${VALUE}"}\n`, 'web/app.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n` });
  const dir = join(root.root, `job-${i}`); mkdirSync(dir);
  const built = buildSecretsJob({ snapshotId: 'snap-synthetic', sourceId: 'src-synthetic', targets }, dir);
  const lock = targets.find(t => t.relativePath === 'web/package-lock.json')!;
  const job = readFileSync(built.inputs[1]!.path, 'utf8') + `F 9 ${lock.artifact.slice(7)} web/package-lock.json\n`;
  const jobPath = join(dir, 'job-all.txt'); writeFileSync(jobPath, job);
  const outcome = await service.run({ adapterId: GITLEAKS_ADAPTER.id, attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    inputs: [built.inputs[0], { id: sha(job), path: jobPath }, ...built.inputs.slice(2), { id: lock.artifact, path: lock.path }] });
  assert.equal(outcome.state, 'succeeded', outcome.code);
  const reports = outcome.outputs.filter((o: any) => o.mediaType === 'application/vnd.sentinel.gitleaks-report');
  const text = readFileSync(reports[0].path, 'utf8');
  absent(text, 'the engine report');
  assert.deepEqual(text.trim().split('\n').map(l => l.split('\t').at(-1)), ['scan/tree/web/app.env'], 'only the non-allowlisted file is reported');
});

test('engine failures are errors over every target, and nothing the engine said leaves the container', { skip }, async () => {
  for (const [name, adapter, code] of [
    ['engineError', VARIANTS.engineError, 'sentinel.secrets.toolFailed'],
    ['inconsistent', VARIANTS.inconsistent, 'sentinel.secrets.reportInconsistent'],
    ['malformed', VARIANTS.malformed, 'sentinel.secrets.reportMalformed'],
    ['tooLarge', VARIANTS.tooLarge, 'sentinel.secrets.reportTooLarge'],
  ] as const) {
    const { r } = await run(treeFiles(), adapter);
    assert.equal(r.status, 'error', name);
    assert.equal(r.reasonCode, code, name);
    assert.equal(r.observations.length, 0, name);
    assert.equal(r.scanned.length, 0, name);
    assert.equal(r.skipped.length, 4, name);
  }
});

test('a job the shim cannot trust is refused with a code before the engine runs', { skip }, async () => {
  const i = n++;
  const targets = captured(join(root.root, `tree-${i}`), treeFiles());
  const dir = join(root.root, `job-${i}`); mkdirSync(dir);
  const built = buildSecretsJob({ snapshotId: 'snap-synthetic', sourceId: 'src-synthetic', targets }, dir);
  const bad = `sentinel-gitleaks-job/1\nF 0 ${targets[0]!.artifact.slice(7)} ../escape.env\n`;
  const badPath = join(dir, 'bad.txt'); writeFileSync(badPath, bad);
  const outcome = await service.run({ adapterId: GITLEAKS_ADAPTER.id, attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    inputs: [built.inputs[0], { id: sha(bad), path: badPath }, ...built.inputs.slice(2)] });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.diagnostics.text, 'sentinel-gitleaks-worker/1 sentinel.secrets.inputInvalid\n');
  const r = normalizeSecretsRun({ job: built.job, jobDigest: built.jobDigest, outcome, observedAt: new Date().toISOString(), outputBytes: () => undefined, targetBytes: () => undefined, ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}) });
  assert.equal(r.reasonCode, 'sentinel.secrets.inputInvalid');
  assert.deepEqual(readdirSync(join(outcome.workDir, 'output')), []);
});
