// The host script stage (Sentinel v2 §3.1): an owner-promoted entry file run on this computer as a child process.
//
// A `script` stage with `runner: host` runs only while the adopted settings turn `stage.host-scripts` on (the
// coordinator checks it at dispatch). Its unit is one of the coordinator's own operations (`sentinel.script.host`,
// whose digest covers this module's bytes); what makes each unit's work its own is the entry file, pinned by digest
// in the run's execution profile and covered by the unit's input fingerprint (scriptFingerprintOf).
//
// One attempt: the entry bytes the owner supplied are checked against the pinned digest before anything is written
// (a changed byte refuses the attempt at start); a private scratch folder receives the entry and the stage's
// declared inputs (the exact artifacts stage-inputs.ts resolved, after the secret fold), with `inputs.json` listing
// them; the interpreter (this Node, or /bin/sh) runs the entry there with an empty environment, no stdin, the unit's
// deadline and its output bound; it must exit 0 and print one JSON document whose `schema` is the stage's declared
// output schema. A failed validation is a failed attempt, never a partial publication. The document and the stage's
// provenance (entry digest, interpreter name, version and digest, argv, environment names) are what it publishes.
//
// Host execution is the weaker isolation class, and the provenance says so (`where: 'host'`): the child shares this
// account, its file system and its network. It is given nothing to read but its folder, and nothing it writes
// outside stdout is kept, but nothing confines it to that. The supervisor's limits on memory and processes are not
// applied to it; only the deadline and the output bound are.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, Digest, Id, Timestamp, WorkRef } from '../contracts/common.js';
import type { ScriptProvenance, ScriptStageDefinition, StageInputBinding } from '../contracts/pipeline.js';
import type { ArtifactPrivacy } from '../store/store-types.js';
import type { SentinelStore } from '../store/index.js';
import { scriptOutputOf, SCRIPT_CONTRACT, scriptFingerprintOf } from '../planner/pipeline.js';
export { scriptOutputOf, SCRIPT_CONTRACT, scriptFingerprintOf };
import type { PreparedOutputs } from './bootstrap.js';
import { ExecutionError } from './errors.js';

/** This module's own file: the script runner operation's digest covers these bytes (registry.ts). */
export const SCRIPT_RUNNER_IMPLEMENTATION_URL = import.meta.url;
/** The registered operation that runs host scripts. */
export const SCRIPT_RUNNER_ID = 'sentinel.script.host';
/** Its registration (createAdapterRegistry): one of the coordinator's own operations, over this module's bytes. */
export const SCRIPT_RUNNER_DEFINITION = Object.freeze({
  id: SCRIPT_RUNNER_ID,
  version: '1',
  kind: 'operation' as const,
  operation: 'script' as const,
});
export const SCRIPT_PROVENANCE_SCHEMA = 'sentinel-script-provenance/draft-1';
export const SCRIPT_INPUTS_SCHEMA = 'sentinel-script-inputs/draft-1';
/** Captured stderr is bounded and never published; it only shortens a failure's detail. */
const MAX_STDERR_BYTES = 65_536;
const sha256 = (b: Uint8Array): Digest => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** The interpreter a script runs under, as found on this computer. */
interface Interpreter {
  name: 'node' | 'sh';
  path: string;
  version: string;
  digest: Digest | null;
}
const interpreters = new Map<string, Interpreter>();
function interpreterOf(name: 'node' | 'sh'): Interpreter {
  const known = interpreters.get(name);
  if (known) return known;
  const path = name === 'node' ? process.execPath : '/bin/sh';
  let digest: Digest | null;
  try {
    digest = sha256(readFileSync(path));
  } catch {
    digest = null;
  }
  const found: Interpreter = { name, path, version: name === 'node' ? process.version : 'posix-sh', digest };
  interpreters.set(name, found);
  return found;
}

export interface HostScriptRequest {
  readonly store: SentinelStore;
  readonly stage: ScriptStageDefinition;
  readonly unit: WorkRef;
  readonly attemptId: Id;
  readonly invocation: ArtifactId;
  /** The entry bytes the owner supplied, and the digest the run's profile pins for them. */
  readonly entry: Uint8Array;
  readonly entryDigest: Digest;
  /** The stage's resolved typed inputs (every one resolved, folded for secrets). */
  readonly inputs: readonly StageInputBinding[];
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
}

/** Refuses entry bytes that are not the ones the run pins, before anything is written or started. */
export function checkEntry(entry: Uint8Array | undefined, digest: Digest): Uint8Array {
  if (!entry || sha256(entry) !== digest)
    throw new ExecutionError('sentinel.execution.inputMismatch', {
      reason: 'the script entry is not the bytes the run pins',
    });
  return entry;
}

const now = (): Timestamp => new Date().toISOString();

/** Runs one host script attempt and prepares what it publishes: its output document and its provenance. */
export async function runHostScript(request: HostScriptRequest): Promise<PreparedOutputs> {
  const { store, stage } = request;
  const output = scriptOutputOf(stage);
  if (!output)
    throw new ExecutionError('sentinel.execution.planInvalid', {
      reason: `script stage ${stage.id} declares exactly one named output`,
    });
  const entry = checkEntry(request.entry, request.entryDigest);
  const interpreter = interpreterOf(stage.interpreter);
  const dir = join(request.scratchRoot, `script.${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  const startedAt = now();
  const t0 = performance.now();
  try {
    // The folder holds exactly the entry and the declared inputs, each read back from the store (which verifies it).
    const entryName = stage.interpreter === 'node' ? 'entry.mjs' : 'entry.sh';
    writeFileSync(join(dir, entryName), entry, { mode: 0o400 });
    const read: ArtifactId[] = [request.entryDigest as ArtifactId];
    const listed: Array<{ stage: string; output: string; files: string[] }> = [];
    mkdirSync(join(dir, 'inputs'), { mode: 0o700 });
    request.inputs.forEach((input, n) => {
      const decl = input.decl as { stage: string; output: string };
      const folder = `inputs/${n}-${decl.stage}-${decl.output}`;
      mkdirSync(join(dir, folder), { mode: 0o700 });
      listed.push({ stage: decl.stage, output: decl.output, files: [] });
    });
    for (const [n, input] of request.inputs.entries()) {
      const decl = input.decl as { stage: string; output: string };
      for (const id of input.artifacts) {
        request.signal.throwIfAborted();
        const bytes = await store.readArtifact(id);
        const file = `inputs/${n}-${decl.stage}-${decl.output}/${id.slice(7)}.json`;
        writeFileSync(join(dir, file), bytes, { mode: 0o400 });
        listed[n]!.files.push(file);
        read.push(id);
      }
    }
    writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ schema: SCRIPT_INPUTS_SCHEMA, inputs: listed }), {
      mode: 0o400,
    });
    chmodSync(join(dir, 'inputs'), 0o500);
    const argv = [entryName, ...(stage.args ?? [])];
    const result = await spawnBounded(interpreter.path, argv, dir, request);
    if (result.exitCode !== 0)
      throw new ExecutionError('sentinel.execution.commandFailed', {
        reason: `the script exited ${result.signal ?? result.exitCode}`,
      });
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(result.stdout));
    } catch {
      throw new ExecutionError('sentinel.execution.outputMismatch', { reason: 'the script printed no JSON document' });
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc as { schema?: unknown }).schema !== output.schema)
      throw new ExecutionError('sentinel.execution.outputMismatch', {
        reason: `the script's output is not a ${output.schema} document`,
      });
    const docId = store.objects.identifyCanonicalJson(doc).id as ArtifactId;
    const endedAt = now();
    const provenance: ScriptProvenance = {
      kind: 'script',
      stage: stage.id,
      unit: { id: request.unit.id, revision: request.unit.revision },
      attempt: request.attemptId,
      where: 'host',
      startedAt,
      endedAt,
      durationMs: Math.round(performance.now() - t0),
      read,
      wrote: [docId],
      invocation: request.invocation,
      entryDigest: request.entryDigest,
      interpreter: { name: interpreter.name, version: interpreter.version, digest: interpreter.digest },
      argv,
      environmentNames: [],
      image: null,
    };
    const items: Array<{ value: unknown; schema: string; privacy: ArtifactPrivacy }> = [
      { value: doc, schema: output.schema, privacy: 'source-derived' },
      { value: provenance, schema: SCRIPT_PROVENANCE_SCHEMA, privacy: 'metadata' },
    ];
    const records: PreparedOutputs['records'] = [];
    const outputs: ArtifactId[] = [];
    let bytes = 0;
    for (const item of items) {
      const id = store.objects.identifyCanonicalJson(item.value);
      records.push({ ...item, links: [] });
      outputs.push(id.id as ArtifactId);
      bytes += id.rawSize;
    }
    return { records, outputs, bytes, usage: { certainty: 'not-applicable' } };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for an explicit cleanup of the scratch root */
    }
  }
}

/** The child under its deadline and output bound, with an empty environment and no stdin. */
function spawnBounded(
  command: string,
  argv: readonly string[],
  cwd: string,
  request: HostScriptRequest,
): Promise<{ exitCode: number | null; signal: string | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], { cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let refusal: ExecutionError | undefined;
    const stop = (why: ExecutionError) => {
      refusal ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => stop(new ExecutionError('sentinel.execution.deadlineExceeded', { deadlineMs: request.deadlineMs })),
      request.deadlineMs,
    );
    const onAbort = () => stop(new ExecutionError('sentinel.execution.canceled', { reason: 'the run was stopped' }));
    request.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > request.maxOutputBytes)
        stop(new ExecutionError('sentinel.execution.outputTooLarge', { limit: request.maxOutputBytes }));
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_STDERR_BYTES) stop(new ExecutionError('sentinel.execution.stderrBudget', {}));
    });
    child.on('error', () =>
      stop(new ExecutionError('sentinel.execution.commandFailed', { reason: 'the interpreter could not start' })),
    );
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      if (refusal) reject(refusal);
      else resolve({ exitCode: code, signal, stdout: Buffer.concat(out) });
    });
  });
}
