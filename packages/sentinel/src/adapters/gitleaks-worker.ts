// The Gitleaks worker: the protocol shim that runs inside the pinned container beside the pinned Gitleaks binary.
// The registry passes this module's compiled bytes as the container command (`node --input-type=module -e …`), so
// the adapter digest pins the shim and the image pins Node and Gitleaks. It imports only Node built-ins.
//
// What it does, in order: announce itself; take the start message; read the scan manifest (always the first input)
// and rebuild the captured current tree in the container's private tmpfs; run Gitleaks once over that tree with the
// pinned configuration and fixed arguments; normalise the report into observation envelopes that keep the detector
// identity and a whole-line location and nothing else; return them as the result.
//
// Secret values never leave the container through this worker. Gitleaks runs with full redaction, its raw report
// stays in the tmpfs that is removed with the container, its stdout and stderr are drained and dropped (never
// forwarded, since a tool error message can quote input), and the normaliser builds every observation from a
// closed set of fields, never copying the report's `Secret`, `Match`, `Line`, `Description` or any other text.
//
// Repository controls cannot suppress an observation: the tree is rebuilt one folder below the scan root, so a
// captured `.gitleaksignore` is scanned as a file but never read as an ignore list; Gitleaks gets an explicit
// configuration and an empty ignore folder; `gitleaks:allow` comments are ignored; no baseline is ever passed.
//
// Failure is never zero findings. A tool exit other than "no leaks" or "leaks found", a missing, oversized or
// malformed report, or a finding that names a file the manifest does not hold makes the worker exit with a coded
// diagnostic on stderr and no result, which the supervisor records as a failed attempt.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const GITLEAKS_WORKER_FORMAT = 'sentinel-gitleaks-worker/draft-1';
export const SCAN_MANIFEST_SCHEMA = 'sentinel-secrets-scan-input/draft-1';

/**
 * The pinned configuration: Gitleaks' own built-in rules for the pinned version, nothing added, nothing allowed.
 * A repository's `.gitleaks.toml` is never read.
 */
export const GITLEAKS_CONFIG = `title = "sentinel-gitleaks-pinned"\n\n[extend]\nuseDefault = true\n`;

/** The detector identity Gitleaks reports must look like a rule ID, not text. */
export const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Files above this are not given to Gitleaks; each is a skipped scope, never a silent omission. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** A report larger than this is refused rather than parsed. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** More findings than this fail the attempt rather than being cut short. */
export const MAX_OBSERVATIONS = 10_000;
/** Gitleaks exits 0 with no leaks and with this code when it found some; anything else is an error. */
export const LEAKS_EXIT_CODE = 2;

export const OBSERVATION_MESSAGE = 'A value shaped like a secret matched this detector. The value is withheld; open the cited lines in the captured source to review it.';
export const OBSERVATION_LIMITATIONS = ['sentinel.secrets.valueWithheld', 'sentinel.secrets.lineLocation'] as const;

/** The fixed Gitleaks arguments around the three folders the worker creates. */
export function gitleaksArgs(scanRoot: string, configPath: string, ignoreDir: string, reportPath: string): string[] {
  return [
    'dir', scanRoot,
    '--config', configPath,
    '--gitleaks-ignore-path', ignoreDir,
    '--ignore-gitleaks-allow',
    '--redact=100',
    '--report-format', 'json',
    '--report-path', reportPath,
    '--exit-code', String(LEAKS_EXIT_CODE),
    // One above the worker's own ceiling: every file the worker hands over is within Gitleaks' limit too.
    '--max-target-megabytes', String(MAX_FILE_BYTES / (1024 * 1024) + 1),
    '--no-banner', '--no-color',
    '--log-level', 'error',
  ];
}

export interface ManifestFile { path: string; content: string; bytes: number }
export interface ScanManifest { schema: typeof SCAN_MANIFEST_SCHEMA; snapshotId: string; sourceId: string; files: ManifestFile[] }

export class WorkerFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

const SAFE_PATH = /^(?![/])(?![\s\S]*[/]$)(?!([\s\S]*[/])?\.{1,2}([/]|$))(?![\s\S]*[/][/])[^\\\u0000\u0001-\u001f\u007f]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Checks the manifest the coordinator built; anything unexpected is refused, never repaired. */
export function parseManifest(value: unknown, otherInputs: readonly string[]): ScanManifest {
  const bad = (): never => { throw new WorkerFailure('sentinel.secrets.inputInvalid'); };
  if (!value || typeof value !== 'object') bad();
  const m = value as Record<string, unknown>;
  if (Object.keys(m).sort().join(',') !== 'files,schema,snapshotId,sourceId' || m.schema !== SCAN_MANIFEST_SCHEMA) bad();
  if (typeof m.snapshotId !== 'string' || !ID.test(m.snapshotId) || typeof m.sourceId !== 'string' || !ID.test(m.sourceId)) bad();
  if (!Array.isArray(m.files) || m.files.length > 100_000) bad();
  const seen = new Set<string>();
  const folded = new Set<string>();
  const files = (m.files as unknown[]).map(f => {
    const e = f as Record<string, unknown>;
    if (!e || typeof e !== 'object' || Object.keys(e).sort().join(',') !== 'bytes,content,path') bad();
    if (typeof e.path !== 'string' || e.path.length > 4096 || !SAFE_PATH.test(e.path)) bad();
    if (typeof e.content !== 'string' || !DIGEST.test(e.content) || !Number.isSafeInteger(e.bytes) || (e.bytes as number) < 0) bad();
    // Two entries cannot become one file in the rebuilt tree, even on a case-insensitive check.
    if (seen.has(e.path as string) || folded.has((e.path as string).toLowerCase())) bad();
    seen.add(e.path as string);
    folded.add((e.path as string).toLowerCase());
    return { path: e.path as string, content: e.content as string, bytes: e.bytes as number };
  });
  // The other inputs are exactly the distinct contents the manifest names.
  const named = new Set(files.map(f => f.content));
  if (named.size !== otherInputs.length || otherInputs.some(id => !named.has(id))) bad();
  return { schema: SCAN_MANIFEST_SCHEMA, snapshotId: m.snapshotId as string, sourceId: m.sourceId as string, files };
}

export const scopeOf = (sourceId: string, path: string) => `${sourceId}:${path}`;

interface ReportFinding { RuleID: string; File: string; StartLine: number; EndLine: number }

/** Reads the report's array and keeps four fields of each entry; every other field is dropped unread. */
export function readFindings(text: string): ReportFinding[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new WorkerFailure('sentinel.secrets.reportMalformed'); }
  if (!Array.isArray(raw)) throw new WorkerFailure('sentinel.secrets.reportMalformed');
  if (raw.length > MAX_OBSERVATIONS) throw new WorkerFailure('sentinel.secrets.tooManyFindings');
  return raw.map(entry => {
    const e = entry as Record<string, unknown>;
    if (!e || typeof e !== 'object') throw new WorkerFailure('sentinel.secrets.reportMalformed');
    const { RuleID, File, StartLine, EndLine } = e;
    if (typeof RuleID !== 'string' || !RULE_ID.test(RuleID) || typeof File !== 'string'
      || !Number.isSafeInteger(StartLine) || !Number.isSafeInteger(EndLine) || (StartLine as number) < 1 || (EndLine as number) < (StartLine as number)) {
      throw new WorkerFailure('sentinel.secrets.reportMalformed');
    }
    return { RuleID, File, StartLine: StartLine as number, EndLine: EndLine as number };
  });
}

/** Byte span of whole lines [start, end] (1-based, inclusive), newline excluded; never a part of a line. */
export function lineSpan(bytes: Uint8Array, startLine: number, endLine: number): { startByte: number; endByte: number } {
  let line = 1, startByte = -1, i = 0;
  if (startLine === 1) startByte = 0;
  for (; i < bytes.length && line <= endLine; i++) {
    if (bytes[i] === 0x0a) {
      if (line === endLine) break;
      line++;
      if (line === startLine) startByte = i + 1;
    }
  }
  if (startByte < 0 || line < endLine) throw new WorkerFailure('sentinel.secrets.locationOutOfRange');
  let endByte = i;
  if (endByte > startByte && bytes[endByte - 1] === 0x0d) endByte--;
  return { startByte, endByte };
}

/** Canonical JSON: sorted keys, no whitespace (the store's canonical form for these shapes). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (b: string | Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export interface Producer { adapterId: string; adapterDigest: string; attemptId: string }

/**
 * One observation per distinct (detector, file, lines). Built from the closed field list below; the report's text
 * fields are never read. `scannerPath` is what Gitleaks printed, the manifest decides which captured file it is.
 */
export function observationsFrom(findings: readonly ReportFinding[], manifest: ScanManifest, scannerPrefixes: readonly string[],
  readContent: (id: string) => Uint8Array, producer: Producer, observedAt: string): object[] {
  const byPath = new Map(manifest.files.map(f => [f.path, f]));
  const out = new Map<string, object>();
  for (const f of findings) {
    const prefix = scannerPrefixes.find(p => f.File.startsWith(p));
    if (prefix === undefined) throw new WorkerFailure('sentinel.secrets.unknownFile');
    const file = byPath.get(f.File.slice(prefix.length));
    if (!file) throw new WorkerFailure('sentinel.secrets.unknownFile');
    const span = lineSpan(readContent(file.content), f.StartLine, f.EndLine);
    const key = canonical([f.RuleID, file.path, f.StartLine, f.EndLine]);
    if (out.has(key)) continue;
    const body = {
      schema: 'sentinel-observation/draft-1',
      snapshotId: manifest.snapshotId,
      producer: { kind: 'scanner', ...producer },
      producerRuleId: f.RuleID,
      originalSeverity: 'unrated',
      message: OBSERVATION_MESSAGE,
      evidence: [{ snapshotId: manifest.snapshotId, sourceId: manifest.sourceId, relativePath: file.path, content: file.content, span }],
      limitationKeys: [...OBSERVATION_LIMITATIONS],
      observedAt,
    };
    // The ID is derived from what identifies the observation, so a rerun of the same attempt names it the same way.
    out.set(key, { ...body, id: `obs-${sha256(canonical({ ...body, observedAt: null })).slice(7, 47)}` });
  }
  return [...out.values()];
}

// --- the protocol, when run as the worker ---

const PROTOCOL = 'sentinel-worker/draft-1';
const GITLEAKS_BIN = (globalThis as { SENTINEL_GITLEAKS_BIN?: string }).SENTINEL_GITLEAKS_BIN ?? '/usr/bin/gitleaks';
/** Gitleaks' own stdout and stderr are drained, counted and discarded; past this the run is stopped. */
const TOOL_OUTPUT_LIMIT = 1024 * 1024;

function readBounded(path: string, limit: number, code: string): Buffer {
  let s;
  try { s = lstatSync(path); } catch { throw new WorkerFailure(code); }
  if (!s.isFile() || s.size > limit) throw new WorkerFailure(code === 'sentinel.secrets.reportMissing' && s.isFile() ? 'sentinel.secrets.reportTooLarge' : code);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(s.size);
    let n = 0;
    while (n < s.size) { const r = readSync(fd, buf, n, s.size - n, null); if (!r) break; n += r; }
    if (n !== s.size) throw new WorkerFailure(code);
    return buf;
  } finally { closeSync(fd); }
}

function runTool(args: string[], cwd: string, home: string): Promise<number | null> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(GITLEAKS_BIN, args, { cwd, env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve(null); return; }
    let seen = 0;
    const drain = (b: Buffer) => { seen += b.byteLength; if (seen > TOOL_OUTPUT_LIMIT) child.kill('SIGKILL'); };
    child.stdout.on('data', drain);
    child.stderr.on('data', drain);
    child.on('error', () => resolve(null));
    child.on('close', (code, signal) => resolve(signal || seen > TOOL_OUTPUT_LIMIT ? null : code));
  });
}

let workDir: string | undefined;

async function main(): Promise<void> {
  const IN = process.env.SENTINEL_INPUT!, OUT = process.env.SENTINEL_OUTPUT!;
  const adapterId = process.env.SENTINEL_ADAPTER_ID!, adapterDigest = process.env.SENTINEL_ADAPTER_DIGEST!;
  const send = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const fail = (code: string): never => {
    // Only the code: never a path, a tool message or anything read from the input.
    process.stderr.write(`${GITLEAKS_WORKER_FORMAT} ${code}\n`);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    process.exit(3);
  };
  const lines: unknown[] = [];
  let wake: (() => void) | undefined;
  let pending = '';
  process.stdin.on('data', (b: Buffer) => {
    pending += b.toString('utf8');
    for (let nl; (nl = pending.indexOf('\n')) >= 0;) {
      try { lines.push(JSON.parse(pending.slice(0, nl))); } catch { fail('sentinel.secrets.protocolInvalid'); }
      pending = pending.slice(nl + 1);
      wake?.();
    }
  });
  process.stdin.on('end', () => wake?.());
  const next = async (): Promise<Record<string, unknown>> => {
    while (!lines.length) {
      if (process.stdin.readableEnded) fail('sentinel.secrets.protocolInvalid');
      await new Promise<void>(r => { wake = r; });
    }
    return lines.shift() as Record<string, unknown>;
  };

  send({ protocol: PROTOCOL, type: 'hello', supported: [PROTOCOL], adapterId, adapterDigest });
  if ((await next()).type !== 'welcome') fail('sentinel.secrets.protocolInvalid');
  const start = await next();
  if (start.type !== 'start' || !Array.isArray(start.inputs) || !start.inputs.length) fail('sentinel.secrets.protocolInvalid');
  const inputs = start.inputs as string[];
  const contentPath = (id: string) => join(IN, id.slice(7));
  const work = workDir = mkdtempSync(join(tmpdir(), 'sentinel-gitleaks-'));
  try {
    let manifest: ScanManifest;
    try {
      manifest = parseManifest(JSON.parse(readBounded(contentPath(inputs[0]!), 64 * 1024 * 1024, 'sentinel.secrets.inputInvalid').toString('utf8')), inputs.slice(1));
    } catch (e) { return fail(e instanceof WorkerFailure ? e.code : 'sentinel.secrets.inputInvalid'); }

    // The tree sits one folder below the scan root: a captured root `.gitleaksignore` is then an ordinary file.
    // Gitleaks runs from `work` with the relative root `scan`, so it reports paths as `scan/tree/<path>`.
    const scanRoot = join(work, 'scan');
    const tree = join(scanRoot, 'tree');
    const empty = join(work, 'no-ignores');
    mkdirSync(tree, { recursive: true, mode: 0o700 });
    mkdirSync(empty, { mode: 0o700 });
    const configPath = join(work, 'gitleaks.toml');
    writeFileSync(configPath, GITLEAKS_CONFIG, { mode: 0o600 });
    const reportPath = join(work, 'report.json');
    const scanned: string[] = [];
    const skipped: { scopeId: string; reasonCode: string }[] = [];
    for (const f of manifest.files) {
      const scopeId = scopeOf(manifest.sourceId, f.path);
      if (f.bytes > MAX_FILE_BYTES) { skipped.push({ scopeId, reasonCode: 'sentinel.secrets.fileTooLarge' }); continue; }
      const bytes = readBounded(contentPath(f.content), MAX_FILE_BYTES, 'sentinel.secrets.inputInvalid');
      if (bytes.length !== f.bytes) fail('sentinel.secrets.inputInvalid');
      const target = join(tree, f.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
      scanned.push(scopeId);
    }

    const exit = await runTool(gitleaksArgs('scan', configPath, empty, reportPath), work, work);
    if (exit === null) fail('sentinel.secrets.toolFailed');
    if (exit !== 0 && exit !== LEAKS_EXIT_CODE) fail('sentinel.secrets.toolFailed');
    let findings: ReportFinding[];
    try {
      findings = readFindings(readBounded(reportPath, MAX_REPORT_BYTES, 'sentinel.secrets.reportMissing').toString('utf8'));
    } catch (e) { return fail(e instanceof WorkerFailure ? e.code : 'sentinel.secrets.reportMalformed'); }
    // The exit code and the report must agree: "leaks" with an empty report, or the reverse, is not trusted.
    if ((exit === LEAKS_EXIT_CODE) !== (findings.length > 0)) fail('sentinel.secrets.reportInconsistent');

    let observations: object[];
    try {
      observations = observationsFrom(findings, manifest, ['scan/tree/', './scan/tree/', `${scanRoot}/tree/`], id => readFileSync(contentPath(id)),
        { adapterId, adapterDigest, attemptId: start.attemptId as string }, new Date().toISOString());
    } catch (e) { return fail(e instanceof WorkerFailure ? e.code : 'sentinel.secrets.reportMalformed'); }
    rmSync(reportPath, { force: true });

    const artifacts = observations.map(o => {
      const bytes = Buffer.from(canonical(o), 'utf8');
      const id = sha256(bytes);
      writeFileSync(join(OUT, id.slice(7)), bytes, { flag: 'wx' });
      return { id, mediaType: 'application/vnd.sentinel.observation+json', bytes: bytes.length };
    });
    send({
      protocol: PROTOCOL, type: 'result', attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch, seq: 0,
      ...(start.fencingGeneration !== undefined ? { fencingGeneration: start.fencingGeneration } : {}),
      inputFingerprint: start.inputFingerprint, granularity: 'per-file', artifacts, observations: artifacts.map(a => a.id),
      coveredChecks: [], scannedSet: scanned, skipped, actualReadSet: scanned, unresolvedFrontiers: [], diagnostics: [],
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
    workDir = undefined;
  }
  process.stdin.destroy();
}

// Run as the worker only when executed (inside the container, or as a built-in test child); importing is inert.
if ((globalThis as { SENTINEL_GITLEAKS_RUN?: boolean }).SENTINEL_GITLEAKS_RUN || process.argv[1] === '--sentinel-gitleaks-worker') {
  // An unexpected error is reported by code only: a stack trace could quote a path or input bytes.
  await main().catch(() => {
    process.stderr.write(`${GITLEAKS_WORKER_FORMAT} sentinel.secrets.workerError\n`);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    process.exit(3);
  });
}
