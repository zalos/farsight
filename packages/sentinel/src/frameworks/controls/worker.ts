// The framework inspection worker (ADR 44): a built-in Sentinel adapter run as a supervised child process, never in
// the coordinator. The supervisor pins this module by digest, runs it only through the launch gate with no inherited
// environment and its sealed inputs only, and kills it (SIGKILL) at its deadline, on cancel or when it exceeds its
// output bounds. Memory, CPU and process counts are not hard limits on this path (no cgroup or rlimit for a child),
// and the child is not network-isolated; it is Sentinel's own code, it opens no connection, and it imports, builds and
// runs nothing from the target: the libraries read captured bytes and the retained parser evidence as data.
//
// Inputs (sealed, by content id): one job, the snapshot envelope, the source's retained parser artifact, result and
// index, and the source's captured files. The job is the one input whose JSON names this job schema; any other count is
// refused. Every input it reads is checked against its id. Output: one document with each library's control-fact
// envelopes and frontiers, or the fixed reason a library refused its inputs. The worker claims no coverage: the
// coordinator's driver derives it from this document (facts.ts).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ArtifactId } from '../../contracts/common.js';
import type { ControlFactsEnvelope } from '../../contracts/controls.js';
import type { SnapshotEnvelope } from '../../contracts/snapshot.js';
import { analyzeExpress } from '../express/index.js';
import { analyzeNest } from '../nest/index.js';
import { analyzeNext } from '../next/index.js';
import { analyzeSpring } from '../spring/index.js';
import { FRAMEWORKS, type FrameworkName, type InspectedProperty, type LibraryOutcome } from './facts.js';

export const FRAMEWORK_CONTROLS_ADAPTER_ID = 'framework-controls';
export const CONTROLS_JOB_SCHEMA = 'sentinel-framework-controls-job/draft-1';
export const CONTROLS_OUTPUT_SCHEMA = 'sentinel-framework-controls-output/draft-1';
export const CONTROLS_OUTPUT_MEDIA = 'application/vnd.sentinel.framework-controls+json';

/** The job the driver seals for one unit: what to read, nothing else. */
export interface ControlsJob {
  readonly schema: typeof CONTROLS_JOB_SCHEMA;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly snapshot: ArtifactId;
  readonly analysis: { readonly artifact: ArtifactId; readonly result: ArtifactId; readonly index: ArtifactId };
  readonly properties: readonly InspectedProperty[];
  /** Spring profiles: none selected, so profile-conditioned chains stay unknown. */
  readonly environment: { readonly activeProfiles: null };
}

export interface ControlsOutput {
  readonly schema: typeof CONTROLS_OUTPUT_SCHEMA;
  readonly job: ArtifactId;
  readonly libraries: readonly LibraryOutcome[];
}

const P = 'sentinel-worker/draft-1';
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const HEX = /^sha256:([0-9a-f]{64})$/;

class Refused extends Error {}

/** Reads one sealed input by id, checked against its digest; anything not sealed for this attempt is refused. */
function sealedReader(dir: string, allowed: ReadonlySet<string>) {
  return (id: string): Uint8Array => {
    const m = HEX.exec(id);
    if (!m || !allowed.has(id)) throw new Refused('not a sealed input of this attempt');
    const bytes = readFileSync(`${dir}/${m[1]}`);
    if (hex(bytes) !== m[1]) throw new Refused('a sealed input does not match its id');
    return bytes;
  };
}
const json = (b: Uint8Array): any => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));

/** Runs the four libraries over one source's sealed inputs. Exported for the worker and its tests. */
export async function inspectSealed(job: ControlsJob, read: (id: string) => Uint8Array): Promise<LibraryOutcome[]> {
  const snapshot = json(read(job.snapshot)) as SnapshotEnvelope;
  const artifact = json(read(job.analysis.artifact));
  const result = json(read(job.analysis.result));
  const index = json(read(job.analysis.index));
  if (snapshot?.id !== job.snapshotId || result?.sourceId !== job.sourceId || index?.sourceId !== job.sourceId) throw new Refused('the job does not bind these inputs');
  const readAsync = async (id: ArtifactId) => read(id);
  const run = async (framework: FrameworkName, f: () => Promise<{ envelopes: readonly ControlFactsEnvelope[]; frontiers?: LibraryOutcome['frontiers'] }>): Promise<LibraryOutcome> => {
    try {
      const out = await f();
      return { framework, packDigest: out.envelopes[0]?.packDigest ?? null, envelopes: out.envelopes, ...(out.frontiers ? { frontiers: out.frontiers } : {}) };
    } catch {
      // A library that refuses its inputs says so with a fixed reason; its own message may quote the source.
      return { framework, packDigest: null, envelopes: [], refused: 'sentinel.controls.libraryRefused' };
    }
  };
  const outcomes: Record<FrameworkName, () => Promise<{ envelopes: readonly ControlFactsEnvelope[]; frontiers?: LibraryOutcome['frontiers'] }>> = {
    next: async () => {
      const r = await analyzeNext({ snapshot, analysis: { sourceId: job.sourceId, artifact, result, index }, read: readAsync, properties: [...job.properties] });
      return { envelopes: r.envelopes, frontiers: r.frontiers };
    },
    express: async () => ({ envelopes: [await analyzeExpress({ snapshot, sourceId: job.sourceId, analysis: { artifact, index }, readContent: readAsync })] }),
    nest: async () => ({ envelopes: [(await analyzeNest({ snapshot, sourceId: job.sourceId, graph: artifact.graph, readArtifact: readAsync })).controls] }),
    spring: async () => ({ envelopes: [await analyzeSpring({ snapshot, sourceId: job.sourceId, analysis: { artifact, index }, readContent: readAsync, environment: { activeProfiles: null } })] }),
  };
  const libraries: LibraryOutcome[] = [];
  for (const framework of FRAMEWORKS) libraries.push(await run(framework, outcomes[framework]));
  return libraries;
}

/** The worker protocol over this process's stdin and stdout. */
export async function runFrameworkControlsWorker(): Promise<void> {
  const IN = process.env.SENTINEL_INPUT!;
  const OUT = process.env.SENTINEL_OUTPUT!;
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const lines: Record<string, any>[] = [];
  let wake: (() => void) | undefined;
  let buffered = '';
  process.stdin.on('data', (b: Buffer) => {
    buffered += b.toString('utf8');
    for (let nl; (nl = buffered.indexOf('\n')) >= 0;) { lines.push(JSON.parse(buffered.slice(0, nl))); buffered = buffered.slice(nl + 1); wake?.(); }
  });
  const next = async () => { while (!lines.length) await new Promise<void>(r => { wake = r; }); return lines.shift()!; };
  send({ protocol: P, type: 'hello', supported: [P], adapterId: process.env.SENTINEL_ADAPTER_ID, adapterDigest: process.env.SENTINEL_ADAPTER_DIGEST });
  if ((await next()).type !== 'welcome') process.exit(9);
  const start = await next();
  if (start.type !== 'start') process.exit(9);
  const binding = { attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch };
  let seq = 0;
  const refuse = (code: string) => { send({ protocol: P, type: 'diagnostic', ...binding, seq: seq++, code }); process.exit(3); };
  const inputs = new Set<string>((start.inputs ?? []) as string[]);
  const read = sealedReader(IN, inputs);
  // The job by its own schema, exactly once: a captured file cannot stand in for it unseen, and two are refused.
  const jobs: { id: string; job: ControlsJob }[] = [];
  for (const id of inputs) {
    let value: any;
    try { value = json(read(id)); } catch { continue; }
    if (value?.schema === CONTROLS_JOB_SCHEMA) jobs.push({ id, job: value });
  }
  if (jobs.length !== 1) return refuse('sentinel.controls.jobInvalid');
  let libraries: LibraryOutcome[];
  try { libraries = await inspectSealed(jobs[0]!.job, read); } catch { return refuse('sentinel.controls.jobInvalid'); }
  const doc = Buffer.from(JSON.stringify({ schema: CONTROLS_OUTPUT_SCHEMA, job: jobs[0]!.id, libraries } satisfies ControlsOutput));
  const h = hex(doc);
  writeFileSync(`${OUT}/${h}`, doc);
  send({
    protocol: P, type: 'result', ...binding, seq: seq++, inputFingerprint: start.inputFingerprint, granularity: 'aggregate',
    artifacts: [{ id: `sha256:${h}`, mediaType: CONTROLS_OUTPUT_MEDIA, bytes: doc.length }], observations: [],
    // No self-reported coverage: only the driver's view of this document counts.
    coveredChecks: [], scannedSet: [], skipped: [], actualReadSet: [], unresolvedFrontiers: [], diagnostics: [],
  });
}

// Run as the built-in adapter's module (`node --import <gate> <this module> …`); importing it runs nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runFrameworkControlsWorker();
