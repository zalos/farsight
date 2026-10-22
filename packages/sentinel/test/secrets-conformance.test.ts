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
  GITLEAKS_ADAPTER, GITLEAKS_PRODUCTION_BUILD, GITLEAKS_ENGINE, buildGitleaksAdapter, runSecretsAttempt, normalizeSecretsRun, buildSecretsJob, toolAllowlisted,
} from '../dist/adapters/gitleaks/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { GENERIC_VALUE, VALUE, absent, allowlistCorpus, captured, sha, snapshotFor, treeFiles } from './secrets-helpers.ts';
import { resolveWithheldLocation } from '../dist/snapshot/locations.js';
import { ENTRY_SCOPE } from '../dist/adapters/gitleaks/index.js';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned Gitleaks image installed';
// An explicit qualification option permits only a platform listed in the pin; measured results stay measured.
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
  const scoped = snapshotFor('snap-synthetic', 'src-synthetic', captured(join(root.root, `tree-${i}`), files));
  const t0 = Date.now();
  let outputs = 0;
  const r = await runSecretsAttempt(service, { attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    ...scoped, sourceId: 'src-synthetic', scratch: root.root, adapter, ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}),
    // Every artifact that left the container, read while it exists: none may carry the value, a path or a name.
    inspect: (outcome: any) => {
      for (const o of outcome.outputs) { const b = readFileSync(o.path); absent(b, 'an output artifact'); assert.ok(!b.includes('scan/tree'), 'no path leaves the container'); outputs++; }
      absent(JSON.stringify(outcome), 'the worker outcome');
    } });
  absent(JSON.stringify(r), 'the scan result');
  snapshots.set(r, scoped.snapshot);
  return { r, ms: Date.now() - t0, outputs };
}
const snapshots = new WeakMap<object, any>();
// Results cite withheld locations only; tests resolve them over the private snapshot, as a local reader would.
const pathOf = (r: any, evidence: any) => { const x = resolveWithheldLocation(snapshots.get(r), evidence); return x.ok ? x.entry.relativePath : undefined; };
const scopePath = (r: any, scopeId: string) => snapshots.get(r).entries[Number(ENTRY_SCOPE.exec(scopeId)?.[2] ?? -1)]?.relativePath;
const found = (r: any) => r.observations.map((o: any) => `${o.producerRuleId} ${pathOf(r, o.evidence[0])}:${o.evidence[0].span.startByte}`).sort();

test('positive: each leaking line is one redacted observation; a root ignore list and inline allows suppress nothing', { skip }, async t => {
  const { r, ms } = await run(treeFiles());
  assert.equal(r.status, 'complete', r.reasonCode);
  assert.deepEqual(found(r), ['github-pat config/service.env:43', 'github-pat notes/allowed.md:0']);
  assert.equal(r.platform.state, 'measured');
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
  const built = buildSecretsJob({ ...snapshotFor('snap-synthetic', 'src-synthetic', targets), sourceId: 'src-synthetic' }, dir);
  const lock = targets.find(t => t.relativePath === 'web/package-lock.json')!;
  const job = readFileSync(built.inputs[1]!.path, 'utf8') + `F 9 ${lock.artifact.slice(7)} web/package-lock.json\n`;
  const jobPath = join(dir, 'job-all.txt'); writeFileSync(jobPath, job);
  const outcome = await service.run({ adapterId: GITLEAKS_ADAPTER.id, attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    inputs: [built.inputs[0], { id: sha(job), path: jobPath }, ...built.inputs.slice(2), { id: lock.artifact, path: lock.path }] });
  assert.equal(outcome.state, 'succeeded', outcome.code);
  const reports = outcome.outputs.filter((o: any) => o.mediaType === 'application/vnd.sentinel.gitleaks-report');
  const text = readFileSync(reports[0].path, 'utf8');
  absent(text, 'the engine report');
  // The report carries the job index of each file, never its path: web/app.env is index 0, the lockfile 9.
  assert.doesNotMatch(text, /scan\/tree|package-lock|app\.env/);
  assert.deepEqual(text.trim().split('\n'), ['F\tgithub-pat\t1\t1\t0'], 'only the non-allowlisted file is reported');
});

test('engine failures are errors over every target, and nothing the engine said leaves the container', { skip }, async () => {
  for (const [name, adapter, code] of [
    ['engineError', VARIANTS.engineError, 'sentinel.secrets.toolFailed'],
    ['inconsistent', VARIANTS.inconsistent, 'sentinel.secrets.reportInconsistent'],
    ['malformed', VARIANTS.malformed, 'sentinel.secrets.unknownFile'], // a line the shim cannot map to a sent file is U
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
  const built = buildSecretsJob({ ...snapshotFor('snap-synthetic', 'src-synthetic', targets), sourceId: 'src-synthetic' }, dir);
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

test('a folder the engine prunes (images.png/, package-lock.json/, nested) is a skipped scope, never complete with zero findings', { skip }, async () => {
  const { r } = await run({
    'images.png/token.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, 'package-lock.json/token.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,
    'a/images.png/b/token.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, 'src/clean.ts': 'export const x = 1;\n',
  });
  assert.equal(r.status, 'partial', r.reasonCode);
  assert.deepEqual(r.skipped.map((s: any) => scopePath(r, s.scopeId)).sort(),
    ['a/images.png/b/token.env', 'images.png/token.env', 'package-lock.json/token.env']);
  assert.ok(r.skipped.every((s: any) => s.reasonCode === 'sentinel.secrets.toolAllowlisted'));
  assert.equal(r.observations.length, 0);
  assert.deepEqual(r.scanned.map((x: string) => scopePath(r, x)), ['src/clean.ts']);
});

test('the engine itself prunes those folders when they are sent anyway, so the skip is the engine\'s, not a guess', { skip }, async () => {
  const i = n++;
  const files = { 'images.png/token.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, 'package-lock.json/token.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, 'web/app.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n` };
  const targets = captured(join(root.root, `tree-${i}`), files);
  const dir = join(root.root, `job-${i}`); mkdirSync(dir);
  const built = buildSecretsJob({ ...snapshotFor('snap-synthetic', 'src-synthetic', targets), sourceId: 'src-synthetic' }, dir);
  const lines = ['sentinel-gitleaks-job/1', ...targets.map((t, k) => `F ${k} ${t.artifact.slice(7)} ${t.relativePath}`)];
  const job = `${lines.join('\n')}\n`;
  const jobPath = join(dir, 'job-all.txt'); writeFileSync(jobPath, job);
  const outcome = await service.run({ adapterId: GITLEAKS_ADAPTER.id, attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    inputs: [built.inputs[0], { id: sha(job), path: jobPath }, ...targets.filter((t, k, a) => a.findIndex(x => x.artifact === t.artifact) === k).map(t => ({ id: t.artifact, path: t.path }))] });
  assert.equal(outcome.state, 'succeeded', outcome.code);
  const report = readFileSync(outcome.outputs.find((o: any) => o.mediaType === 'application/vnd.sentinel.gitleaks-report').path, 'utf8');
  const sent = targets.map(t => t.relativePath);
  assert.deepEqual(report.trim().split('\n').map(l => sent[Number(l.split('\t')[4])]), ['web/app.env'], 'nothing under the pruned folders is reported');
});

test('a file name shaped like a secret is found by the engine, and no location leaks anywhere', { skip }, async () => {
  const named = `keys/${VALUE}.txt`;
  const { r, outputs } = await run({ [named]: `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, 'keys/plain.txt': 'nothing\n', [`assets/${VALUE}.png`]: 'x' });
  assert.equal(outputs, 2, 'the record and the report were checked');
  assert.equal(r.status, 'partial', r.reasonCode);
  const name = r.observations.filter((o: any) => o.limitationKeys.includes('sentinel.secrets.nameMatch'));
  // names below hold the value: compare masked, so no failure message can print it
  const mask = (p: string | undefined) => String(p).replaceAll(VALUE, '<value>');
  assert.deepEqual(name.map((o: any) => mask(pathOf(r, o.evidence[0]))).sort(), ['assets/<value>.png', 'keys/<value>.txt'], 'both secret-shaped names are findings');
  const inside = r.observations.find((o: any) => !o.limitationKeys.includes('sentinel.secrets.nameMatch'));
  assert.equal(mask(pathOf(r, inside.evidence[0])), 'keys/<value>.txt');
  assert.ok(r.observations.every((o: any) => o.evidence.every((e: any) => e.location === 'withheld' && !('relativePath' in e))));
  assert.ok(!JSON.stringify(r).includes('keys/') && !JSON.stringify(r).includes('assets/'), 'no captured path is exported');
});

test('a value the detector finds only in context (generic-api-key) never leaks through a file name, in this file or another', { skip }, async () => {
  const files = {
    'config/keys.env': `api_key = "${GENERIC_VALUE}"\n`,
    // the matched value used as names: alone, no detector recognises it
    [`config/${GENERIC_VALUE}.env`]: `api_key = "${GENERIC_VALUE}"\n`,
    [`cache/${GENERIC_VALUE}`]: 'clean\n',
  };
  // Paths below hold the value: every comparison goes through this mask, so no failure message can print it.
  const mask = (p: string | undefined) => String(p).replaceAll(GENERIC_VALUE, '<value>');
  let outputsChecked = 0;
  const i = n++;
  const scoped = snapshotFor('snap-synthetic', 'src-synthetic', captured(join(root.root, `tree-${i}`), files));
  const r = await runSecretsAttempt(service, { attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    ...scoped, sourceId: 'src-synthetic', scratch: root.root, ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}),
    inspect: (outcome: any) => {
      for (const o of outcome.outputs) { absent(readFileSync(o.path), 'an output artifact', GENERIC_VALUE); outputsChecked++; }
      absent(JSON.stringify(outcome), 'the worker outcome', GENERIC_VALUE);
    } });
  absent(JSON.stringify(r), 'the exported result', GENERIC_VALUE);
  snapshots.set(r, scoped.snapshot);
  assert.equal(outputsChecked, 2);
  assert.equal(r.status, 'complete', r.reasonCode);
  const generic = r.observations.filter((o: any) => o.producerRuleId === 'generic-api-key');
  assert.deepEqual(generic.map((o: any) => mask(pathOf(r, o.evidence[0]))).sort(), ['config/<value>.env', 'config/keys.env'], 'the engine finds the value in both assignments');
  assert.ok(!r.observations.some((o: any) => o.limitationKeys.includes('sentinel.secrets.nameMatch')), 'no detector sees the value as a bare name');
  assert.deepEqual(r.scanned.map((x: string) => mask(scopePath(r, x))).sort(), ['cache/<value>', 'config/<value>.env', 'config/keys.env'], 'the private table still resolves every file exactly');
});

test('host and engine agree on every allowlisted path of a case-folding corpus (ſ, Kelvin K, upper case, folders)', { skip }, async t => {
  const i = n++;
  const paths = allowlistCorpus();
  const files = Object.fromEntries(paths.map(p => [p, `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`]));
  const targets = captured(join(root.root, `tree-${i}`), files);
  const dir = join(root.root, `job-${i}`); mkdirSync(dir);
  const built = buildSecretsJob({ ...snapshotFor('snap-synthetic', 'src-synthetic', targets.slice(0, 1)), sourceId: 'src-synthetic' }, dir);
  // Every path is sent, whatever the host thinks, so the engine's own skips are what is measured.
  const job = `${['sentinel-gitleaks-job/1', ...targets.map((x, k) => `F ${k} ${x.artifact.slice(7)} ${x.relativePath}`)].join('\n')}\n`;
  const jobPath = join(dir, 'job-all.txt'); writeFileSync(jobPath, job);
  const outcome = await service.run({ adapterId: GITLEAKS_ADAPTER.id, attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    inputs: [built.inputs[0], { id: sha(job), path: jobPath }, { id: targets[0]!.artifact, path: targets[0]!.path }] });
  assert.equal(outcome.state, 'succeeded', outcome.code);
  const report = readFileSync(outcome.outputs.find((o: any) => o.mediaType === 'application/vnd.sentinel.gitleaks-report').path, 'utf8');
  absent(report, 'the engine report');
  const reported = new Set(report.trim().split('\n').filter(l => l.startsWith('F\t')).map(l => targets[Number(l.split('\t')[4])]!.relativePath));
  const engineSkips = paths.filter(p => !reported.has(p));
  const hostSkips = paths.filter(p => toolAllowlisted(p));
  assert.deepEqual(hostSkips, engineSkips, 'the host skips exactly what the engine skips');
  assert.ok(engineSkips.some(p => p.includes('\u017F')) && engineSkips.some(p => p.includes('\u212A')), 'the corpus exercises both foldings');
  t.diagnostic(`${paths.length} paths, ${engineSkips.length} skipped by the engine, host agrees`);
});

// ---- the job is found by authority, not by position --------------------------------------------------------------

async function ordered(files: Record<string, string>, opts: { scoped: boolean }) {
  const i = n++;
  const targets = captured(join(root.root, `tree-${i}`), files);
  const dir = join(root.root, `job-${i}`); mkdirSync(dir);
  const scoped = snapshotFor('snap-synthetic', 'src-synthetic', targets);
  const built = buildSecretsJob({ ...scoped, sourceId: 'src-synthetic' }, dir);
  const sources = targets.filter((t, k, a) => a.findIndex(x => x.artifact === t.artifact) === k).map(t => ({ id: t.artifact, path: t.path }));
  // The canonical coordinator's order: captured sources first, then its own job record, then the auxiliary worker and job.
  const record = Buffer.from(JSON.stringify({ schema: 'sentinel-production-secrets-job/draft-1', note: 'canonical job record' }));
  const recordPath = join(dir, 'record.json'); writeFileSync(recordPath, record);
  const worker = built.inputs.find((x: any) => x.id === GITLEAKS_PRODUCTION_BUILD.workerDigest)!;
  const job = built.inputs.find((x: any) => x.id === built.jobDigest)!;
  const outcome = await service.run({ adapterId: GITLEAKS_ADAPTER.id, attemptId: `att-secrets-${i}`, work: { id: 'work-secrets', revision: 1 },
    inputs: [...sources, { id: sha(record), path: recordPath }, worker, job],
    ...(opts.scoped ? { assignment: { checks: ['chk-secrets'], scopes: ['src-synthetic'], inputScopes: sources.map(s => ({ input: s.id, scopes: ['src-synthetic'] })) } } : {}) });
  const outputs = new Map(outcome.outputs.map((o: any) => [o.id, o.path]));
  const r = outcome.state === 'succeeded' ? normalizeSecretsRun({ job: built.job, jobDigest: built.jobDigest, outcome, observedAt: new Date().toISOString(),
    outputBytes: (id: string) => readFileSync(outputs.get(id) as string), targetBytes: (id: string) => { const p = sources.find(s => s.id === id)?.path; return p ? readFileSync(p) : undefined; },
    ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}) }) : null;
  return { outcome, r, scoped };
}

test('in the canonical order (sources first) the shim finds its sealed job by exclusion and scans every source', { skip }, async () => {
  const { outcome, r } = await ordered({ 'app.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`, 'notes.txt': 'nothing here\n' }, { scoped: true });
  assert.equal(outcome.state, 'succeeded', outcome.code);
  assert.notEqual(r!.status, 'error', r!.reasonCode);
  assert.equal(r!.scanned.length, 2);
  assert.equal(r!.observations.length, 1);
});

test('a captured file shaped like a job is a source: scanned, never the job; without scopes the ambiguity is refused', { skip }, async () => {
  const fake = 'sentinel-gitleaks-job/1\nF 0 0000000000000000000000000000000000000000000000000000000000000000 ../escape.env\n';
  const files = { 'docs/looks-like-a-job.txt': fake, 'app.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n` };
  const scoped = await ordered(files, { scoped: true });
  assert.equal(scoped.outcome.state, 'succeeded', scoped.outcome.code);
  assert.notEqual(scoped.r!.status, 'error', scoped.r!.reasonCode);
  assert.equal(scoped.r!.scanned.length, 2, 'the job-shaped file is scanned as captured content');
  assert.equal(scoped.r!.observations.length, 1);
  const legacy = await ordered(files, { scoped: false });
  assert.equal(legacy.outcome.state, 'failed');
  assert.equal(legacy.outcome.diagnostics.text, 'sentinel-gitleaks-worker/1 sentinel.secrets.inputInvalid\n', 'two job-shaped inputs and no scopes: refused, not guessed');
  absent(legacy.outcome.diagnostics.text, 'the refusal');
});
