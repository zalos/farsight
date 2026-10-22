// One secret-scan attempt end to end, through PR 07's execution service only: build the job, run the registered
// adapter (isolated container, pinned image, no pull, no network), read the verified outputs and the attempt's sealed
// input copies (never the caller's paths again), normalize, release the work folder. Internal: the PR 08 scheduler and
// the PR 09 command are its callers.
import { closeSync, constants as FS, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, Id, WorkRef } from '../../contracts/common.js';
import type { ExecutionService } from '../../execution/service.js';
import { releaseWorkDir, type WorkerOutcome } from '../../execution/supervisor.js';
import { GITLEAKS_PRODUCTION_BUILD, type GitleaksAdapterBuild } from './adapter.js';
import { buildSecretsJob, type SecretsTarget } from './job.js';
import { normalizeSecretsRun, type SecretsScanResult } from './normalize.js';

export interface SecretsAttempt {
  attemptId: Id;
  work: WorkRef;
  snapshotId: Id;
  sourceId: Id;
  targets: readonly SecretsTarget[];
  /** A private folder for the job files. */
  scratch: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Test seam: a variant adapter (its own id and digests). */
  adapter?: GitleaksAdapterBuild;
  /** Qualification only: an unmeasured platform of the pinned index whose results are marked candidate. */
  qualifyingArchitecture?: string;
  /** Test seam: sees the supervised outcome while its verified outputs still exist, before the work folder is released. */
  inspect?: (outcome: WorkerOutcome) => void;
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

export async function runSecretsAttempt(service: ExecutionService, attempt: SecretsAttempt): Promise<SecretsScanResult> {
  const adapter = attempt.adapter ?? GITLEAKS_PRODUCTION_BUILD;
  const jobDir = mkdtempSync(join(attempt.scratch, 'gitleaks-job-'));
  try {
    const built = buildSecretsJob({ snapshotId: attempt.snapshotId, sourceId: attempt.sourceId, targets: attempt.targets }, jobDir, adapter);
    const outcome = await service.run({
      adapterId: adapter.definition.id, attemptId: attempt.attemptId, work: attempt.work, inputs: built.inputs,
      ...(attempt.signal ? { signal: attempt.signal } : {}),
    });
    try {
      attempt.inspect?.(outcome);
      const byId = new Map(outcome.outputs.map(o => [o.id, o.path]));
      const sealed = join(outcome.workDir, 'input');
      return normalizeSecretsRun({
        job: built.job, jobDigest: built.jobDigest, outcome, observedAt: (attempt.now?.() ?? new Date()).toISOString(),
        outputBytes: id => { const p = byId.get(id); return p ? readFileSync(p) : undefined; },
        targetBytes: a => readSealed(sealed, a),
        ...(attempt.qualifyingArchitecture ? { qualifyingArchitecture: attempt.qualifyingArchitecture } : {}),
      });
    } finally {
      releaseWorkDir(outcome.workDir);
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
