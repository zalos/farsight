// One OSV attempt end to end, through PR 07's execution service only: build the job, run the registered adapter
// (isolated container, pinned image, no pull, no network), read the verified outputs and the attempt's sealed input
// copies (never the caller's paths again), normalize, release the work folder. Internal: the PR 08 scheduler and the
// PR 09 command are its callers.
import { closeSync, constants as FS, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, Id, WorkRef } from '../../contracts/common.js';
import type { ExecutionService } from '../../execution/service.js';
import { releaseWorkDir } from '../../execution/supervisor.js';
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

function readSealed(dir: string, artifact: ArtifactId): Uint8Array | undefined {
  const m = /^sha256:([0-9a-f]{64})$/.exec(artifact);
  if (!m) return undefined;
  let fd: number;
  try { fd = openSync(join(dir, m[1]!), FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0)); } catch { return undefined; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    return off === st.size ? buf : undefined;
  } finally { closeSync(fd); }
}

export async function runOsvAttempt(service: ExecutionService, attempt: OsvAttempt): Promise<OsvRunResult> {
  const jobDir = mkdtempSync(join(attempt.scratch, 'osv-job-'));
  try {
    const built = buildOsvJob(attempt.targets, attempt.snapshots, jobDir, attempt.adapter);
    const outcome = await service.run({
      adapterId: attempt.adapterId ?? attempt.adapter?.definition.id ?? OSV_ADAPTER.id, attemptId: attempt.attemptId, work: attempt.work,
      inputs: built.inputs, ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      const byId = new Map(outcome.outputs.map(o => [o.id, o.path]));
      const sealed = join(outcome.workDir, 'input');
      return normalizeOsvRun({
        job: built.job, jobDigest: built.jobDigest, outcome, policy: attempt.policy,
        outputBytes: id => readFileSync(byId.get(id)!), targetBytes: a => readSealed(sealed, a),
        ...(attempt.qualifyingArchitecture ? { qualifyingArchitecture: attempt.qualifyingArchitecture } : {}),
      });
    } finally {
      releaseWorkDir(outcome.workDir);
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
