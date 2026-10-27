// Read-only current owner data. Opaque list keys never authorize execution or reveal source labels/object handles.
import { randomBytes } from 'node:crypto';
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import { loadPlan } from '../execution/plans.js';
import { DEFAULT_CAPACITY } from '../execution/scheduler.js';
import { withStoreReadBudget, readBudgetCheckpoint } from '../store/read-budget.js';
import { reviewIdentityIn } from '../service/review-adapter.js';
import { OwnerUiError } from './session.js';
import { assertOwnerUiProof, type OwnerUiProof } from './authority.js';
export class OwnerUiProcess {
  readonly #store: SentinelStore;
  readonly #lists = new Map<string, { until: number; keys: Map<string, string> }>();
  constructor(store: SentinelStore) {
    boundOwner(store).assertHeld();
    this.#store = store;
  }
  #held(proof: OwnerUiProof) {
    assertOwnerUiProof(proof);
    this.#store.assertHeld();
    if (proof.issuer.storeId !== this.#store.storeId || proof.issuer.ownerEpoch !== this.#store.epoch)
      throw new OwnerUiError();
    for (const [key, list] of this.#lists) if (performance.now() >= list.until) this.#lists.delete(key);
  }
  runs(proof: OwnerUiProof) {
    this.#held(proof);
    const rows = this.#store.ledger.listRuns(65),
      keys = new Map<string, string>(),
      runs = rows.slice(0, 64).map((row) => {
        const key = 'h' + randomBytes(16).toString('hex');
        keys.set(key, row.id);
        return { key, state: row.state, revision: row.planRevision, createdAt: row.createdAt };
      });
    if (this.#lists.size >= 4 && !this.#lists.has(proof.issuer.sessionDigest))
      this.#lists.delete(this.#lists.keys().next().value!);
    this.#lists.set(proof.issuer.sessionDigest, { until: performance.now() + 60000, keys });
    return { runs, more: rows.length > 64 };
  }
  resolve(proof: OwnerUiProof, key: unknown) {
    this.#held(proof);
    if (typeof key !== 'string' || !/^h[a-f0-9]{32}$/.test(key)) throw new OwnerUiError();
    const runId = this.#lists.get(proof.issuer.sessionDigest)?.keys.get(key);
    if (!runId || !this.#store.ledger.getRun(runId)) throw new OwnerUiError('sentinel.ownerUi.changed');
    return { runId };
  }
  async details(proof: OwnerUiProof, runId: string, signal?: AbortSignal) {
    this.#held(proof);
    const original = this.#store.ledger.getRun(runId);
    if (!original) throw new OwnerUiError('sentinel.service.runUnknown');
    const sequence = this.#store.ledger.currentSequence();
    const result = await withStoreReadBudget(this.#store, { durationMs: 20000, signal }, async () => {
      const admitted = await loadPlan(this.#store, runId, original.planRevision);
      readBudgetCheckpoint(this.#store);
      this.#held(proof);
      const review = await reviewIdentityIn(this.#store, runId);
      readBudgetCheckpoint(this.#store);
      this.#held(proof);
      return {
        grants: ['capture', 'parse', 'inventory', 'check'].map((stage) => ({
          stage,
          ...admitted.profile.resources[stage as keyof typeof admitted.profile.resources],
        })),
        scheduler: { history: 'unrecorded' as const, currentDefault: { ...DEFAULT_CAPACITY } },
        review,
        runDeadlineAt: new Date(
          Date.parse(original.envelope.createdAt) + original.envelope.budgets.deadlineMs,
        ).toISOString(),
      };
    });
    this.#held(proof);
    const current = this.#store.ledger.getRun(runId);
    if (
      signal?.aborted ||
      !current ||
      current.planRevision !== original.planRevision ||
      current.envelope.snapshotId !== original.envelope.snapshotId ||
      this.#store.ledger.currentSequence() !== sequence
    )
      throw new OwnerUiError('sentinel.service.viewChanged');
    return result.value;
  }
  close() {
    this.#lists.clear();
  }
}
