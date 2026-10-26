// The ledger-backed checkpoint store (PR 22): review checkpoints live in the model ledger beside the budget they spend,
// written under one coordinator epoch in one transaction. After recovery fences an epoch, a process still running
// under it can no longer save, so a session has exactly one writer; the next epoch resumes from the last checkpoint.
import { parseEnvelope } from '../validate.js';
import type { BudgetLedger } from './providers/budget.js';
import { reviewFail } from './errors.js';
import type { CheckpointStore, ReviewCheckpoint } from './session.js';

const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');

export class LedgerCheckpointStore implements CheckpointStore {
  readonly #ledger: BudgetLedger;
  readonly #epoch: string;
  readonly #now: () => Date;
  constructor(ledger: BudgetLedger, epoch: string, now: () => Date = () => new Date()) {
    this.#ledger = ledger;
    this.#epoch = epoch;
    this.#now = now;
  }
  async load(sessionId: string): Promise<ReviewCheckpoint | null> {
    const row = this.#ledger.loadCheckpoint(sessionId);
    if (!row) return null;
    const v = parseEnvelope('checkpoint', row.body);
    if (!v.ok)
      return reviewFail(
        'sentinel.review.checkpoint',
        `the stored checkpoint does not validate: ${v.errors[0]?.code} ${v.errors[0]?.path}`,
      );
    if (v.value.sessionId !== sessionId)
      reviewFail('sentinel.review.checkpoint', 'the stored checkpoint is not this session’s');
    return v.value;
  }
  async save(cp: ReviewCheckpoint): Promise<void> {
    this.#ledger.saveCheckpoint(cp.sessionId, this.#epoch, JSON.stringify(cp), stamp(this.#now()));
  }
}
