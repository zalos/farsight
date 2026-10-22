// PR 06 end to end with the real modules: capture a synthetic repository into a real store, parse it with the
// public parser, validate rule packs, promote them into the rule lock with owner receipts, derive the effective
// policy, plan, decide admission for the plan, and convert it into canonical work envelopes. Then a pack update
// adds a rule: a new revision plans it over the published bootstrap with no recapture, and the earlier revision
// and lock are unchanged. Synthetic fixtures only; nothing is scanned and no network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { emptyLock, lockDigest, promote, promotionIntent, validatePack, verifyPinnedLock } from '../dist/rules/index.js';
import { DEFAULT_SETTINGS, ReceiptBook, admit, effectivePolicy } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { validateEnvelope } from '../dist/validate.js';
import {
  SURFACE_NODE_KINDS, planBoundaryFor, evaluateRequiredCoverage, verifyWorkEnvelope, adapterOf, capturedInputsOf, checksCoveredBy, plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom,
  plannerSnapshotFrom, planAnalysis, planBootstrap, verifyPlanRevision, workEnvelopesFor,
} from '../dist/planner/index.js';
import { commitRepo, needsStore, openCaptureStore, scratch, unlock } from './snapshot-helpers.ts';
import { trustedProfile } from './planner-helpers.ts';

const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const NOW = new Date('2026-10-22T12:00:00.000Z');

const REPO: Record<string, string> = {
  'src/util.ts': 'export function run(code: string) {\n  return eval(code);\n}\n',
  'src/bad.ts': 'export function (\n',
  'app/api/items/route.ts': 'export async function GET() {\n  return new Response("[]");\n}\n',
  'src/main/java/App.java': 'package app;\npublic class App {\n  public int run() { return 1; }\n}\n',
  'package.json': '{ "name": "fixture", "version": "1.0.0" }\n',
  '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
};

const rule = (familyId: string, over: Record<string, unknown> = {}) => ({
  familyId, revision: 1, titleKey: 'sentinel.rule.fixture',
  applicability: { languages: ['typescript', 'javascript'], scopeKind: 'source-file' },
  requires: ['source-bytes', 'pattern-match'], implementation: { adapterId: 'sentinel-pattern', rulePath: `detectors/${familyId}.yml` },
  meaning: 'candidate', severity: 'high', evidenceRequired: ['source-span'], limitationKeys: [], mappings: { cwe: ['CWE-95'] },
  fixtures: { positive: [`fixtures/${familyId}-bad.ts`], negative: [`fixtures/${familyId}-good.ts`] }, ...over,
});

const EVAL = rule('sentinel.ts.eval');
const ROUTE = rule('sentinel.http.route-guard', { applicability: { languages: ['typescript'], scopeKind: 'surface' }, requires: ['framework-order'] });
const CALL = rule('sentinel.ts.dangerous-call', { requires: ['call-occurrence'] });

/** A validated pack holding `rules`, built as bytes the way readPackDirectory would return them. */
function pack(rules: ReturnType<typeof rule>[]) {
  const files = new Map<string, Uint8Array>();
  files.set('sentinel-pack.json', Buffer.from(JSON.stringify({ schema: 'sentinel-rulepack/draft-1', packId: 'fixture-pack', version: `0.${rules.length}.0`,
    rights: { spdx: 'MIT', origin: 'sentinel-original' }, rules })));
  for (const r of rules) {
    files.set(r.implementation.rulePath, Buffer.from(`rule: ${r.familyId}\n`));
    for (const f of [...r.fixtures.positive, ...r.fixtures.negative]) files.set(f, Buffer.from(`// ${f}\n`));
  }
  return validatePack(files);
}

const profile = trustedProfile({ permitExtra: ['framework-order'] });
const LIMITS = { deadlineMs: 60_000, memoryBytes: 512 * 1024 * 1024, cpuQuota: 1, maxPids: 32, maxOutputBytes: 1024 * 1024 };
const execution = { resources: { capture: LIMITS, parse: LIMITS, inventory: LIMITS, check: LIMITS } };

test('captured, parsed, locked and adopted inputs plan, admit and convert end to end; a new rule needs no recapture', needsStore, async t => {
  // 1. Capture and parse (the checkout is gone before parsing).
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, REPO);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  unlock(root);
  rmSync(root, { recursive: true, force: true });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const parsed = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: { gitignore: true, testFiles: 'include' },
    limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1 << 20, maxEntries: 10_000, maxDurationMs: 60_000 } });
  const analyses = parsed.sources.map(s => plannerAnalysisFrom(s));
  const surfaces = analyses[0]!.surfaces;
  assert.ok(surfaces.length > 0 && surfaces.every(s => SURFACE_NODE_KINDS.includes(s.kind as never)), JSON.stringify(surfaces));
  assert.ok(surfaces.some(s => s.kind === 'route' && s.path === 'app/api/items/route.ts'), 'the Next route handler is an HTTP surface');

  // 2. Promote a pack into the lock with the owner's receipt.
  const book = new ReceiptBook(join(scratch(t, 'sentinel-trust-'), 'receipts'));
  const confirmPromotion = (lock: any, candidate: any) => {
    const intent = promotionIntent(lock, candidate);
    const pin = lockDigest(lock);
    const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent, stateDigest: pin, policyRevision: D('promotion') }, { now: NOW, ttlMs: 600_000 });
    return promote(lock, candidate, book.consume(r.id, { intent, stateDigest: pin, policyRevision: D('promotion') }, NOW), NOW);
  };
  const v1 = pack([EVAL, ROUTE]);
  const lock2 = confirmPromotion(emptyLock(NOW), { kind: 'pack', pack: v1 });

  // 3. The adopted settings make all three rules mandatory; the third is not in the lock yet.
  const settings = { ...structuredClone(DEFAULT_SETTINGS), mandatoryRules: [EVAL.familyId, ROUTE.familyId, CALL.familyId],
    grants: [{ actions: ['run.start'], principals: ['human', 'agent'], confirm: 'agent' as const }] };
  const policy = effectivePolicy({ trust: 'adopted', settings, settingsDigest: D('settings'), repoConfig: null, repoConfigDigest: null });

  // 4. Plan: bootstrap, then analysis over the real snapshot and parser evidence.
  const boot = planBootstrap({ runId: 'run-1', sourceIds: ['app'], profile });
  const inventory = boot.units.at(-1)!;
  const bootstrapRefs = [{ id: inventory.id, revision: inventory.revision }];
  const first = planAnalysis({ runId: 'run-1', revision: 2, previous: boot, bootstrap: bootstrapRefs, profile,
    snapshot: plannerSnapshotFrom(snapshot), analyses, lock: plannerLockFrom(lock2, [v1], lockDigest(lock2)), policy: plannerPolicyFrom(policy) });
  assert.ok(validateEnvelope('plan', first).ok && verifyPlanRevision(first));
  const byScope = (familyId: string) => Object.fromEntries(first.checks.filter(c => c.familyId === familyId).map(c => [c.scopeId, c.state]));
  assert.equal(byScope(EVAL.familyId)['app:src/util.ts'], 'planned');
  assert.equal(byScope(EVAL.familyId)['app:src/bad.ts'], 'planned', 'a pattern over bytes needs no parse');
  const route = first.checks.filter(c => c.familyId === ROUTE.familyId);
  assert.ok(route.every(c => c.required));
  assert.deepEqual(route.filter(c => c.state === 'unsupported').map(c => c.scopeId).sort(), surfaces.filter(s => s.path.endsWith('.ts')).map(s => s.nodeId).sort(),
    'each discovered route is a check, unsupported without framework order');
  assert.deepEqual(route.filter(c => c.state !== 'unsupported').map(c => [c.scopeId, c.state, c.reasonCode]),
    [['app:src/bad.ts', 'scope-unknown', 'sentinel.plan.surfacesUndiscovered']], 'a file that did not parse may hold routes nobody found');
  assert.deepEqual(first.ruleGaps, [{ familyId: CALL.familyId, required: true, reasonCode: 'sentinel.plan.ruleNotLocked' }]);
  assert.equal(first.requiredCoverageAchievable, false);
  assert.equal(first.pins.ruleLockDigest, lockDigest(lock2));
  assert.equal(first.pins.policyDigest, policy.revision);

  // 5. Admission of the plan: an agent's start waits for a person; the person's own request is admitted.
  const intent = { action: 'run.start' as const, input: first.digest, effects: ['local-artifacts' as const],
    budget: { maxTokens: null, maxCost: null, currency: null }, scope: { profile: profile.id, provider: null, targets: [first.digest] } };
  const decide = (principal: 'agent' | 'human', channel: 'mcp' | 'owner-cli') => admit({ intent, requestedBy: { principal, channel }, policy,
    stateDigest: first.digest, now: NOW, capability: () => ({ available: true, detail: 'built-in adapters only' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no remote credential is needed' }) });
  assert.equal(decide('agent', 'mcp').record.outcome, 'awaiting-confirmation');
  assert.equal(decide('human', 'owner-cli').record.outcome, 'admitted');

  // 6. Canonical work envelopes for the coordinator, covering exactly the planned checks.
  const converted = workEnvelopesFor(first, { coordinatorEpoch: 'epoch-test', createdAt: '2026-10-22T12:00:00Z', execution });
  assert.equal(converted.length, first.units.length);
  for (const { envelope, manifest } of converted) {
    assert.ok(validateEnvelope('work', envelope).ok);
    assert.equal(envelope.state, 'pending', 'every check waits for the published inventory');
    assert.deepEqual(manifest.checks, checksCoveredBy(first, envelope));
    assert.equal(adapterOf(first, envelope), 'sentinel-pattern');
    for (const input of capturedInputsOf(first, envelope, snapshot)) {
      assert.ok(snapshot.entries.some((e: any) => e.disposition === 'included' && e.content === input.id && e.relativePath === input.relativePath));
    }
  }
  const covered = converted.flatMap(c => c.manifest.checks).sort();
  assert.deepEqual(covered, first.checks.filter(c => c.state === 'planned').map(c => c.id).sort(), 'no invented coverage');

  // The coordinator's PlanBoundary: a run that names this plan's pins; anything else is refused.
  const base = JSON.parse(readFileSync(new URL('./contracts/valid/run-active.json', import.meta.url), 'utf8'));
  const run = { ...base, id: 'run-1', planRevision: first.revision, snapshotId: snapshot.id, coordinatorEpoch: 'epoch-test',
    ruleLockDigest: first.pins.ruleLockDigest, policyRevisionDigest: first.pins.policyDigest, toolLockDigest: first.pins.ruleLockDigest,
    requestedScope: { sourceIds: ['app'], profile: profile.id } };
  const request = { run, conversion: { coordinatorEpoch: 'epoch-test', createdAt: '2026-10-22T12:00:00Z', execution }, snapshot,
    pathOf: (i: { relativePath: string }) => join(work, 'materialized', i.relativePath) };
  const boundary = planBoundaryFor(first, request);
  assert.deepEqual(boundary.works.map(w => w.id), first.units.map(u => u.id));
  for (const w of boundary.works) {
    assert.equal(boundary.adapterFor(w), 'sentinel-pattern');
    assert.ok(boundary.inputsFor(w).every(i => i.path.startsWith(join(work, 'materialized')) && /^sha256:/.test(i.id)));
  }
  assert.throws(() => planBoundaryFor(first, { ...request, run: { ...run, policyRevisionDigest: D('other policy') } }), /policy revision/);
  assert.throws(() => planBoundaryFor(first, { ...request, run: { ...run, planRevision: 9 } }), /plan revision/);
  assert.throws(() => planBoundaryFor(boot, request), /only an analysis revision/);
  assert.throws(() => planBoundaryFor(first, { ...request, run: { ...run, requestedScope: { sourceIds: ['other-source'], profile: profile.id } } }), /requested sources/);
  assert.throws(() => planBoundaryFor(first, { ...request, run: { ...run, requestedScope: { sourceIds: ['app'], profile: 'other-profile' } } }), /requested profile/);
  // A plan restored from JSON is the caller's mutable object: the boundary keeps its own frozen copy.
  const restored = JSON.parse(JSON.stringify(first));
  const fromRestored = planBoundaryFor(restored, request);
  restored.units[0].inputFingerprint = D('changed after hand-off');
  assert.notEqual(fromRestored.plan, restored);
  assert.ok(Object.isFrozen(fromRestored.plan.units[0]));
  assert.equal(fromRestored.plan.units[0]!.inputFingerprint, fromRestored.works[0]!.inputFingerprint, 'the plan and its works stay one binding');
  assert.throws(() => boundary.adapterFor({ ...boundary.works[0]!, id: 'work-other' }), /not part of this boundary/);

  // The boundary carries the plan: required coverage is computed from coverage records the stages produce.
  assert.deepEqual(boundary.plan, first);
  assert.equal(boundary.plan.digest, first.digest, 'the boundary carries its own copy of exactly this plan');
  let n = 0;
  const records = boundary.works.flatMap(w => {
    verifyWorkEnvelope(first, w);
    return boundary.checksFor(w).map(checkId => ({ schema: 'sentinel-coverage/draft-1' as const, id: `cov-${++n}`, runId: run.id, checkId, workId: w.id,
      workRevision: w.revision, status: 'complete' as const, granularity: 'per-file-per-rule' as const, assessedScopeArtifact: D('scope'),
      limitationsArtifact: D('limitations'), basis: { kind: 'executed' as const, attemptId: `att-${n}` }, skipped: [], recordedAt: '2026-10-22T12:00:00Z' }));
  });
  assert.equal(evaluateRequiredCoverage(first, []).requiredComplete, 0, 'work alone completes nothing');
  const coverage = evaluateRequiredCoverage(first, records);
  assert.equal(coverage.requiredComplete, first.checks.filter(c => c.state === 'planned' && c.required).length);
  assert.equal(coverage.complete, false, 'the unsupported route checks and the missing rule keep it incomplete');

  // 7. A pack update adds the third rule: a new revision over the same snapshot and published bootstrap.
  const firstJson = JSON.stringify(first);
  const v2 = pack([EVAL, ROUTE, CALL]);
  const lock3 = confirmPromotion(lock2, { kind: 'pack', pack: v2 });
  const second = planAnalysis({ runId: 'run-1', revision: 3, previous: first, bootstrap: bootstrapRefs, profile,
    snapshot: plannerSnapshotFrom(snapshot), analyses, lock: plannerLockFrom(lock3, [v2], lockDigest(lock3)), policy: plannerPolicyFrom(policy) });
  const call = Object.fromEntries(second.checks.filter(c => c.familyId === CALL.familyId).map(c => [c.scopeId, [c.state, c.reasonCode ?? null]]));
  assert.deepEqual(call['app:src/util.ts'], ['planned', null]);
  assert.deepEqual(call['app:src/bad.ts'], ['scope-unavailable', 'sentinel.plan.parseRequired'], 'the parser evidence decides');
  assert.deepEqual(second.ruleGaps, []);
  assert.ok(second.units.every(u => u.stage === 'check'), 'no capture or parse again');
  assert.equal(second.pins.snapshotId, snapshot.id);
  assert.equal(second.previous, first.digest);
  assert.equal(JSON.stringify(first), firstJson, 'the earlier revision is unchanged');
  assert.deepEqual(verifyPinnedLock(JSON.parse(JSON.stringify(lock2)), first.pins.ruleLockDigest!), lock2, 'its lock is still the pinned one');
  assert.throws(() => plannerLockFrom(lock3, [v1], lockDigest(lock3)), (e: any) => e.code === 'sentinel.rules.packMismatch', 'the old pack cannot stand in for the new lock');
});

test('parser evidence is accepted only for the snapshot and source it read: a stale A analysis cannot plan snapshot B', needsStore, async t => {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  const lib = join(dir, 'lib');
  commitRepo(root, { 'app/api/items/route.ts': 'export const items = [];\n' });
  commitRepo(lib, { 'src/util.ts': 'export function util() { return 1; }\n' });
  const fx = await openCaptureStore(t, dir);
  const parse = async (snapshotId: string, name: string) => {
    const work = join(dir, name);
    mkdirSync(work, { mode: 0o700 });
    return parseSnapshot(fx.store, { snapshotId, workDir: work, selection: { gitignore: true, testFiles: 'include' },
      limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1 << 20, maxEntries: 10_000, maxDurationMs: 60_000 } });
  };
  const sources = [{ sourceId: 'app', repositoryId: 'example/app', root }, { sourceId: 'lib', repositoryId: 'example/lib', root: lib }];
  const a = (await captureSnapshot(fx.store, { mode: 'working-copy', sources })).snapshot;
  const parsedA = await parse(a.id, 'work-a');
  // B: the same file now exports a route handler.
  writeFileSync(join(root, 'app/api/items/route.ts'), 'export async function GET() {\n  return new Response("[]");\n}\n');
  const b = (await captureSnapshot(fx.store, { mode: 'working-copy', sources })).snapshot;
  const parsedB = await parse(b.id, 'work-b');
  const analysesOf = (parsed: typeof parsedA) => parsed.sources.map(s => plannerAnalysisFrom(s));
  assert.equal(analysesOf(parsedA).find(x => x.sourceId === 'app')!.surfaces.length, 0, 'A has no route');
  assert.equal(analysesOf(parsedB).find(x => x.sourceId === 'app')!.surfaces.length, 1, 'B has the route');

  const v1 = pack([ROUTE]);
  const lock = { ...emptyLock(NOW), revision: 2, previous: lockDigest(emptyLock(NOW)),
    packs: [{ ...structuredClone((v1 as any).entry), promotion: { receipt: D('receipt'), at: '2026-10-22T12:00:00.000000000Z' } }] };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), mandatoryRules: [ROUTE.familyId] };
  const policy = plannerPolicyFrom(effectivePolicy({ trust: 'adopted', settings, settingsDigest: D('settings'), repoConfig: null, repoConfigDigest: null }));
  const boot = planBootstrap({ runId: 'run-ab', sourceIds: ['app', 'lib'], profile });
  const planB = (analyses: ReturnType<typeof plannerAnalysisFrom>[]) => planAnalysis({ runId: 'run-ab', revision: 2, previous: boot,
    bootstrap: [{ id: boot.units.at(-1)!.id, revision: 1 }], profile, snapshot: plannerSnapshotFrom(b), analyses,
    lock: plannerLockFrom(lock as never, [v1], lockDigest(lock as never)), policy });

  assert.throws(() => planB(analysesOf(parsedA)), (e: any) => e.code === 'sentinel.plan.pinMismatch', 'A’s evidence cannot plan B');
  const good = planB(analysesOf(parsedB));
  assert.deepEqual(good.checks.filter(c => c.familyId === ROUTE.familyId && c.sourceId === 'app').map(c => c.state), ['unsupported'],
    'the route B declares is a required check');
  assert.equal(good.requiredCoverageAchievable, false);

  // Mixed or relabelled evidence: B's app with A's lib, a result paired with another snapshot's index, a source relabelled.
  const [appB, libB] = ['app', 'lib'].map(s => parsedB.sources.find(x => x.sourceId === s)!);
  const libA = parsedA.sources.find(x => x.sourceId === 'lib')!;
  assert.throws(() => planB([plannerAnalysisFrom(appB), plannerAnalysisFrom(libA)]), (e: any) => e.code === 'sentinel.plan.pinMismatch');
  assert.throws(() => plannerAnalysisFrom({ ...appB, index: parsedA.sources.find(x => x.sourceId === 'app')!.index }), (e: any) => e.code === 'sentinel.plan.pinMismatch');
  assert.throws(() => plannerAnalysisFrom({ ...libB, sourceId: 'app' }), (e: any) => e.code === 'sentinel.plan.pinMismatch');
  assert.throws(() => planB([plannerAnalysisFrom(appB)]), (e: any) => e.code === 'sentinel.plan.pinMismatch', 'every source needs its own analysis');
});
