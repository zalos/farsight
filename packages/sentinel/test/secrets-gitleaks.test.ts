// The Gitleaks adapter (PR 11). Three layers:
// 1. Pure: the manifest, the report reader, the whole-line span and the redaction shape.
// 2. The worker through the real execution service, as a built-in child over a stand-in Gitleaks
//    (fixtures/secrets/fake-gitleaks.mjs) that keeps raw values in its report and quotes them on failure.
// 3. The real pinned engine in a real container: runs only with SENTINEL_ISOLATION=1 and SENTINEL_GITLEAKS_IMAGE set
//    (and SENTINEL_GITLEAKS_VERSION); there a missing image or runtime is a failure, never a skip.
//
// The synthetic value is assembled here at run time from inert parts, so no secret-shaped value is committed and the
// repository's own secret scan needs no allowlist for it. No assertion message, diagnostic or report line ever
// includes it: every check is `includes(...) === false` with a message naming only where it looked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import {
  GITLEAKS_CONFIG, GITLEAKS_CONFIG_DIGEST, GITLEAKS_PINS, gitleaksAdapterDefinition, gitleaksWorkerSource, prepareScanInput, readSecretsOutcome,
} from '../dist/adapters/gitleaks.js';
import {
  canonical, gitleaksArgs, lineSpan, observationsFrom, parseManifest, readFindings, OBSERVATION_MESSAGE, MAX_FILE_BYTES,
} from '../dist/adapters/gitleaks-worker.js';
import { removeScratch, runAttempt, scratch, storeIn, work } from './execution-helpers.ts';

// `ghp_` and 36 letters and digits: the GitHub token shape, plainly synthetic.
const VALUE = ['ghp', '_', 'SentinelSynthetic', 'InertFixture', '0000001'].join('');
const FAKE = fileURLToPath(new URL('./fixtures/secrets/fake-gitleaks.mjs', import.meta.url));
const WORKER_MODULE = fileURLToPath(new URL('../dist/adapters/gitleaks-worker.js', import.meta.url));
const sha = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** Fails with a message naming the place only; the value and the haystack are never printed. */
function absent(haystack: string | Buffer | Uint8Array, where: string): void {
  const found = Buffer.isBuffer(haystack) || haystack instanceof Uint8Array ? Buffer.from(haystack).includes(VALUE) : haystack.includes(VALUE);
  assert.equal(found, false, `${where} contains the synthetic value`);
}

const s = scratch('secrets');
after(() => removeScratch(s.root));

/** The captured current tree: one leaking line, one clean file, an inline allow, and a root ignore list for both. */
function capturedTree(root: string, extra: Record<string, string | Buffer> = {}) {
  const files: Record<string, string | Buffer> = {
    'config/service.env': `# synthetic fixture for the secret scanner\nSENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,
    'src/clean.ts': 'export const nothingSecret = 1;\n',
    'notes/allowed.md': `example ${VALUE} gitleaks:allow\n`,
    // Fingerprints for both findings, in every form a path could take: none of them may suppress anything.
    '.gitleaksignore': ['config/service.env:github-pat:2', 'notes/allowed.md:github-pat:1', 'scan/tree/config/service.env:github-pat:2',
      'scan/tree/notes/allowed.md:github-pat:1', 'tree/config/service.env:github-pat:2'].join('\n') + '\n',
    ...extra,
  };
  const dir = join(root, 'captured');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Object.entries(files).map(([relativePath, text]) => {
    const bytes = Buffer.from(text);
    const content = sha(bytes);
    const path = join(dir, content.slice(7));
    writeFileSync(path, bytes);
    return { relativePath, content, path, bytes: bytes.length };
  });
}

// --- 1. pure ---

test('the pinned configuration extends only the version’s own rules and allows nothing', () => {
  assert.equal(GITLEAKS_CONFIG, 'title = "sentinel-gitleaks-pinned"\n\n[extend]\nuseDefault = true\n');
  assert.equal(GITLEAKS_CONFIG_DIGEST, sha(GITLEAKS_CONFIG));
  assert.doesNotMatch(GITLEAKS_CONFIG, /allowlist|paths|regexes|stopwords|disabledRules/);
  const args = gitleaksArgs('scan', '/w/gitleaks.toml', '/w/no-ignores', '/w/report.json');
  const flag = (n: string) => args[args.indexOf(n) + 1];
  assert.equal(args[0], 'dir');
  assert.equal(flag('--config'), '/w/gitleaks.toml');
  assert.equal(flag('--gitleaks-ignore-path'), '/w/no-ignores');
  assert.ok(args.includes('--ignore-gitleaks-allow') && args.includes('--redact=100'));
  assert.ok(!args.some(a => /baseline|enable-rule|no-git/.test(a)), 'no baseline, no rule selection');
});

test('no production pin exists, and the registration pins the shim bytes in its command', () => {
  assert.deepEqual([...GITLEAKS_PINS], []);
  const pin = { version: '8.0.0-test', image: `example/gitleaks@sha256:${'1'.repeat(64)}` };
  const def = gitleaksAdapterDefinition(pin);
  assert.deepEqual(def.command.slice(0, 3), ['node', '--input-type=module', '-e']);
  assert.equal(def.command[3], gitleaksWorkerSource());
  assert.deepEqual(def.command.slice(4), ['--', '--sentinel-gitleaks-worker']);
  const a = createAdapterRegistry([def]).get('gitleaks');
  const b = createAdapterRegistry([{ ...def, command: [...def.command.slice(0, 3), `${def.command[3]}\n// changed`, ...def.command.slice(4)] }]).get('gitleaks');
  assert.notEqual(a.digest, b.digest, 'a changed shim is a different adapter');
});

test('the manifest refuses unsafe paths, extra fields, collisions and inputs it does not name', () => {
  const c = `sha256:${'a'.repeat(64)}`;
  const ok = { schema: 'sentinel-secrets-scan-input/draft-1', snapshotId: 'snap-1', sourceId: 'src-1', files: [{ path: 'a/b.env', content: c, bytes: 3 }] };
  assert.equal(parseManifest(ok, [c]).files.length, 1);
  const refused = (m: unknown, inputs = [c]) => assert.throws(() => parseManifest(m, inputs), (e: any) => e.code === 'sentinel.secrets.inputInvalid');
  for (const path of ['../x', '/etc/x', 'a/../b', 'a//b', 'a/', 'a\\b', 'a\u0000b', 'a\nb', '.']) refused({ ...ok, files: [{ ...ok.files[0], path }] });
  refused({ ...ok, extra: 1 });
  refused({ ...ok, files: [{ ...ok.files[0], quote: 'x' }] });
  refused({ ...ok, files: [ok.files[0], { ...ok.files[0], path: 'A/B.env' }] });
  refused(ok, []);
  refused(ok, [c, `sha256:${'b'.repeat(64)}`]);
});

test('the report reader keeps four fields and refuses text where a rule ID belongs', () => {
  const raw = JSON.stringify([{ RuleID: 'github-pat', File: 'scan/tree/a', StartLine: 2, EndLine: 2, Secret: VALUE, Match: VALUE, Line: VALUE, Description: VALUE }]);
  const kept = readFindings(raw);
  absent(JSON.stringify(kept), 'the kept findings');
  assert.deepEqual(kept, [{ RuleID: 'github-pat', File: 'scan/tree/a', StartLine: 2, EndLine: 2 }]);
  const refused = (text: string, code = 'sentinel.secrets.reportMalformed') => assert.throws(() => readFindings(text), (e: any) => e.code === code);
  refused(JSON.stringify([{ RuleID: `github-pat ${VALUE}`, File: 'a', StartLine: 1, EndLine: 1 }]));
  refused(JSON.stringify([{ RuleID: 'r', File: 'a', StartLine: 0, EndLine: 1 }]));
  refused(JSON.stringify([{ RuleID: 'r', File: 'a', StartLine: 3, EndLine: 2 }]));
  refused('{"not":"an array"}');
  refused(`[{"RuleID":"r","Secret":"${VALUE}"`);
  refused(JSON.stringify(Array.from({ length: 10_001 }, () => ({ RuleID: 'r', File: 'a', StartLine: 1, EndLine: 1 }))), 'sentinel.secrets.tooManyFindings');
});

test('a location is whole lines, never a part of one', () => {
  const b = Buffer.from('one\r\ntwo three\nfour');
  assert.deepEqual(lineSpan(b, 1, 1), { startByte: 0, endByte: 3 });
  assert.deepEqual(lineSpan(b, 2, 2), { startByte: 5, endByte: 14 });
  assert.deepEqual(lineSpan(b, 3, 3), { startByte: 15, endByte: 19 });
  assert.deepEqual(lineSpan(b, 1, 3), { startByte: 0, endByte: 19 });
  assert.throws(() => lineSpan(b, 4, 4), (e: any) => e.code === 'sentinel.secrets.locationOutOfRange');
});

test('an observation is built from the closed field list only', () => {
  const bytes = Buffer.from(`a\nkey=${VALUE}\n`);
  const content = sha(bytes);
  const manifest = parseManifest({ schema: 'sentinel-secrets-scan-input/draft-1', snapshotId: 'snap-1', sourceId: 'src-1', files: [{ path: 'k.env', content, bytes: bytes.length }] }, [content]);
  const producer = { adapterId: 'gitleaks', adapterDigest: `sha256:${'c'.repeat(64)}`, attemptId: 'attempt-1' };
  const findings = [{ RuleID: 'github-pat', File: 'scan/tree/k.env', StartLine: 2, EndLine: 2 }];
  const [o] = observationsFrom([...findings, ...findings], manifest, ['scan/tree/'], () => bytes, producer, '2026-10-22T00:00:00Z') as any[];
  absent(canonical(o), 'the observation');
  assert.equal(o.message, OBSERVATION_MESSAGE);
  assert.deepEqual(o.evidence[0].span, { startByte: 2, endByte: 2 + `key=${VALUE}`.length });
  assert.equal(observationsFrom([...findings, ...findings], manifest, ['scan/tree/'], () => bytes, producer, '2026-10-22T00:00:00Z').length, 1, 'duplicates fold');
  assert.throws(() => observationsFrom([{ ...findings[0]!, File: 'k.env' }], manifest, ['scan/tree/'], () => bytes, producer, 'x'), (e: any) => e.code === 'sentinel.secrets.unknownFile');
});

// --- 2. the worker through the execution service, over the stand-in tool ---

function fakeRegistry(behaviours: string[]) {
  const dir = join(s.root, 'fake');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return createAdapterRegistry(behaviours.map(b => {
    const bin = join(dir, `gitleaks-${b}`);
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${b}' "$@"\n`);
    chmodSync(bin, 0o755);
    const module = join(dir, `worker-${b}.mjs`);
    writeFileSync(module, `globalThis.SENTINEL_GITLEAKS_RUN = true; globalThis.SENTINEL_GITLEAKS_BIN = ${JSON.stringify(bin)};\nawait import(${JSON.stringify(new URL(`file://${WORKER_MODULE}`).href)});\n`);
    return { id: `gitleaks-${b}`, version: '0.0.0-test', kind: 'built-in' as const, isolation: 'child' as const, module,
      limits: { timeoutMs: 30_000, helloTimeoutMs: 10_000, cancelGraceMs: 2_000 } };
  }));
}

let store: Awaited<ReturnType<typeof storeIn>> | undefined;
after(() => { try { store?.close(); } catch { /* closed */ } });
let attempt = 0;
const BEHAVIOURS = ['normal', 'crash', 'malformed', 'no-report', 'lie-clean', 'unknown-file', 'bad-line', 'rule-text', 'flood'];
let registry: ReturnType<typeof fakeRegistry> | undefined;

async function scanWith(behaviour: string, extra: Record<string, string | Buffer> = {}) {
  store ??= await storeIn(s.root);
  registry ??= fakeRegistry(BEHAVIOURS);
  const n = ++attempt;
  const files = capturedTree(join(s.root, `tree-${n}`), extra);
  const input = prepareScanInput(join(s.root, `manifest-${n}`), { snapshotId: 'snap-synthetic', sourceId: 'src-synthetic', files });
  const outcome = await runAttempt(store, s.work, registry, { adapterId: `gitleaks-${behaviour}`, attemptId: `attempt-s${n}`, work, inputs: input.inputs });
  const result = readSecretsOutcome(outcome, input);
  // Nothing that leaves the attempt may carry the value: the outcome (stdout frames, stderr diagnostics, result),
  // every output artifact, and the scan result the report would be built from.
  absent(JSON.stringify(outcome), `${behaviour}: the worker outcome`);
  absent(JSON.stringify(result), `${behaviour}: the scan result`);
  for (const name of readdirSync(join(outcome.workDir, 'output'))) absent(readFileSync(join(outcome.workDir, 'output', name)), `${behaviour}: an output artifact`);
  return { outcome, result, input };
}

test('a leaking line is one redacted observation; ignore lists and inline allows suppress nothing', async () => {
  const { outcome, result } = await scanWith('normal');
  assert.equal(outcome.state, 'succeeded', outcome.code);
  assert.equal(result.status, 'complete');
  const found = result.observations.map(o => `${o.producerRuleId} ${o.evidence[0]!.relativePath}:${o.evidence[0]!.span.startByte}`).sort();
  assert.deepEqual(found, ['github-pat config/service.env:43', 'github-pat notes/allowed.md:0']);
  assert.deepEqual([...result.scanned].sort(), ['.gitleaksignore', 'config/service.env', 'notes/allowed.md', 'src/clean.ts'].map(p => `src-synthetic:${p}`));
  assert.equal(result.audit.configDigest, GITLEAKS_CONFIG_DIGEST);
  assert.equal(result.audit.adapterDigest, outcome.adapter.digest);
});

test('a clean tree is complete with no observations', async () => {
  const { result } = await scanWith('normal', { 'config/service.env': 'NOTHING=here\n', 'notes/allowed.md': 'plain\n' });
  assert.equal(result.status, 'complete');
  assert.equal(result.observations.length, 0);
});

test('a file above the size limit is a skipped scope and the scan is partial', async () => {
  const { result } = await scanWith('normal', { 'big.bin': Buffer.alloc(MAX_FILE_BYTES + 1, 0x61) });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.skipped, [{ scopeId: 'src-synthetic:big.bin', reasonCode: 'sentinel.secrets.fileTooLarge' }]);
  assert.equal(result.observations.length, 2, 'the findings elsewhere remain');
});

for (const [behaviour, code] of [
  ['crash', 'sentinel.secrets.toolFailed'], ['flood', 'sentinel.secrets.toolFailed'], ['malformed', 'sentinel.secrets.reportMalformed'],
  ['no-report', 'sentinel.secrets.reportMissing'], ['lie-clean', 'sentinel.secrets.reportInconsistent'], ['unknown-file', 'sentinel.secrets.unknownFile'],
  ['bad-line', 'sentinel.secrets.locationOutOfRange'], ['rule-text', 'sentinel.secrets.reportMalformed'],
] as const) {
  test(`a tool that misbehaves (${behaviour}) is an error over every file, never zero findings, and its words are dropped`, async () => {
    const { outcome, result } = await scanWith(behaviour);
    assert.equal(outcome.state, 'failed');
    assert.equal(result.status, 'error');
    assert.equal(result.reasonCode, code);
    assert.equal(result.observations.length, 0);
    assert.equal(result.scanned.length, 0);
    assert.equal(result.skipped.length, 4);
    assert.ok(result.skipped.every(x => x.reasonCode === code));
  });
}

test('the reader refuses an observation that carries anything beyond the redaction shape', async () => {
  const { outcome, input } = await scanWith('normal');
  const out = outcome.outputs[0]!;
  const original = readFileSync(out.path);
  const tampered = JSON.parse(original.toString('utf8'));
  tampered.evidence[0].quoteDigest = sha('x');
  const bytes = Buffer.from(canonical(tampered));
  chmodSync(out.path, 0o600);
  writeFileSync(out.path, bytes);
  const result = readSecretsOutcome(outcome, input);
  assert.equal(result.status, 'error');
  assert.equal(result.reasonCode, 'sentinel.secrets.outputRefused');
  writeFileSync(out.path, original);
  // A result that forgets a captured file is a gap, not a clean scan.
  const forgetful = { ...outcome, result: { ...outcome.result!, scannedSet: outcome.result!.scannedSet.slice(1) } };
  assert.equal(readSecretsOutcome(forgetful, input).reasonCode, 'sentinel.secrets.coverageMismatch');
});

// --- 3. the real pinned engine, in a real container ---

const IMAGE = process.env.SENTINEL_GITLEAKS_IMAGE;
const VERSION = process.env.SENTINEL_GITLEAKS_VERSION;
const real = process.env.SENTINEL_ISOLATION === '1' && !!IMAGE;
const skipReal = !real && 'real engine: set SENTINEL_ISOLATION=1, SENTINEL_GITLEAKS_IMAGE (repo@sha256:…) and SENTINEL_GITLEAKS_VERSION with the image installed';

test('the pinned engine finds the leaking lines, keeps them through ignore lists and allows, and leaks no value', { skip: skipReal }, async () => {
  assert.ok(VERSION, 'SENTINEL_GITLEAKS_VERSION names the release inside the image');
  store ??= await storeIn(s.root);
  const pin = { version: VERSION!, image: IMAGE! };
  const reg = createAdapterRegistry([gitleaksAdapterDefinition(pin)]);
  const runReal = async (extra: Record<string, string> = {}) => {
    const n = ++attempt;
    const files = capturedTree(join(s.root, `real-${n}`), extra);
    const input = prepareScanInput(join(s.root, `real-manifest-${n}`), { snapshotId: 'snap-synthetic', sourceId: 'src-synthetic', files });
    const outcome = await runAttempt(store!, s.work, reg, { adapterId: 'gitleaks', attemptId: `attempt-r${n}`, work, inputs: input.inputs }, true);
    const result = readSecretsOutcome(outcome, input, pin);
    absent(JSON.stringify(outcome), 'real engine: the worker outcome');
    absent(JSON.stringify(result), 'real engine: the scan result');
    return { outcome, result };
  };
  const positive = await runReal();
  assert.equal(positive.result.status, 'complete', positive.result.reasonCode);
  assert.deepEqual(positive.result.observations.map(o => o.evidence[0]!.relativePath).sort(), ['config/service.env', 'notes/allowed.md']);
  assert.equal(positive.result.audit.imageId, positive.outcome.container?.image.id);
  const negative = await runReal({ 'config/service.env': 'NOTHING=here\n', 'notes/allowed.md': 'plain\n' });
  assert.equal(negative.result.status, 'complete');
  assert.equal(negative.result.observations.length, 0);
});
