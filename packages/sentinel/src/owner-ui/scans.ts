// The viewer's read model, gathered inside the held owner service (Sentinel v2 §9, lane L-UX U-1). It reads the
// retained runs, plans, units, attempts, publications, snapshots, review traces and the report fold, and hands plain
// records to the pure fold (transport/http/read-model.ts). Read-only: it never admits, starts, writes or deletes, and
// never copies a run, unit, attempt or artifact id into an answer. A scan is addressed by its number in the newest
// window of the ledger's runs. When a scan's accepted evidence holds a secret match (the review gate's own test),
// no review trace is read at all and the fold withholds every file name and model text.
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import { withStoreReadBudget } from '../store/read-budget.js';
import { loadPlan, type AdmittedPlan } from '../execution/plans.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { openSnapshot } from '../snapshot/materialize.js';
import type { PlanWork } from '../contracts/plan.js';
import type { Workspace } from '../service/local.js';
import { canonicalResult } from '../service/canonical.js';
import { fullReportFormat } from '../service/full-report.js';
import { publicRegistry } from '../service/scanner-profile.js';
import { reviewSecretsKnown } from '../review/dispatch.js';
import { reviewIdentityIn, hasConfiguredReviews } from '../service/review-adapter.js';
import { loadPolicyInputsReadOnly } from '../policy/adoption.js';
import { effectivePolicy } from '../policy/settings.js';
import { readPublishedInstructions } from '../review/instructions.js';
import {
  READ_MODEL_LIMITS,
  scanAnswer,
  scanRow,
  scansAnswer,
  stageAnswer,
  type AdapterRecord,
  type AttemptRecord,
  type ReviewRecord,
  type ScanAction,
  type ScanRecord,
  type UnitRecord,
  type WorkerPlace,
} from '../transport/http/read-model.js';
import type { ReportFormatName } from '../transport/http/routes.js';
import { assertOwnerUiProof, type OwnerUiProof } from './authority.js';
import { OwnerUiError } from './session.js';

/**
 * The newest runs the ledger lists, the same window the owner panel's run list reads (process.ts): 64 shown and one
 * more to know whether older scans exist. A scan's number is its place among them, oldest first.
 */
const WINDOW = 65;
/** The answer must fit one owner-socket frame (transport/ipc.ts MAX_FRAME_BYTES) with room for the envelope. */
const ANSWER_BYTES = 900 * 1024;
/** How long a list may spend counting findings before the rest say *not counted yet*. */
const LIST_COUNT_MS = 5000;
const FINAL = new Set(['completed', 'canceled']);
/**
 * A recorded reason passed on only when it has the shape of a catalog code; the viewer prints it through the catalog
 * and says *not recorded* for a code the catalog lacks. (No catalog import here: the package's reviewed imports.)
 */
const safeCode = (v: unknown): string | null =>
  typeof v === 'string' && /^sentinel\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/.test(v) && v.length <= 128 ? v : null;
const ref = (u: { id: string; revision: number }) => `${u.id}#${u.revision}`;
const PLACE: Readonly<Record<string, WorkerPlace>> = {
  'coordinator-operation': 'in-process',
  'owned-child': 'child',
  'owned-container': 'container',
  'external-claim': 'external',
};

interface Listed {
  readonly runs: { id: string; state: string; createdAt: string }[];
  readonly numberOf: Map<string, number>;
  readonly more: boolean;
}

type Cached = { readonly key: string; readonly record: ScanRecord };

export class OwnerUiScans {
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #cache = new Map<string, Cached>();
  readonly #registry: () => AdapterRegistry;

  constructor(store: SentinelStore, ws: Workspace, registry?: () => AdapterRegistry) {
    boundOwner(store).assertHeld();
    this.#store = store;
    this.#ws = ws;
    this.#registry = registry ?? (() => publicRegistry(ws.trustDir));
  }

  #held(proof: OwnerUiProof) {
    assertOwnerUiProof(proof);
    this.#store.assertHeld();
    if (proof.issuer.storeId !== this.#store.storeId || proof.issuer.ownerEpoch !== this.#store.epoch)
      throw new OwnerUiError();
  }

  /** The workspace folder's own name, as the owner sees it in the file system. */
  get #workspace(): string {
    return this.#ws.path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  }

  #listed(): Listed {
    const rows = this.#store.ledger.listRuns(WINDOW);
    const runs = rows.slice(0, READ_MODEL_LIMITS.scans);
    const numberOf = new Map<string, number>();
    runs.forEach((r, i) => numberOf.set(r.id, runs.length - i));
    return { runs, numberOf, more: rows.length > runs.length };
  }

  #resolve(listed: Listed, number: unknown): string {
    if (!Number.isSafeInteger(number) || (number as number) < 1) throw new OwnerUiError();
    const run = listed.runs[listed.runs.length - (number as number)];
    if (!run) throw new OwnerUiError('sentinel.viewer.scanUnknown');
    return run.id;
  }

  /** The SCANS stop: the newest scans, each counted the way the PIPELINE stop counts it. */
  async scans(proof: OwnerUiProof, signal?: AbortSignal) {
    this.#held(proof);
    const listed = this.#listed();
    const shown = listed.runs;
    const until = performance.now() + LIST_COUNT_MS;
    const rows = [];
    for (const run of shown) {
      if (signal?.aborted) throw new OwnerUiError('sentinel.ownerUi.changed');
      rows.push(scanRow(await this.#record(run.id, listed, { full: performance.now() < until, signal })));
      this.#held(proof);
    }
    return fit(scansAnswer(this.#workspace, rows, listed.more, this.#scanAction()));
  }

  /**
   * Whether the owner panel can start a scan from a browser, said before anyone presses Scan: the same refusals its
   * preview and start answer (no adopted settings; a configured model stage needs the owner command line, ADR 48).
   */
  #scanAction(): ScanAction {
    try {
      const inputs = loadPolicyInputsReadOnly({ workspace: this.#ws.path, trustDir: this.#ws.trustDir });
      if (inputs.trust !== 'adopted') return { available: false, reasonCode: 'sentinel.preparation.unavailable' };
      if (hasConfiguredReviews(effectivePolicy(inputs)))
        return { available: false, reasonCode: 'sentinel.review.foregroundRequired' };
      return { available: true, reasonCode: null };
    } catch {
      return { available: false, reasonCode: 'sentinel.preparation.unavailable' };
    }
  }

  /** The PIPELINE stop: one scan's stages with their provenance. */
  async scan(proof: OwnerUiProof, number: unknown, signal?: AbortSignal) {
    this.#held(proof);
    const listed = this.#listed();
    const record = await this.#record(this.#resolve(listed, number), listed, { full: true, signal });
    this.#held(proof);
    return fit(scanAnswer(this.#workspace, record));
  }

  /** The STAGE stop: one stage's retained record, step by step. */
  async stage(proof: OwnerUiProof, number: unknown, stage: unknown, signal?: AbortSignal) {
    this.#held(proof);
    if (typeof stage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stage)) throw new OwnerUiError();
    const listed = this.#listed();
    const record = await this.#record(this.#resolve(listed, number), listed, { full: true, signal });
    this.#held(proof);
    const answer = stageAnswer(this.#workspace, record, stage);
    if (!answer) throw new OwnerUiError('sentinel.viewer.stageUnknown');
    let steps = answer.steps.length;
    for (let shaped = answer; ;) {
      if (Buffer.byteLength(JSON.stringify(shaped)) <= ANSWER_BYTES) return shaped;
      if (steps <= 1) throw new OwnerUiError('sentinel.service.projectionLimit');
      steps = Math.ceil(steps / 2);
      shaped = { ...answer, steps: answer.steps.slice(0, steps), more: true };
    }
  }

  /** The run a report route names, resolved from its number; the caller renders it through the report delivery. */
  reportRun(proof: OwnerUiProof, number: unknown, format: unknown): { runId: string; format: ReportFormatName } {
    this.#held(proof);
    if (typeof format !== 'string' || !['md', 'html', 'json', 'sarif'].includes(format)) throw new OwnerUiError();
    const listed = this.#listed();
    const runId = this.#resolve(listed, number);
    if (this.#store.ledger.getRun(runId)?.state !== 'completed')
      throw new OwnerUiError('sentinel.viewer.absent.notFinished');
    return { runId, format: format as ReportFormatName };
  }

  async #record(runId: string, listed: Listed, want: { full: boolean; signal?: AbortSignal }): Promise<ScanRecord> {
    const run = this.#store.ledger.getRun(runId);
    const final = !!run && FINAL.has(run.state);
    // Numbers count from the oldest listed scan: the key changes when the window slides, and then nothing is reused.
    const window = `${listed.runs.length}|${listed.runs.at(-1)?.id ?? ''}`;
    const key = run ? `${run.state}|${run.planRevision}|${run.completedAt ?? ''}|${window}` : '';
    const cached = this.#cache.get(runId);
    if (final && cached?.key === key && ('findings' in cached.record.report || !want.full)) return cached.record;
    const record = (
      await withStoreReadBudget(this.#store, { durationMs: 20000, signal: want.signal }, () =>
        this.#gather(runId, listed, want),
      )
    ).value;
    if (final) {
      if (this.#cache.size >= 256) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(runId, { key, record });
    }
    return record;
  }

  async #gather(runId: string, listed: Listed, want: { full: boolean; signal?: AbortSignal }): Promise<ScanRecord> {
    const store = this.#store;
    const run = store.ledger.getRun(runId);
    const plans = store.ledger.listPlans(runId);
    if (!plans.length) throw new OwnerUiError('sentinel.viewer.scanUnknown');
    const currentRevision = run?.planRevision ?? plans.at(-1)!.revision;
    const admitted: AdmittedPlan[] = [];
    for (const p of plans) if (p.revision <= currentRevision) admitted.push(await loadPlan(store, runId, p.revision));
    const current = admitted.at(-1)!;
    const included = admitted.filter((a) => a === current || a.plan.kind === 'bootstrap');
    const selection = current.selection;
    const held = new Set(selection?.held.map((h) => h.unit) ?? []);
    const declared = new Map<string, { unit: PlanWork; revision: number; reusedFrom: number | null }>();
    for (const a of included)
      for (const u of a.plan.units) declared.set(ref(u), { unit: u, revision: a.plan.revision, reusedFrom: null });
    // Work an earlier scan published that this one depends on without redoing (a selected rerun's bootstrap).
    for (const r of current.plan.reused) {
      if (declared.has(ref(r))) continue;
      const work = store.ledger.getWork(r);
      if (!work) continue;
      const owner = await loadPlan(store, work.runId, work.envelope.planRevision).catch(() => null);
      const unit = owner?.plan.units.find((u) => u.id === r.id && u.revision === r.revision);
      if (unit)
        declared.set(ref(r), {
          unit,
          revision: work.envelope.planRevision,
          reusedFrom: listed.numberOf.get(work.runId) ?? null,
        });
    }
    const adapters: Record<string, AdapterRecord> = {};
    const registry = this.#registry();
    for (const pin of [...included.flatMap((a) => a.profile.adapters), ...current.plan.pins.adapters]) {
      if (adapters[pin.adapterId]) continue;
      let entry: ReturnType<AdapterRegistry['get']> | null;
      try {
        entry = registry.get(pin.adapterId);
      } catch {
        entry = null;
      }
      // Only the exact adapter the plan pinned speaks for the scan: a changed one names its version, not this one's.
      const same = !!entry && entry.digest === pin.digest;
      adapters[pin.adapterId] = {
        version: same ? entry!.version : null,
        kind: entry?.kind ?? null,
        image: same && entry!.kind === 'external' ? entry!.image : null,
        command: same && entry!.kind === 'external' ? [...entry!.command] : null,
        registry: !entry ? 'absent' : same ? 'current' : 'changed',
      };
    }
    const units: UnitRecord[] = [];
    for (const [key, d] of declared) {
      const u = d.unit;
      const work = store.ledger.getWork(u);
      const publication = work ? store.ledger.getPublication(u) : null;
      const attempts: AttemptRecord[] = [];
      if (work)
        for (const a of store.ledger.listAttempts(u, { limit: 500 })) {
          const row = store.ledger.getAttempt(a.id);
          if (!row) continue;
          const env = row.envelope;
          attempts.push({
            ordinal: a.ordinal,
            state: row.state,
            startedAt: env.startedAt,
            endedAt: 'endedAt' in env ? env.endedAt : null,
            worker: PLACE[env.worker.kind] ?? 'external',
            usage: {
              certainty: env.usage.certainty,
              ...(typeof env.usage.inputTokens === 'number' ? { inputTokens: env.usage.inputTokens } : {}),
              ...(typeof env.usage.outputTokens === 'number' ? { outputTokens: env.usage.outputTokens } : {}),
              ...(typeof env.usage.monetaryCost === 'string' ? { monetaryCost: env.usage.monetaryCost } : {}),
              ...(typeof env.usage.currency === 'string' ? { currency: env.usage.currency } : {}),
            },
            accepted: publication?.attemptId === a.id,
            error: 'error' in env && env.error ? safeCode(env.error.code) : null,
          });
        }
      const heldHere = !work && held.has(u.id);
      const reused = d.reusedFrom !== null || (!!work && work.runId !== runId);
      units.push({
        key,
        planRevision: d.revision,
        stage: u.stage,
        contract: u.contract,
        adapterId: u.adapterId,
        implementationDigest: u.implementationDigest,
        dependencies: u.dependencies.map(ref),
        checks: u.checks.length,
        scopes: [...u.scopes],
        inputs: u.inputs.length,
        inputPaths: u.inputs.slice(0, 8).map((i) => i.relativePath),
        review: u.review ? { providerId: u.review.selection.providerId, modelId: u.review.selection.modelId } : null,
        work: work
          ? {
              // Work an earlier scan published is reused here, never run again (its tries are that scan's).
              state: reused ? 'satisfied-by-reuse' : work.state,
              reason: safeCode(work.reason) ?? safeCode((work.envelope as { reasonCode?: unknown }).reasonCode),
              kind: work.envelope.stage.kind,
              deadlineMs: work.envelope.resources.deadlineMs,
              reusedFrom: d.reusedFrom,
            }
          : heldHere
            ? { state: 'blocked', reason: 'sentinel.viewer.selection.held', kind: '', deadlineMs: 0, reusedFrom: null }
            : null,
        attempts: reused ? [] : attempts,
        outputs: publication ? publication.outputs.map((o) => o.schema) : null,
      });
    }
    // The snapshot, for the source commit only: every count of captured files is the report's (one source).
    let sources: ScanRecord['sources'] = null;
    const snapshotId = current.plan.pins.snapshotId ?? run?.envelope.snapshotId ?? null;
    if (snapshotId)
      try {
        const opened = await openSnapshot(store, snapshotId);
        sources = opened.snapshot.sources.map((s) => ({ commit: s.commit, dirty: s.dirty }));
      } catch {
        /* not captured yet, or not admitted: the fold says so */
      }
    // A secret match anywhere in the accepted evidence withholds every name and text, as the report does.
    const analysis = current.plan.kind === 'analysis';
    const withheld = analysis ? await reviewSecretsKnown(store, runId, current).catch(() => true) : false;
    let result: ScanRecord['result'] = null;
    if (run?.state === 'completed') {
      const r = await canonicalResult(store, 'status', runId, { executing: false, trustDir: this.#ws.trustDir });
      const f = (r.facts ?? {}) as Record<string, unknown>;
      result = {
        outcome: r.outcome,
        reasonCode: safeCode(r.reasonCode) ?? 'sentinel.viewer.absent.notRecorded',
        requiredChecks: typeof f.requiredChecks === 'number' ? f.requiredChecks : null,
        requiredComplete: typeof f.requiredComplete === 'number' ? f.requiredComplete : null,
      };
    }
    let report: ScanRecord['report'] = { absent: 'sentinel.viewer.absent.notFinished' };
    if (run?.state === 'completed' && analysis) {
      if (!want.full) report = { absent: 'sentinel.viewer.absent.notCounted' };
      else
        try {
          const built = await fullReportFormat(
            {
              store,
              runId,
              workspace: this.#ws.path,
              trustDir: this.#ws.trustDir,
              disclosure: 'shareable',
              now: new Date(),
            },
            'json',
            { signal: want.signal },
          );
          const adapterOf = new Map(current.plan.pins.rules.map((r) => [r.familyId, r.adapterId]));
          const byAdapter: Record<string, number> = {};
          for (const f of built.document.findings) {
            const a = adapterOf.get(f.ruleFamilyId);
            if (a) byAdapter[a] = (byAdapter[a] ?? 0) + 1;
          }
          const counts = built.document.counts;
          report = {
            findings: { ...counts.findings },
            seenByNoStage: { ...counts.seenByNoStage },
            unknownScopeBoundaries: { ...counts.unknownScopeBoundaries },
            findingsByAdapter: byAdapter,
          };
        } catch {
          report = { absent: 'sentinel.viewer.absent.reportUnavailable' };
        }
    }
    // Reviews: model identity and instruction digests are the owner panel's own projection (reviewIdentityIn, the
    // one process.ts shows), never re-derived here; the retained trace adds only turns, observations and the prompt
    // text. Nothing is read when the scan is withheld, and a list reads them only within its counting time.
    const reviewUnits = units.filter((u) => u.review && u.outputs);
    let review: ScanRecord['review'] = { status: reviewUnits.length ? 'available' : 'unavailable', units: [] };
    if (withheld && reviewUnits.length) review = { status: 'withheld', units: [] };
    else if (want.full && reviewUnits.length)
      try {
        const identity = await reviewIdentityIn(store, runId);
        if (identity.status === 'withheld') review = { status: 'withheld', units: [] };
        else if (identity.status !== 'available') review = { status: 'unreadable', units: [] };
        else {
          const traces: ReviewRecord[] = [];
          for (const u of reviewUnits) {
            const d = declared.get(u.key)!;
            const named = identity.reviews.find(
              (r) => r.stage === d.unit.stage && r.segmentId === d.unit.review?.segmentId,
            );
            if (!named) throw new OwnerUiError('sentinel.viewer.absent.reviewUnreadable');
            traces.push(
              reviewRecord(u.key, named, await readPublishedInstructions(store, d.unit, { signal: want.signal })),
            );
          }
          review = { status: 'available', units: traces };
        }
      } catch {
        review = { status: 'unreadable', units: [] };
      }
    return {
      number: listed.numberOf.get(runId) ?? 0,
      parentNumber: selection ? (listed.numberOf.get(selection.parent.runId) ?? null) : null,
      state: run?.state ?? 'awaiting',
      outcome: run?.outcome ?? null,
      createdAt: run?.envelope.createdAt ?? plans[0]!.admittedAt,
      completedAt: run?.completedAt ?? null,
      planRevision: currentRevision,
      profileId: current.plan.pins.profileId,
      deadlineMs: run?.envelope.budgets.deadlineMs ?? 0,
      sources,
      units,
      adapters,
      report,
      result,
      review,
      withheld,
    };
  }

  close() {
    this.#cache.clear();
  }
}

/** A list or scan answer that fits one frame, or a refusal that says the view is too large. */
function fit<T>(answer: T): T {
  if (Buffer.byteLength(JSON.stringify(answer)) > ANSWER_BYTES)
    throw new OwnerUiError('sentinel.service.projectionLimit');
  return answer;
}

const utf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};
const lastOf = (messages: readonly { role: string; content: string }[], role: string) =>
  [...messages].reverse().find((m) => m.role === role)?.content ?? null;

/**
 * One review unit, read for the STAGE stop: identity and instruction digests from the panel's own projection, and
 * from the retained trace only the turns (by the closed grammar, never the evidence served), the observations and the
 * prompt text.
 */
function reviewRecord(
  unitKey: string,
  identity: Extract<Awaited<ReturnType<typeof reviewIdentityIn>>, { status: 'available' }>['reviews'][number],
  trace: Awaited<ReturnType<typeof readPublishedInstructions>>,
): ReviewRecord {
  const m = trace.instructions;
  const promptBytes = trace.contents.find((c) => c.id === m.prompt.content)?.bytes;
  const byOperation = new Map(trace.requests.map((r) => [r.operationId, r]));
  const record = trace.record;
  const turns = record.operations.map((op) => {
    const request = byOperation.get(op.operationId);
    // The model's reply to this request travels as the next message of the following request, when there is one.
    const next = request
      ? trace.requests.find((r) => r.messages.length > request.messages.length && r.sessionId === request.sessionId)
      : undefined;
    const reply =
      request && next && next.messages[request.messages.length]?.role === 'assistant'
        ? next.messages[request.messages.length]!.content
        : null;
    const usage = (op as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
    return {
      outcome: String(op.outcome ?? ''),
      inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null,
      outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null,
      inputBytes: typeof op.inputBytes === 'number' ? op.inputBytes : 0,
      sent: request ? lastOf(request.messages, 'user') : null,
      reply,
    };
  });
  return {
    unitKey,
    model: identity.reportedIdentity
      ? {
          requested: identity.reportedIdentity.requestedModel ?? null,
          reported: identity.reportedIdentity.returnedModel ?? null,
          source: identity.reportedIdentity.source,
        }
      : null,
    prompt: {
      name: m.prompt.id,
      revision: identity.instructions.prompt.revision,
      digest: identity.instructions.prompt.digest,
      bytes: identity.instructions.prompt.bytes,
      text: promptBytes ? utf8(promptBytes) : null,
    },
    skills: identity.instructions.skills.map((s, i) => ({
      name: m.skills[i]?.id ?? '',
      revision: s.revision,
      digest: s.digest,
      bytes: s.bytes,
    })),
    verdict: record.verdict ?? null,
    outcome: record.outcome,
    totals: { ...record.totals },
    turns,
    observations: trace.observations.map((o) => ({
      message: o.message,
      severity: String(o.originalSeverity ?? 'unrated'),
      citations: o.evidence.flatMap((e) =>
        'relativePath' in e && typeof e.relativePath === 'string'
          ? [
              {
                path: e.relativePath,
                startByte: (e as { span?: { startByte?: number } }).span?.startByte ?? 0,
                endByte: (e as { span?: { endByte?: number } }).span?.endByte ?? 0,
              },
            ]
          : [],
      ),
    })),
    inspected: record.inspected.map((i) => i.relativePath),
  };
}
