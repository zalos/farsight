// The command line's trusted profile against the canonical planner, planning only: a real capture and parse, the
// built-in foundation-preview pack promoted into a real lock with the owner's receipt, an adopted policy, and the
// narrow registry. It shows what the planner would plan for the preview rule and what a plan admission would pin.
// It does not run anything: bootstrap publication and coverage evaluation belong to the coordinator (not built yet
// for this path), so the bootstrap reference here is a planning input, not published work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import {
  emptyLock,
  lockDigest,
  promote,
  promotionIntent,
  readPackDirectory,
  validatePack,
} from '../dist/rules/index.js';
import { DEFAULT_SETTINGS, ReceiptBook, effectivePolicy } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import {
  planAnalysis,
  planBootstrap,
  plannerAnalysisFrom,
  plannerLockFrom,
  plannerPolicyFrom,
  plannerSnapshotFrom,
  verifyPlanRevision,
} from '../dist/planner/index.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { EXECUTION_PROFILE_SCHEMA, foundationProfile } from '../dist/service/trusted-profile.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_RULE } from '../dist/adapters/preview-detector.js';
import { commitRepo, needsStore, openCaptureStore, scratch, unlock } from './snapshot-helpers.ts';

const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const NOW = new Date('2026-10-22T12:00:00.000Z');

test("the profile is the coordinator's canonical record: adapter ids and digests, facts, permits, operations; nothing live", () => {
  const p = foundationProfile();
  assert.equal(p.record.schema, EXECUTION_PROFILE_SCHEMA);
  assert.deepEqual(JSON.parse(JSON.stringify(p.record)), p.record, 'plain data, no functions or live objects');
  assert.deepEqual(
    p.record.adapters.map((a) => a.adapterId),
    [PREVIEW_DETECTOR_ID, 'sentinel-capture', 'sentinel-inventory', 'sentinel-parse'].sort(),
    "the narrow registry: the coordinator's bootstrap operations and the preview detector only",
  );
  assert.deepEqual(p.record.permits, ['pattern-match', 'source-bytes', 'source-span']);
  assert.ok(p.record.capabilities.every((c) => c.adapterId === PREVIEW_DETECTOR_ID));
  assert.deepEqual(Object.keys(p.record.operations).sort(), ['capture', 'inventory', 'parse']);
  assert.ok(
    Object.values(p.record.operations).every((o) => o !== null),
    'every bootstrap stage is bound to its operation',
  );
  assert.equal(foundationProfile().digest, p.digest, 'deterministic');
  assert.equal(p.registry.get(PREVIEW_DETECTOR_ID).coverage, 'per-file-per-rule');
  // Any change to what the profile trusts changes its digest.
  assert.notEqual(foundationProfile(p.registry, { operations: false }).digest, p.digest);
});

test(
  'over a real capture, lock and policy the canonical planner plans exactly the preview rule on TS/JS/Java files',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const root = join(dir, 'repo');
    commitRepo(root, {
      'src/users.ts': 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n',
      'src/Orders.java': 'class Orders { String q = "SELECT * FROM orders WHERE id = ?"; }\n',
      'README.md': '# fixture\n',
    });
    const fx = await openCaptureStore(t, dir);
    const { snapshot } = await captureSnapshot(fx.store, {
      mode: 'working-copy',
      sources: [{ sourceId: 'app', repositoryId: 'example/app', root }],
    });
    unlock(root);
    rmSync(root, { recursive: true, force: true });
    const work = join(dir, 'work');
    mkdirSync(work, { mode: 0o700 });
    const parsed = await parseSnapshot(fx.store, {
      snapshotId: snapshot.id,
      workDir: work,
      selection: { gitignore: true, testFiles: 'include' },
      limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1 << 20, maxEntries: 10_000, maxDurationMs: 60_000 },
    });

    // The shipped pack, promoted the way `rules promote` does: the owner's receipt for this candidate against this lock.
    const pack = validatePack(readPackDirectory(realpathSync.native(builtinPackDir('foundation-preview')!)));
    const book = new ReceiptBook(join(scratch(t, 'sentinel-trust-'), 'receipts'));
    const empty = emptyLock(NOW);
    const intent = promotionIntent(empty, { kind: 'pack', pack });
    const r = issueReceipt(
      book,
      { channel: 'owner-cli', principal: 'owner' },
      { intent, stateDigest: lockDigest(empty), policyRevision: D('p') },
      { now: NOW, ttlMs: 600_000 },
    );
    const lock = promote(
      empty,
      { kind: 'pack', pack },
      book.consume(r.id, { intent, stateDigest: lockDigest(empty), policyRevision: D('p') }, NOW),
      NOW,
    );

    const settings = { ...structuredClone(DEFAULT_SETTINGS), mandatoryRules: [PREVIEW_RULE] };
    const policy = effectivePolicy({
      trust: 'adopted',
      settings,
      settingsDigest: D('settings'),
      repoConfig: null,
      repoConfigDigest: null,
    });
    const profile = foundationProfile();
    // Revision 1 is the bootstrap; with no bootstrap operation bound yet its stages stay blocked, never run here.
    const boot = planBootstrap({ runId: 'run-preview', sourceIds: ['app'], profile: profile.planner });
    const inventory = boot.units.at(-1)!;
    assert.equal(inventory.stage, 'inventory');
    const plan = planAnalysis({
      runId: 'run-preview',
      revision: 2,
      previous: boot,
      bootstrap: [{ id: inventory.id, revision: inventory.revision }],
      profile: profile.planner,
      snapshot: plannerSnapshotFrom(snapshot),
      analyses: parsed.sources.map((s) => plannerAnalysisFrom(s)),
      lock: plannerLockFrom(lock, [pack], lockDigest(lock)),
      policy: plannerPolicyFrom(policy),
    });
    assert.ok(verifyPlanRevision(plan));
    const byScope = Object.fromEntries(
      plan.checks.filter((c) => c.familyId === PREVIEW_RULE).map((c) => [c.scopeId, c.state]),
    );
    assert.deepEqual(
      byScope,
      { 'app:src/Orders.java': 'planned', 'app:src/users.ts': 'planned' },
      'TS/JS/Java files only, never the README',
    );
    assert.ok(
      plan.units.filter((u) => u.stage === 'check').every((u) => u.adapterId === PREVIEW_DETECTOR_ID),
      'only the trusted preview adapter is planned',
    );
    assert.equal(plan.pins.ruleLockDigest, lockDigest(lock));
    assert.equal(plan.pins.policyDigest, policy.revision);
  },
);
