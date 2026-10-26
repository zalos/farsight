// One OSV attempt end to end, through PR 07's execution service only: build the job, run the registered adapter
// (isolated container, pinned image, no pull, no network), read the verified outputs and the attempt's sealed input
// copies (never the caller's paths again), normalize, release the work folder. Internal: the PR 08 scheduler and the
// PR 09 command are its callers.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, WorkRef } from '../../contracts/common.js';
import type { ExecutionService } from '../../execution/service.js';
import { releaseWorkDir } from '../../execution/supervisor.js';
import { readSealedInput } from '../sealed-input.js';
import { OSV_ADAPTER, type OsvAdapterBuild } from './adapter.js';
import { buildOsvJob, type DependencyTarget, type SnapshotInput } from './job.js';
import { normalizeOsvRun, type OsvRunResult } from './normalize.js';

export interface OsvAttempt {
  attemptId: Id;
  work: WorkRef;
  targets: readonly DependencyTarget[];
  snapshots: readonly SnapshotInput[];
  scratch: string;
  policy: { now: Date; maxDatabaseAgeMs: number };
  signal?: AbortSignal;
  /** Test seams: a variant adapter, or another registered id for the same worker. */
  adapter?: OsvAdapterBuild;
  adapterId?: Id;
  /** Qualification only: an unmeasured platform of the pinned index whose results are marked candidate. */
  qualifyingArchitecture?: string;
}

export async function runOsvAttempt(service: ExecutionService, attempt: OsvAttempt): Promise<OsvRunResult> {
  const jobDir = mkdtempSync(join(attempt.scratch, 'osv-job-'));
  try {
    const built = buildOsvJob(attempt.targets, attempt.snapshots, jobDir, attempt.adapter);
    const outcome = await service.run({
      adapterId: attempt.adapterId ?? attempt.adapter?.definition.id ?? OSV_ADAPTER.id,
      attemptId: attempt.attemptId,
      work: attempt.work,
      inputs: built.inputs,
      ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      const byId = new Map(outcome.outputs.map((o) => [o.id, o.path]));
      return normalizeOsvRun({
        job: built.job,
        jobDigest: built.jobDigest,
        outcome,
        policy: attempt.policy,
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
