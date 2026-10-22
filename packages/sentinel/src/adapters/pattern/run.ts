// One pattern attempt end to end, through PR 07's execution service only: build the job's inputs in a private folder,
// run the registered adapter (isolated container, pinned image, no pull, no host fallback), read the verified outputs
// and normalize them. Internal to the package: the PR 08 scheduler and the PR 09 command are its callers.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, WorkRef } from '../../contracts/common.js';
import type { ExecutionService } from '../../execution/service.js';
import { releaseWorkDir } from '../../execution/supervisor.js';
import { PATTERN_ADAPTER, type PatternAdapterBuild } from './adapter.js';
import { buildPatternJob, type PatternRule, type PatternTarget } from './job.js';
import { normalizePatternRun, type PatternRunResult } from './normalize.js';

export interface PatternAttempt {
  attemptId: Id;
  work: WorkRef;
  rules: readonly PatternRule[];
  targets: readonly PatternTarget[];
  /** A private (0700) folder for the job's own input files. */
  scratch: string;
  signal?: AbortSignal;
  /** Test seam: another registered adapter (a lowered deadline or a variant built by buildPatternAdapter). */
  adapterId?: Id;
  adapter?: PatternAdapterBuild;
}

export async function runPatternAttempt(service: ExecutionService, attempt: PatternAttempt): Promise<PatternRunResult> {
  const jobDir = mkdtempSync(join(attempt.scratch, 'pattern-job-'));
  try {
    const built = buildPatternJob(attempt.rules, attempt.targets, jobDir, attempt.adapter);
    const outcome = await service.run({
      adapterId: attempt.adapterId ?? attempt.adapter?.definition.id ?? PATTERN_ADAPTER.id, attemptId: attempt.attemptId, work: attempt.work, inputs: built.inputs,
      ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      const byId = new Map(outcome.outputs.map(o => [o.id, o.path]));
      const paths = new Map(attempt.targets.map(t => [t.relativePath, t.path]));
      return normalizePatternRun({
        job: built.job, jobDigest: built.jobDigest, rules: attempt.rules, outcome,
        outputBytes: id => readFileSync(byId.get(id)!),
        targetBytes: rel => readFileSync(paths.get(rel)!),
      });
    } finally {
      releaseWorkDir(outcome.workDir);
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
