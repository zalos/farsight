// The invoice-app example as planner inputs, for the declared-pipeline golden suite: the example copied into a
// hermetic Git repository, captured into a real store at a fixed clock, parsed with the public parser, and planned
// under the shipped rule packs, an adopted policy and the shipped (or a machine-independent) trusted profile. The
// same inputs plan today's way (planBootstrap, planAnalysis, withReviewUnits through reviewsFor, exactly as
// service/canonical.ts calls them) and through a declared pipeline; the suite compares the two byte for byte.
//
// Two values are normalised so a recorded golden plan is the same on every host: the snapshot's environment profile
// digest (it hashes the Node version, platform and architecture) and the bootstrap operations, which the
// machine-independent profile binds to image-pinned synthetic adapters (an operation's or built-in's digest hashes
// a module's bytes and absolute path). Nothing is scanned, no container starts and no model is called.
import { cpSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { emptyLock, lockDigest, readPackDirectory, validatePack } from '../dist/rules/index.js';
import { DEFAULT_SETTINGS, effectivePolicy, parseSettings } from '../dist/policy/index.js';
import { plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom, plannerSnapshotFrom } from '../dist/planner/index.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { productionDrivers } from '../dist/adapters/drivers/index.js';
import { publicProfile, publicRegistry } from '../dist/service/scanner-profile.js';
import { reviewRegistry } from '../dist/service/review-adapter.js';
import { initialSettings } from '../dist/cli/init.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { git, openCaptureStore, scratch } from './snapshot-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE = resolve(here, '../../../examples/invoice-app');
const RULES = resolve(here, '../rules');
const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const AT = '2026-10-27T12:00:00.000000000Z';
export const NOW = new Date('2026-10-27T12:00:00.000Z');
/** The environment every golden snapshot plans under (see the module comment). */
export const ENVIRONMENT = D('sentinel golden environment');

/** The five image-pinned scanner adapters this build ships, by registry id. */
export const SCANNER_ADAPTERS = [
  'advisories-osv',
  'ci-zizmor',
  'iac-trivy',
  'pattern-semgrep',
  'secrets-gitleaks',
] as const;
/** The shipped packs each profile plans with. */
export const SCANNER_PACKS = ['advisories', 'ci', 'infrastructure', 'pattern', 'secrets'] as const;

/** The invoice-app example captured and parsed: the snapshot envelope and each source's retained analysis. */
export async function invoiceApp(t: { after(fn: () => void): void }) {
  const dir = scratch(t, 'sentinel-golden-');
  const root = join(dir, 'repo');
  cpSync(EXAMPLE, root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['add', '--all', '--force']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, {
    mode: 'working-copy',
    sources: [{ sourceId: 'workspace', repositoryId: 'local-workspace', root }],
    now: () => AT,
  });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const parsed = await parseSnapshot(fx.store, {
    snapshotId: snapshot.id,
    workDir: work,
    selection: { gitignore: true, testFiles: 'include' },
    limits: {
      maxFiles: 20_000,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 268_435_456,
      maxEntries: 200_000,
      maxDurationMs: 120_000,
    },
  });
  const envelope = { ...structuredClone(snapshot), environmentProfileDigest: ENVIRONMENT };
  const evidence = { snapshot: envelope, analyses: parsed.sources };
  return { store: fx.store, snapshot: envelope, evidence };
}

/** The shipped rule packs by folder name, validated from their bytes. */
export const shippedPacks = (names: readonly string[]) =>
  names.map((n) => validatePack(readPackDirectory(join(RULES, n))));

/**
 * A lock holding `packs` and exact tool entries for the named external adapters of `registry` (the version and image
 * digest planning compares), with the two advisory/check databases the scanner rules read.
 */
export function lockOver(packs: readonly any[], registry: any, tools: readonly string[]) {
  const promotion = { receipt: D('golden receipt'), at: AT };
  const lock = {
    ...emptyLock(NOW),
    revision: 2,
    previous: lockDigest(emptyLock(NOW)),
    packs: packs.map((p) => ({ ...structuredClone(p.entry), promotion })),
    databases: ['advisories-osv-db', 'iac-trivy-checks'].map((databaseId) => ({
      databaseId,
      snapshotDigest: D(`golden ${databaseId}`),
      capturedAt: '2026-10-27T00:00:00Z',
      rights: {
        spdx: 'CC-BY-4.0',
        origin: 'third-party' as const,
        upstream: { name: databaseId, revision: '2026-10-27' },
      },
      promotion,
    })),
    tools: tools.map((id) => {
      const a = registry.get(id);
      return {
        adapterId: id,
        version: a.version,
        artifactDigest: `sha256:${a.image.slice(a.image.lastIndexOf('@sha256:') + 8)}`,
        platform: 'linux-x64',
        rights: { spdx: 'Apache-2.0', origin: 'third-party' as const, upstream: { name: id, revision: a.version } },
        promotion,
      };
    }),
  };
  const pin = lockDigest(lock as never);
  return { lock, pin, view: plannerLockFrom(lock as never, packs as never, pin) };
}

/** A local model review on the guided and general stages, for the review scenario. */
const REVIEW_PROVIDER = {
  id: 'local-review',
  kind: 'ollama',
  endpoint: 'http://127.0.0.1:9',
  credential: null,
  disclosure: 'local-only',
  budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
  models: [
    {
      id: 'review',
      model: 'review-model:1',
      limits: {
        maxRequestBytes: 65536,
        maxResponseBytes: 16384,
        timeoutMs: 2000,
        maxOutputTokens: 256,
        contextTokens: 8192,
        maxMessages: 16,
        templateTokensPerMessage: 8,
      },
      pricing: { kind: 'no-fee', basis: 'local-runtime' },
      terms: null,
      capability: {
        schema: 'sentinel-model-capability/draft-1',
        kind: 'ollama',
        origin: 'http://127.0.0.1:9',
        model: 'review-model:1',
        listed: true,
        revision: null,
        probedAt: '2026-10-27T11:00:00.000000000Z',
      },
    },
  ],
};

/** The adopted policy `init --profile <profile>` writes, optionally with model review on the named stages. */
export function adoptedPolicy(profile: 'static' | 'scanners', review: { guided?: string[]; general?: boolean } = {}) {
  const base: any = initialSettings(profile);
  const reviewing = review.general || review.guided?.length;
  const settings = parseSettings(
    Buffer.from(
      JSON.stringify({
        ...structuredClone(DEFAULT_SETTINGS),
        ...base,
        ...(reviewing
          ? {
              providers: [REVIEW_PROVIDER],
              reviewModels: {
                // `guided: ['all']` reviews every planned check; other entries name guided segments.
                stages: [
                  ...(review.guided?.includes('all')
                    ? [{ stage: 'guided', providerId: 'local-review', modelId: 'review' }]
                    : []),
                  ...(review.general ? [{ stage: 'general', providerId: 'local-review', modelId: 'review' }] : []),
                ],
                segments: (review.guided ?? [])
                  .filter((s) => s !== 'all')
                  .map((segmentId) => ({ stage: 'guided', segmentId, providerId: 'local-review', modelId: 'review' })),
              },
            }
          : {}),
      }),
    ),
  );
  const policy = effectivePolicy({
    trust: 'adopted',
    settings,
    settingsDigest: canonicalDigest(settings),
    repoConfig: null,
    repoConfigDigest: null,
  });
  return { policy, view: plannerPolicyFrom(policy) };
}

/**
 * The machine-independent registry: the five shipped scanner adapters exactly as this build defines them, and the
 * bootstrap operations and the preview detector as image-pinned synthetic adapters under their shipped ids.
 */
export function portableRegistry() {
  const synthetic = (id: string) => ({
    id,
    version: '1',
    kind: 'external' as const,
    isolation: 'container' as const,
    image: `${id.replace(/[^a-z0-9-]/g, '-')}@sha256:${createHash('sha256').update(id).digest('hex')}`,
    command: ['golden'],
  });
  const drivers = productionDrivers({ maxAdvisoryAgeMs: 7 * 86400000 });
  return createAdapterRegistry([
    ...['sentinel-capture', 'sentinel-parse', 'sentinel-inventory', 'sentinel.preview.detector'].map(synthetic),
    ...SCANNER_ADAPTERS.map((id) => drivers.get(id)!.definition),
  ]);
}

/**
 * The registry the review seeds read their adapter digests from, for the recorded reviewed scenario: the portable
 * registry, with each review operation's digest a fixed stand-in. An operation's real digest covers its module's
 * built bytes, so a recorded review unit would otherwise change with any build.
 */
export const portableReviewRegistry = (base = portableRegistry()) => ({
  ...base,
  get: (id: string) =>
    id === 'sentinel.review.guided' || id === 'sentinel.review.general'
      ? { id, digest: D(`golden review adapter ${id}`) }
      : base.get(id),
});

/** The shipped registry the CLI plans with (foundation operations, review adapters and the scanner adapters). */
export const shippedRegistry = () => reviewRegistry(publicRegistry());

/** The trusted profile canonical planning builds over `registry`, with `available` scanner adapters installed. */
export const profileOver = (registry: any, packs: readonly any[], available: readonly string[]) =>
  publicProfile(registry, new Set(available), packs as never);

export const plannerInputs = (evidence: { snapshot: any; analyses: any[] }) => ({
  snapshot: plannerSnapshotFrom(evidence.snapshot),
  analyses: evidence.analyses.map((a) => plannerAnalysisFrom(a)),
});

/** What a plan's identity is, for the golden record: the plan digest and each unit's ids and fingerprints. */
export const identityOf = (plan: any) => ({
  kind: plan.kind,
  digest: plan.digest,
  units: plan.units.map((u: any) => ({
    id: u.id,
    stage: u.stage,
    adapterId: u.adapterId,
    inputFingerprint: u.inputFingerprint,
    inputSetDigest: u.inputSetDigest,
    checks: u.checks.length,
  })),
  checks: plan.tallies.checks,
});
