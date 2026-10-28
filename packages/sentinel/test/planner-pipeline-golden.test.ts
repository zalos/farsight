// The declared default pipeline plans to today's unit set and digests (P-3's acceptance), on the invoice-app example.
//
// Today's planning is the bootstrap, then the analysis over the captured and parsed snapshot, then (with model review
// configured) the review units appended by withReviewUnits, called exactly as service/canonical.ts calls them. The
// golden file pins the machine-independent scenarios' unit ids, input fingerprints and plan digests as they were on
// main before declared planning existed; `SENTINEL_GOLDEN_WRITE=1` rewrites it (a reviewer then reads the diff).
// The declared path plans the default pipeline (defaultPipelineOf) and must give the same revisions byte for byte;
// a planted change (a stage removed) must change them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  PlanError,
  agentSeedsOf,
  defaultPipelineOf,
  planAnalysis,
  planBootstrap,
  planPipelineAnalysis,
  planPipelineBootstrap,
  selectStages,
  stageModel,
} from '../dist/planner/index.js';
import { reviewsFor } from '../dist/service/review-adapter.js';
import { publicRegistry } from '../dist/service/scanner-profile.js';
import { canonicalJsonBytes } from '../dist/store/objects.js';
import { needsStore } from './snapshot-helpers.ts';
import {
  SCANNER_ADAPTERS,
  SCANNER_PACKS,
  adoptedPolicy,
  identityOf,
  invoiceApp,
  lockOver,
  plannerInputs,
  portableRegistry,
  profileOver,
  shippedPacks,
} from './pipeline-golden-helpers.ts';

const GOLDEN = new URL('./fixtures/pipeline-golden/invoice-app.json', import.meta.url);
const RUN = 'run-golden';

type Scenario = 'scanners' | 'static';
/**
 * `available`: the installed scanner adapters canonical planning finds; `tools`: the external adapters the lock
 * approves (on the portable registry the preview detector is an image-pinned stand-in, so the lock names it too).
 */
const SCENARIOS: Record<
  Scenario,
  { packs: readonly string[]; available: readonly string[]; tools: readonly string[]; limits: object }
> = {
  scanners: {
    packs: SCANNER_PACKS,
    available: SCANNER_ADAPTERS,
    tools: SCANNER_ADAPTERS,
    limits: { maxScopesPerWork: 32 },
  },
  static: { packs: ['foundation-preview'], available: [], tools: [], limits: { maxScopesPerWork: 1 } },
};

const cleanups: (() => void)[] = [];
let fx: any;
before(async () => {
  if (!needsStore.skip) fx = await invoiceApp({ after: (fn) => cleanups.push(fn) });
});
after(() => {
  for (const fn of cleanups.reverse()) fn();
});

interface Terms {
  registry: any;
  scenario: Scenario;
  review?: { guided?: string[]; general?: boolean };
  tools?: readonly string[];
}

/** Everything both planning paths read for one scenario. */
function inputsOf({ registry, scenario, review, tools }: Terms) {
  const s = SCENARIOS[scenario];
  const packs = shippedPacks(s.packs);
  const profile = profileOver(registry, packs, s.available);
  const { policy, view } = adoptedPolicy(scenario, review);
  const lock = lockOver(packs, registry, tools ?? s.tools);
  const selected = new Set(policy.rules);
  const adapters = lock.view.rules.filter((r: any) => selected.has(r.familyId)).map((r: any) => r.adapterId);
  return { s, packs, profile, policy, view, lock, adapters };
}

/** Today's canonical planning: bootstrap, analysis, then the closed review units when model review is configured. */
function legacyPlans(terms: Terms) {
  const { s, packs, profile, policy, view, lock } = inputsOf(terms);
  const boot = planBootstrap({ runId: RUN, sourceIds: ['workspace'], profile: profile.planner });
  const inventory = boot.units.find((u: any) => u.stage === 'inventory')!;
  const deterministic = planAnalysis({
    runId: RUN,
    revision: 2,
    previous: boot,
    bootstrap: [{ id: inventory.id, revision: inventory.revision }],
    profile: profile.planner,
    ...plannerInputs(fx.evidence),
    lock: lock.view,
    policy: view,
    limits: s.limits,
  });
  const reviewed = terms.review
    ? reviewsFor(deterministic, fx.evidence, policy, terms.registry, packs)
    : { plan: deterministic, artifacts: [] };
  return { boot, analysis: reviewed.plan, deterministic };
}

/** The same terms planned through a declaration (the default pipeline unless one is given). */
function declaredPlans(terms: Terms, pipeline?: any, seedsFrom?: any) {
  const { s, profile, lock, view, adapters } = inputsOf(terms);
  const reviews = [
    ...(terms.review?.guided?.length ? ['guided' as const] : []),
    ...(terms.review?.general ? ['general' as const] : []),
  ];
  const declaration = pipeline ?? defaultPipelineOf({ adapters, reviews });
  const boot = planPipelineBootstrap({
    runId: RUN,
    sourceIds: ['workspace'],
    profile: profile.planner,
    pipeline: declaration,
  });
  const inventory = boot.units.find((u: any) => u.stage === 'inventory')!;
  const analysis = planPipelineAnalysis({
    runId: RUN,
    revision: 2,
    previous: boot,
    bootstrap: [{ id: inventory.id, revision: inventory.revision }],
    profile: profile.planner,
    ...plannerInputs(fx.evidence),
    lock: lock.view,
    policy: view,
    limits: s.limits,
    pipeline: declaration,
    ...(seedsFrom ? { agents: agentSeedsOf(seedsFrom) } : {}),
  });
  return { boot, analysis, declaration };
}

const bytes = (plan: unknown) => canonicalJsonBytes(plan);
/** The pipeline without one stage, and without every mention of it in the others' ordering. */
const withoutStage = (p: any, id: string) => ({
  ...p,
  stages: p.stages
    .filter((s: any) => s.id !== id)
    .map((s: any) => ({ ...s, ...(s.after ? { after: s.after.filter((a: string) => a !== id) } : {}) })),
});
const portableTerms = (scenario: Scenario): Terms => ({
  registry: portableRegistry(),
  scenario,
  // On the portable registry the preview detector is an image-pinned stand-in the lock must approve.
  tools: scenario === 'static' ? ['sentinel.preview.detector'] : SCENARIOS[scenario].tools,
});

test('today’s plans of the invoice-app example are the recorded golden plans', needsStore, () => {
  const recorded: Record<string, unknown> = {};
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const { boot, analysis } = legacyPlans(portableTerms(scenario));
    recorded[scenario] = { bootstrap: identityOf(boot), analysis: identityOf(analysis) };
  }
  if (process.env.SENTINEL_GOLDEN_WRITE === '1') writeFileSync(GOLDEN, JSON.stringify(recorded, null, 2) + '\n');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(recorded, golden);
  // The fixture is not trivially empty: every scanner with a scope in the example has work (it has no CI workflow),
  // and the preview plans one scope per unit.
  const scanners = (recorded.scanners as any).analysis.units;
  assert.deepEqual(
    [...new Set(scanners.map((u: any) => u.adapterId))].sort(),
    SCANNER_ADAPTERS.filter((a) => a !== 'ci-zizmor'),
  );
  assert.ok((recorded.static as any).analysis.units.length > 1);
});

test('the declared default pipeline plans the golden revisions, unit for unit and byte for byte', needsStore, () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const terms = portableTerms(scenario);
    const legacy = legacyPlans(terms);
    const declared = declaredPlans(terms);
    assert.deepEqual(
      { bootstrap: identityOf(declared.boot), analysis: identityOf(declared.analysis) },
      golden[scenario],
      `${scenario}: unit ids, input fingerprints and plan digests`,
    );
    assert.ok(bytes(declared.boot).equals(bytes(legacy.boot)), `${scenario}: the bootstrap revision`);
    assert.ok(bytes(declared.analysis).equals(bytes(legacy.analysis)), `${scenario}: the analysis revision`);
  }
});

test('on the shipped registry the declared default pipeline is today’s plan too', needsStore, () => {
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const terms = { registry: publicRegistry(), scenario };
    const legacy = legacyPlans(terms);
    const declared = declaredPlans(terms);
    assert.ok(bytes(declared.boot).equals(bytes(legacy.boot)), `${scenario}: the bootstrap revision`);
    assert.ok(bytes(declared.analysis).equals(bytes(legacy.analysis)), `${scenario}: the analysis revision`);
    assert.equal(declared.analysis.digest, legacy.analysis.digest);
  }
});

test('review units declared as agent stages are placed and sealed exactly as withReviewUnits did', needsStore, () => {
  // The guided review (one unit per planned check: the preview's 30 fit the review side's bound of 32) and the general
  // review (one unit per source partition), both on a local model.
  const terms: Terms = { registry: publicRegistry(), scenario: 'static', review: { guided: ['all'], general: true } };
  const legacy = legacyPlans(terms);
  const reviewUnits = legacy.analysis.units.filter((u: any) => u.review);
  assert.deepEqual([...new Set(reviewUnits.map((u: any) => u.stage))].sort(), ['review-general', 'review-guided']);
  const declared = declaredPlans(terms, undefined, legacy.analysis);
  assert.ok(bytes(declared.analysis).equals(bytes(legacy.analysis)), 'the reviewed analysis revision');
  assert.equal(declared.analysis.digest, legacy.analysis.digest);
  // Each review unit belongs to the agent stage declaring its fan-out.
  const model = stageModel(declared.declaration);
  const pick = selectStages(model, declared.analysis, ['review-general']);
  assert.deepEqual(
    pick.units,
    reviewUnits
      .filter((u: any) => u.stage === 'review-general')
      .map((u: any) => u.id)
      .sort(),
  );
  // A configured review the pipeline does not declare is refused, never added.
  assert.throws(
    () => declaredPlans(terms, withoutStage(declared.declaration, 'review-guided'), legacy.analysis),
    (e: any) => e instanceof PlanError && e.code === 'sentinel.plan.agentStageMissing',
  );
});

test(
  'a planted change, the secrets stage removed, changes the plan and keeps the rule as a counted gap',
  needsStore,
  () => {
    const terms = portableTerms('scanners');
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).scanners;
    const { adapters } = inputsOf(terms);
    const full = defaultPipelineOf({ adapters });
    const planted = withoutStage(full, 'secrets');
    const { boot, analysis } = declaredPlans(terms, planted);
    assert.equal(boot.digest, golden.bootstrap.digest, 'the bootstrap does not depend on check stages');
    assert.notEqual(analysis.digest, golden.analysis.digest, 'the analysis revision changed');
    assert.equal(
      analysis.units.some((u: any) => u.adapterId === 'secrets-gitleaks'),
      false,
      'no unit runs the removed stage',
    );
    // What the stage would have checked is unsupported because no stage runs it; scope gaps keep their own reason.
    const secrets = analysis.checks.filter((c: any) => c.familyId === 'sentinel.secrets.current-tree');
    const wouldRun = new Set(
      legacyPlans(terms)
        .analysis.checks.filter((c: any) => c.familyId === 'sentinel.secrets.current-tree' && c.state === 'planned')
        .map((c: any) => c.id),
    );
    assert.ok(wouldRun.size > 0);
    for (const c of secrets) {
      assert.notEqual(c.state, 'planned');
      if (wouldRun.has(c.id))
        assert.deepEqual([c.state, c.reasonCode], ['unsupported', 'sentinel.plan.stageNotDeclared']);
    }
    // The secrets rule is mandatory in the scanners profile: removing its stage leaves required coverage unachievable.
    assert.equal(analysis.requiredCoverageAchievable, false);
    // Every other unit is the golden unit, untouched.
    const kept = golden.analysis.units.filter((u: any) => u.adapterId !== 'secrets-gitleaks');
    assert.deepEqual(identityOf(analysis).units, kept);
  },
);
