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
// group, and its descendants are listed while it runs: at its deadline, at its output bound and when the interpreter
// exits, its group and every descendant that left it (a `detached` child in a group of its own) are frozen and killed,
// each process only after its identity is verified again while it is stopped (reapTree), so a descendant can neither
// outlive the attempt nor hold it open, and a reused pid is never signalled but to stop it and continue it at once.
// The limit of that guarantee: a descendant that leaves the tree before a listing sees it (within TREE_POLL_MS), or is
// spawned between the last listing and the kill; on macOS a process's start time resolves to the second. The supervisor's memory and process limits are not
// applied to it; only the deadline and the output bound are.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * One process as the system lists it: its id, its parent, its group, its state, and when it started. A process is the
 * script's by pid and start together, so a pid the system reused for another process is never taken for it. The start
 * is the kernel's start time in clock ticks on Linux (`/proc/<pid>/stat`), and `ps`'s `lstart` elsewhere, which
 * resolves to the second.
 */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** The state letters (`T`: stopped; `Z`: exited, not yet reaped). */
  readonly state: string;
  readonly started: string;
}

/** Reads the process table, and the current rows of named pids: injectable so a test can replace a pid's identity. */
export interface ProcessReader {
  table(): Promise<ProcessRow[]>;
  rows(pids: readonly number[]): Promise<ProcessRow[]>;
}

/** How often a running script's descendants are listed, so one that leaves the tree is still known at the end. */
const TREE_POLL_MS = 100;
/** How long one listing of the process table may take before the attempt settles without it. */
const PS_TIMEOUT_MS = 2_000;
/** How many times the tree is listed and frozen again for what was started before it stopped. */
const FREEZE_ROUNDS = 3;

/** One `/proc/<pid>/stat` line as a row: the fields after the command name (which may hold spaces and parentheses). */
export function procRow(pid: number, line: string): ProcessRow | undefined {
  const rest = line.slice(line.lastIndexOf(')') + 2).split(' ');
  if (rest.length < 20) return undefined;
  return { pid, state: rest[0]!, ppid: Number(rest[1]), pgid: Number(rest[2]), started: `ticks:${rest[19]}` };
}
function procRows(pids: Iterable<number>): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const pid of pids)
    try {
      const row = procRow(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (row) rows.push(row);
    } catch {
      /* it has ended */
    }
  return rows;
}
/** `ps` with a fixed environment; an exit status (a named pid that has ended) still yields the rows it printed. */
function psRows(args: readonly string[]): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      [...args, '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
      { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' }, timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') return resolve([]);
        const rows: ProcessRow[] = [];
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
          if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), state: m[4]!, started: m[5]! });
        }
        resolve(rows);
      },
    );
  });
}
/** This computer's processes: `/proc` on Linux, `ps` elsewhere. A table that cannot be read is empty. */
export const SYSTEM_PROCESSES: ProcessReader = Object.freeze({
  table: async () => {
    if (process.platform !== 'linux') return psRows(['-A']);
    try {
      return procRows(
        readdirSync('/proc')
          .filter((n) => /^\d+$/.test(n))
          .map(Number),
      );
    } catch {
      return [];
    }
  },
  rows: async (pids: readonly number[]) =>
    !pids.length ? [] : process.platform === 'linux' ? procRows(pids) : psRows(['-p', pids.join(',')]),
});

/**
 * The processes of `table` that are the script's: every row whose identity (pid and start) is already `known`, every
 * row whose pid is `live` (the interpreter, while it has not exited), and every descendant of those by parent.
 */
export function treeOf(table: readonly ProcessRow[], known: ReadonlyMap<number, string>, live?: number): ProcessRow[] {
  const ours = new Map<number, ProcessRow>();
  for (const r of table) if (known.get(r.pid) === r.started || r.pid === live) ours.set(r.pid, r);
  const children = new Map<number, ProcessRow[]>();
  for (const r of table) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const queue = [...ours.values()];
  while (queue.length) {
    for (const c of children.get(queue.pop()!.pid) ?? [])
      if (!ours.has(c.pid)) {
        ours.set(c.pid, c);
        queue.push(c);
      }
  }
  return [...ours.values()];
}

const send = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    /* it has ended */
  }
};
const sameProcess = (a: ProcessRow, b: ProcessRow) =>
  a.pid === b.pid && a.ppid === b.ppid && a.pgid === b.pgid && a.started === b.started;

/**
 * Ends every process of a script: the interpreter's group, and every descendant that left it (a `detached` child in a
 * group or session of its own), one verified process at a time.
 *
 * While the interpreter has not exited (`alive()`, read synchronously, so its pid is not yet reaped and cannot be
 * reused) its group, which Sentinel created, is stopped wholesale. Then, each round: the table is read and the tree
 * taken from it, with the members of the interpreter's group while that group is still Sentinel's; each process of the tree is stopped (SIGSTOP), its row read again, and kept only when pid, parent,
 * group and start are unchanged and it is stopped; any other is continued (SIGCONT) at once and left alone. A stopped
 * process cannot exit, so its pid cannot be reused before it is killed. Rounds repeat for what was started before its
 * parent stopped. Then every kept process is killed (SIGKILL), and the interpreter's group is killed wholesale only
 * while the interpreter is alive or a kept, stopped member still holds that group. No other group is signalled.
 *
 * Its limit: a descendant that left the tree (its parent exited) before any listing saw it, or that was started
 * between the last listing and the kill, is not known; on macOS a start resolves to the second, so a process that
 * reused a pid within the same second with the same parent and group would be taken for the script's.
 */
export async function reapTree(
  group: number | undefined,
  known: Map<number, string>,
  alive: () => boolean,
  reader: ProcessReader = SYSTEM_PROCESSES,
): Promise<void> {
  const live = () => (alive() ? group : undefined);
  // The members of the interpreter's group, while that group is still the one Sentinel created: the interpreter is
  // alive, or no process now has its pid (members keep a group's id from being reused), or the one that has it is the
  // interpreter as first listed. A pid taken by another process's group gives no members.
  const groupOf = (table: readonly ProcessRow[]) => {
    if (group === undefined) return [];
    const leader = table.find((r) => r.pid === group);
    if (!alive() && leader && known.get(group) !== leader.started) return [];
    return table.filter((r) => r.pgid === group);
  };
  if (group !== undefined && alive()) send(-group, 'SIGSTOP');
  const kept = new Map<number, ProcessRow>();
  const stopped = new Set<number>();
  try {
    for (let round = 0; round < FREEZE_ROUNDS; round++) {
      const table = await reader.table();
      const listed = new Map(treeOf(table, known, live()).map((r) => [r.pid, r]));
      for (const r of groupOf(table)) if (!listed.has(r.pid)) listed.set(r.pid, r);
      const candidates = [...listed.values()].filter((r) => !kept.has(r.pid));
      if (!candidates.length) break;
      for (const r of candidates) {
        known.set(r.pid, r.started);
        send(r.pid, 'SIGSTOP');
        stopped.add(r.pid);
      }
      const now = new Map((await reader.rows(candidates.map((r) => r.pid))).map((r) => [r.pid, r]));
      for (const r of candidates) {
        const again = now.get(r.pid);
        if (again && sameProcess(r, again) && again.state.includes('T')) kept.set(r.pid, again);
        else {
          stopped.delete(r.pid);
          if (again && !again.state.includes('Z')) send(r.pid, 'SIGCONT');
        }
      }
    }
  } finally {
    // A stopped process the reap could not verify is never left stopped.
    for (const pid of stopped) if (!kept.has(pid)) send(pid, 'SIGCONT');
    if (group !== undefined && (alive() || [...kept.values()].some((r) => r.pgid === group))) send(-group, 'SIGKILL');
    for (const pid of kept.keys()) send(pid, 'SIGKILL');
  }
}

/**
 * The child in its own process group, under its deadline and output bound, with an empty environment and no stdin.
 * The attempt settles when the interpreter exits, whatever its descendants do: its whole tree is killed then (and at
 * the deadline or the output bound; see reapTree), and a stream a descendant still holds open is not waited for beyond
 * a short grace. While it runs, its descendants are listed every TREE_POLL_MS, so one that leaves the interpreter's
 * group or loses its parent is still known when the tree is killed.
 */
export function spawnBounded(
  command: string,
  argv: readonly string[],
  cwd: string,
  request: Pick<HostScriptRequest, 'signal' | 'deadlineMs' | 'maxOutputBytes'>,
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
    let settling = false;
    /** Every process seen in the script's tree, by pid and start time. */
    const known = new Map<number, string>();
    let polling: Promise<void> | undefined;
    const poll = () => {
      if (settling || exited || polling) return;
      polling = SYSTEM_PROCESSES.table().then((table) => {
        for (const r of treeOf(table, known, exited ? undefined : child.pid)) known.set(r.pid, r.started);
        polling = undefined;
      });
    };
    const ticker = setInterval(poll, TREE_POLL_MS);
    poll();
    const settle = () => {
      if (settling) return;
      settling = true;
      clearInterval(ticker);
      clearTimeout(timer);
      clearTimeout(grace);
      request.signal.removeEventListener('abort', onAbort);
      // The attempt settles whatever the reap finds: a listing that fails or times out leaves only the group kill.
      void (polling ?? Promise.resolve())
        .then(() => reapTree(child.pid, known, () => !exited))
        .catch(() => undefined)
        .then(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          if (refusal) reject(refusal);
          else if (exited) resolve({ exitCode: exited.code, signal: exited.signal, stdout: Buffer.concat(out) });
          else reject(new ExecutionError('sentinel.execution.commandFailed', { reason: 'the script did not exit' }));
        });
    };
    const stop = (why: ExecutionError) => {
      refusal ??= why;
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
      if (settling) return;
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
    // The interpreter's exit ends the attempt: its tree is killed, and the output it wrote is read until its stream
    // closes or a short grace passes (a descendant cannot hold the attempt open).
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      grace = setTimeout(settle, EXIT_GRACE_MS);
    });
    child.on('close', () => {
      if (exited) settle();
    });
  });
}
