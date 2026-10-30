// The declared default pipeline plans the recorded golden revisions (P-3's acceptance), on the invoice-app example.
//
// The golden files are the oracle. `invoice-app.json` pins the machine-independent scenarios' unit ids, input
// fingerprints and plan digests as they were on main before declared planning existed; `invoice-app-reviewed.json`
// pins the reviewed scenario (the guided and general review units) as the retired withReviewUnits placed them, recorded
// once from that path before it was removed. `SENTINEL_GOLDEN_WRITE=1` rewrites both from the declared path (a
// reviewer then reads the diff). A plan digest covers the plan's canonical bytes, so matching it is byte for byte; a
// planted change (a stage removed) must change them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promoteStagePack } from '../dist/review/packs.js';
import {
  PlanError,
  agentSeedsOf,
  declaredAnalysis,
  defaultPipelineOf,
  planPipelineAnalysis,
  planPipelineBootstrap,
  selectStages,
  stageModel,
} from '../dist/planner/index.js';
import { reviewSeedsFor, reviewUnitOf } from '../dist/review/plan.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { publicRegistry } from '../dist/service/scanner-profile.js';
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
  portableReviewRegistry,
  profileOver,
  shippedPacks,
} from './pipeline-golden-helpers.ts';

const GOLDEN = new URL('./fixtures/pipeline-golden/invoice-app.json', import.meta.url);
const REVIEWED = new URL('./fixtures/pipeline-golden/invoice-app-reviewed.json', import.meta.url);
const RUN = 'run-golden';
const SKILL = fileURLToPath(new URL('./fixtures/stage-packs/skills/invoice-approvals', import.meta.url));

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
  // The default pipeline's check stages: each adapter the policy's locked rules run under, with exactly those rules.
  const checks = lock.view.rules
    .filter((r: any) => selected.has(r.familyId))
    .map((r: any) => ({ adapterId: r.adapterId, rules: [r.familyId] }));
  return { s, packs, profile, policy, view, lock, checks };
}

/** The same terms planned through a declaration (the default pipeline unless one is given). */
function declaredPlans(terms: Terms, pipeline?: any, seeds?: any[]) {
  const { s, profile, lock, view, checks } = inputsOf(terms);
  // The planner does not read the runner or model (the review seed carries the adopted selection); these name what
  // the test's local review provider is. The contract has no runner word for a local model server yet.
  const review = { runner: 'hosted-api' as const, provider: 'local-review', model: 'review' };
  const reviews = [
    ...(terms.review?.guided?.length ? [{ kind: 'guided' as const, ...review }] : []),
    ...(terms.review?.general ? [{ kind: 'general' as const, ...review }] : []),
  ];
  const declaration = pipeline ?? defaultPipelineOf({ checks, reviews });
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
    ...(seeds ? { agents: seeds } : {}),
  });
  return { boot, analysis, declaration };
}

/** The digest of a revision's canonical bytes without its own digest field: what the recorded digest pins. */
const bodyDigest = (plan: any) => {
  const { digest: recorded, ...body } = plan;
  void recorded;
  return canonicalDigest(body);
};
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

test('the declared default pipeline plans the recorded golden plans of the invoice-app example', needsStore, () => {
  const recorded: Record<string, unknown> = {};
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const { boot, analysis } = declaredPlans(portableTerms(scenario));
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
    const declared = declaredPlans(terms);
    assert.deepEqual(
      { bootstrap: identityOf(declared.boot), analysis: identityOf(declared.analysis) },
      golden[scenario],
      `${scenario}: unit ids, input fingerprints and plan digests`,
    );
    // Byte for byte: each revision's digest is of its canonical bytes, and that digest is the recorded one.
    assert.equal(bodyDigest(declared.boot), golden[scenario].bootstrap.digest, `${scenario}: the bootstrap revision`);
    assert.equal(bodyDigest(declared.analysis), golden[scenario].analysis.digest, `${scenario}: the analysis revision`);
  }
});

test('on the shipped registry the declared default pipeline plans the golden units', needsStore, () => {
  // The shipped adapters' digests cover their built bytes, so ids and digests are not recorded for them; every unit's
  // stage, adapter, input set and check count is, and the shipped plan has exactly the golden ones.
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const shape = (units: any[]) =>
    units.map((u) => [u.stage, u.adapterId, u.inputSetDigest, u.checks]).sort((a, b) => (a.join() < b.join() ? -1 : 1));
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const declared = declaredPlans({ registry: publicRegistry(), scenario });
    for (const [plan, recorded] of [
      [declared.boot, golden[scenario].bootstrap],
      [declared.analysis, golden[scenario].analysis],
    ] as const) {
      assert.deepEqual(shape(identityOf(plan).units), shape(recorded.units), `${scenario}: ${plan.kind} units`);
      assert.equal(bodyDigest(plan), plan.digest, `${scenario}: ${plan.kind} digest of its canonical bytes`);
    }
  }
});

test(
  'review units declared as agent stages are the recorded review units, and admission re-derives each one',
  needsStore,
  () => {
    // The guided review (one unit per planned check: the preview's 31 fit the review side's bound of 32) and the general
    // review (one unit per source partition), both on a local model, with the review adapters' digests fixed stand-ins.
    const terms: Terms = { ...portableTerms('static'), review: { guided: ['all'], general: true } };
    const { policy, packs } = inputsOf(terms);
    const deterministic = declaredPlans(terms);
    const built = reviewSeedsFor(
      deterministic.analysis,
      fx.evidence,
      policy,
      portableReviewRegistry(terms.registry),
      packs,
    );
    const declared = declaredPlans(terms, undefined, built.seeds);
    const reviewed = { analysis: identityOf(declared.analysis), artifacts: built.artifacts.length };
    if (process.env.SENTINEL_GOLDEN_WRITE === '1')
      writeFileSync(REVIEWED, JSON.stringify({ reviewed }, null, 2) + '\n');
    assert.deepEqual(reviewed, JSON.parse(readFileSync(REVIEWED, 'utf8')).reviewed);
    assert.equal(bodyDigest(declared.analysis), reviewed.analysis.digest, 'the reviewed revision, byte for byte');
    const reviewUnits = declared.analysis.units.filter((u: any) => u.review);
    assert.deepEqual([...new Set(reviewUnits.map((u: any) => u.stage))].sort(), ['review-general', 'review-guided']);
    // The planner places the seeds as they were built, and admission's re-derivation gives each placed unit exactly.
    const bySegment = (seeds: any[]) => [...seeds].sort((a, b) => (a.segmentId < b.segmentId ? -1 : 1));
    assert.deepEqual(bySegment(built.seeds), bySegment(agentSeedsOf(declared.analysis)));
    for (const seed of built.seeds) {
      const unit = reviewUnits.find((u: any) => u.review.segmentId === seed.segmentId);
      assert.deepEqual(reviewUnitOf(declared.analysis, seed), unit, seed.segmentId);
    }
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
      () => declaredPlans(terms, withoutStage(declared.declaration, 'review-guided'), built.seeds),
      (e: any) => e instanceof PlanError && e.code === 'sentinel.plan.agentStageMissing',
    );
    // When the general review's agent stage names a promoted skill, its seeds carry it, sealed with its digest; the
    // guided seeds, whose stage names none, are unchanged; the planner places them and admission re-derives them.
    const trustDir = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-golden-trust-')));
    try {
      const skill = promoteStagePack(trustDir, SKILL, { confirm: true });
      const general = declaredAnalysis(model).stageOfSeed({ kind: 'general' });
      const stagePacks = {
        trustDir,
        stages: [
          {
            ...declared.declaration.stages.find((st: any) => st.id === general),
            skills: ['skills/invoice-approvals@1'],
          },
        ],
        stageOf: { general },
      };
      const packed = reviewSeedsFor(
        deterministic.analysis,
        fx.evidence,
        policy,
        portableReviewRegistry(terms.registry),
        packs,
        stagePacks as any,
      );
      const kinds = (seeds: any[], kind: string) => bySegment(seeds.filter((x) => x.kind === kind));
      assert.deepEqual(kinds(packed.seeds, 'guided'), kinds(built.seeds, 'guided'));
      const [packedGeneral] = kinds(packed.seeds, 'general'),
        [bundledGeneral] = kinds(built.seeds, 'general');
      assert.notEqual(packedGeneral.review.specDigest, bundledGeneral.review.specDigest);
      const record = JSON.parse(
        Buffer.from(packed.artifacts.find((a: any) => a.id === packedGeneral.review.spec)!.bytes).toString('utf8'),
      );
      assert.deepEqual(record.spec.packs, [{ ref: 'skills/invoice-approvals@1', digest: skill.digest }]);
      const placed = declaredPlans(terms, undefined, packed.seeds);
      const unit = placed.analysis.units.find((u: any) => u.review?.segmentId === packedGeneral.segmentId);
      assert.deepEqual(reviewUnitOf(placed.analysis, packedGeneral), unit);
    } finally {
      rmSync(trustDir, { recursive: true, force: true });
    }
  },
);

test(
  'a planted change, the secrets stage removed, changes the plan and keeps the rule as a counted gap',
  needsStore,
  () => {
    const terms = portableTerms('scanners');
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).scanners;
    const full = defaultPipelineOf({ checks: inputsOf(terms).checks });
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
      declaredPlans(terms)
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
