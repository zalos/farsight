// Closed private companion operations over the existing held service, never generic RPC or a competing store.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import {
  runWriteBinding,
  printed,
  envelopeBinding,
  pipelineWriteBinding,
  pipelineBytesOf,
  showWorkspacePipeline,
} from '../service/local.js';
import { bindProvider } from '../review/providers/profile.js';
import { loadPipeline } from '../app/pipeline-adoption.js';
import { currentPlan } from '../service/canonical.js';
import type { RequestedBy } from '../cli/actor.js';
import { result } from '../cli/outcome.js';
import { controlOutcome } from '../service/controls.js';
import { preparationOutcome } from '../service/preparation-projection.js';
import { loadPolicyInputsReadOnly } from '../policy/adoption.js';
import { effectivePolicy } from '../policy/settings.js';
import type { ReceiptBinding } from '../policy/receipts.js';
import { admitOwnerUi } from '../policy/admission.js';
import { canonicalDigest } from '../policy/digest.js';
import { OwnerUiScans } from './scans.js';
import { OwnerUiAuthority, activeOwnerUiProof, assertOwnerUiProof, type OwnerUiAction } from './authority.js';
import { OwnerUiReceiptBook, issueOwnerUiReceipt } from './receipts.js';
import { OwnerUiError } from './session.js';
export function ownerUiPolicy(ws: Workspace) {
  const inputs = loadPolicyInputsReadOnly({ workspace: ws.path, trustDir: ws.trustDir });
  if (inputs.trust !== 'adopted')
    return { refusal: result('owner-ui', 'configuration-failure', { reasonCode: 'sentinel.preparation.unavailable' }) };
  return { policy: effectivePolicy(inputs) };
}
type Handle = (
  op: string,
  body: unknown,
  by: RequestedBy,
  context: { readonly signal?: AbortSignal },
) => Promise<unknown>;
type Confirmation = (kind: 'accept' | 'resume' | 'cancel', body: unknown, by: RequestedBy) => ReceiptBinding;
const bodyFields = (value: unknown, required: readonly string[], optional: readonly string[] = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 8)
    throw new OwnerUiError();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => ![...required, ...optional].includes(k)) || required.some((k) => v[k] === undefined))
    throw new OwnerUiError();
  return v;
};
const requestKey = (v: unknown) => {
  if (typeof v !== 'string' || !/^([A-Za-z0-9_-]{16,128})$/.test(v)) throw new OwnerUiError();
  return v;
};
const runId = (v: unknown) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) throw new OwnerUiError();
  return v;
};
interface Preview {
  readonly id: string;
  readonly runId: string;
  readonly action: OwnerUiAction;
  readonly binding: ReceiptBinding;
  readonly revision: number;
  readonly expiresAt: number;
  /** A start that calls models: each envelope it opens, confirmed with it as one composite (`paid.admit`). */
  readonly envelopes?: readonly ReceiptBinding[];
  /** A pipeline write: exactly the object written, and the file digest the owner's view read (null: no file). */
  readonly pipeline?: { readonly value: unknown; readonly expectDigest: string | null };
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export class OwnerUiOperations {
  readonly #scans: OwnerUiScans;
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #authority: OwnerUiAuthority;
  readonly #handle: Handle;
  readonly #confirmation: Confirmation;
  readonly #previews = new Map<string, Preview>();
  constructor(store: SentinelStore, ws: Workspace, handle: Handle, confirmation: Confirmation) {
    this.#store = store;
    this.#scans = new OwnerUiScans(store, ws);
    this.#ws = ws;
    this.#authority = new OwnerUiAuthority(store, ws);
    this.#handle = handle;
    this.#confirmation = confirmation;
  }
  capabilities() {
    return {
      schema: 'sentinel-owneruicapabilities/draft-1',
      apiRevision: 1,
      storeId: this.#store.storeId,
      epoch: this.#store.epoch,
      operations: [
        'owner-ui.pair',
        'owner-ui.revoke',
        'owner-ui.context',
        'owner-ui.preview',
        'owner-ui.accept',
        'owner-ui.status',
        'owner-ui.resume',
        'owner-ui.cancel',
        'owner-ui.control-preview',
        'owner-ui.control',
      ],
      receiptSchema: 'sentinel-owneruireceipt/draft-1',
      settingsSave: false,
      modelAdmission: false,
    };
  }
  /** The admission the panel's own receipt is issued under: a deterministic operation, or a model envelope it opens. */
  #preflight(binding: ReceiptBinding, kind: 'operation' | 'model' = 'operation') {
    const adopted = ownerUiPolicy(this.#ws);
    if ('refusal' in adopted) return { refusal: adopted.refusal };
    if (adopted.policy.revision !== binding.policyRevision) throw new OwnerUiError('sentinel.ownerUi.changed');
    const proof = activeOwnerUiProof()!;
    assertOwnerUiProof(proof, binding.intent.action);
    const decision = admitOwnerUi(
      {
        intent: binding.intent,
        stateDigest: binding.stateDigest,
        policy: adopted.policy,
        requestedBy: proof.requestedBy,
        now: new Date(),
        capability: () =>
          kind === 'model'
            ? { available: true, detail: 'exact configured model capability' }
            : { available: true, detail: 'exact implemented deterministic owner service operation' },
        // A model envelope's credential is read by the broker when the envelope opens, never at preview: the panel
        // asks the policy and the capability here, and the broker's own admission decides the credential then.
        credential: () =>
          kind === 'model'
            ? {
                basis: 'keychain-scope' as const,
                allowed: true,
                detail: 'not read at preview; read when the envelope opens',
              }
            : { basis: 'local-only' as const, detail: 'no provider/model admission is included' },
      },
      proof,
      true,
    );
    if (decision.record.outcome === 'denied')
      return {
        refusal: result('owner-ui', 'configuration-failure', {
          verdicts: printed(decision.record),
          reasonCode: !decision.record.verdicts.policy.allowed
            ? decision.record.verdicts.policy.reasonCode
            : !decision.record.verdicts.capability.allowed
              ? decision.record.verdicts.capability.reasonCode
              : decision.record.verdicts.credential.reasonCode,
        }),
      };
    return { decision };
  }
  async handle(
    op: string,
    body: unknown,
    by: RequestedBy,
    context: { readonly signal?: AbortSignal },
  ): Promise<unknown> {
    if (by.channel !== 'owner-ui' || by.principal !== 'agent') throw new OwnerUiError();
    if (op === 'owner-ui.pair') return this.#authority.pair(body);
    if (op === 'owner-ui.revoke') {
      const f = bodyFields(body, ['proof']);
      this.#authority.revoke(f.proof);
      this.#previews.delete(f.proof as string);
      return { revoked: true };
    }
    if (op === 'owner-ui.context') {
      const f = bodyFields(body, ['proof', 'view']);
      return this.#authority.context(f.proof, f.view);
    }
    const base =
      op === 'owner-ui.preview'
        ? ['requestKey']
        : op === 'owner-ui.accept'
          ? ['requestKey', 'previewId']
          : ['owner-ui.status', 'owner-ui.resume', 'owner-ui.cancel'].includes(op)
            ? ['requestKey']
            : op === 'owner-ui.control-preview'
              ? ['runId', 'action']
              : op === 'owner-ui.control'
                ? ['previewId']
                : op === 'owner-ui.review-capabilities'
                  ? []
                  : op === 'owner-ui.scans'
                    ? []
                    : op === 'owner-ui.scan'
                      ? ['runId']
                      : op === 'owner-ui.stage'
                        ? ['runId', 'stage']
                        : op === 'owner-ui.unit'
                          ? ['runId', 'stage', 'unit']
                          : op === 'owner-ui.scan-report'
                            ? ['runId', 'format']
                            : op === 'owner-ui.pipeline'
                              ? []
                              : op === 'owner-ui.pipeline-preview'
                                ? ['pipeline', 'expectDigest']
                                : op === 'owner-ui.pipeline-write'
                                  ? ['previewId']
                                  : null;
    if (!base) throw new OwnerUiError();
    const f = bodyFields(
      body,
      ['proof', 'revision', ...base],
      op === 'owner-ui.preview' ? ['parentId'] : op === 'owner-ui.scans' ? ['before'] : [],
    );
    if (typeof f.proof !== 'string' || !/^([a-f0-9]{64})$/.test(f.proof) || !Number.isSafeInteger(f.revision))
      throw new OwnerUiError();
    // The viewer's read model (transport/http/): read-only, under the same paired proof and view revision as every
    // other read here, and never an action; a report is rendered through the existing retained report delivery.
    if (op === 'owner-ui.scans' || op === 'owner-ui.scan' || op === 'owner-ui.stage' || op === 'owner-ui.unit')
      return this.#authority.with<unknown>(f.proof, f.revision, null, () => {
        const proof = activeOwnerUiProof()!;
        return op === 'owner-ui.scans'
          ? this.#scans.scans(proof, f.before ?? null, context.signal)
          : op === 'owner-ui.scan'
            ? this.#scans.scan(proof, runId(f.runId), context.signal)
            : op === 'owner-ui.stage'
              ? this.#scans.stage(proof, runId(f.runId), f.stage, context.signal)
              : this.#scans.unit(proof, runId(f.runId), f.stage, f.unit, context.signal);
      });
    if (op === 'owner-ui.scan-report')
      return this.#authority.with<unknown>(f.proof, f.revision, null, async () => {
        const named = this.#scans.reportRun(activeOwnerUiProof()!, runId(f.runId), f.format);
        const delivery = (await this.#handle(
          'report.open',
          { runId: named.runId, format: named.format },
          by,
          context,
        )) as {
          deliveryId: string;
          format: string;
          formatDigest: string;
          formatBytes: number;
        };
        // The delivery's manifest names the run; the companion needs only the handle to read its bytes.
        return {
          deliveryId: delivery.deliveryId,
          format: delivery.format,
          formatDigest: delivery.formatDigest,
          formatBytes: delivery.formatBytes,
          number: named.number,
        };
      });
    if (op === 'owner-ui.review-capabilities')
      return this.#authority.with(f.proof, f.revision, null, () => ({
        schema: 'sentinel-review-capabilities/draft-1',
        availability: 'unavailable',
        reasonCode: 'sentinel.ownerUi.modelPending',
        deterministic: { model: 'not-applicable' },
        settingsSave: false,
        modelAdmission: false,
      }));
    if (op === 'owner-ui.preview' || op === 'owner-ui.status')
      return this.#authority.with(f.proof, f.revision, null, () =>
        this.#handle(
          op === 'owner-ui.preview' ? 'configuration.preview' : 'prepare.status',
          {
            requestKey: requestKey(f.requestKey),
            ...(f.parentId === undefined ? {} : { parentId: runId(f.parentId) }),
          },
          by,
          context,
        ),
      );
    if (['owner-ui.accept', 'owner-ui.resume', 'owner-ui.cancel'].includes(op)) {
      const kind = op.slice(9) as 'accept' | 'resume' | 'cancel',
        action = kind === 'cancel' ? 'run.cancel' : 'capture.source';
      let dispatched = false;
      try {
        return await this.#authority.with(f.proof, f.revision, action, async () => {
          const args = {
            requestKey: requestKey(f.requestKey),
            ...(kind === 'accept' ? { previewId: f.previewId } : {}),
          };
          if (
            kind === 'accept' &&
            (typeof f.previewId !== 'string' || !/^prepare-preview-[a-f0-9]{32}$/.test(f.previewId))
          )
            throw new OwnerUiError();
          const binding = this.#confirmation(kind, args, by),
            preflight = this.#preflight(binding);
          if (preflight.refusal) return preparationOutcome(preflight.refusal);
          const proof = activeOwnerUiProof()!,
            receiptId = issueOwnerUiReceipt(
              new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), proof),
              binding,
              new Date(),
            ).id;
          // Errors after actual controller dispatch remain uncertain; never classify a potentially accepted task as refused.
          dispatched = true;
          return preparationOutcome(await this.#handle(`prepare.${kind}`, { ...args, receiptId }, by, context));
        });
      } catch (error) {
        if (dispatched) throw error;
        return preparationOutcome(
          result('owner-ui', 'configuration-failure', { reasonCode: 'sentinel.ownerUi.changed' }),
        );
      }
    }
    // The workspace's pipeline file, for the PIPELINE stop's editor: read only, as the owner's CLI `pipeline show`
    // reads it (its trust, digest and problems), with the declared object and the digest of the file's own bytes.
    if (op === 'owner-ui.pipeline')
      return this.#authority.with<unknown>(f.proof, f.revision, null, () => this.#pipelineRead());
    // A pipeline the owner edited in the browser, checked and previewed by the service's own `pipeline.write` with no
    // receipt: it validates, says what a run would rerun against the adopted pipeline, and writes nothing.
    if (op === 'owner-ui.pipeline-preview') {
      if (!f.pipeline || typeof f.pipeline !== 'object' || Array.isArray(f.pipeline)) throw new OwnerUiError();
      if (!(f.expectDigest === null || (typeof f.expectDigest === 'string' && DIGEST.test(f.expectDigest))))
        throw new OwnerUiError();
      return this.#authority.with(f.proof, f.revision, 'settings.adopt', async () => {
        const checked: any = await this.#handle(
          'pipeline.write',
          { pipeline: f.pipeline, expectDigest: f.expectDigest },
          by,
          context,
        );
        const facts = (checked?.facts ?? {}) as Record<string, unknown>;
        const refused = Array.isArray(facts.problems) && facts.problems.some((p: any) => p?.class === 'refused');
        const answer = {
          outcome: checked?.outcome ?? null,
          reasonCode: checked?.reasonCode ?? null,
          problems: facts.problems ?? [],
          preview: facts.preview ?? null,
          // a pipeline the service cannot parse says where, in safe words (stage ids, field paths; never a value)
          detail: typeof facts.detail === 'string' ? facts.detail.slice(0, 240) : null,
        };
        if (refused || !facts.preview) return { ...answer, unavailable: true };
        const preview: Preview = {
          id: 'owner-preview-' + randomBytes(16).toString('hex'),
          runId: '',
          action: 'settings.adopt',
          binding: this.#pipelineBinding(f.pipeline, f.expectDigest as string | null),
          revision: f.revision as number,
          expiresAt: Date.now() + 30000,
          pipeline: { value: f.pipeline, expectDigest: f.expectDigest as string | null },
        };
        this.#remember(f.proof as string, preview);
        return { ...answer, id: preview.id, expiresAt: new Date(preview.expiresAt).toISOString() };
      });
    }
    if (op === 'owner-ui.pipeline-write') {
      const preview = this.#previews.get(f.proof as string);
      this.#previews.delete(f.proof as string);
      if (
        !preview?.pipeline ||
        preview.id !== f.previewId ||
        preview.revision !== f.revision ||
        Date.now() >= preview.expiresAt
      )
        throw new OwnerUiError('sentinel.ownerUi.changed');
      const { value, expectDigest } = preview.pipeline;
      return this.#authority.with(f.proof, f.revision, 'settings.adopt', async () => {
        const binding = this.#pipelineBinding(value, expectDigest);
        if (canonicalDigest(binding) !== canonicalDigest(preview.binding))
          throw new OwnerUiError('sentinel.ownerUi.changed');
        // The receipt names exactly these bytes replacing exactly the file the owner's view read; the service spends
        // it once and writes the file, and adopts nothing (adoption stays the CLI owner's act).
        const receipt = issueOwnerUiReceipt(
          new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), activeOwnerUiProof()!),
          binding,
          new Date(),
        );
        return this.#handle('pipeline.write', { pipeline: value, expectDigest, receiptId: receipt.id }, by, context);
      });
    }
    if (op === 'owner-ui.control-preview') {
      const id = runId(f.runId);
      if (typeof f.action !== 'string' || !['start', 'pause', 'cancel'].includes(f.action)) throw new OwnerUiError();
      const action = `run.${f.action}` as OwnerUiAction;
      return this.#authority.with(f.proof, f.revision, action, async () => {
        const plan = await currentPlan(this.#store, id);
        if (!plan || plan.kind !== 'analysis') throw new OwnerUiError('sentinel.service.planUnknown');
        const adopted = ownerUiPolicy(this.#ws);
        if ('refusal' in adopted) return { unavailable: true, outcome: controlOutcome(adopted.refusal) };
        // A start that calls models is the composite the owner confirms once here (ADR 48 as amended by U-3): the
        // service's own start preview names its stages and each model with its budget, and one envelope receipt per
        // model is confirmed with the start.
        const paid = action === 'run.start' && plan.effects.includes('paid-inference');
        const envelopes = paid ? this.#envelopes(plan, adopted.policy) : [];
        if ('refusal' in envelopes) return { unavailable: true, outcome: controlOutcome(envelopes.refusal) };
        const composite: any = paid ? await this.#handle('start.preview', { runId: id }, by, context) : null;
        const binding = {
            ...runWriteBinding(this.#ws, action as 'run.start' | 'run.pause' | 'run.cancel', plan, {
              storeId: this.#store.storeId,
              runId: id,
            }),
            policyRevision: plan.policyRevision,
          },
          preflight = this.#preflight(binding);
        if (preflight.refusal) return { unavailable: true, outcome: controlOutcome(preflight.refusal) };
        const preview: Preview = {
          id: 'owner-preview-' + randomBytes(16).toString('hex'),
          runId: id,
          action,
          binding,
          revision: f.revision as number,
          expiresAt: Date.now() + 30000,
          ...(paid ? { envelopes } : {}),
        };
        for (const e of envelopes as readonly ReceiptBinding[]) {
          const checked = this.#preflight(e, 'model');
          if (checked.refusal) return { unavailable: true, outcome: controlOutcome(checked.refusal) };
        }
        this.#remember(f.proof as string, preview);
        const facts = (composite?.facts ?? {}) as Record<string, unknown>;
        return {
          id: preview.id,
          runId: id,
          action,
          effects: binding.intent.effects,
          expiresAt: new Date(preview.expiresAt).toISOString(),
          modelAdmission: paid,
          ...(paid
            ? {
                composite: {
                  stages: Array.isArray(facts.stages) ? facts.stages : [],
                  models: Array.isArray(facts.models) ? facts.models : [],
                  envelopes: (envelopes as readonly ReceiptBinding[]).length,
                },
              }
            : {}),
        };
      });
    }
    const preview = this.#previews.get(f.proof);
    this.#previews.delete(f.proof);
    if (!preview || preview.id !== f.previewId || preview.revision !== f.revision || Date.now() >= preview.expiresAt)
      throw new OwnerUiError('sentinel.ownerUi.changed');
    return this.#authority.with(f.proof, f.revision, preview.action, async () => {
      const plan = await currentPlan(this.#store, preview.runId);
      if (!plan) throw new OwnerUiError('sentinel.service.planUnknown');
      const paid = preview.action === 'run.start' && plan.effects.includes('paid-inference');
      // The composite confirmed in the preview, and nothing else: a start whose models or envelopes changed since is
      // a changed view, never a narrower or wider start.
      if (paid !== !!preview.envelopes) throw new OwnerUiError('sentinel.ownerUi.changed');
      const binding = {
        ...runWriteBinding(this.#ws, preview.action as 'run.start' | 'run.pause' | 'run.cancel', plan, {
          storeId: this.#store.storeId,
          runId: preview.runId,
        }),
        policyRevision: plan.policyRevision,
      };
      if (canonicalDigest(binding) !== canonicalDigest(preview.binding))
        throw new OwnerUiError('sentinel.ownerUi.changed');
      const preflight = this.#preflight(binding);
      if (preflight.refusal) return controlOutcome(preflight.refusal);
      let envelopes: readonly ReceiptBinding[] = [];
      if (paid) {
        const policy = ownerUiPolicy(this.#ws);
        if ('refusal' in policy) return controlOutcome(policy.refusal);
        const now = this.#envelopes(plan, policy.policy);
        if ('refusal' in now) return controlOutcome(now.refusal);
        if (canonicalDigest(now) !== canonicalDigest(preview.envelopes))
          throw new OwnerUiError('sentinel.ownerUi.changed');
        for (const e of now) {
          const checked = this.#preflight(e, 'model');
          if (checked.refusal) return controlOutcome(checked.refusal);
        }
        envelopes = now;
      }
      const book = new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), activeOwnerUiProof()!);
      const receipt = issueOwnerUiReceipt(book, binding, new Date());
      // One receipt per model envelope, each bound to exactly the store, run, plan digest and binding the review opens.
      const envelopeReceipts = envelopes.map((e) => issueOwnerUiReceipt(book, e, new Date()).id);
      return controlOutcome(
        await this.#handle(
          preview.action,
          {
            ...(preview.action === 'run.start' ? { planId: preview.runId } : { runId: preview.runId }),
            receiptId: receipt.id,
            ...(envelopeReceipts.length ? { envelopeReceipts } : {}),
          },
          by,
          context,
        ),
      );
    });
  }
  /** At most four pending confirmations, one per paired session. */
  #remember(proof: string, preview: Preview) {
    if (this.#previews.size >= 4 && !this.#previews.has(proof))
      this.#previews.delete(this.#previews.keys().next().value!);
    this.#previews.set(proof, preview);
  }

  /** The write of a pipeline file: exactly these bytes replacing exactly the file the owner's view read, under the policy. */
  #pipelineBinding(pipeline: unknown, expectDigest: string | null): ReceiptBinding {
    const adopted = ownerUiPolicy(this.#ws);
    if ('refusal' in adopted) throw new OwnerUiError('sentinel.preparation.unavailable');
    return {
      ...pipelineWriteBinding(this.#ws, pipelineBytesOf(pipeline), expectDigest),
      policyRevision: adopted.policy.revision,
    };
  }

  /**
   * The model envelopes a start opens, as the owner's CLI binds them (`confirmForService`): the plan's one binding
   * resolved again under the current policy and required to be the admitted one, each bound to this store and run.
   */
  #envelopes(
    plan: NonNullable<Awaited<ReturnType<typeof currentPlan>>>,
    policy: ReturnType<typeof effectivePolicy>,
  ): readonly ReceiptBinding[] | { refusal: ReturnType<typeof result> } {
    const refusal = {
      refusal: result('run', 'configuration-failure', { reasonCode: 'sentinel.provider.bindingChanged' }),
    };
    if (plan.modelConflict || !plan.model?.modelId) return refusal;
    let binding: ReturnType<typeof bindProvider>;
    try {
      binding = bindProvider(policy, plan.model.providerId, plan.model.modelId);
    } catch {
      return refusal;
    }
    if (binding.digest !== plan.model.bindingDigest) return refusal;
    return [envelopeBinding(binding, plan, this.#store.storeId, policy.revision, plan.model.budget)];
  }

  /** The workspace's pipeline file and what the owner's CLI `pipeline show` says of it. Reads only. */
  #pipelineRead() {
    const shown = showWorkspacePipeline(this.#ws);
    const loaded = loadPipeline({ workspace: this.#ws.path, trustDir: this.#ws.trustDir, readOnly: true });
    const facts = (shown.facts ?? {}) as Record<string, unknown>;
    return {
      schema: 'sentinel-viewer-pipeline/draft-1',
      trust: facts.trust ?? loaded.trust,
      reasonCode: shown.reasonCode ?? null,
      pipeline: loaded.read?.pipeline ?? null,
      fileDigest: loaded.read?.fileDigest ?? null,
      digest: facts.digest ?? null,
      problems: Array.isArray(facts.problems) ? facts.problems : [],
      readOnly: true,
    };
  }

  get retaining() {
    return this.#authority.retaining;
  }
  close() {
    this.#scans.close();
    this.#authority.close();
    this.#previews.clear();
  }
}
