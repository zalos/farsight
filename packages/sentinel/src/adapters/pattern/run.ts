// One pattern attempt end to end, through PR 07's execution service only: build the job's inputs in a private folder,
// run the registered adapter (isolated container, pinned image, no pull, no host fallback), read the verified outputs
// and normalize them. Internal to the package: the PR 08 scheduler and the PR 09 command are its callers.
import { closeSync, constants as FS, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, Id, WorkRef } from '../../contracts/common.js';
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
  /** Qualification only: see NormalizeInput.qualifyingArchitecture. */
  qualifyingArchitecture?: string;
}

export async function runPatternAttempt(service: ExecutionService, attempt: PatternAttempt): Promise<PatternRunResult> {
  const jobDir = mkdtempSync(join(attempt.scratch, 'pattern-job-'));
  try {
    const built = buildPatternJob(attempt.rules, attempt.targets, jobDir, attempt.adapter);
    const outcome = await service.run({
      adapterId: attempt.adapterId ?? attempt.adapter?.definition.id ?? PATTERN_ADAPTER.id,
      attemptId: attempt.attemptId,
      work: attempt.work,
      inputs: built.inputs,
      ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      const byId = new Map(outcome.outputs.map((o) => [o.id, o.path]));
      // Targets are read from the attempt's sealed input copies, the bytes the supervisor hashed while copying and the
      // engine actually scanned; never again from the caller's paths, which may have changed since.
      const sealed = join(outcome.workDir, 'input');
      return normalizePatternRun({
        job: built.job,
        jobDigest: built.jobDigest,
        rules: attempt.rules,
        outcome,
        outputBytes: (id) => readFileSync(byId.get(id)!),
        targetBytes: (artifact) => readSealed(sealed, artifact),
        ...(attempt.qualifyingArchitecture ? { qualifyingArchitecture: attempt.qualifyingArchitecture } : {}),
      });
    } finally {
      releaseWorkDir(outcome.workDir);
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}

/** One sealed input copy by artifact id, read without following a link; undefined when it is not there. */
function readSealed(dir: string, artifact: ArtifactId): Uint8Array | undefined {
  const m = /^sha256:([0-9a-f]{64})$/.exec(artifact);
  if (!m) return undefined;
  let fd: number;
  try {
    fd = openSync(join(dir, m[1]!), FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? buf : undefined;
  } finally {
    closeSync(fd);
  }
}
