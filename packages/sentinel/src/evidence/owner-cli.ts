// Owner executable only. No IPC/MCP handler calls this module, and request JSON cannot select its actor.
import { resolve } from 'node:path';
import type { ImportViewEnvelope, ImportPageEnvelope, ReportCount } from '../contracts/index.js';
import type { ParsedCommand } from '../cli/args.js';
import { result, type CommandResult } from '../cli/outcome.js';
import { assertMayConfirm } from '../cli/actor.js';
import { openStore, type SentinelStore } from '../store/index.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { digestOf } from '../store/ledger-json.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { loadPlan } from '../execution/plans.js';
import type { ProofTiming, RetainedSourceAncestor } from '../execution/retained-source.js';
import { OWNER, receiptBook, printed, type Workspace } from '../service/local.js';
import { writeNewFile } from '../service/full-report.js';
import { validateEnvelope } from '../validate.js';
import { SentinelError } from '../kernel/errors.js';
import { sentinelServiceWord } from '@farsight/core/dist/strings-sentinel-service.js';
import { sentinelWord, SENTINEL_CLI_STRINGS } from '@farsight/core/dist/strings-sentinel-cli.js';
import { acceptReportImportFiles } from './accept.js';
import { abandonReportImport } from './abandon.js';
import { readAcceptedReportImport } from './reader.js';
import { importOwnerContext, ownerContextOf } from './owner-context.js';

/**
 * The evidence command's bounds: acknowledgement bytes, delivered output bytes, the page size (default and most) and
 * the cursor length.
 */
export const IMPORT_CLI_LIMITS = Object.freeze({
  ackBytes: 16 * 1024,
  outputBytes: 32 * 1024 * 1024,
  defaultPage: 50,
  maxPage: 100,
  cursorBytes: 512,
});
/** A rendering past the output cap or the nesting bound; the command reports it as `sentinel.evidence.outputTooLarge`. */
class OutputLimitError extends SentinelError<'sentinel.evidence.outputTooLarge'> {
  constructor() {
    super('sentinel.evidence.outputTooLarge', 'import output too large');
    this.name = 'OutputLimitError';
  }
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const generatedOperation = /^evidence-[0-9a-f-]{36}$/;
type Phase =
  | 'preflight'
  | 'proof'
  | 'input'
  | 'receipt'
  | 'operation'
  | 'stage'
  | 'object'
  | 'publication'
  | 'readback'
  | 'abandon';
const reason = (name: string) => `sentinel.evidence.${name}`;
function refused(
  command: string,
  code: string,
  phase: Phase = 'preflight',
  facts: Record<string, unknown> = {},
): CommandResult {
  return result(command, 'refused', { reasonCode: reason(code), facts: { phase, ...facts } });
}
function count(n: number, unit: string): ReportCount {
  return { n, unit, scope: 'sentinel.evidence.countScope', source: 'accepted report-import normalized projection' };
}
/**
 * The owner-local public form of an authenticated import view: its counts as Counted totals over the accepted import,
 * each with the command that reads it again. Throws when the result does not fit the `importview` contract.
 */
export function publicImportView(view: Awaited<ReturnType<typeof readAcceptedReportImport>>): ImportViewEnvelope {
  const doc: ImportViewEnvelope = {
    ...view,
    kind: 'imported-report',
    authority: 'owner-associated-imported-claims',
    disclosure: 'owner-local',
    limitation: view.limitation as ImportViewEnvelope['limitation'],
    schema: 'sentinel-import-view/draft-1',
    limitationKey: 'sentinel.evidence.importedClaims',
    counts: {
      claims: count(view.counts.claims, 'sentinel.evidence.claims'),
      exchanges: count(view.counts.exchanges, 'sentinel.evidence.exchanges'),
      cookies: count(view.counts.cookies, 'sentinel.evidence.cookies'),
    },
  };
  for (const c of Object.values(doc.counts)) {
    c.source = `accepted report import ${doc.candidateDigest}`;
    c.recheck = { cli: `farsight-sentinel evidence read ${doc.candidateDigest} --json` };
  }
  if (!validateEnvelope('importview', doc).ok) throw Error('import projection unavailable');
  return doc;
}
/** Bounded readable JSON. Expansion is counted while constructing, before delivery or export. */
function prettyJson(value: unknown): string {
  const parts: string[] = [];
  let bytes = 0;
  const add = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > IMPORT_CLI_LIMITS.outputBytes) throw new OutputLimitError();
    parts.push(text);
  };
  const visit = (v: unknown, depth: number) => {
    if (depth > 96) throw new OutputLimitError();
    if (v === null || typeof v !== 'object') {
      add(JSON.stringify(v).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
      return;
    }
    const array = Array.isArray(v),
      keys = array ? v.map((_: unknown, i: number) => i) : Object.keys(v);
    add(array ? '[' : '{');
    for (let n = 0; n < keys.length; n++) {
      add((n ? ',' : '') + '\n' + '  '.repeat(depth + 1));
      const key = keys[n]!;
      if (!array) add(JSON.stringify(key) + ': ');
      visit((v as Record<string | number, unknown>)[key], depth + 1);
    }
    if (keys.length) add('\n' + '  '.repeat(depth));
    add(array ? ']' : '}');
  };
  visit(value, 0);
  return parts.join('');
}
/** Called only after exact retained authority/privacy validation. These are owner-local projections. */
export function renderImportDocument(document: ImportViewEnvelope | ImportPageEnvelope, format: 'json' | 'md'): string {
  const raw = prettyJson(document);
  if (format === 'json') return raw;
  const counts = 'counts' in document ? Object.values(document.counts) : [document.count];
  const tips = counts
    .map(
      (c) => `${sentinelWord(c.unit, { n: c.n })} (${sentinelWord(c.scope)}). ${SENTINEL_CLI_STRINGS[c.unit]!.define}`,
    )
    .join('\n');
  const parts = [`${sentinelWord('sentinel.evidence.importedClaims')}\n\n${tips}\n\n`];
  let size = Buffer.byteLength(parts[0]!);
  // CommonMark indented code is inert; entity escaping here would corrupt the retained strings.
  for (const line of raw.split('\n')) {
    const part = '    ' + line + '\n';
    size += Buffer.byteLength(part);
    if (size > IMPORT_CLI_LIMITS.outputBytes) throw new OutputLimitError();
    parts.push(part);
  }
  return parts.join('');
}
async function ancestorFor(store: SentinelStore, runId: string, sourceId: string): Promise<RetainedSourceAncestor> {
  const run = store.ledger.getRun(runId);
  if (!run || run.state !== 'completed' || !run.envelope.requestedScope.sourceIds.includes(sourceId))
    throw Error('source unavailable');
  const { plan } = await loadPlan(store, runId, run.planRevision);
  const retained = store.ledger.getPlan(runId, run.planRevision);
  if (!retained || plan.pins.snapshotId !== run.envelope.snapshotId || plan.digest !== retained.digest)
    throw Error('source unavailable');
  return {
    runId,
    revision: run.planRevision,
    planDigest: retained.digest,
    snapshotId: run.envelope.snapshotId,
    sourceId,
  };
}
function bindingDigest(store: SentinelStore, ancestor: RetainedSourceAncestor) {
  return digestOf({ domain: 'report-import', storeId: store.storeId, ancestor });
}
function decodeCursor(text: string | undefined, binding: string): string | null {
  if (text === undefined) return null;
  if (text.length > IMPORT_CLI_LIMITS.cursorBytes || !/^[A-Za-z0-9_-]+$/.test(text)) throw Error('cursor refused');
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text) throw Error('cursor refused');
  const v = JSON.parse(decoded.toString('utf8'));
  if (
    !v ||
    Object.keys(v).sort().join('|') !== 'after|binding|schema' ||
    v.schema !== 'evidence-page/1' ||
    v.binding !== binding ||
    typeof v.after !== 'string' ||
    !generatedOperation.test(v.after)
  )
    throw Error('cursor refused');
  return v.after;
}
function page(
  store: SentinelStore,
  ancestor: RetainedSourceAncestor,
  after: string | undefined,
  limit: number,
): ImportPageEnvelope {
  const binding = bindingDigest(store, ancestor),
    cursor = decodeCursor(after, binding),
    rows = evidenceLedgerFor(store).page(binding, cursor, limit + 1),
    more = rows.length > limit;
  const selected = rows.slice(0, limit);
  if (selected.some((r) => !generatedOperation.test(r.operationId))) throw Error('page unavailable');
  const doc: ImportPageEnvelope = {
    schema: 'sentinel-import-page/draft-1',
    authority: 'metadata-only-not-evaluated',
    items: selected.map((r) => ({ ...r, availability: 'not-evaluated' })),
    next: more
      ? Buffer.from(
          JSON.stringify({ schema: 'evidence-page/1', binding, after: selected.at(-1)!.operationId }),
        ).toString('base64url')
      : null,
    count: {
      ...count(selected.length, 'sentinel.evidence.operations'),
      scope: 'sentinel.evidence.pageScope',
      source: 'bounded report-import metadata page',
    },
  };
  if (!validateEnvelope('importpage', doc).ok) throw Error('page unavailable');
  return doc;
}
function ack(
  command: string,
  outcome: Parameters<typeof result>[1],
  facts: Record<string, unknown>,
  reasonCode?: string,
): CommandResult {
  const value = result(command, outcome, { facts, ...(reasonCode ? { reasonCode: reason(reasonCode) } : {}) });
  if (Buffer.byteLength(JSON.stringify(value)) > IMPORT_CLI_LIMITS.ackBytes) throw Error('ack unavailable');
  return value;
}
/** One evidence command's result, and its readable text when it has one. */
export interface EvidenceCliOutput {
  readonly result: CommandResult;
  readonly text?: string;
}
/**
 * The bytes an evidence command writes: one JSON line, or text in the catalog's words. Wrapper, heading and newline
 * share one output cap, with no pretty-print expansion; past it the result becomes `delivery-failed` with
 * `sentinel.evidence.outputTooLarge`, keeping only its phase, acceptance and identities. Throws when even that
 * acknowledgement does not fit.
 */
export function evidenceWire(output: EvidenceCliOutput, json: boolean): { result: CommandResult; text: string } {
  const serialize = (r: CommandResult, body?: string) => {
    if (json) return JSON.stringify(r) + '\n';
    const head = sentinelServiceWord(
      `sentinel.outcome.${r.outcome.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`,
    );
    const candidate =
      typeof r.facts.candidateDigest === 'string' && DIGEST.test(r.facts.candidateDigest)
        ? sentinelWord('sentinel.evidence.candidate', { candidate: r.facts.candidateDigest })
        : undefined;
    return (
      [body, head + (r.reasonCode ? ': ' + sentinelWord(r.reasonCode) : ''), candidate]
        .filter((v) => v !== undefined)
        .join('\n') + '\n'
    );
  };
  let r = output.result,
    text = serialize(r, output.text);
  if (Buffer.byteLength(text) > IMPORT_CLI_LIMITS.outputBytes) {
    const facts: Record<string, unknown> = { delivery: 'refused' };
    // These are metadata previously derived by the genuine writer/reader, not arbitrary input/report fields.
    for (const k of ['phase', 'acceptance', 'candidateDigest', 'root', 'reused', 'operationId'])
      if (Object.hasOwn(r.facts, k)) facts[k] = r.facts[k];
    r = ack(r.command, 'delivery-failed', facts, 'outputTooLarge');
    text = serialize(r);
  }
  if (Buffer.byteLength(text) > IMPORT_CLI_LIMITS.outputBytes) throw Error('bounded acknowledgement unavailable');
  return { result: r, text };
}
/** Where an evidence command has got to, and what it has established: the refusal of a failure reports both. */
interface CommandState {
  phase: Phase;
  metadata: Record<string, unknown>;
}
/** The values an evidence command reads from its flags. */
interface CommandFlags {
  readonly action: string | undefined;
  readonly target: string;
  readonly confirm: boolean;
  readonly format: string;
  readonly out: string | undefined;
  readonly baselineRunId: string | undefined;
  readonly sourceId: string | undefined;
  readonly expect: string | undefined;
}
/**
 * True when the arguments do not fit the command's action: an unknown action or format, a `--disclosure` flag, a
 * malformed baseline, candidate, predecessor, source, run or operation id, or an import without its report, its
 * manifest or, with `--out`, its confirmation.
 */
function argumentsRefused(p: ParsedCommand, f: CommandFlags, value: (key: string) => string | undefined): boolean {
  const { action, target, confirm, format, out, baselineRunId, sourceId, expect } = f;
  return (
    !['import', 'read', 'list', 'abandon'].includes(action ?? '') ||
    !['json', 'md'].includes(format) ||
    Object.hasOwn(p.flags, '--disclosure') ||
    (baselineRunId !== undefined && !ID.test(baselineRunId)) ||
    (expect !== undefined && !DIGEST.test(expect)) ||
    (value('--predecessor') !== undefined && !generatedOperation.test(value('--predecessor')!)) ||
    ((action === 'import' || action === 'list') && (!sourceId || !ID.test(sourceId) || !ID.test(target))) ||
    (action === 'read' && !DIGEST.test(target)) ||
    (action === 'abandon' && !generatedOperation.test(target)) ||
    (action === 'import' && (!value('--report') || !value('--manifest') || (!!out && !confirm)))
  );
}
/**
 * `evidence read`: the accepted import of candidate `target`, authenticated again from its retained records, as its
 * public view, with the acknowledgement that names it.
 */
async function readImport(
  store: SentinelStore,
  ws: Workspace,
  args: {
    readonly command: string;
    readonly target: string;
    readonly timing: ProofTiming;
    readonly baselineRunId?: string;
  },
  state: CommandState,
): Promise<{ document: ImportViewEnvelope; success: CommandResult }> {
  const { command, target, timing, baselineRunId } = args;
  state.phase = 'readback';
  state.metadata = { phase: 'readback', acceptance: 'not-established' };
  const document = publicImportView(
    await readAcceptedReportImport(store, ws, target, { timing, ...(baselineRunId ? { baselineRunId } : {}) }),
  );
  state.metadata = {
    ...state.metadata,
    acceptance: 'retained',
    candidateDigest: document.candidateDigest,
    root: document.root,
  };
  return { document, success: ack(command, 'read', state.metadata) };
}
/**
 * `evidence abandon`: previews abandoning operation `target`; without `--confirm` it waits for confirmation, with it it
 * issues the owner's receipt and abandons. A denial refuses with `sentinel.evidence.denied`; a spent receipt that did
 * not apply is `sentinel.evidence.spentNotApplied`, any other outcome `sentinel.evidence.applicationUncertain`.
 */
async function abandonImport(
  store: SentinelStore,
  ws: Workspace,
  args: { readonly command: string; readonly target: string; readonly timing: ProofTiming; readonly confirm: boolean },
  state: CommandState,
): Promise<EvidenceCliOutput> {
  const { command, target, timing, confirm } = args;
  state.phase = 'receipt';
  const preview = await abandonReportImport(store, ws, target, { timing });
  if (preview.status === 'denied')
    return {
      result: result(command, 'refused', { reasonCode: reason('denied'), verdicts: printed(preview.admission) }),
    };
  if (preview.status !== 'awaiting-confirmation') throw Error('abandon preview unavailable');
  if (!confirm)
    return {
      result: result(command, 'awaiting-confirmation', {
        verdicts: printed(preview.admission),
        facts: { phase: 'receipt', operationId: target },
      }),
    };
  if (!preview.binding) throw Error('abandon unavailable');
  assertMayConfirm(OWNER);
  const issued = issueReceipt(receiptBook(ws), OWNER, preview.binding, { now: new Date(), ttlMs: 60000 });
  state.phase = 'abandon';
  const done = await abandonReportImport(store, ws, target, { timing, receiptId: issued.id });
  if (done.status !== 'abandoned')
    return {
      result: refused(
        command,
        done.status === 'spentNotApplied' ? 'spentNotApplied' : 'applicationUncertain',
        'abandon',
        { operationId: target },
      ),
    };
  return {
    result: ack(command, 'abandoned', {
      phase: 'abandon',
      operationId: target,
      pinsReleased: true,
      objectBytesDeleted: false,
    }),
  };
}
type ImportOutcome = Awaited<ReturnType<typeof acceptReportImportFiles>>;
/** The reason an import that did not end accepted is refused with, in the `publication` phase. */
function publicationReason(done: ImportOutcome): string {
  if (done.status === 'spentNotPublished') return 'spentNotPublished';
  if (done.status === 'publicationUnknown' && done.acceptanceRecorded) return 'acceptedReadbackUnverified';
  return 'publicationUncertain';
}
/**
 * The refusal of an import that did not end accepted: `sentinel.evidence.spentNotPublished`,
 * `sentinel.evidence.acceptedReadbackUnverified` (the acceptance is recorded but its readback failed) or
 * `sentinel.evidence.publicationUncertain`, with the candidate and operation when known.
 */
function publicationRefused(command: string, done: ImportOutcome): CommandResult {
  return refused(command, publicationReason(done), 'publication', {
    ...('candidateDigest' in done ? { candidateDigest: done.candidateDigest } : {}),
    ...('operationId' in done ? { operationId: done.operationId } : {}),
    acceptance: done.status === 'publicationUnknown' && done.acceptanceRecorded ? 'recorded-unverified' : 'unknown',
  });
}
/**
 * The owner CLI's `evidence import|read|list|abandon` command. Only the trusted owner CLI supplies `ws`; same-account
 * application code stays outside this boundary, and request JSON never selects the actor. It guarantees one bounded
 * result and, for `read` and `import`, the authenticated public view of the accepted import. Its outcomes:
 * - `read`, `accepted` (with `reused` when the candidate was already accepted) or `abandoned`;
 * - `awaiting-confirmation` without `--confirm`, with the verdicts and the candidate or operation to confirm;
 * - `refused`, by `sentinel.evidence.*` code: `inputRefused` (arguments that do not fit the action, or an unreadable
 *   report), `ownerBusy` or `storageRefused` (the store cannot be opened), `denied` (policy), `confirmationStale` (the
 *   files changed since the preview), `spentNotPublished`, `acceptedReadbackUnverified` or `publicationUncertain`
 *   (an import that did not end accepted), `spentNotApplied` or `applicationUncertain` (an abandon that did not
 *   apply), and `sourceUnavailable` for any other failure, which carries the failure's own code when it is a
 *   cancellation, deadline, analysis or receipt code;
 * - `delivery-failed` with `sentinel.evidence.outputTooLarge` or `sentinel.evidence.deliveryRefused`, which never rolls
 *   back a recorded acceptance.
 */
export async function ownerEvidenceCommand(ws: Workspace, p: ParsedCommand): Promise<EvidenceCliOutput> {
  const action = p.args.action,
    target = p.args.target,
    command = `evidence.${action}`,
    value = (key: string) => (typeof p.flags[key] === 'string' ? (p.flags[key] as string) : undefined);
  const confirm = p.flags['--confirm'] === true,
    format = value('--format') ?? 'json',
    out = value('--out'),
    baselineRunId = value('--baseline'),
    sourceId = value('--source'),
    expect = value('--expect-candidate');
  if (!target || argumentsRefused(p, { action, target, confirm, format, out, baselineRunId, sourceId, expect }, value))
    return { result: refused(command, 'inputRefused') };
  const limit = value('--limit') === undefined ? IMPORT_CLI_LIMITS.defaultPage : Number(value('--limit'));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > IMPORT_CLI_LIMITS.maxPage)
    return { result: refused(command, 'inputRefused') };
  let store: SentinelStore;
  try {
    store = await openStore(ws.storePath);
  } catch (e) {
    return {
      result: refused(
        command,
        (e as { code?: string })?.code === 'sentinel.store.ownedElsewhere' ? 'ownerBusy' : 'storageRefused',
      ),
    };
  }
  const timing: ProofTiming = { signal: new AbortController().signal, deadlineAt: performance.now() + 120000 };
  const state: CommandState = { phase: 'preflight', metadata: { acceptance: 'not-established' } };
  let document: ImportViewEnvelope | ImportPageEnvelope | undefined, success: CommandResult;
  try {
    if (action === 'read') {
      ({ document, success } = await readImport(store, ws, { command, target, timing, baselineRunId }, state));
    } else if (action === 'list') {
      state.phase = 'readback';
      const context = importOwnerContext(store, ws, timing),
        ancestor = await ancestorFor(store, target, sourceId!);
      ownerContextOf(context);
      document = page(store, ancestor, value('--after'), limit);
      ownerContextOf(context);
      success = ack(command, 'read', { phase: 'readback', availability: 'not-evaluated' });
    } else if (action === 'abandon') {
      return await abandonImport(store, ws, { command, target, timing, confirm }, state);
    } else {
      state.phase = 'proof';
      const ancestor = await ancestorFor(store, target, sourceId!),
        files = { reportPath: value('--report')!, manifestPath: value('--manifest')! };
      const options = {
        timing,
        ...(baselineRunId ? { baselineRunId } : {}),
        ...(expect ? { expectCandidate: expect } : {}),
      };
      state.phase = 'input';
      let done = await acceptReportImportFiles(store, ws, ancestor, files, options);
      if (done.status === 'confirmationStale')
        return { result: refused(command, 'confirmationStale', 'receipt', { candidateDigest: done.candidateDigest }) };
      if (done.status === 'denied')
        return {
          result: result(command, 'refused', { reasonCode: reason('denied'), verdicts: printed(done.admission) }),
        };
      if (done.status === 'refused') return { result: refused(command, 'inputRefused', 'input') };
      if (done.status === 'awaiting-confirmation') {
        const candidateDigest = done.binding!.intent.input;
        if (!confirm)
          return {
            result: result(command, 'awaiting-confirmation', {
              verdicts: printed(done.admission),
              facts: { phase: 'receipt', candidateDigest, authority: 'owner-associated-imported-claims' },
            }),
          };
        state.phase = 'receipt';
        assertMayConfirm(OWNER);
        const issued = issueReceipt(receiptBook(ws), OWNER, done.binding!, { now: new Date(), ttlMs: 60000 });
        state.phase = 'publication';
        done = await acceptReportImportFiles(store, ws, ancestor, files, {
          ...options,
          expectCandidate: candidateDigest,
          receiptId: issued.id,
          ...(value('--predecessor') ? { predecessorId: value('--predecessor')! } : {}),
        });
      }
      if (done.status === 'confirmationStale')
        return { result: refused(command, 'confirmationStale', 'receipt', { candidateDigest: done.candidateDigest }) };
      if (done.status !== 'accepted') return { result: publicationRefused(command, done) };
      state.metadata = {
        phase: 'readback',
        acceptance: 'accepted',
        candidateDigest: done.candidateDigest,
        root: done.root,
        reused: done.reused,
      };
      document = publicImportView(done.view);
      success = ack(command, 'accepted', state.metadata);
    }
    let text: string;
    try {
      text = renderImportDocument(document, format as 'json' | 'md');
      const combined = result(success.command, success.outcome, {
        ...('reasonCode' in success ? { reasonCode: success.reasonCode } : {}),
        verdicts: success.verdicts,
        facts: { ...success.facts, document },
      });
      // Acknowledgement has a separate small cap; fully serialized document+wrapper has the output cap.
      if (evidenceWire({ result: combined, ...(!p.json ? { text } : {}) }, p.json).result.outcome === 'delivery-failed')
        throw new OutputLimitError();
      if (out) {
        writeNewFile(resolve(out), text);
        return { result: ack(command, success.outcome, { ...success.facts, delivery: 'written' }) };
      }
      return { result: combined, ...(!p.json ? { text } : {}) };
    } catch (error) {
      return {
        result: ack(
          command,
          'delivery-failed',
          { ...success.facts, delivery: 'refused' },
          error instanceof OutputLimitError ? 'outputTooLarge' : 'deliveryRefused',
        ),
      };
    }
  } catch (error) {
    const cause = (error as { code?: unknown })?.code;
    const facts =
      typeof cause === 'string' &&
      [
        'sentinel.execution.canceled',
        'sentinel.execution.deadlineExceeded',
        'sentinel.execution.analysisUnavailable',
        'sentinel.receipt.expired',
        'sentinel.receipt.mismatch',
        'sentinel.receipt.alreadyUsed',
      ].includes(cause)
        ? { ...state.metadata, cause }
        : state.metadata;
    return {
      result:
        state.metadata.acceptance === 'accepted'
          ? ack(command, 'delivery-failed', { ...state.metadata, delivery: 'refused' }, 'deliveryRefused')
          : refused(command, 'sourceUnavailable', state.phase, facts),
    };
  } finally {
    try {
      store.close();
    } catch {
      /* A close failure cannot roll back a verified publication or expose raw errors. */
    }
  }
}
