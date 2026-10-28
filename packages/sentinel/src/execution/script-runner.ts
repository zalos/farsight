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
// A host script is unconfined by design (the lead's ruling of 2026-10-28): it runs as the owner, with the owner's file
// system and network, like any script the owner runs, and only while the adopted settings turn `stage.host-scripts`
// on. Its provenance says so (`where: 'host'`, `confinement: 'none'`). It is started with nothing to read but its
// folder and nothing it writes outside stdout is kept, but nothing confines it to that. It runs in its own process
// group: at its deadline, at its output bound and when the interpreter exits, the whole group is killed, so a
// descendant can neither outlive the attempt nor hold it open. The supervisor's memory and process limits are not
// applied to it; only the deadline and the output bound are.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Ajv } from 'ajv';
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
/** How long output still in flight is read after the interpreter exits. */
const EXIT_GRACE_MS = 250;
/** Captured stderr is bounded and never published; it only shortens a failure's detail. */
const MAX_STDERR_BYTES = 65_536;
const sha256 = (b: Uint8Array): Digest => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** The interpreter a script runs under, measured on this computer: its absolute path, its bytes' digest, its version. */
interface Interpreter {
  name: 'node' | 'sh';
  path: string;
  version: string;
  digest: Digest;
}
/** What `/bin/sh` is called when it answers no version: it is identified by its digest alone, and says so. */
export const SH_UNVERSIONED = 'no version reported; identified by its digest';
const interpreters = new Map<string, Interpreter>();
/**
 * The interpreter's measured identity, refused when it cannot be measured: an unreadable binary has no digest, and a
 * script never runs under an interpreter whose bytes are unknown. Node's version is this running Node's; `/bin/sh`'s
 * is what `sh --version` answers, in an empty environment, or SH_UNVERSIONED.
 */
export function interpreterOf(name: 'node' | 'sh'): Interpreter {
  const path = name === 'node' ? process.execPath : '/bin/sh';
  let key: string;
  let bytes: Buffer;
  try {
    const st = statSync(path);
    key = `${name}\u0000${path}\u0000${st.size}\u0000${st.mtimeMs}`;
    const known = interpreters.get(key);
    if (known) return known;
    bytes = readFileSync(path);
  } catch {
    throw new ExecutionError('sentinel.execution.interpreterUnmeasured', { interpreter: name });
  }
  let version = process.version;
  if (name === 'sh') {
    const asked = spawnSync(path, ['--version'], { env: {}, timeout: 2000, encoding: 'utf8', stdio: 'pipe' });
    const line = asked.status === 0 ? (asked.stdout ?? '').split('\n')[0]!.trim() : '';
    version = line ? line.slice(0, 200) : SH_UNVERSIONED;
  }
  const found: Interpreter = { name, path, version, digest: sha256(bytes) };
  interpreters.set(key, found);
  return found;
}

/** The largest output schema a stage pack may hold. */
const MAX_SCHEMA_BYTES = 262_144;

export interface HostScriptRequest {
  readonly store: SentinelStore;
  readonly stage: ScriptStageDefinition;
  readonly unit: WorkRef;
  readonly attemptId: Id;
  readonly invocation: ArtifactId;
  /** The entry bytes the owner supplied, and the digest the run's profile pins for them. */
  readonly entry: Uint8Array;
  readonly entryDigest: Digest;
  /** The declared output schema's JSON Schema bytes, and the digest the run's profile pins for them. */
  readonly outputSchema: Uint8Array;
  readonly outputSchemaDigest: Digest;
  /** The stage's resolved typed inputs (every one resolved, folded for secrets). */
  readonly inputs: readonly StageInputBinding[];
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
}

/** Refuses an entry or a schema whose bytes are not the ones the run pins, before anything is written or started. */
export function checkEntry(
  bytes: Uint8Array | undefined,
  digest: Digest,
  what: 'entry' | 'output schema' = 'entry',
): Uint8Array {
  if (!bytes || sha256(bytes) !== digest)
    throw new ExecutionError('sentinel.execution.inputMismatch', {
      reason: `the script ${what} is not the bytes the run pins`,
    });
  return bytes;
}

/** Compiles the declared output schema, refusing one that is not a bounded JSON Schema document. */
function outputValidator(bytes: Uint8Array, id: string): (doc: unknown) => boolean {
  try {
    if (bytes.byteLength > MAX_SCHEMA_BYTES) throw new Error('too large');
    const schema = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as object;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('not an object');
    const compiled = new Ajv({ allErrors: false, strict: false, validateSchema: true }).compile(schema);
    return (doc) => compiled(doc) === true;
  } catch {
    throw new ExecutionError('sentinel.execution.inputMismatch', {
      reason: `the output schema ${id} is not a JSON Schema document`,
    });
  }
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
  const validates = outputValidator(
    checkEntry(request.outputSchema, request.outputSchemaDigest, 'output schema'),
    output.schema,
  );
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
    // The document names its schema and validates against the pinned schema; nothing else is published.
    if (
      !doc ||
      typeof doc !== 'object' ||
      Array.isArray(doc) ||
      (doc as { schema?: unknown }).schema !== output.schema ||
      !validates(doc)
    )
      throw new ExecutionError('sentinel.execution.outputMismatch', {
        reason: `the script's output is not a valid ${output.schema} document`,
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
      interpreter: {
        name: interpreter.name,
        version: interpreter.version,
        digest: interpreter.digest,
        path: interpreter.path,
      },
      confinement: 'none',
      outputSchema: { id: output.schema, digest: request.outputSchemaDigest },
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

/**
 * The child in its own process group, under its deadline and output bound, with an empty environment and no stdin.
 * The attempt settles when the interpreter exits, whatever its descendants do: the group is killed then (and at the
 * deadline or the output bound), and a stream a descendant still holds open is not waited for beyond a short grace.
 */
function spawnBounded(
  command: string,
  argv: readonly string[],
  cwd: string,
  request: HostScriptRequest,
): Promise<{ exitCode: number | null; signal: string | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], {
      cwd,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let refusal: ExecutionError | undefined;
    let exited: { code: number | null; signal: string | null } | undefined;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the group has ended */
      }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      request.signal.removeEventListener('abort', onAbort);
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      if (refusal) reject(refusal);
      else if (exited) resolve({ exitCode: exited.code, signal: exited.signal, stdout: Buffer.concat(out) });
      else reject(new ExecutionError('sentinel.execution.commandFailed', { reason: 'the script did not exit' }));
    };
    const stop = (why: ExecutionError) => {
      refusal ??= why;
      killGroup();
      settle();
    };
    const timer = setTimeout(
      () => stop(new ExecutionError('sentinel.execution.deadlineExceeded', { deadlineMs: request.deadlineMs })),
      request.deadlineMs,
    );
    let grace: ReturnType<typeof setTimeout> | undefined;
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
    // The interpreter's exit ends the attempt: its descendants are killed with the group, and the output it wrote is
    // read until its stream closes or a short grace passes (a descendant cannot hold the attempt open).
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      killGroup();
      grace = setTimeout(settle, EXIT_GRACE_MS);
    });
    child.on('close', () => {
      if (exited) settle();
    });
  });
}
