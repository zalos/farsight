// One Trivy attempt end to end, through PR 07's execution service only: build the job, run the registered adapter
// (isolated container, pinned image, no pull, no network), read the verified outputs and the attempt's sealed input
// copies (never the caller's paths again), normalize, release the work folder. With no bundle, or nothing to send,
// nothing runs and the coverage says why. Internal: the PR 08 scheduler and the PR 09 command are its callers.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, WorkRef } from '../../contracts/common.js';
import type { ExecutionService } from '../../execution/service.js';
import { releaseWorkDir } from '../../execution/supervisor.js';
import { readSealedInput } from '../sealed-input.js';
import { TRIVY_ADAPTER, type TrivyAdapterBuild } from './adapter.js';
import { buildTrivyJob, type BundleInput, type ConfigTarget } from './job.js';
import { normalizeTrivyRun, notRunResult, type TrivyRunResult } from './normalize.js';

/** One attempt run directly through an execution service: its targets, the held bundle and scratch. */
export interface TrivyAttempt {
  attemptId: Id;
  work: WorkRef;
  targets: readonly ConfigTarget[];
  /** The verified pinned bundle (`loadChecksBundle`), or null when it has not been acquired. */
  bundle: BundleInput | null;
  scratch: string;
  signal?: AbortSignal;
  /** Test seams: a variant adapter, or another registered id for the same worker. */
  adapter?: TrivyAdapterBuild;
  adapterId?: Id;
  /** Qualification only: an unmeasured platform of the pinned index whose results are marked candidate. */
  qualifyingArchitecture?: string;
}

/**
 * Builds the job, runs the pinned worker through `service` and normalizes the outcome; with no bundle nothing runs and
 * every file is a gap. The adapter's own tests and conformance runs use it; production runs go through the
 * coordinator and the canonical driver instead.
 */
export async function runTrivyAttempt(service: ExecutionService, attempt: TrivyAttempt): Promise<TrivyRunResult> {
  const jobDir = mkdtempSync(join(attempt.scratch, 'trivy-job-'));
  try {
    const built = buildTrivyJob(attempt.targets, attempt.bundle, jobDir, attempt.adapter);
    const adapterId = attempt.adapterId ?? attempt.adapter?.definition.id ?? TRIVY_ADAPTER.id;
    if (!built.jobDigest) return notRunResult(built.job, adapterId);
    const outcome = await service.run({
      adapterId,
      attemptId: attempt.attemptId,
      work: attempt.work,
      inputs: built.inputs,
      ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      const byId = new Map(outcome.outputs.map((o) => [o.id, o.path]));
      return normalizeTrivyRun({
        job: built.job,
        jobDigest: built.jobDigest,
        outcome,
        outputBytes: (id) => readFileSync(byId.get(id)!),
        targetBytes: (a) => readSealedInput(outcome.workDir, a),
        ...(attempt.qualifyingArchitecture ? { qualifyingArchitecture: attempt.qualifyingArchitecture } : {}),
      });
    } finally {
      releaseWorkDir(outcome.workDir);
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
