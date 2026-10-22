// The framework inspection worker as the built-in child the supervisor runs (ADR 44): real capture → parse of original
// synthetic trees, the job and every input sealed by id, the module pinned by digest and run through the launch gate,
// with a hard deadline. Nothing from the target is installed, built, imported or run; the libraries read bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { canonicalJson } from '../dist/store/ledger-json.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { readPackDirectory, validatePack } from '../dist/rules/index.js';
import { surfacesFromIndex } from '../dist/planner/index.js';
import { CONTROLS_JOB_SCHEMA, CONTROLS_OUTPUT_SCHEMA, FRAMEWORK_CONTROLS_ADAPTER_ID, inspect, inspectSealed } from '../dist/frameworks/controls/index.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { ORDER } from './express-fixtures.ts';

const HERE = import.meta.dirname;
const MODULE = fileURLToPath(new URL('../dist/frameworks/controls/worker.js', import.meta.url));
const E2 = join(HERE, 'fixtures/framework-feasibility/sources/nest-validation');
const LIMITS = { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 };
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const work = { id: 'work-controls', revision: 1 };

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.includes('.fixture')) out[f.replace('.fixture', '')] = readFileSync(join(dir, f), 'utf8');
  return out;
}

/** Capture and parse a synthetic tree, then seal the job, the snapshot, the retained evidence and every captured file. */
async function sealed(t: any, files: Record<string, string>, jobs = 1) {
  const dir = scratch(t, 'sentinel-controls-');
  const root = join(dir, 'repo');
  commitRepo(root, files);
  const { store } = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const parseDir = join(dir, 'parse');
  mkdirSync(parseDir, { mode: 0o700 });
  const parsed = (await parseSnapshot(store, { snapshotId: snapshot.id, workDir: parseDir, selection: { gitignore: true, testFiles: 'include' }, limits: LIMITS })).sources[0]!;
  const sealedDir = join(dir, 'sealed');
  mkdirSync(sealedDir, { mode: 0o700 });
  const ids: { id: string; path: string }[] = [];
  const put = (bytes: Uint8Array | string) => {
    const h = sha(bytes);
    const path = join(sealedDir, h);
    writeFileSync(path, bytes);
    if (!ids.some(i => i.id === `sha256:${h}`)) ids.push({ id: `sha256:${h}`, path });
    return `sha256:${h}`;
  };
  const files_: string[] = [];
  const walk = (v: any) => { if (v && typeof v === 'object') { if (v.disposition === 'included' && typeof v.content === 'string') files_.push(v.content); for (const x of Object.values(v)) walk(x); } };
  walk(snapshot);
  for (const id of new Set(files_)) put(await store.readArtifact(id));
  const job = (n: number) => ({
    schema: CONTROLS_JOB_SCHEMA, snapshotId: snapshot.id, sourceId: 'app', snapshot: put(canonicalJson(snapshot)),
    analysis: { artifact: put(canonicalJson(parsed.artifact)), result: put(canonicalJson(parsed.result)), index: put(canonicalJson(parsed.index)) },
    properties: ['authentication', 'authorization', 'input-validation'], environment: { activeProfiles: null }, ...(n ? { copy: n } : {}),
  });
  for (let n = 0; n < jobs; n++) put(canonicalJson(job(n)));
  return { store, dir, inputs: ids, job: job(0), surfaces: surfacesFromIndex(parsed.index as any).map(s => s.nodeId), read: (id: string) => readFileSync(ids.find(i => i.id === id)!.path) };
}

async function child(fx: Awaited<ReturnType<typeof sealed>>, limits: Record<string, number> = {}, n = 'a', signal?: AbortSignal) {
  const registry = createAdapterRegistry([{ id: FRAMEWORK_CONTROLS_ADAPTER_ID, version: '0.1.0', kind: 'built-in' as const, isolation: 'child' as const, module: MODULE,
    limits: { timeoutMs: 60_000, cancelGraceMs: 1_000, helloTimeoutMs: 10_000, ...limits } }]);
  const scratchRoot = join(fx.dir, `exec-${n}`);
  mkdirSync(scratchRoot, { mode: 0o700 });
  const service = await createExecutionService(fx.store, { scratchRoot, registry, containers: false });
  return service.run({ adapterId: FRAMEWORK_CONTROLS_ADAPTER_ID, attemptId: `attempt-${n}`, work, inputs: fx.inputs, ...(signal ? { signal } : {}) } as any);
}

// The plan's repository-scoped checks for source `app`: one per family.
const checks = ['authentication', 'authorization', 'input-validation'].map(p => ({ id: `app|${p}`, familyId: `sentinel.controls.${p}`, scopeId: 'app' }));

test('the child inspects an Express tree: established where the order is read, partial where a refusal proves nothing', needsStore, async t => {
  const fx = await sealed(t, ORDER);
  const o = await child(fx);
  assert.equal(o.state, 'succeeded', JSON.stringify({ code: o.code, detail: o.detail }));
  assert.equal(o.worker?.kind, 'owned-child');
  assert.deepEqual(o.result.coveredChecks, [], 'the worker claims no coverage of its own');
  assert.equal(o.outputs.length, 1);
  const out = JSON.parse(readFileSync(o.outputs[0].path, 'utf8'));
  assert.equal(out.schema, CONTROLS_OUTPUT_SCHEMA);
  assert.deepEqual(out.libraries.map((l: any) => [l.framework, l.refused ?? 'ran']), [['next', 'ran'], ['express', 'ran'], ['nest', 'ran'], ['spring', 'ran']],
    'a library meets a repository without its framework and does not refuse');
  const { coverage, rows, checks: states } = inspect(checks, out.libraries, fx.surfaces, `sha256:${'f'.repeat(64)}`);
  const row = (s: string, p: string) => rows.find((r: any) => r.surfaceId === `app::route::${s}` && r.property === p);
  assert.deepEqual([row('GET /reports', 'authentication').state, row('GET /reports', 'authentication').verdict], ['established', 'does-not-apply']);
  assert.deepEqual([row('GET /account', 'authentication').state, row('GET /account', 'authentication').reasonCode], ['partial', 'sentinel.express.refusalUnproven']);
  assert.equal(row('GET /reports', 'input-validation').state, 'not-run', 'Express models no input validation');
  assert.equal(row('GET /reports', 'input-validation').reasonCode, 'sentinel.controls.propertyNotModeled');
  // Repository checks: every surface in the extent counts, so a refusal that proves nothing leaves the family partial.
  assert.deepEqual(fx.surfaces.sort(), ['app::route::GET /account', 'app::route::GET /reports', 'app::route::POST /account']);
  assert.deepEqual(states.map((c: any) => [c.familyId.split('.').pop(), c.state]), [['authentication', 'partial'], ['authorization', 'partial'], ['input-validation', 'partial']]);
  assert.ok(states.find((c: any) => c.familyId.endsWith('input-validation')).reasons.includes('sentinel.controls.propertyNotModeled'));
  assert.equal(coverage.granularity, 'aggregate');
  // The child's answer is the same as the libraries' over the same sealed bytes in this process.
  assert.deepEqual(JSON.parse(JSON.stringify(await inspectSealed(fx.job as any, fx.read))), out.libraries);
});

test('the child inspects the Nest E2 tree: a ValidationPipe establishes input validation, its absence establishes none', needsStore, async t => {
  const fx = await sealed(t, tree(E2));
  const o = await child(fx);
  assert.equal(o.state, 'succeeded', JSON.stringify({ code: o.code, detail: o.detail }));
  const out = JSON.parse(readFileSync(o.outputs[0].path, 'utf8'));
  const { rows, coverage, checks: states } = inspect(checks, out.libraries, fx.surfaces, `sha256:${'f'.repeat(64)}`);
  const row = (s: string, p: string) => rows.find((r: any) => r.surfaceId === `app::route::${s}` && r.property === p);
  assert.deepEqual([row('POST /users/validated', 'input-validation').state, row('POST /users/validated', 'input-validation').verdict], ['established', 'applies']);
  assert.deepEqual([row('POST /users/unvalidated', 'input-validation').state, row('POST /users/unvalidated', 'input-validation').verdict], ['established', 'does-not-apply']);
  assert.ok(coverage.unresolvedFrontiers.some((f: any) => f.reasonCode === 'sentinel.nest.adapterRouteNotModeled'), 'the bypassing adapter route stays a named gap');
  // Every surface's input validation is established, but the adapter route Nest names is not inspected: partial, said why.
  assert.deepEqual(states.find((c: any) => c.familyId.endsWith('input-validation')), { checkId: 'app|input-validation', familyId: 'sentinel.controls.input-validation', state: 'partial', reasons: ['sentinel.nest.adapterRouteNotModeled'] });
});

/** ORDER plus many mounted routers: enough source that reading it takes far longer than the deadline below. */
function wide(routers: number, routes: number): Record<string, string> {
  const files: Record<string, string> = { ...ORDER };
  const mounts: string[] = [];
  for (let r = 0; r < routers; r++) {
    files[`src/routers/r${r}.ts`] = `import express from 'express';\nconst router = express.Router();\n${
      Array.from({ length: routes }, (_, i) => `router.get('/item${i}', (req, res) => { res.json({ n: ${i} }); });`).join('\n')}\nexport default router;\n`;
    mounts.push(`import r${r} from './routers/r${r}.js';\napp.use('/r${r}', r${r});`);
  }
  files['src/app.ts'] = files['src/app.ts']!.replace('export default app;', `${mounts.join('\n')}\nexport default app;`);
  return files;
}

test('the child is killed at its deadline and publishes nothing', needsStore, async t => {
  const fx = await sealed(t, wide(150, 40));
  const t0 = Date.now();
  const full = await child(fx, {}, 'full');
  assert.equal(full.state, 'succeeded', 'unbounded, the same job completes');
  assert.ok(Date.now() - t0 > 600, `the job takes long enough to cut short (${Date.now() - t0} ms)`);
  const o = await child(fx, { timeoutMs: 300, helloTimeoutMs: 300, cancelGraceMs: 0 }, 'deadline');
  assert.notEqual(o.state, 'succeeded');
  assert.ok(['sentinel.execution.deadlineExceeded', 'sentinel.execution.protocolViolation'].includes(o.code), JSON.stringify({ state: o.state, code: o.code, detail: o.detail }));
  assert.equal(o.result, undefined);
  assert.deepEqual(o.outputs, []);
  assert.ok(o.exit, 'the worker process was reaped');
});

test('a cancel stops the child within its grace, killing it if it does not answer; nothing is published', needsStore, async t => {
  const fx = await sealed(t, wide(150, 40));
  const c = new AbortController();
  const pending = child(fx, { cancelGraceMs: 200 }, 'cancel', c.signal);
  setTimeout(() => c.abort(), 400);
  const t0 = Date.now();
  const o = await pending;
  assert.equal(o.state, 'canceled', JSON.stringify({ state: o.state, code: o.code }));
  assert.equal(o.result, undefined);
  assert.deepEqual(o.outputs, []);
  assert.ok(o.exit, 'the worker process was reaped');
  assert.equal(o.detail?.forced, true, 'the worker does not answer a cancel mid-analysis: it is killed after the grace');
  assert.ok(Date.now() - t0 < 1_400, 'stopped well before the job would have finished');
});

test('two job-shaped inputs are refused with a fixed code; nothing is published', needsStore, async t => {
  const fx = await sealed(t, ORDER, 2);
  const o = await child(fx, {}, 'twojobs');
  assert.notEqual(o.state, 'succeeded');
  assert.equal(o.result, undefined);
  assert.deepEqual(o.outputs, []);
  // The worker sends hello and its one fixed diagnostic (sentinel.controls.jobInvalid), then exits with its refusal status.
  assert.equal(o.code, 'sentinel.execution.workerExited');
  assert.equal(o.detail?.exitCode, 3);
  assert.equal(o.protocol.frames, 2);
});

test('the shipped pack validates: three inspection families, candidate meaning, no framework gate, no finding evidence', () => {
  const pack: any = validatePack(readPackDirectory(fileURLToPath(new URL('../rules/framework-controls', import.meta.url))));
  const rules = pack.manifest?.rules ?? pack.rules;
  assert.deepEqual(rules.map((r: any) => r.familyId), ['sentinel.controls.authentication', 'sentinel.controls.authorization', 'sentinel.controls.input-validation']);
  for (const r of rules) {
    assert.equal(r.meaning, 'candidate');
    assert.equal(r.applicability.scopeKind, 'repository', 'the check\'s sealed inputs are the whole source the libraries read');
    assert.equal(r.applicability.frameworks, undefined, 'version authority stays with the libraries at execution');
    assert.deepEqual(r.requires, ['framework-order']);
    assert.deepEqual(r.evidenceRequired, ['control-fact']);
    assert.equal(r.implementation.adapterId, FRAMEWORK_CONTROLS_ADAPTER_ID);
  }
});
