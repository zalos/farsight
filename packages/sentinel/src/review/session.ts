// One bounded review session (PR 22): the loop shared by guided and general review.
//
// The session sends the fixed prompt and a task naming its scope, then alternates model replies and broker results
// until the model returns a valid final assessment or a bound stops it: steps, invalid replies, cumulative serialized
// input, the deadline, cancellation, or the provider (budget exhausted, uncertain usage, an error). Each model call is
// one operation with a stable id; the checkpoint records it settled, with the reply and any broker result, before the
// next call is made, so a resumed session never re-sends a settled operation and an interrupted one is never replayed
// for free (the budget ledger refuses a repeat). The record says exactly which files were read, at which lines,
// separately from anything the model claims; it is model-review inspection, never deterministic coverage, and its
// claims become observations a person may later dispose of. Nothing here approves, suppresses or promotes.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Digest,
  ModelIdentity,
  ObservationEnvelope,
  ReviewCheckpointEnvelope,
  ReviewOperation,
  ReviewRecordEnvelope,
  ScopedReason,
  ServedCitation,
} from '../contracts/index.js';
import { MAX_ENVELOPE_BYTES } from '../contracts/index.js';
import { canonicalDigest as digestOf } from '../policy/digest.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot } from '../policy/immutable.js';
import { parseEnvelope, validateEnvelope } from '../validate.js';
import type { ChatMessage } from './providers/kinds.js';
import {
  EvidenceBroker,
  type DisclosureFilter,
  type EvidenceItem,
  type EvidenceLimits,
  type EvidenceScope,
  type ToolRequest,
  type ToolResult,
} from './evidence.js';
import { reviewFail, type ReviewFrontierCode } from './errors.js';
import type { ReviewRequestEnvelope, ReviewProviderSelection, NativeReviewWire } from '../contracts/instructions.js';
import type { NamedStageOutput } from '../contracts/pipeline.js';
import {
  instructionManifest,
  renderedInstructions,
  instructionArtifacts,
  type PreparedInstructions,
  type InstructionArtifact,
} from './instructions.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { sha256Digest } from '../policy/digest.js';
import { promptDigest, type PromptArtifact } from './prompts.js';
import { validateReply } from './validator.js';

// ---- the model seam ----

export interface CallerReply {
  readonly content: string;
  readonly truncated: boolean;
  readonly identity: ModelIdentity;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** A model call. `kind` says whether a real provider stood behind it: mock replies can never qualify anything. */
export interface ModelCaller {
  readonly kind: 'mock' | 'provider';
  readonly selection?: Readonly<ReviewProviderSelection>;
  renderRequest?(messages: readonly ChatMessage[], maxOutputTokens: number): NativeReviewWire | undefined;
  call(req: {
    operationId: string;
    messages: readonly ChatMessage[];
    maxOutputTokens: number;
    requestedSelection?: Readonly<ReviewProviderSelection>;
    expectedWireDigest?: string;
    signal?: AbortSignal;
  }): Promise<CallerReply>;
}

/** Thrown by a caller; `spend: 'possible'` means the provider may have charged for it. */
export interface CallerFailure {
  readonly code?: string;
  readonly spend?: 'none' | 'possible';
}

// ---- specification and records ----

export interface SessionBudget {
  /** Model calls, valid or not. */
  readonly maxSteps: number;
  /** Rejected replies tolerated (each answered once with the rejection) before the session stops. */
  readonly maxInvalidReplies: number;
  /** Serialized request bytes summed over every call: the whole conversation is re-sent each time. */
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
  /** Wall-clock milliseconds from the session's first start. */
  readonly deadlineMs: number;
}

export interface SessionSpec {
  readonly sessionId: string;
  readonly kind: 'guided' | 'general';
  readonly runId: string;
  readonly attemptId: string;
  /** The adapter identity observations carry (`sentinel.review.guided` / `.general`) and its digest. */
  readonly adapterId: string;
  readonly adapterDigest: Digest;
  readonly prompt: PromptArtifact;
  readonly instructions?: PreparedInstructions;
  readonly segmentId?: string;
  readonly requestedSelection?: Readonly<ReviewProviderSelection>;
  readonly scope: EvidenceScope;
  readonly limits: EvidenceLimits;
  readonly budget: SessionBudget;
  /** The producer rule id observations carry, and the planned rule when guided. */
  readonly producerRuleId: string;
  readonly rule?: { readonly familyId: string; readonly revisionDigest: Digest };
  readonly tools: readonly ToolRequest['action'][];
  /** The promoted pack references the prompt and skills came from, with the digest each resolved to. */
  readonly packs?: readonly Readonly<{ ref: string; digest: string }>[];
  /**
   * Present when the review runs in native mode: the CLI's own loop over the scope's files, under this stage's
   * instructions, skills, output schema and budget (`review/runner.ts`). Absent, the review is a brokered session.
   */
  readonly native?: NativeReviewStage;
}

/** What a native review runs: one agent stage's declaration, as its spec seals it. */
export interface NativeReviewStage {
  /** The declared agent stage the review belongs to. */
  readonly stage: string;
  readonly runner: import('./runner.js').AgentRunnerId;
  /** The instructions file the CLI reads, by pack reference; absent means the bundled native instructions. */
  readonly instructions?: string;
  /** Ordered skill pack references. */
  readonly skills?: readonly string[];
  /** The one named output, validated against its schema before publication. */
  readonly produces: readonly Readonly<NamedStageOutput>[];
  readonly budget: Readonly<{ turns: number; tokens: number; seconds: number; usd?: string }>;
}

export type OperationRecord = ReviewOperation;
/** The registered `sentinel-review-checkpoint/draft-1` envelope. */
export type ReviewCheckpoint = ReviewCheckpointEnvelope;

/** Durable checkpoints. The coordinator's store can stand behind this seam; `FileCheckpointStore` is the default. */
export interface CheckpointStore {
  load(sessionId: string): Promise<ReviewCheckpoint | null>;
  save(cp: ReviewCheckpoint): Promise<void>;
}

/** The registered `sentinel-review-record/draft-1` envelope. */
export type ReviewRecord = ReviewRecordEnvelope;

export interface SessionResult {
  readonly record: ReviewRecord;
  readonly observations: readonly ObservationEnvelope[];
  readonly privateArtifacts?: readonly InstructionArtifact[];
}

const CHECKPOINT_SCHEMA = 'sentinel-review-checkpoint/draft-1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const served = (items: readonly EvidenceItem[]): ServedCitation[] =>
  items.map((e) => ({ id: e.id, startLine: e.startLine, endLine: e.endLine, citation: { ...e.citation } }));

/** Checkpoints as private JSON files, written whole and renamed into place. */
export class FileCheckpointStore implements CheckpointStore {
  readonly #dir: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#dir = dir;
  }
  #path(id: string) {
    if (!ID.test(id)) reviewFail('sentinel.review.checkpoint', 'not a session id');
    return join(this.#dir, `${id}.json`);
  }
  async load(sessionId: string): Promise<ReviewCheckpoint | null> {
    let text: string;
    try {
      text = readFileSync(this.#path(sessionId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const v = parseEnvelope('checkpoint', text);
    if (!v.ok)
      return reviewFail(
        'sentinel.review.checkpoint',
        `the checkpoint does not validate: ${v.errors[0]?.code} ${v.errors[0]?.path}`,
      );
    if (v.value.sessionId !== sessionId)
      reviewFail('sentinel.review.checkpoint', 'the checkpoint is not this session\u2019s');
    return v.value;
  }
  async save(cp: ReviewCheckpoint): Promise<void> {
    const path = this.#path(cp.sessionId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}

/** The digest a checkpoint is bound to: scope, files with their content ids, rules, limits, budget, prompt, tools. */
export function specDigest(spec: SessionSpec): Digest {
  if ((spec.segmentId !== undefined || spec.requestedSelection !== undefined) && !spec.instructions)
    reviewFail('sentinel.review.invalidInput', 'new segment selection requires a prepared instruction binding');
  return canonicalDigest({
    sessionId: spec.sessionId,
    kind: spec.kind,
    runId: spec.runId,
    adapterId: spec.adapterId,
    adapterDigest: spec.adapterDigest,
    prompt: promptDigest(spec.prompt),
    scope: spec.scope,
    limits: spec.limits,
    budget: spec.budget,
    producerRuleId: spec.producerRuleId,
    rule: spec.rule ?? null,
    tools: [...spec.tools].sort(),
    ...(spec.instructions
      ? {
          instructions: instructionManifest(spec.instructions).digest,
          segmentId: spec.segmentId ?? spec.sessionId,
          ...(spec.requestedSelection ? { requestedSelection: spec.requestedSelection } : {}),
        }
      : {}),
    ...(spec.packs?.length ? { packs: spec.packs.map((p) => ({ ref: p.ref, digest: p.digest })) } : {}),
    ...(spec.native ? { native: spec.native } : {}),
  }) as Digest;
}

const userJson = (value: unknown): ChatMessage => ({ role: 'user', content: JSON.stringify(value) });

const resultMessage = (r: ToolResult): ChatMessage =>
  userJson(
    r.ok
      ? {
          tool: r.tool,
          ok: true,
          data: r.data,
          evidence: r.evidence.map((e) => ({
            id: e.id,
            path: e.relativePath,
            lines: [e.startLine, e.endLine],
            untrusted: true,
            text: e.text,
          })),
        }
      : { tool: r.tool, ok: false, refused: r.refused, detail: r.detail },
  );

function taskMessage(spec: SessionSpec): ChatMessage {
  return userJson({
    task: spec.kind === 'guided' ? 'rule-guided review' : 'general review',
    rules: spec.scope.rules.map((r) => r.familyId),
    files: spec.scope.files.map((f) => f.relativePath),
    pathNodes: spec.scope.paths.map((p) => p.nodeId),
    tools: [...spec.tools, 'final'],
  });
}

/** Rebuilds every tool-result message from re-derived slices; null when any saved one differs. */
function rederive(
  messages: readonly ChatMessage[],
  broker: EvidenceBroker,
  withheld: readonly string[],
): { servedBytes: number } | null {
  let servedBytes = 0;
  for (let i = 2; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    let v: unknown;
    try {
      v = JSON.parse(m.content);
    } catch {
      return null;
    }
    const evidence = (v as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) continue;
    const entries = [];
    for (const e of evidence as { id?: string }[]) {
      if (typeof e?.id !== 'string') return null;
      if (withheld.includes(e.id)) {
        entries.push(e);
        continue;
      }
      const item = broker.served(e.id);
      if (!item) return null;
      servedBytes += Buffer.byteLength(item.text);
      entries.push({
        id: item.id,
        path: item.relativePath,
        lines: [item.startLine, item.endLine],
        untrusted: true,
        text: item.text,
      });
    }
    if (JSON.stringify({ ...(v as object), evidence: entries }) !== m.content) return null;
  }
  return { servedBytes };
}

export interface RunSessionOptions {
  readonly caller: ModelCaller;
  readonly checkpoints: CheckpointStore;
  readonly read: (content: string) => Promise<Uint8Array>;
  readonly withhold?: DisclosureFilter;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

function checkSpec(spec: SessionSpec): void {
  if (!ID.test(spec.sessionId)) reviewFail('sentinel.review.invalidInput', 'a session id is a short ledger id');
  const b = spec.budget;
  for (const [k, max] of [
    ['maxSteps', 200],
    ['maxInvalidReplies', 10],
    ['maxInputBytes', 512 * 1024 * 1024],
    ['maxOutputTokens', 131072],
    ['deadlineMs', 86_400_000],
  ] as const) {
    const v = b[k];
    if (!Number.isSafeInteger(v) || v < (k === 'maxInvalidReplies' ? 0 : 1) || v > max)
      reviewFail('sentinel.review.invalidInput', `budget.${k} is out of bounds`);
  }
  if (spec.tools.some((t) => !['list', 'read', 'rule', 'paths'].includes(t)))
    reviewFail('sentinel.review.invalidInput', 'unknown tool');
}

/** Runs (or resumes) one session to a final assessment or a stated stop. */
export async function runSession(spec: SessionSpec, opts: RunSessionOptions): Promise<SessionResult> {
  const { instructions: prepared, ...plain } = spec;
  spec = { ...snapshot(plain), ...(prepared ? { instructions: prepared } : {}) };
  checkSpec(spec);
  const now = opts.now ?? Date.now;
  const manifest = spec.instructions ? instructionManifest(spec.instructions) : undefined;
  if (
    manifest &&
    (manifest.prompt.id !== spec.prompt.id ||
      manifest.prompt.revision !== spec.prompt.version ||
      manifest.prompt.digest !== sha256Digest(Buffer.from(spec.prompt.text)))
  )
    reviewFail('sentinel.review.integrity', 'the prepared instructions name another base prompt');
  const system = spec.instructions ? renderedInstructions(spec.instructions) : spec.prompt.text;
  const selection = opts.caller.selection;
  if (manifest && opts.caller.kind === 'provider' && (!spec.requestedSelection || !selection))
    reviewFail('sentinel.review.invalidInput', 'instruction-bound provider sessions seal their requested selection');
  if (spec.requestedSelection && canonicalDigest(selection ?? null) !== canonicalDigest(spec.requestedSelection))
    reviewFail('sentinel.review.integrity', 'the caller selection changed');
  if (manifest && (!spec.segmentId || !ID.test(spec.segmentId)))
    reviewFail('sentinel.review.invalidInput', 'instruction-bound sessions require an explicit segment id');
  const digest = specDigest(spec);
  const broker = new EvidenceBroker(spec.scope, spec.limits, opts.read, opts.withhold);
  const tools = new Set(spec.tools);
  let cp = await opts.checkpoints.load(spec.sessionId);
  if (cp) {
    // Whatever store stood behind the seam, a checkpoint is a validated envelope for exactly this spec.
    const checked = validateEnvelope('checkpoint', cp);
    if (!checked.ok)
      reviewFail(
        'sentinel.review.checkpoint',
        `the checkpoint does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`,
      );
    if (cp.sessionId !== spec.sessionId || cp.specDigest !== digest)
      reviewFail('sentinel.review.checkpoint', 'the checkpoint is for another scope, prompt, budget or tool set');
    if (canonicalDigest(cp.instructions ?? null) !== canonicalDigest(manifest ?? null))
      reviewFail('sentinel.review.checkpoint', 'the checkpoint instruction binding changed');
    if (cp.messages[0]!.content !== system)
      reviewFail('sentinel.review.checkpoint', 'the checkpoint does not start with this session\u2019s prompt');
    if (cp.messages[1]!.role !== 'user' || cp.messages[1]!.content !== taskMessage(spec).content)
      reviewFail('sentinel.review.checkpoint', 'the checkpoint\u2019s task is not this session\u2019s');
    if (manifest)
      for (const r of cp.requests ?? []) {
        if (
          r.runId !== spec.runId ||
          r.snapshotId !== spec.scope.snapshotId ||
          r.sourceId !== spec.scope.sourceId ||
          r.segmentId !== (spec.segmentId ?? spec.sessionId) ||
          r.scopeDigest !== canonicalDigest(spec.scope) ||
          canonicalDigest(r.selection ?? null) !== canonicalDigest(spec.requestedSelection ?? null) ||
          canonicalDigest(r.messages) !== canonicalDigest(cp.messages.slice(0, r.messages.length))
        )
          reviewFail('sentinel.review.checkpoint', 'retained request differs from this exact session transcript');
      }
    // The transcript is re-derived, never trusted: every slice from the snapshot bytes under the current disclosure
    // filter, and every tool result rebuilt from those slices and compared with what was saved.
    const withheld = await broker.restore(cp.served, cp.toolCalls);
    const rebuilt = rederive(cp.messages, broker, withheld);
    if (rebuilt === null)
      reviewFail('sentinel.review.checkpoint', 'the checkpoint\u2019s transcript is not what its evidence gives');
    if (withheld.length && !cp.final && !cp.stopped) {
      // Evidence the model already saw is now withheld: the conversation cannot continue with it, and is not resent.
      cp = { ...cp, stopped: 'sentinel.review.frontier.withheld' };
      await opts.checkpoints.save(cp);
    }
    broker.chargeRestored(rebuilt!.servedBytes);
  } else {
    cp = {
      schema: CHECKPOINT_SCHEMA,
      sessionId: spec.sessionId,
      specDigest: digest,
      startedAt: stamp(now()),
      messages: [{ role: 'system', content: system }, taskMessage(spec)],
      ...(manifest ? { instructions: manifest, requests: [] } : {}),
      served: [],
      toolCalls: 0,
      invalid: 0,
      inputBytes: 0,
      operations: [],
      identity: null,
      final: null,
      stopped: null,
    };
    await opts.checkpoints.save(cp);
  }
  const startedAt = Date.parse(cp.startedAt);
  const fits = (next: ReviewCheckpoint) => Buffer.byteLength(JSON.stringify(next)) <= MAX_ENVELOPE_BYTES;
  const save = async (next: ReviewCheckpoint) => {
    // A checkpoint that would not fit one envelope is never written: the session stops at its last one that did.
    if (!fits(next)) next = { ...cp!, stopped: 'sentinel.review.frontier.budget' };
    const checked = validateEnvelope('checkpoint', next);
    if (!checked.ok)
      reviewFail(
        'sentinel.review.integrity',
        `a checkpoint does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`,
      );
    cp = next;
    await opts.checkpoints.save(next);
  };
  const stop = (code: ReviewFrontierCode) => save({ ...cp!, stopped: code });

  // A prepared request survived without a settled checkpoint. Do not invent dispatch certainty or replay it.
  if (cp.requests && cp.requests.length === cp.operations.length + 1 && !cp.final && !cp.stopped) {
    const request = cp.requests[cp.operations.length]!,
      bytes = Buffer.byteLength(JSON.stringify(request.messages));
    await save({
      ...cp,
      inputBytes: cp.inputBytes + bytes,
      operations: [
        ...cp.operations,
        {
          operationId: request.operationId,
          request: digestOf(request) as Digest,
          state: 'unsettled',
          inputBytes: bytes,
          outcome: 'failed',
        },
      ],
      stopped: 'sentinel.review.frontier.uncertainUsage',
    });
  }
  while (!cp.final && !cp.stopped) {
    const step = cp.operations.length;
    if (step >= spec.budget.maxSteps) {
      await stop('sentinel.review.frontier.steps');
      break;
    }
    if (now() - startedAt > spec.budget.deadlineMs) {
      await stop('sentinel.review.frontier.deadline');
      break;
    }
    if (opts.signal?.aborted) {
      await stop('sentinel.review.frontier.canceled');
      break;
    }
    const bytes = Buffer.byteLength(JSON.stringify(cp.messages));
    if (cp.inputBytes + bytes > spec.budget.maxInputBytes) {
      await stop('sentinel.review.frontier.budget');
      break;
    }
    const operationId = `${spec.sessionId}.op${step + 1}`;
    let request: ReviewRequestEnvelope | undefined;
    const messagesToSend = snapshot(cp.messages);
    const rendered = opts.caller.renderRequest?.(messagesToSend, spec.budget.maxOutputTokens),
      wire = rendered ? snapshot(rendered) : undefined;
    if (
      wire &&
      (!['sentinel-claude-chat/v1', 'sentinel-copilot-chat/v1'].includes(wire.encoding) ||
        typeof wire.system !== 'string' ||
        typeof wire.stdin !== 'string' ||
        typeof wire.requestedModel !== 'string' ||
        Object.keys(wire).sort().join(',') !== 'encoding,requestedModel,stdin,system' ||
        wire.system !== messagesToSend[0]?.content ||
        Buffer.byteLength(JSON.stringify(wire)) > MAX_ENVELOPE_BYTES)
    )
      reviewFail('sentinel.review.integrity', 'native wire exceeds its fixed request contract');
    if (manifest) {
      if (
        spec.requestedSelection &&
        canonicalDigest(opts.caller.selection ?? null) !== canonicalDigest(spec.requestedSelection)
      )
        reviewFail('sentinel.review.integrity', 'the caller selection changed');
      const body = {
        schema: 'sentinel-review-request/draft-1' as const,
        sessionId: spec.sessionId,
        runId: spec.runId,
        attemptId: spec.attemptId,
        snapshotId: spec.scope.snapshotId,
        sourceId: spec.scope.sourceId,
        segmentId: spec.segmentId ?? spec.sessionId,
        operationId,
        specDigest: digest,
        instructionDigest: manifest.digest,
        scopeDigest: canonicalDigest(spec.scope) as Digest,
        ...(spec.requestedSelection ? { selection: { ...spec.requestedSelection } } : {}),
        messages: messagesToSend,
        ...(wire ? { wire: { ...wire, digest: canonicalDigest(wire) as Digest } } : {}),
      };
      request = { ...body, digest: digestOf(body) as Digest };
      await save({ ...cp, requests: [...cp.requests!, request] });
      if (cp.stopped) break;
    }
    const requestRef = request ? { request: digestOf(request) as Digest } : {};
    let reply: CallerReply;
    try {
      reply = await opts.caller.call({
        operationId,
        messages: messagesToSend,
        maxOutputTokens: spec.budget.maxOutputTokens,
        ...(wire ? { expectedWireDigest: canonicalDigest(wire) } : {}),
        ...(spec.requestedSelection ? { requestedSelection: spec.requestedSelection } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      const e = (error ?? {}) as CallerFailure;
      // An operation the ledger already holds (a crash between its call and its checkpoint) is never re-sent: its
      // spend is uncertain until the owner reconciles it. A fenced epoch hands the session to the next coordinator.
      const code: ReviewFrontierCode =
        e.code === 'sentinel.provider.budgetExhausted' || e.code === 'sentinel.provider.envelopeOverdrawn'
          ? 'sentinel.review.frontier.budget'
          : e.code === 'sentinel.provider.canceled'
            ? 'sentinel.review.frontier.canceled'
            : e.code === 'sentinel.provider.epochFenced'
              ? 'sentinel.review.frontier.fenced'
              : e.code === 'sentinel.provider.reservationState' || e.spend === 'possible'
                ? 'sentinel.review.frontier.uncertainUsage'
                : 'sentinel.review.frontier.modelError';
      if (code === 'sentinel.review.frontier.fenced') throw error;
      await save({
        ...cp,
        inputBytes: cp.inputBytes + (e.spend === 'possible' ? bytes : 0),
        operations: [
          ...cp.operations,
          { operationId, ...requestRef, state: 'unsettled', inputBytes: bytes, outcome: 'failed' },
        ],
        stopped: code,
      });
      break;
    }
    const messages: ChatMessage[] = [...cp.messages, { role: 'assistant', content: reply.content }];
    const op = {
      operationId,
      ...requestRef,
      ...(manifest ? { identity: snapshot(reply.identity) } : {}),
      state: 'settled' as const,
      inputBytes: bytes,
      usage: { inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens },
    };
    // A reply that arrives after the deadline or a cancel is recorded (it was charged) and not acted on.
    const late: ReviewFrontierCode | null = opts.signal?.aborted
      ? 'sentinel.review.frontier.canceled'
      : now() - startedAt > spec.budget.deadlineMs
        ? 'sentinel.review.frontier.deadline'
        : null;
    if (late) {
      await save({
        ...cp,
        messages,
        inputBytes: cp.inputBytes + bytes,
        identity: reply.identity,
        operations: [...cp.operations, { ...op, outcome: late }],
        stopped: late,
      });
      break;
    }
    // An output cut at its allowance is incomplete: never a final assessment or a tool request.
    const v = reply.truncated
      ? {
          ok: false as const,
          code: 'sentinel.review.reply.truncated' as const,
          detail: 'the reply stopped at its output allowance',
        }
      : validateReply(reply.content, broker, tools);
    if (!v.ok) {
      const invalid = cp.invalid + 1;
      const over = invalid > spec.budget.maxInvalidReplies;
      if (!over)
        messages.push(
          userJson({
            rejected: v.code,
            detail: v.detail,
            reminder: 'reply with one JSON object of the grammar in your instructions',
          }),
        );
      await save({
        ...cp,
        messages,
        invalid,
        inputBytes: cp.inputBytes + bytes,
        identity: reply.identity,
        operations: [...cp.operations, { ...op, outcome: v.code }],
        ...(over ? { stopped: 'sentinel.review.frontier.invalidReplies' as const } : {}),
      });
      continue;
    }
    if (v.kind === 'final') {
      await save({
        ...cp,
        messages,
        inputBytes: cp.inputBytes + bytes,
        identity: reply.identity,
        final: v.assessment,
        operations: [...cp.operations, { ...op, outcome: 'final' }],
      });
      continue;
    }
    const result = await broker.run(v.request);
    messages.push(resultMessage(result));
    const st = broker.state();
    await save({
      ...cp,
      messages,
      served: served(st.served),
      toolCalls: st.toolCalls,
      inputBytes: cp.inputBytes + bytes,
      identity: reply.identity,
      operations: [...cp.operations, { ...op, outcome: 'tool' }],
    });
  }
  return finish(spec, cp, broker, opts.caller.kind, now());
}

function finish(
  spec: SessionSpec,
  cp: ReviewCheckpoint,
  broker: EvidenceBroker,
  callerKind: 'mock' | 'provider',
  at: number,
): SessionResult {
  const { sourceId, snapshotId } = spec.scope;
  const scopeId = (p: string) => `${sourceId}:${p}`;
  const served = broker.state();
  const ranges = new Map<string, { content: string; ranges: [number, number][] }>();
  for (const e of served.served) {
    const r = ranges.get(e.relativePath) ?? { content: e.citation.content, ranges: [] };
    r.ranges.push([e.startLine, e.endLine]);
    ranges.set(e.relativePath, r);
  }
  const inspected = [...ranges]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([relativePath, r]) => ({
      relativePath,
      content: r.content,
      ranges: r.ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    }));
  const notInspected = spec.scope.files.map((f) => f.relativePath).filter((p) => !ranges.has(p));
  const frontiers: ScopedReason[] = notInspected.map((p) => ({
    scopeId: scopeId(p),
    reasonCode: 'sentinel.review.frontier.notInspected',
  }));
  for (const r of served.refusals)
    if (r.code === 'sentinel.review.tool.withheld')
      frontiers.push({ scopeId: `${sourceId}:${spec.sessionId}`, reasonCode: 'sentinel.review.frontier.withheld' });
  if (cp.stopped) frontiers.push({ scopeId: `${sourceId}:${spec.sessionId}`, reasonCode: cp.stopped });
  const settled = cp.operations.filter((o) => o.state === 'settled');
  const completed = cp.final !== null;
  const observations: ObservationEnvelope[] = [];
  if (completed && cp.final!.verdict === 'finding' && cp.identity) {
    cp.final!.claims.forEach((c, i) => {
      // Re-derived from the snapshot bytes by the broker, never the saved copy.
      const evidence = c.citations.map((id) => {
        const item = broker.served(id);
        if (!item)
          return reviewFail('sentinel.review.integrity', 'a claim cites evidence this session cannot re-derive');
        return { ...item.citation };
      });
      const obs: ObservationEnvelope = {
        schema: 'sentinel-observation/draft-1',
        id: `obs-${canonicalDigest({ session: spec.sessionId, i, c }).slice(7, 39)}`,
        snapshotId,
        producer: {
          kind: 'model-review',
          adapterId: spec.adapterId,
          adapterDigest: spec.adapterDigest,
          attemptId: spec.attemptId,
          model: cp.identity!,
          promptDigest: (spec.instructions
            ? instructionManifest(spec.instructions).assembled.digest
            : promptDigest(spec.prompt)) as Digest,
        },
        producerRuleId: spec.producerRuleId,
        ...(spec.rule ? { rule: { familyId: spec.rule.familyId, revisionDigest: spec.rule.revisionDigest } } : {}),
        originalSeverity: 'unrated',
        message: c.statement.slice(0, 4000),
        evidence,
        limitationKeys: ['sentinel.review.limitation.modelClaim'],
        ...(c.cwe ? { mappings: { cwe: [c.cwe] } } : {}),
        observedAt: stamp(at),
      };
      const checked = validateEnvelope('observation', obs);
      if (!checked.ok)
        reviewFail(
          'sentinel.review.integrity',
          `an observation does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`,
        );
      observations.push(snapshot(obs));
    });
  }
  const body = {
    schema: 'sentinel-review-record/draft-1' as const,
    sessionId: spec.sessionId,
    kind: spec.kind,
    runId: spec.runId,
    attemptId: spec.attemptId,
    snapshotId,
    sourceId,
    specDigest: cp.specDigest,
    ...(spec.instructions
      ? {
          instructions: {
            manifest: digestOf(instructionManifest(spec.instructions)) as Digest,
            digest: instructionManifest(spec.instructions).digest,
            assembled: instructionManifest(spec.instructions).assembled.content,
            sourcePacket: canonicalDigest(spec.scope) as Digest,
            segmentId: spec.segmentId ?? spec.sessionId,
            ...(spec.requestedSelection ? { selection: { ...spec.requestedSelection } } : {}),
          },
        }
      : {}),
    promptDigest: (spec.instructions
      ? instructionManifest(spec.instructions).assembled.digest
      : promptDigest(spec.prompt)) as Digest,
    model: cp.identity,
    callerKind,
    outcome: completed ? ('completed' as const) : ('unfinished' as const),
    verdict: completed ? cp.final!.verdict : null,
    inspected,
    notInspected,
    frontiers,
    operations: cp.operations,
    totals: {
      steps: cp.operations.length,
      toolCalls: served.toolCalls,
      inputBytes: cp.inputBytes,
      inputTokens: settled.reduce((a, o) => a + (o.usage?.inputTokens ?? 0), 0),
      outputTokens: settled.reduce((a, o) => a + (o.usage?.outputTokens ?? 0), 0),
      usage: cp.operations.some((o) => o.state === 'unsettled') ? ('unknown' as const) : ('confirmed' as const),
    },
    refusals: served.refusals.length,
    rejectedReplies: cp.invalid,
    observations: observations.map((o) => o.id),
    establishes: 'model-review-inspection' as const,
    deterministicCoverage: false as const,
  };
  const record: ReviewRecord = {
    ...body,
    inspected: body.inspected.map((i) => ({ ...i, ranges: i.ranges.map((r) => [r[0], r[1]] as [number, number]) })),
    digest: digestOf({
      ...body,
      inspected: body.inspected.map((i) => ({ ...i, ranges: i.ranges.map((r) => [r[0], r[1]]) })),
    }) as Digest,
  };
  const checked = validateEnvelope('review', record);
  if (!checked.ok)
    reviewFail(
      'sentinel.review.integrity',
      `the review record does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`,
    );
  const privateArtifacts: InstructionArtifact[] = [];
  if (spec.instructions) {
    privateArtifacts.push(...instructionArtifacts(spec.instructions));
    privateArtifacts.push({
      id: canonicalDigest(spec.scope) as Digest,
      bytes: canonicalJsonBytes(spec.scope),
      schema: 'application/json',
      links: spec.scope.files.map((f) => f.content as Digest),
    });
    for (const value of [instructionManifest(spec.instructions), ...(cp.requests ?? [])]) {
      const bytes = canonicalJsonBytes(value);
      privateArtifacts.push({
        id: digestOf(value) as Digest,
        bytes,
        schema: value.schema,
        links:
          value.schema === 'sentinel-review-instructions/draft-1'
            ? [
                value.prompt.content,
                value.assembled.content,
                ...value.skills.flatMap((s) => [s.content, ...s.resources.map((r) => r.content)]),
              ]
            : [
                instructionManifest(spec.instructions).assembled.content,
                canonicalDigest(spec.scope) as Digest,
                digestOf(instructionManifest(spec.instructions)) as Digest,
              ],
      });
    }
  }
  return Object.freeze({
    record: snapshot(record),
    observations: Object.freeze(observations),
    ...(spec.instructions ? { privateArtifacts: Object.freeze(privateArtifacts) } : {}),
  });
}
