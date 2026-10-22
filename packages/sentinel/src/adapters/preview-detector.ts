// The foundation-preview detector: one original coded check, run as a built-in worker, so the whole path (capture,
// plan, run, publish, report) can be shown without an external tool. It is a preview, not scanner coverage: one
// line-level heuristic for SQL text assembled from strings in TypeScript, JavaScript and Java, nothing more.
//
// Protocol (sentinel-worker/draft-1 over newline-delimited JSON): hello → welcome → start → result. It reads only
// the inputs the coordinator copied into SENTINEL_INPUT, writes one findings artifact to SENTINEL_OUTPUT, and
// contacts nothing. The inputs include a manifest naming each content artifact's captured path.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const PREVIEW_DETECTOR_ID = 'sentinel.preview.detector';
/** The rule family this detector implements, as the built-in foundation-preview pack declares it. */
export const PREVIEW_RULE = 'sentinel.preview.sql-string-concat';
export const PREVIEW_FINDINGS_SCHEMA = 'sentinel-preview-findings/draft-1';

const LANGUAGES = /\.(?:[cm]?[jt]sx?|java)$/i;
const SQL = String.raw`\b(?:SELECT\b[\s\S]*?\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]*?\bSET|DELETE\s+FROM)\b`;
/** A quoted SQL fragment joined with `+` to something that is not a literal. */
const CONCAT = new RegExp(String.raw`(["'])(?:(?!\1).)*${SQL}(?:(?!\1).)*\1\s*\+\s*[A-Za-z_$(]`, 'i');
/** A template literal with SQL text and an interpolation. */
const TEMPLATE = new RegExp(String.raw`\`[^\`]*${SQL}[^\`]*\$\{`, 'i');

export interface PreviewFinding { readonly input: string; readonly path: string; readonly line: number; readonly rule: string }

/** The check itself, pure: findings in one file's text. */
export function detect(path: string, text: string, input: string): PreviewFinding[] {
  if (!LANGUAGES.test(path)) return [];
  const out: PreviewFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (CONCAT.test(line) || TEMPLATE.test(line)) out.push({ input, path, line: i + 1, rule: PREVIEW_RULE });
  });
  return out;
}

// ---- the worker ----

const P = 'sentinel-worker/draft-1';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Why a scope was not checked; each a catalog reason, so a skipped scope is never read as covered. */
export const PREVIEW_SKIP_REASONS = Object.freeze({
  unattributed: 'sentinel.preview.skipUnattributed',
  language: 'sentinel.preview.skipLanguage',
  notText: 'sentinel.preview.skipNotText',
});

/**
 * Runs the worker protocol on this process's stdin and stdout. Only the package's executable calls it. The start
 * names the checks and the scopes this attempt is to cover. The detector covers a unit only when it can attribute
 * it: exactly one captured input and one source-file scope (`<source>:<path>`), in a language it reads, as UTF-8
 * text. Anything else is reported skipped with its reason, never covered.
 */
export async function runPreviewWorker(): Promise<void> {
  const IN = process.env.SENTINEL_INPUT!;
  const OUT = process.env.SENTINEL_OUTPUT!;
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const lines: unknown[] = [];
  let wake: (() => void) | undefined;
  let buffered = '';
  process.stdin.on('data', (b: Buffer) => {
    buffered += b.toString('utf8');
    for (let nl; (nl = buffered.indexOf('\n')) >= 0;) { lines.push(JSON.parse(buffered.slice(0, nl))); buffered = buffered.slice(nl + 1); wake?.(); }
  });
  const next = async (): Promise<Record<string, any>> => {
    while (!lines.length) await new Promise<void>(r => { wake = r; });
    return lines.shift() as Record<string, any>;
  };
  send({ protocol: P, type: 'hello', supported: [P], adapterId: process.env.SENTINEL_ADAPTER_ID, adapterDigest: process.env.SENTINEL_ADAPTER_DIGEST });
  if ((await next()).type !== 'welcome') process.exit(9);
  const start = await next();
  if (start.type !== 'start') process.exit(9);

  const inputs = (start.inputs ?? []) as string[];
  const scopes = (start.scopes ?? []) as string[];
  const checks = (start.checks ?? []) as string[];
  const findings: PreviewFinding[] = [];
  const scanned: string[] = [];
  const skipped: { scopeId: string; reasonCode: string }[] = [];
  if (inputs.length !== 1 || scopes.length !== 1 || scopes[0]!.indexOf(':') < 1) {
    for (const scopeId of scopes) skipped.push({ scopeId, reasonCode: PREVIEW_SKIP_REASONS.unattributed });
  } else {
    const scopeId = scopes[0]!;
    const path = scopeId.slice(scopeId.indexOf(':') + 1);
    let text: string | undefined;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(`${IN}/${inputs[0]!.slice('sha256:'.length)}`)); } catch { text = undefined; }
    if (!LANGUAGES.test(path)) skipped.push({ scopeId, reasonCode: PREVIEW_SKIP_REASONS.language });
    else if (text === undefined) skipped.push({ scopeId, reasonCode: PREVIEW_SKIP_REASONS.notText });
    else { findings.push(...detect(path, text, inputs[0]!)); scanned.push(scopeId); }
  }
  const doc = Buffer.from(JSON.stringify({
    schema: PREVIEW_FINDINGS_SCHEMA, detector: PREVIEW_DETECTOR_ID, rule: PREVIEW_RULE, label: 'foundation-preview',
    checks: [...checks].sort(), scopes: [...scopes].sort(), scanned, skipped, findings,
  }));
  const hex = sha(doc);
  writeFileSync(`${OUT}/${hex}`, doc);
  const artifact = { id: `sha256:${hex}`, mediaType: 'application/json', bytes: doc.length };
  send({
    protocol: P, type: 'result', attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch, seq: 0,
    inputFingerprint: start.inputFingerprint, granularity: 'per-file-per-rule', artifacts: [artifact], observations: [artifact.id],
    // A check is reported covered only with its evidence; a skipped scope keeps it partial in the coverage records.
    coveredChecks: checks.map(checkId => ({ checkId, coverage: artifact.id })), scannedSet: scanned, skipped,
    actualReadSet: scanned, unresolvedFrontiers: [], diagnostics: [],
  });
}
