import { validateEnvelope } from '../validate.js';
// One held owner's bounded, sanitized read views. These maps are private delivery buffers, never store authority.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { CAPABILITIES } from '../capabilities.js';
import type { SentinelStore } from '../store/index.js';
import { READ_BUDGET_LIMITS, withStoreReadBudget, readBudgetCheckpoint } from '../store/read-budget.js';
import { ExecutionError } from '../execution/errors.js';
import { loadPlan } from '../execution/plans.js';
import { rerunEnvelopeOf } from './canonical.js';
import { fullReportFormat, REPORT_FORMATS, type ReportFormat } from './full-report.js';
import type { Workspace } from './local.js';
import { WORK_STATES, ATTEMPT_STATES, USAGE_CERTAINTIES, ENVELOPES } from '../contracts/index.js';
import type {
  ServiceCapabilities,
  RunInspection,
  InspectionCollection,
  InspectionRow,
  InspectionPage,
  ReportDelivery,
  DeliveryChunk,
} from '../contracts/service.js';

export const READONLY_OPERATIONS = Object.freeze([
  'service.capabilities',
  'run.inspect',
  'view.page',
  'report.open',
  'delivery.read',
] as const);
export const READONLY_LIMITS = Object.freeze({
  pageRows: 128,
  pageBytes: 256 * 1024,
  viewUnits: 2000,
  viewAttempts: 10000,
  viewBytes: 8 * 1024 * 1024,
  viewTtlMs: 60000,
  views: 8,
  viewCacheBytes: 64 * 1024 * 1024,
  inspectMs: 5000,
  copyMs: 250,
  reportMs: READ_BUDGET_LIMITS.durationMs,
  reportReads: READ_BUDGET_LIMITS.reads,
  reportDecodedBytes: READ_BUDGET_LIMITS.decodedBytes,
  reportEncodedBytes: READ_BUDGET_LIMITS.encodedBytes,
  deliveryBytes: 32 * 1024 * 1024,
  deliveryCacheBytes: 64 * 1024 * 1024,
  deliveries: 4,
  deliveryTtlMs: 300000,
  chunkDefault: 16 * 1024,
  chunkMax: 64 * 1024,
  cursors: 4096,
});
export type ReadonlyErrorCode =
  | 'sentinel.service.requestInvalid'
  | 'sentinel.service.planUnknown'
  | 'sentinel.service.viewExpired'
  | 'sentinel.service.viewInvalid'
  | 'sentinel.service.viewChanged'
  | 'sentinel.service.inspectBusy'
  | 'sentinel.service.projectionLimit'
  | 'sentinel.service.deliveryExpired'
  | 'sentinel.service.deliveryInvalid'
  | 'sentinel.service.deliveryLimit'
  | 'sentinel.service.deliveryBusy';
export class ReadonlyError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ReadonlyErrorCode) {
    super(code);
    this.name = 'ReadonlyError';
    this.retryable =
      code === 'sentinel.service.viewChanged' ||
      code === 'sentinel.service.deliveryBusy' ||
      code === 'sentinel.service.inspectBusy';
  }
}
const invalid = (): never => {
  throw new ReadonlyError('sentinel.service.requestInvalid');
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export function readFields(
  body: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
  const out = body as Record<string, unknown>;
  if (
    Object.keys(out).some((k) => ![...required, ...optional].includes(k)) ||
    required.some((k) => !Object.hasOwn(out, k))
  )
    return invalid();
  return out;
}
const number = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const token = (prefix: string) => `${prefix}.${randomBytes(16).toString('hex')}`;
const handle = () => `h${randomBytes(16).toString('hex')}`;
const collections: readonly InspectionCollection[] = ['works', 'attempts', 'inputs', 'outputs'];
const safeCode = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('sentinel.') && Object.hasOwn(STRINGS, v);
const schemas = new Set([
  'sentinel-worker/draft-1#result',
  'sentinel-observation/draft-1',
  'sentinel-coverage/draft-1',
  'sentinel-driver-finding/draft-1',
  'sentinel-driver-report/draft-1',
  'sentinel-controls/draft-1',
  'sentinel-inspection/draft-1',
  'sentinel-preview-findings/draft-1',
  'application/json',
]);
type Cursor = { collection: InspectionCollection; workKey?: string; attemptKey?: string; offset: number };
type View = {
  manifest: RunInspection;
  channel: string;
  until: number;
  bytes: number;
  rows: Record<InspectionCollection, InspectionRow[]>;
  keys: Map<string, string>;
  workKeys: Set<string>;
  attemptKeys: Map<string, string>;
  cursors: Map<string, Cursor>;
  cursorKeys: Map<string, string>;
};
type Delivery = { manifest: ReportDelivery; channel: string; until: number; bytes: Buffer };

/** Checks the actual raw-byte boundary before creating the delivery buffer (also used by the boundary tests). */
export function deliveryBuffer(text: string): Buffer {
  if (Buffer.byteLength(text, 'utf8') > READONLY_LIMITS.deliveryBytes)
    throw new ReadonlyError('sentinel.service.deliveryLimit');
  return Buffer.from(text, 'utf8');
}
export function checkInspectionPageBytes(page: InspectionPage): void {
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > READONLY_LIMITS.pageBytes)
    throw new ReadonlyError('sentinel.service.projectionLimit');
}
export class ReadonlyViews {
  readonly #views = new Map<string, View>();
  readonly #deliveries = new Map<string, Delivery>();
  readonly #closed = new AbortController();
  #generating = false;
  #inspecting = false;
  constructor(
    readonly store: SentinelStore,
    readonly ws: Workspace,
    readonly now: () => Date = () => new Date(),
  ) {}
  close() {
    this.#closed.abort();
    this.#views.clear();
    this.#deliveries.clear();
  }
  /** Absolute TTLs only: connected readers and repeated reads never renew retention. */
  get retaining(): boolean {
    this.#purge();
    return this.#views.size > 0 || this.#deliveries.size > 0;
  }
  #signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.#closed.signal]) : this.#closed.signal;
  }
  #held(signal?: AbortSignal) {
    this.store.assertHeld();
    if (signal?.aborted) throw new ExecutionError('sentinel.execution.canceled');
  }
  #purge() {
    const now = performance.now();
    for (const [id, v] of this.#views) if (now >= v.until) this.#views.delete(id);
    for (const [id, d] of this.#deliveries) if (now >= d.until) this.#deliveries.delete(id);
  }
  capabilities(): ServiceCapabilities {
    this.#held();
    return {
      schema: 'sentinel-service-capabilities/draft-1',
      apiRevision: 1,
      storeId: this.store.storeId,
      epoch: this.store.epoch,
      operations: [...READONLY_OPERATIONS, 'run.describe', 'run.status', 'run.wait'],
      schemas: ['servicecapabilities', 'runinspection', 'inspectionpage', 'reportdelivery', 'deliverychunk'].map(
        (k) => ENVELOPES[k as keyof typeof ENVELOPES].schema,
      ),
      controlsSupported: false,
      features: CAPABILITIES.map((c) => ({
        id: c.id,
        library: c.state,
        readiness: 'not-checked',
        reasonCode: c.reasonCode,
      })),
      limits: { ...READONLY_LIMITS },
      limitationKey: 'sentinel.service.readLimits',
    };
  }
  async inspect(body: unknown, channel: string, signal?: AbortSignal): Promise<RunInspection> {
    const f = readFields(body, ['runId'], ['planRevision']);
    if (!id(f.runId) || (f.planRevision !== undefined && !number(f.planRevision, 1, 2147483647))) return invalid();
    if (this.#inspecting) throw new ReadonlyError('sentinel.service.inspectBusy');
    this.#inspecting = true;
    const stop = this.#signal(signal);
    let prepared: View;
    try {
      prepared = (
        await withStoreReadBudget(this.store, { durationMs: READONLY_LIMITS.inspectMs, signal: stop }, async () => {
          const original = this.store.ledger.getRun(f.runId as string);
          // Exact admitted selected children have an existing validated envelope derivation, not an arbitrary latest fallback.
          const awaiting = original ? undefined : await rerunEnvelopeOf(this.store, f.runId as string);
          if (!original && !awaiting) throw new ReadonlyError('sentinel.service.planUnknown');
          const recorded = original?.planRevision ?? awaiting!.planRevision;
          const revision = f.planRevision === undefined ? recorded : (f.planRevision as number);
          if (revision > recorded || !this.store.ledger.getPlan(f.runId as string, revision))
            throw new ReadonlyError('sentinel.service.planUnknown');
          for (let generation = 0; generation < 2; generation++) {
            const sequence = this.store.ledger.currentSequence();
            const admitted = await loadPlan(this.store, f.runId as string, revision);
            readBudgetCheckpoint(this.store);
            const { plan, selection } = admitted;
            const unitRefs = new Set(plan.units.map((u) => `${u.id}\0${u.revision}`));
            if (plan.units.length > READONLY_LIMITS.viewUnits)
              throw new ReadonlyError('sentinel.service.projectionLimit');
            let bytes = 0,
              count = 0,
              totalAttempts = 0;
            const copyStart = performance.now(),
              keys = new Map<string, string>(),
              workKeys = new Set<string>(),
              attemptKeys = new Map<string, string>();
            const key = (kind: string, value: string) => {
              const full = `${kind}\0${value}`;
              let k = keys.get(full);
              if (!k) {
                k = handle();
                bytes += Buffer.byteLength(full) + k.length + 64;
                if (bytes > READONLY_LIMITS.viewBytes) throw new ReadonlyError('sentinel.service.projectionLimit');
                keys.set(full, k);
              }
              return k;
            };
            const workKey = (ref: { id: string; revision: number }) => key('work', `${ref.id}\0${ref.revision}`);
            const rows: View['rows'] = { works: [], attempts: [], inputs: [], outputs: [] };
            const append = (collection: InspectionCollection, row: InspectionRow) => {
              if (++count % 64 === 0) {
                readBudgetCheckpoint(this.store);
                if (performance.now() - copyStart > READONLY_LIMITS.copyMs)
                  throw new ReadonlyError('sentinel.service.projectionLimit');
              }
              bytes += Buffer.byteLength(JSON.stringify(row));
              if (bytes > READONLY_LIMITS.viewBytes) throw new ReadonlyError('sentinel.service.projectionLimit');
              rows[collection].push(row);
            };
            for (const unit of plan.units) {
              if (unit.dependencies.length > 1024) throw new ReadonlyError('sentinel.service.projectionLimit');
              const ref = { id: unit.id, revision: unit.revision },
                wk = workKey(ref);
              workKeys.add(wk);
              const work = this.store.ledger.getWork(ref);
              if (
                work &&
                (!validateEnvelope('work', work.envelope).ok ||
                  work.runId !== plan.runId ||
                  work.envelope.planRevision !== revision ||
                  work.envelope.inputFingerprint !== unit.inputFingerprint ||
                  work.envelope.stage.implementationDigest !== unit.implementationDigest ||
                  !WORK_STATES.includes(work.state as any))
              )
                throw new ReadonlyError('sentinel.service.viewInvalid');
              const publication = work ? this.store.ledger.getPublication(ref) : null;
              append('works', {
                kind: 'work',
                workKey: wk,
                revision: unit.revision,
                stage: unit.stage,
                prerequisites: unit.dependencies.map((ref) => ({
                  workKey: workKey(ref),
                  revision: ref.revision,
                  binding: unitRefs.has(`${ref.id}\0${ref.revision}`) ? 'in-view' : 'reference-only',
                })),
                disposition: selection
                  ? selection.selected.some((s) => s.unit === unit.id)
                    ? 'selected'
                    : selection.downstream.includes(unit.id)
                      ? 'downstream'
                      : 'held'
                  : 'planned',
                recordedWork: work
                  ? {
                      state: work.state as any,
                      influenceKey: key('influence', work.envelope.influenceManifest),
                      activeAttemptKey: work.activeAttemptId ? key('attempt', work.activeAttemptId) : null,
                    }
                  : null,
                inputCount: unit.inputs.length,
                implementationKey: key('implementation', unit.implementationDigest),
                ...(work ? { resources: { ...work.envelope.resources } } : {}),
              });
              for (const input of unit.inputs)
                append('inputs', {
                  kind: 'input',
                  workKey: wk,
                  sourceKey: key('source', input.sourceId),
                  inputKey: key('input', `${input.sourceId}\0${input.relativePath}`),
                  contentKey: key('artifact', input.content),
                });
              const attempts = work ? this.store.ledger.countAttempts(ref) : 0;
              totalAttempts += attempts;
              if (totalAttempts > READONLY_LIMITS.viewAttempts)
                throw new ReadonlyError('sentinel.service.projectionLimit');
              let after = 0,
                seen = 0;
              while (seen < attempts) {
                const page = this.store.ledger.listAttempts(ref, {
                  afterOrdinal: after,
                  limit: Math.min(500, attempts - seen),
                });
                if (!page.length) throw new ReadonlyError('sentinel.service.viewInvalid');
                for (const entry of page) {
                  const a = this.store.ledger.getAttempt(entry.id);
                  if (
                    !a ||
                    a.work.id !== ref.id ||
                    a.work.revision !== ref.revision ||
                    !ATTEMPT_STATES.includes(a.state as any) ||
                    !USAGE_CERTAINTIES.includes(a.envelope.usage.certainty)
                  )
                    throw new ReadonlyError('sentinel.service.viewInvalid');
                  const env = a.envelope,
                    ak = key('attempt', entry.id);
                  attemptKeys.set(ak, wk);
                  const accepted = publication?.attemptId === entry.id;
                  append('attempts', {
                    kind: 'attempt',
                    workKey: wk,
                    attemptKey: ak,
                    ordinal: entry.ordinal,
                    state: a.state as any,
                    startedAt: env.startedAt,
                    ...('endedAt' in env ? { endedAt: env.endedAt } : {}),
                    usageCertainty: env.usage.certainty,
                    invocationKey: env.invocation ? key('invocation', env.invocation) : null,
                    outputCount: 'outputs' in env ? env.outputs.length : null,
                    accepted,
                    ...('error' in env && env.error && safeCode(env.error.code)
                      ? { error: { code: env.error.code, retryable: env.error.retryable } }
                      : {}),
                  });
                  const outputs = accepted
                    ? publication!.outputs
                    : 'outputs' in env
                      ? env.outputs.map((output) => ({ id: output, schema: null, privacy: null }))
                      : [];
                  for (const output of outputs)
                    append('outputs', {
                      kind: 'output',
                      workKey: wk,
                      attemptKey: ak,
                      outputKey: key('artifact', output.id),
                      accepted,
                      mediaType: output.schema && schemas.has(output.schema) ? output.schema : null,
                      privacy: output.privacy,
                      publicationKey: accepted ? key('publication', publication!.resultDigest) : null,
                      sequence: accepted ? publication!.sequence : null,
                      acceptedAt: accepted ? publication!.acceptedAt : null,
                    });
                  after = entry.ordinal;
                  seen++;
                }
              }
            }
            readBudgetCheckpoint(this.store);
            if (performance.now() - copyStart > READONLY_LIMITS.copyMs)
              throw new ReadonlyError('sentinel.service.projectionLimit');
            const current = this.store.ledger.getRun(plan.runId),
              record = this.store.ledger.getPlan(plan.runId, revision);
            if (
              original
                ? !current ||
                  current.planRevision !== original.planRevision ||
                  current.envelope.snapshotId !== original.envelope.snapshotId
                : current !== null
            )
              throw new ReadonlyError('sentinel.service.viewChanged');
            if (record?.plan !== admitted.record.plan || record.digest !== plan.digest)
              throw new ReadonlyError('sentinel.service.viewChanged');
            if (this.store.ledger.currentSequence() !== sequence) {
              if (!generation) continue;
              throw new ReadonlyError('sentinel.service.viewChanged');
            }
            const created = this.now(),
              expiry = new Date(created.getTime() + READONLY_LIMITS.viewTtlMs);
            const counted = (name: InspectionCollection) => ({
              n: rows[name].length,
              unit: `sentinel.service.count.${name}`,
              bizUnit: `sentinel.service.count.${name}`,
              scope: 'sentinel.scope.inspection',
              source: `ReadonlyViews.inspect.${name}`,
            });
            const manifest: RunInspection = {
              schema: 'sentinel-run-inspection/draft-1',
              viewId: token('view'),
              storeId: this.store.storeId,
              epoch: this.store.epoch,
              runKey: key('run', plan.runId),
              planKey: key('plan', admitted.record.plan),
              snapshotKey: plan.pins.snapshotId ? key('snapshot', plan.pins.snapshotId) : null,
              planRevision: revision,
              sequence,
              historical: revision < recorded,
              status: current?.state ?? 'awaiting-first-execution',
              outcome: current?.outcome ?? null,
              createdAt: created.toISOString(),
              expiresAt: expiry.toISOString(),
              counts: {
                works: counted('works'),
                attempts: counted('attempts'),
                inputs: counted('inputs'),
                outputs: counted('outputs'),
              },
            };
            return {
              manifest,
              channel,
              until: performance.now() + READONLY_LIMITS.viewTtlMs,
              bytes,
              rows,
              keys,
              workKeys,
              attemptKeys,
              cursors: new Map(),
              cursorKeys: new Map(),
            };
          }
          throw new ReadonlyError('sentinel.service.viewChanged');
        })
      ).value;
      // No await or callbacks after this fence: scope success precedes cache installation.
      this.#held(stop);
      if (this.store.ledger.currentSequence() !== prepared.manifest.sequence)
        throw new ReadonlyError('sentinel.service.viewChanged');
      this.#purge();
      while (
        this.#views.size >= READONLY_LIMITS.views ||
        [...this.#views.values()].reduce((n, v) => n + v.bytes, 0) + prepared.bytes > READONLY_LIMITS.viewCacheBytes
      )
        this.#views.delete(this.#views.keys().next().value!);
      this.#views.set(prepared.manifest.viewId, prepared);
      return structuredClone(prepared.manifest);
    } finally {
      this.#inspecting = false;
    }
  }
  page(body: unknown, channel: string): InspectionPage {
    const f = readFields(body, ['viewId', 'collection'], ['workKey', 'attemptKey', 'cursor', 'limit']);
    if (
      !id(f.viewId) ||
      !collections.includes(f.collection as any) ||
      (f.limit !== undefined && !number(f.limit, 1, READONLY_LIMITS.pageRows)) ||
      ['workKey', 'attemptKey', 'cursor'].some((k) => f[k] !== undefined && !id(f[k]))
    )
      return invalid();
    this.#held();
    this.#purge();
    const view = this.#views.get(f.viewId);
    if (!view) throw new ReadonlyError('sentinel.service.viewExpired');
    if (view.channel !== channel) throw new ReadonlyError('sentinel.service.viewInvalid');
    if (
      (f.workKey && !view.workKeys.has(f.workKey as string)) ||
      (f.attemptKey && !view.attemptKeys.has(f.attemptKey as string)) ||
      (f.workKey && f.attemptKey && view.attemptKeys.get(f.attemptKey as string) !== f.workKey)
    )
      throw new ReadonlyError('sentinel.service.viewInvalid');
    if (f.attemptKey && (f.collection === 'works' || f.collection === 'inputs')) return invalid();
    const collection = f.collection as InspectionCollection,
      limit = f.limit === undefined ? 32 : (f.limit as number);
    let offset = 0;
    if (f.cursor) {
      const cursor = view.cursors.get(f.cursor as string);
      if (
        !cursor ||
        cursor.collection !== collection ||
        cursor.workKey !== f.workKey ||
        cursor.attemptKey !== f.attemptKey
      )
        throw new ReadonlyError('sentinel.service.viewInvalid');
      offset = cursor.offset;
    }
    const rows = view.rows[collection].filter(
      (r) =>
        (!f.workKey || r.workKey === f.workKey) &&
        (!f.attemptKey || ('attemptKey' in r && r.attemptKey === f.attemptKey)),
    );
    const selected = rows.slice(offset, offset + limit),
      next = offset + selected.length;
    let nextCursor: string | null = null;
    if (next < rows.length) {
      const key = JSON.stringify([collection, f.workKey ?? null, f.attemptKey ?? null, next]);
      nextCursor = view.cursorKeys.get(key) ?? null;
      if (!nextCursor) {
        if (view.cursors.size >= READONLY_LIMITS.cursors) throw new ReadonlyError('sentinel.service.projectionLimit');
        nextCursor = token('cursor');
        view.cursorKeys.set(key, nextCursor);
        view.cursors.set(nextCursor, {
          collection,
          workKey: f.workKey as string | undefined,
          attemptKey: f.attemptKey as string | undefined,
          offset: next,
        });
      }
    }
    const page: InspectionPage = {
      schema: 'sentinel-inspection-page/draft-1',
      viewId: view.manifest.viewId,
      sequence: view.manifest.sequence,
      collection,
      rows: selected,
      nextCursor,
    };
    checkInspectionPageBytes(page);
    return structuredClone(page);
  }
  async report(body: unknown, channel: string, signal?: AbortSignal): Promise<ReportDelivery> {
    const f = readFields(body, ['runId', 'format'], ['baselineRunId']);
    if (
      !id(f.runId) ||
      (f.baselineRunId !== undefined && !id(f.baselineRunId)) ||
      !REPORT_FORMATS.includes(f.format as any)
    )
      return invalid();
    if (this.#generating) throw new ReadonlyError('sentinel.service.deliveryBusy');
    this.#generating = true;
    const stop = this.#signal(signal),
      started = performance.now();
    try {
      const built = await fullReportFormat(
        {
          store: this.store,
          runId: f.runId,
          baselineRunId: f.baselineRunId as string | undefined,
          workspace: this.ws.path,
          trustDir: this.ws.trustDir,
          disclosure: 'shareable',
          now: this.now(),
        },
        f.format as ReportFormat,
        { signal: stop },
      );
      // Scope is CLOSED and successful here. Buffer allocation/copy happens before the last synchronous fence.
      const bytes = deliveryBuffer(built.text),
        created = this.now();
      const manifest: ReportDelivery = {
        schema: 'sentinel-report-delivery/draft-1',
        deliveryId: token('delivery'),
        storeId: this.store.storeId,
        epoch: this.store.epoch,
        reportId: built.document.id,
        current: { ...built.currentIdentity },
        ...(built.baselineIdentity ? { baseline: { ...built.baselineIdentity } } : {}),
        generationSequence: built.generationSequence,
        evaluatedAt: built.document.evaluatedAt,
        disclosure: structuredClone(built.document.disclosure),
        catalogVersion: built.document.catalogVersion,
        context: { binding: 'unavailable', reasonCode: 'sentinel.place.noContext' },
        documentDigest: built.documentDigest,
        format: built.format,
        formatDigest: built.formatDigest,
        formatBytes: bytes.length,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + READONLY_LIMITS.deliveryTtlMs).toISOString(),
      };
      this.#held(stop);
      if (performance.now() - started >= READONLY_LIMITS.reportMs)
        throw new ExecutionError('sentinel.execution.deadlineExceeded');
      for (const identity of [built.currentIdentity, ...(built.baselineIdentity ? [built.baselineIdentity] : [])]) {
        const run = this.store.ledger.getRun(identity.runId);
        if (
          !run ||
          run.state !== 'completed' ||
          run.planRevision !== identity.planRevision ||
          run.envelope.snapshotId !== identity.snapshotId
        )
          throw new ReadonlyError('sentinel.service.viewChanged');
      }
      if (this.store.ledger.currentSequence() !== built.generationSequence)
        throw new ReadonlyError('sentinel.service.viewChanged');
      // No await/caller callback after the final owner/signal/run/revision/snapshot/sequence fence.
      this.#purge();
      while (
        this.#deliveries.size >= READONLY_LIMITS.deliveries ||
        [...this.#deliveries.values()].reduce((n, d) => n + d.bytes.length, 0) + bytes.length >
          READONLY_LIMITS.deliveryCacheBytes
      )
        this.#deliveries.delete(this.#deliveries.keys().next().value!);
      this.#deliveries.set(manifest.deliveryId, {
        manifest,
        channel,
        until: performance.now() + READONLY_LIMITS.deliveryTtlMs,
        bytes,
      });
      return structuredClone(manifest);
    } finally {
      this.#generating = false;
    }
  }
  read(body: unknown, channel: string): DeliveryChunk {
    const f = readFields(body, ['deliveryId', 'offset'], ['maxBytes']);
    if (
      !id(f.deliveryId) ||
      !number(f.offset, 0, READONLY_LIMITS.deliveryBytes) ||
      (f.maxBytes !== undefined && !number(f.maxBytes, 1, READONLY_LIMITS.chunkMax))
    )
      return invalid();
    this.#held();
    this.#purge();
    const delivery = this.#deliveries.get(f.deliveryId);
    if (!delivery) throw new ReadonlyError('sentinel.service.deliveryExpired');
    if (delivery.channel !== channel) throw new ReadonlyError('sentinel.service.deliveryInvalid');
    const offset = f.offset as number;
    if (offset > delivery.bytes.length) return invalid();
    const end = Math.min(
      delivery.bytes.length,
      offset + (f.maxBytes === undefined ? READONLY_LIMITS.chunkDefault : (f.maxBytes as number)),
    );
    return {
      schema: 'sentinel-delivery-chunk/draft-1',
      deliveryId: delivery.manifest.deliveryId,
      offset,
      base64: delivery.bytes.subarray(offset, end).toString('base64'),
      nextOffset: end === delivery.bytes.length ? null : end,
      formatDigest: delivery.manifest.formatDigest,
      totalBytes: delivery.bytes.length,
    };
  }
}
