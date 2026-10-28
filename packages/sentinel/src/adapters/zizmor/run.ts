// One zizmor attempt end to end, through PR 07's execution service only: build the job, run the registered adapter
// (isolated container, pinned image, no pull, no network), read the verified outputs and the attempt's sealed input
// copies, normalize, release the work folder. Internal: the PR 08 scheduler and the PR 09 command are its callers.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, WorkRef } from '../../contracts/common.js';
import type { ExecutionService } from '../../execution/service.js';
import { releaseWorkDir } from '../../execution/supervisor.js';
import { readSealedInput } from '../sealed-input.js';
import { ZIZMOR_ADAPTER, type ZizmorAdapterBuild } from './adapter.js';
import { buildZizmorJob, type CiTarget } from './job.js';
import { normalizeZizmorRun, notRunZizmor, type ZizmorRunResult } from './normalize.js';

/** One attempt run directly through an execution service: its targets and scratch. */
export interface ZizmorAttempt {
  attemptId: Id;
  work: WorkRef;
  targets: readonly CiTarget[];
  scratch: string;
  signal?: AbortSignal;
  adapter?: ZizmorAdapterBuild;
  adapterId?: Id;
  qualifyingArchitecture?: string;
}

/**
 * Builds the job, runs the pinned worker through `service` and normalizes the outcome; with nothing to send nothing
 * runs. The adapter's own tests and conformance runs use it; production runs go through the coordinator and the
 * canonical driver instead.
 */
export async function runZizmorAttempt(service: ExecutionService, attempt: ZizmorAttempt): Promise<ZizmorRunResult> {
  const jobDir = mkdtempSync(join(attempt.scratch, 'zizmor-job-'));
  try {
    const built = buildZizmorJob(attempt.targets, jobDir, attempt.adapter);
    const adapterId = attempt.adapterId ?? attempt.adapter?.definition.id ?? ZIZMOR_ADAPTER.id;
    if (!built.jobDigest) return notRunZizmor(built.job, adapterId);
    const outcome = await service.run({
      adapterId,
      attemptId: attempt.attemptId,
      work: attempt.work,
      inputs: built.inputs,
      ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      const byId = new Map(outcome.outputs.map((o) => [o.id, o.path]));
      return normalizeZizmorRun({
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
