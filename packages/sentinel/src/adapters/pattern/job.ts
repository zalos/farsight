// Building one pattern attempt: the rule config, the job manifest and the input list the execution service copies
// into the container. Rules arrive already chosen by trusted policy and the pinned lock (PR 06); this module only
// checks that each engine rule is one this adapter can run faithfully, and writes the bytes the worker reads.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId } from '../../contracts/common.js';
import type { CapturedInput } from '../../execution/supervisor.js';
import { isSafeRelativePath } from '../../validate.js';
import {
  ENGINE_TIMEOUT_SECONDS,
  PATTERN_WORKER_BYTES,
  PATTERN_WORKER_DIGEST,
  type PatternAdapterBuild,
} from './adapter.js';
import { patternFail } from './errors.js';

export type PatternLanguage = 'typescript' | 'javascript' | 'java';
export type PatternEvidenceKind = 'structural-locator' | 'local-taint';

/** One rule as the adapter runs it: the engine rule object and what kind of evidence it may produce. */
export interface PatternRule {
  readonly familyId: string;
  readonly revision: number;
  readonly kind: PatternEvidenceKind;
  readonly languages: readonly PatternLanguage[];
  readonly engineRule: Readonly<Record<string, unknown>>;
  /** Provenance from the pinned lock, when the rule came through patternRulesFromResolved. */
  readonly pins?: Readonly<{
    definitionDigest: string;
    packDigest: string;
    lockDigest: string;
    detectorDigest: string;
  }>;
}

/** A captured target: where its bytes are now, its artifact id and its path inside the source. */
export interface PatternTarget {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly path: string;
}

export interface PatternJob {
  readonly schema: 'sentinel-pattern-job/draft-1';
  readonly worker: string;
  readonly rules: ArtifactId;
  readonly ruleIds: readonly string[];
  /** The lock pins of each rule, recorded for provenance; the worker does not read them. */
  readonly rulePins: Readonly<Record<string, PatternRule['pins'] | null>>;
  readonly targets: readonly { readonly path: string; readonly artifact: ArtifactId }[];
  readonly maxTargetBytesRead: number;
  readonly engineTimeoutSeconds: number;
}

export interface BuiltPatternJob {
  readonly job: PatternJob;
  readonly jobDigest: ArtifactId;
  readonly rulesDigest: ArtifactId;
  readonly inputs: readonly CapturedInput[];
}

/** Per attempt: with per-rule match times every target adds to the engine output, which is held to 3 MiB. */
export const MAX_PATTERN_TARGETS = 2_000;
/** The worker reads at most this much of one target: enough for the engine to see it is over MAX_TARGET_BYTES. */
export const MAX_TARGET_READ_BYTES = 16 * 1024 * 1024;

const LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript', 'java']);
/** Engine rule keys the adapter accepts. Anything else (path filters, fixes, options, join/extract modes) is refused. */
const RULE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'languages',
  'severity',
  'message',
  'mode',
  'pattern',
  'patterns',
  'pattern-either',
  'pattern-not',
  'pattern-inside',
  'pattern-not-inside',
  'pattern-sources',
  'pattern-sinks',
  'pattern-sanitizers',
  'focus-metavariable',
  'metavariable-pattern',
  'metadata',
]);
const sha256 = (b: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** The language a target path is scanned as, or undefined when no rule language applies. */
export function languageOf(relativePath: string): PatternLanguage | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(relativePath);
  switch (m?.[1]) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'java':
      return 'java';
    default:
      return undefined;
  }
}

/** A rule from its detector file (`{"rules":[<one engine rule>]}`), checked against its family id and revision. */
export function patternRuleOf(familyId: string, revision: number, detector: Uint8Array): PatternRule {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(detector));
  } catch {
    return patternFail('sentinel.pattern.ruleInvalid', `${familyId}: not JSON`);
  }
  const rules = (value as { rules?: unknown })?.rules;
  if (!Array.isArray(rules) || rules.length !== 1 || typeof rules[0] !== 'object' || rules[0] === null)
    patternFail('sentinel.pattern.ruleInvalid', `${familyId}: one rule per detector`);
  const rule = (rules as Record<string, unknown>[])[0]!;
  for (const key of Object.keys(rule))
    if (!RULE_KEYS.has(key)) patternFail('sentinel.pattern.ruleInvalid', `${familyId}: unsupported rule key ${key}`);
  if (rule.id !== familyId)
    patternFail('sentinel.pattern.ruleInvalid', `${familyId}: the engine rule id must be the family id`);
  const languages = rule.languages;
  if (
    !Array.isArray(languages) ||
    !languages.length ||
    languages.some((l) => typeof l !== 'string' || !LANGUAGES.has(l))
  ) {
    patternFail('sentinel.pattern.ruleInvalid', `${familyId}: languages must be typescript, javascript or java`);
  }
  if (rule.mode !== undefined && rule.mode !== 'taint')
    patternFail('sentinel.pattern.ruleInvalid', `${familyId}: only search and taint modes`);
  return Object.freeze({
    familyId,
    revision,
    kind: rule.mode === 'taint' ? 'local-taint' : 'structural-locator',
    languages: Object.freeze([...(languages as PatternLanguage[])]),
    engineRule: Object.freeze(structuredClone(rule)),
  });
}

function digestOfFile(path: string): ArtifactId {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) patternFail('sentinel.pattern.targetInvalid', 'a target is not a regular file');
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    for (let off = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, off);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      off += n;
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the rule config, the job and the worker into `dir` (a private folder) and returns the attempt's inputs:
 * worker, job, rules, then every target. Target artifact ids are checked against their bytes now; the execution
 * service checks them again as it copies them.
 */
export function buildPatternJob(
  rules: readonly PatternRule[],
  targets: readonly PatternTarget[],
  dir: string,
  adapter?: PatternAdapterBuild,
): BuiltPatternJob {
  const worker = adapter
    ? { bytes: adapter.workerBytes, digest: adapter.workerDigest }
    : { bytes: PATTERN_WORKER_BYTES, digest: PATTERN_WORKER_DIGEST };
  if (!rules.length) patternFail('sentinel.pattern.ruleInvalid', 'a job runs at least one rule');
  const ids = rules.map((r) => r.familyId);
  if (new Set(ids).size !== ids.length) patternFail('sentinel.pattern.ruleInvalid', 'duplicate rule');
  if (targets.length > MAX_PATTERN_TARGETS)
    patternFail('sentinel.pattern.targetInvalid', `at most ${MAX_PATTERN_TARGETS} targets per attempt`);
  const seen = new Set<string>();
  for (const t of targets) {
    if (!isSafeRelativePath(t.relativePath) || Buffer.byteLength(t.relativePath) > 1024)
      patternFail('sentinel.pattern.targetInvalid', 'unsafe target path');
    if (seen.has(t.relativePath)) patternFail('sentinel.pattern.targetInvalid', 'duplicate target path');
    seen.add(t.relativePath);
    if (digestOfFile(t.path) !== t.artifact)
      patternFail('sentinel.pattern.targetInvalid', `${t.relativePath} does not match its artifact id`);
  }
  const config = Buffer.from(JSON.stringify({ rules: rules.map((r) => r.engineRule) }), 'utf8');
  const rulesDigest = sha256(config);
  const job: PatternJob = {
    schema: 'sentinel-pattern-job/draft-1',
    worker: worker.digest,
    rules: rulesDigest,
    ruleIds: [...ids].sort(),
    rulePins: Object.fromEntries(rules.map((r) => [r.familyId, r.pins ?? null])),
    targets: targets.map((t) => ({ path: t.relativePath, artifact: t.artifact })),
    maxTargetBytesRead: MAX_TARGET_READ_BYTES,
    engineTimeoutSeconds: ENGINE_TIMEOUT_SECONDS,
  };
  const jobBytes = Buffer.from(JSON.stringify(job), 'utf8');
  if (jobBytes.byteLength > 1024 * 1024)
    patternFail('sentinel.pattern.targetInvalid', 'the job manifest exceeds 1 MiB');
  const jobDigest = sha256(jobBytes);
  const write = (name: string, bytes: Uint8Array) => {
    const p = join(dir, name);
    writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' });
    return p;
  };
  const inputs: CapturedInput[] = [
    { id: worker.digest, path: write('worker.py', worker.bytes) },
    { id: jobDigest, path: write('job.json', jobBytes) },
    { id: rulesDigest, path: write('rules.json', config) },
  ];
  const known = new Set(inputs.map((i) => i.id));
  for (const t of targets)
    if (!known.has(t.artifact)) {
      known.add(t.artifact);
      inputs.push({ id: t.artifact, path: t.path });
    }
  return Object.freeze({ job: Object.freeze(job), jobDigest, rulesDigest, inputs: Object.freeze(inputs) });
}
