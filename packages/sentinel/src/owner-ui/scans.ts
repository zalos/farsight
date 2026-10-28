// The viewer's read model, gathered inside the held owner service (Sentinel v2 §9, lane L-UX U-1). It reads the
// retained runs, plans, units, attempts, invocation records, publications, snapshots, review traces and the report
// fold, and hands plain records to the pure fold (transport/http/read-model.ts). Read-only: it never admits, starts,
// writes or deletes, and never copies a plan, unit, attempt or artifact id into an answer. A scan is addressed by its
// run id; its number is its place in the order the store created its runs (the ledger's run-created events), exact
// and stable, so the list pages backwards by number. When a scan's accepted evidence holds a secret match (the review
// gate's own test), no review trace and no retained output text is read at all, and the fold withholds every file
// name and model text.
import type { SentinelStore } from '../store/index.js';
import type { ArtifactId, WorkRef } from '../contracts/common.js';
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
  stageUnits,
  unitAnswer,
  type AdapterRecord,
  type AttemptRecord,
  type InvocationRead,
  type OutputPrivacy,
  type OutputRecord,
  type RawOutputRecord,
  type ReviewRecord,
  type ReviewedRecord,
  type ScanAction,
  type ScanRecord,
  type UnitRecord,
  type WorkerPlace,
} from '../transport/http/read-model.js';
import { RUN_ID, type ReportFormatName } from '../transport/http/routes.js';
import { assertOwnerUiProof, type OwnerUiProof } from './authority.js';
import { OwnerUiError } from './session.js';

/** The answer must fit one owner-socket frame (transport/ipc.ts MAX_FRAME_BYTES) with room for the envelope. */
const ANSWER_BYTES = 900 * 1024;
/** How long a list may spend counting findings before the rest say *not counted yet*. */
const LIST_COUNT_MS = 5000;
/** The largest retained output read for its text, and the largest invocation record read at all. */
const OUTPUT_READ_BYTES = 4 * 1024 * 1024;
const INVOCATION_READ_BYTES = 256 * 1024;
const FINAL = new Set(['completed', 'canceled']);
const PRIVACY = new Set<OutputPrivacy>(['metadata', 'source-derived', 'source']);
/**
 * A recorded reason passed on only when it has the shape of a catalog code; the viewer prints it through the catalog
 * and says *not recorded* for a code the catalog lacks. (No catalog import here: the package's reviewed imports.)
 */
const safeCode = (v: unknown): string | null =>
  typeof v === 'string' && /^sentinel\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/.test(v) && v.length <= 128 ? v : null;
const ref = (u: { id: string; revision: number }) => `${u.id}#${u.revision}`;
/** The work a fold key names (`<id>#<revision>`; ids never hold `#`). */
const refOf = (key: string): WorkRef => {
  const i = key.lastIndexOf('#');
  return { id: key.slice(0, i), revision: Number(key.slice(i + 1)) } as WorkRef;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PLACE: Readonly<Record<string, WorkerPlace>> = {
  'coordinator-operation': 'in-process',
  'owned-child': 'child',
  'owned-container': 'container',
  'external-claim': 'external',
};

type Cached = { readonly key: string; readonly full: boolean; readonly record: ScanRecord };

export class OwnerUiScans {
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #cache = new Map<string, Cached>();
  readonly #registry: () => AdapterRegistry;
  /** Every run in the order the store created it, read incrementally from the ledger's run-created events. */
  readonly #index = { cursor: 0, runs: [] as string[], position: new Map<string, number>() };

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

  /** Brings the run index up to the ledger's latest event. Runs and their creation events are never deleted. */
  #indexRuns(signal?: AbortSignal): void {
    const index = this.#index;
    for (;;) {
      if (signal?.aborted) throw new OwnerUiError('sentinel.ownerUi.changed');
      const page = this.#store.ledger.readEvents({ after: index.cursor, limit: 500 });
      for (const e of page.events)
        if (e.kind === 'run-created' && e.runId && !index.position.has(e.runId)) {
          index.runs.push(e.runId);
          index.position.set(e.runId, index.runs.length);
        }
      index.cursor = page.cursor;
      if (!page.more) return;
    }
  }

  #number(runId: string | null | undefined): number | null {
    return runId ? (this.#index.position.get(runId) ?? null) : null;
  }

  /** A run id from an address: the run must be one this store created. */
  #resolve(runId: unknown, signal?: AbortSignal): string {
    if (typeof runId !== 'string' || !RUN_ID.test(runId) || runId === 'before') throw new OwnerUiError();
    this.#indexRuns(signal);
    if (!this.#index.position.has(runId) || !this.#store.ledger.getRun(runId))
      throw new OwnerUiError('sentinel.viewer.scanUnknown');
    return runId;
  }

  /**
   * The SCANS stop: one page of scans, newest first, each counted the way the PIPELINE stop counts it. `before` is
   * the cursor: the page lists the scans numbered below it (null for the newest page).
   */
  async scans(proof: OwnerUiProof, before: unknown, signal?: AbortSignal) {
    this.#held(proof);
    if (before !== null && (!Number.isSafeInteger(before) || (before as number) < 1)) throw new OwnerUiError();
    this.#indexRuns(signal);
    const total = this.#index.runs.length;
    const end = before === null ? total : Math.min((before as number) - 1, total);
    const start = Math.max(0, end - READ_MODEL_LIMITS.scans);
    const shown = this.#index.runs.slice(start, end).reverse();
    const until = performance.now() + LIST_COUNT_MS;
    const rows = [];
    for (const runId of shown) {
      if (signal?.aborted) throw new OwnerUiError('sentinel.ownerUi.changed');
      rows.push(scanRow(await this.#record(runId, { full: performance.now() < until, signal })));
      this.#held(proof);
    }
    return fit(scansAnswer(this.#workspace, rows, { total, before: before as number | null }, this.#scanAction()));
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
  async scan(proof: OwnerUiProof, runId: unknown, signal?: AbortSignal) {
    this.#held(proof);
    const record = await this.#record(this.#resolve(runId, signal), { full: true, signal });
    this.#held(proof);
    return fit(scanAnswer(this.#workspace, record));
  }

  /** The STAGE stop: one stage's retained record, check by check or review by review. */
  async stage(proof: OwnerUiProof, runId: unknown, stage: unknown, signal?: AbortSignal) {
    this.#held(proof);
    const stageId = stageOf(stage);
    const record = await this.#record(this.#resolve(runId, signal), { full: true, signal });
    this.#held(proof);
    const answer = stageAnswer(this.#workspace, record, stageId);
    if (!answer) throw new OwnerUiError('sentinel.viewer.stageUnknown');
    let units = answer.units.length;
    for (let shaped = answer; ;) {
      if (Buffer.byteLength(JSON.stringify(shaped)) <= ANSWER_BYTES) return shaped;
      if (units <= 1) throw new OwnerUiError('sentinel.service.projectionLimit');
      units = Math.ceil(units / 2);
      shaped = { ...answer, units: answer.units.slice(0, units), more: true };
    }
  }

  /**
   * One check or review of a stage, opened: its tries, the authenticated invocation of its accepted (else latest)
   * try, its retained outputs with bounded text, and for a review every exchange with the model's own words. Output
   * text is never read when the scan holds a secret match, or for an output that is the source itself.
   */
  async unit(proof: OwnerUiProof, runId: unknown, stage: unknown, number: unknown, signal?: AbortSignal) {
    this.#held(proof);
    const stageId = stageOf(stage);
    if (!Number.isSafeInteger(number) || (number as number) < 1) throw new OwnerUiError();
    const record = await this.#record(this.#resolve(runId, signal), { full: true, signal });
    const units = stageUnits(record, stageId);
    if (!units.length) throw new OwnerUiError('sentinel.viewer.stageUnknown');
    const unit = units[(number as number) - 1];
    if (!unit) throw new OwnerUiError('sentinel.viewer.unitUnknown');
    const work = refOf(unit.key);
    const detail = {
      invocation: unit.attempts.length ? await this.#invocation(work, unit, signal) : null,
      outputs: await this.#outputs(work, record.withheld, signal),
    };
    this.#held(proof);
    const answer = unitAnswer(this.#workspace, record, stageId, number as number, detail)!;
    // Fit one frame: shorter texts first, then fewer exchanges; never a partial record presented as the whole.
    for (let shaped = answer, keep = READ_MODEL_LIMITS.outputChars; ;) {
      if (Buffer.byteLength(JSON.stringify(shaped)) <= ANSWER_BYTES) return shaped;
      if (keep < 256) throw new OwnerUiError('sentinel.service.projectionLimit');
      keep = Math.floor(keep / 2);
      shaped = {
        ...answer,
        outputs: answer.outputs.map((o) =>
          o.text !== null && o.text.length > keep ? { ...o, text: o.text.slice(0, keep), truncated: true } : o,
        ),
        unit: answer.unit.review
          ? {
              ...answer.unit,
              review: {
                ...answer.unit.review,
                turns: answer.unit.review.turns.map((t) =>
                  t.text
                    ? {
                        ...t,
                        text: {
                          sent: cut(t.text.sent, Math.min(keep, READ_MODEL_LIMITS.turnChars)),
                          reply: cut(t.text.reply, Math.min(keep, READ_MODEL_LIMITS.turnChars)),
                        },
                      }
                    : t,
                ),
              },
            }
          : answer.unit,
      };
    }
  }

  /** The run a report route names; the caller renders it through the report delivery. */
  reportRun(
    proof: OwnerUiProof,
    runId: unknown,
    format: unknown,
  ): { runId: string; format: ReportFormatName; number: number } {
    this.#held(proof);
    if (typeof format !== 'string' || !['md', 'html', 'json', 'sarif'].includes(format)) throw new OwnerUiError();
    const id = this.#resolve(runId);
    if (this.#store.ledger.getRun(id)?.state !== 'completed')
      throw new OwnerUiError('sentinel.viewer.absent.notFinished');
    return { runId: id, format: format as ReportFormatName, number: this.#number(id)! };
  }

  async #record(runId: string, want: { full: boolean; signal?: AbortSignal }): Promise<ScanRecord> {
    const run = this.#store.ledger.getRun(runId);
    const final = !!run && FINAL.has(run.state);
    // A number is a run's place in creation order and never moves, so a finished scan's record is reused as it is.
    const key = run ? `${run.state}|${run.planRevision}|${run.completedAt ?? ''}` : '';
    const cached = this.#cache.get(runId);
    if (final && cached?.key === key && (cached.full || !want.full)) return cached.record;
    const record = (
      await withStoreReadBudget(this.#store, { durationMs: 20000, signal: want.signal }, () =>
        this.#gather(runId, want),
      )
    ).value;
    if (final) {
      if (this.#cache.size >= 256) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(runId, { key, full: want.full, record });
    }
    return record;
  }

  /** The decoded size the store recorded for an artifact, or null. */
  #size(id: string): number | null {
    try {
      const receipt = this.#store.ledger.objectsOf(id)[0];
      return receipt ? Number(receipt.rawSize) : null;
    } catch {
      return null;
    }
  }

  /**
   * The invocation record of one unit's accepted (else latest) try, authenticated against that try, its work, the
   * owner epoch that ran it and the adapter the plan pinned, before any field of it is used.
   */
  async #invocation(work: WorkRef, unit: UnitRecord, signal?: AbortSignal): Promise<InvocationRead | null> {
    const store = this.#store;
    const listed = store.ledger.listAttempts(work, { limit: 500 });
    const accepted = store.ledger.getPublication(work)?.attemptId;
    const chosen = (accepted && listed.find((a) => a.id === accepted)) || listed.at(-1);
    if (!chosen) return null;
    const attempt = store.ledger.getAttempt(chosen.id);
    if (!attempt || !same(attempt.work, work)) return { absent: 'sentinel.viewer.invocation.unverified' };
    const handle = attempt.envelope.invocation;
    if (!handle)
      return {
        absent:
          attempt.envelope.worker?.kind === 'coordinator-operation'
            ? 'sentinel.viewer.invocation.none'
            : 'sentinel.viewer.invocation.notRecorded',
      };
    if (signal?.aborted) throw new OwnerUiError('sentinel.ownerUi.changed');
    const size = this.#size(handle);
    if (size === null || size > INVOCATION_READ_BYTES) return { absent: 'sentinel.viewer.invocation.unverified' };
    let v: any;
    try {
      v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await store.readArtifact(handle)));
    } catch {
      return { absent: 'sentinel.viewer.invocation.unverified' };
    }
    store.assertHeld();
    const str = (x: unknown, max = 512) => typeof x === 'string' && x.length <= max;
    const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    const bound =
      !!v &&
      v.store === store.storeId &&
      v.attemptId === attempt.id &&
      same(v.work, { id: work.id, revision: work.revision }) &&
      v.coordinatorEpoch === attempt.epoch &&
      v.adapter?.id === unit.adapterId &&
      v.adapter?.digest === unit.implementationDigest &&
      str(v.adapter?.version, 128);
    const adapter = bound ? { id: v.adapter.id, version: v.adapter.version, digest: v.adapter.digest } : null;
    // Sentinel's own in-process operation (capture, parse, inventory, a review): the operation it ran, no argv.
    if (adapter && v.format === 'sentinel-operation-invocation/draft-1' && str(v.operation, 64))
      return {
        attempt: chosen.ordinal,
        adapter,
        isolation: 'in-process',
        operation: v.operation,
        image: null,
        argv: [],
        environmentNames: [],
        limits: null,
      };
    if (
      !adapter ||
      v.format !== 'sentinel-invocation/draft-1' ||
      (v.isolation !== 'container' && v.isolation !== 'child') ||
      !Array.isArray(v.argv) ||
      !Array.isArray(v.environmentNames) ||
      !num(v.limits?.memoryBytes) ||
      !num(v.limits?.cpus) ||
      !num(v.limits?.pids) ||
      !num(v.limits?.timeoutMs) ||
      (v.image !== undefined && (!str(v.image?.reference) || !str(v.image?.id) || !str(v.image?.architecture, 64)))
    )
      return { absent: 'sentinel.viewer.invocation.unverified' };
    return {
      attempt: chosen.ordinal,
      adapter,
      isolation: v.isolation,
      operation: null,
      image: v.image ? { reference: v.image.reference, id: v.image.id, architecture: v.image.architecture } : null,
      argv: v.argv.slice(0, READ_MODEL_LIMITS.argvItems),
      environmentNames: v.environmentNames.filter((n: unknown) => typeof n === 'string'),
      limits: {
        memoryBytes: Math.floor(v.limits.memoryBytes),
        cpus: v.limits.cpus,
        pids: Math.floor(v.limits.pids),
        timeoutMs: Math.floor(v.limits.timeoutMs),
      },
    };
  }

  /**
   * One unit's accepted outputs with their text. Nothing is read when the scan holds a secret match or for the source
   * itself; a large or non-text output keeps its size and type only.
   */
  async #outputs(work: WorkRef, withheld: boolean, signal?: AbortSignal): Promise<RawOutputRecord[]> {
    const publication = this.#store.ledger.getPublication(work);
    if (!publication) return [];
    const out: RawOutputRecord[] = [];
    for (const o of publication.outputs.slice(0, READ_MODEL_LIMITS.outputsPerUnit + 1)) {
      if (signal?.aborted) throw new OwnerUiError('sentinel.ownerUi.changed');
      const privacy: OutputPrivacy = PRIVACY.has(o.privacy as OutputPrivacy) ? (o.privacy as OutputPrivacy) : 'source';
      const bytes = this.#size(o.id);
      const base = { schema: o.schema, privacy, bytes };
      if (withheld || privacy === 'source' || out.length >= READ_MODEL_LIMITS.outputsPerUnit) {
        out.push({ ...base, text: null, reason: null });
        continue;
      }
      if (bytes === null || bytes > OUTPUT_READ_BYTES) {
        out.push({ ...base, text: null, reason: 'sentinel.viewer.raw.tooLarge' });
        continue;
      }
      let text: string | null = null;
      let reason: string | null = null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await this.#store.readArtifact(o.id as ArtifactId));
        if (controlBytes(text)) {
          text = null;
          reason = 'sentinel.viewer.raw.binary';
        }
      } catch (error) {
        reason = error instanceof TypeError ? 'sentinel.viewer.raw.binary' : 'sentinel.viewer.raw.unreadable';
      }
      this.#store.assertHeld();
      out.push({ ...base, text, reason });
    }
    return out;
  }

  async #gather(runId: string, want: { full: boolean; signal?: AbortSignal }): Promise<ScanRecord> {
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
    const checks = new Map(admitted.flatMap((a) => a.plan.checks).map((c) => [c.id, c]));
    const declared = new Map<
      string,
      { unit: PlanWork; revision: number; reusedFrom: { id: string; number: number | null } | null }
    >();
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
          reusedFrom: { id: work.runId, number: this.#number(work.runId) },
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
      // What a try ran comes from its own invocation record; the registry only says whether it still holds the
      // exact pinned adapter, and names a version for Sentinel's own in-process code when it does.
      const exact = !!entry && entry.digest === pin.digest;
      adapters[pin.adapterId] = {
        version: exact ? entry!.version : null,
        kind: entry?.kind ?? null,
        registry: !entry ? 'absent' : exact ? 'current' : 'changed',
      };
    }
    const units: UnitRecord[] = [];
    const spoken = new Set<string>();
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
      const segment = u.review?.segmentId ?? '';
      const reviewedCheck = segment.startsWith('guided-') ? checks.get(segment.slice(7)) : undefined;
      const reviewed: ReviewedRecord | null = !u.review
        ? null
        : reviewedCheck
          ? {
              kind: 'rule',
              familyId: reviewedCheck.familyId,
              revision: reviewedCheck.ruleRevision,
              scope: reviewedCheck.scopeId,
            }
          : { kind: 'files' };
      const base = {
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
        reviewed,
        work: work
          ? {
              // Work an earlier scan published is reused here, never run again (its tries are that scan's).
              state: reused ? 'satisfied-by-reuse' : work.state,
              reason: safeCode(work.reason) ?? safeCode((work.envelope as { reasonCode?: unknown }).reasonCode),
              kind: work.envelope.stage.kind,
              deadlineMs: work.envelope.resources.deadlineMs,
              reusedFrom: d.reusedFrom ?? (reused ? { id: work.runId, number: this.#number(work.runId) } : null),
            }
          : heldHere
            ? { state: 'blocked', reason: 'sentinel.viewer.selection.held', kind: '', deadlineMs: 0, reusedFrom: null }
            : null,
        attempts: reused ? [] : attempts,
        outputs: publication
          ? publication.outputs.map((o): OutputRecord => ({
              schema: o.schema,
              privacy: PRIVACY.has(o.privacy as OutputPrivacy) ? (o.privacy as OutputPrivacy) : 'source',
              bytes: want.full ? this.#size(o.id) : null,
            }))
          : null,
      } satisfies UnitRecord;
      // PIPELINE shows what each stage's first tried check ran, from that try's own invocation record.
      if (want.full && !reused && attempts.length && !spoken.has(u.contract)) {
        spoken.add(u.contract);
        units.push({
          ...base,
          invocation: await this.#invocation({ id: u.id, revision: u.revision }, base, want.signal),
        });
      } else units.push(base);
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
          // Folders never listed are left out: the preview and the full report fold count them differently today.
          report = {
            findings: { ...counts.findings },
            seenByNoStage: { ...counts.seenByNoStage },
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
      id: runId,
      number: this.#number(runId) ?? 0,
      parent: selection ? { id: selection.parent.runId, number: this.#number(selection.parent.runId) } : null,
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

/** A NUL or another control character (tab, newlines, form feed and carriage return aside) in the first 4 KiB. */
const controlBytes = (text: string): boolean => {
  for (let i = 0; i < Math.min(text.length, 4096); i++) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13) return true;
  }
  return false;
};
const stageOf = (stage: unknown): string => {
  if (typeof stage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stage)) throw new OwnerUiError();
  return stage;
};
const cut = <T extends { text: string; truncated: boolean } | null>(part: T, max: number): T =>
  part && part.text.length > max ? ({ text: part.text.slice(0, max), truncated: true } as T) : part;

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
 * from the retained trace the turns (each request's last user message and the model's reply to it, as retained; the
 * fold reads the STAGE list by their closed grammar and gives their bounded words only to one opened review), the
 * observations and the prompt text.
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
      inputBytes: typeof op.inputBytes === 'number' ? op.inputBytes : null,
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
