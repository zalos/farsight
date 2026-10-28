// The declared default pipeline plans to today's unit set and digests (P-3's acceptance), on the invoice-app example.
//
// Today's planning is the bootstrap, then the analysis over the captured and parsed snapshot, then (with model review
// configured) the review units appended by withReviewUnits, called exactly as service/canonical.ts calls them. The
// golden file pins the machine-independent scenarios' unit ids, input fingerprints and plan digests as they were on
// main before declared planning existed; `SENTINEL_GOLDEN_WRITE=1` rewrites it (a reviewer then reads the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { planAnalysis, planBootstrap } from '../dist/planner/index.js';
import { reviewsFor } from '../dist/service/review-adapter.js';
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
 * approves (on the portable registry the preview detector is an image-pinned stand-in, so the lock names it).
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

/** Today's canonical planning: bootstrap, analysis, then the closed review units when model review is configured. */
function legacyPlans(
  fx: any,
  registry: any,
  scenario: Scenario,
  review?: { guided?: string[]; general?: boolean },
  tools: readonly string[] = SCENARIOS[scenario].tools,
) {
  const s = SCENARIOS[scenario];
  const packs = shippedPacks(s.packs);
  const profile = profileOver(registry, packs, s.available);
  const { policy, view } = adoptedPolicy(scenario, review);
  const lock = lockOver(packs, registry, tools);
  const boot = planBootstrap({ runId: RUN, sourceIds: ['workspace'], profile: profile.planner });
  const inventory = boot.units.find((u: any) => u.stage === 'inventory')!;
  const analysis = planAnalysis({
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
  const reviewed = review
    ? reviewsFor(analysis, fx.evidence, policy, registry, packs)
    : { plan: analysis, artifacts: [] };
  return { boot, analysis: reviewed.plan, deterministic: analysis, artifacts: reviewed.artifacts };
}

test('today’s plans of the invoice-app example are the recorded golden plans', needsStore, async (t) => {
  const fx = await invoiceApp(t);
  const portable = portableRegistry();
  const recorded: Record<string, unknown> = {};
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const tools = scenario === 'static' ? ['sentinel.preview.detector'] : SCENARIOS[scenario].tools;
    const { boot, analysis } = legacyPlans(fx, portable, scenario, undefined, tools);
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

export { legacyPlans, SCENARIOS, RUN };
