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
export const PREVIEW_INPUTS_SCHEMA = 'sentinel-preview-inputs/draft-1';
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

/** Runs the worker protocol on this process's stdin and stdout. Only the package's executable calls it. */
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

  const bytesOf = (id: string) => readFileSync(`${IN}/${id.slice('sha256:'.length)}`);
  let manifest: { files: { id: string; path: string }[] } | undefined;
  for (const id of start.inputs as string[]) {
    try {
      const v = JSON.parse(bytesOf(id).toString('utf8'));
      if (v?.schema === PREVIEW_INPUTS_SCHEMA && Array.isArray(v.files)) { manifest = v; break; }
    } catch { /* source bytes, not the manifest */ }
  }
  const findings: PreviewFinding[] = [];
  const pathOf = new Map((manifest?.files ?? []).map(f => [f.id, f.path]));
  for (const id of start.inputs as string[]) {
    const path = pathOf.get(id);
    if (path === undefined) continue;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(id)); } catch { continue; } // not UTF-8 text: not checked
    findings.push(...detect(path, text, id));
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  const doc = Buffer.from(JSON.stringify({
    schema: PREVIEW_FINDINGS_SCHEMA, detector: PREVIEW_DETECTOR_ID, rule: PREVIEW_RULE, label: 'foundation-preview',
    checkedFiles: [...pathOf.values()].filter(p => LANGUAGES.test(p)).length, findings,
  }));
  const hex = sha(doc);
  writeFileSync(`${OUT}/${hex}`, doc);
  const artifact = { id: `sha256:${hex}`, mediaType: 'application/json', bytes: doc.length };
  send({
    protocol: P, type: 'result', attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch, seq: 0,
    inputFingerprint: start.inputFingerprint, granularity: 'per-file', artifacts: [artifact], observations: [artifact.id],
    coveredChecks: [], scannedSet: [], skipped: [], actualReadSet: [], unresolvedFrontiers: [], diagnostics: [],
  });
}

