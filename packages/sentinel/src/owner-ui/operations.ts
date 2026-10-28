// Closed private companion operations over the existing held service, never generic RPC or a competing store.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import { runWriteBinding, printed } from '../service/local.js';
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
import { OwnerUiProcess } from './process.js';
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
}
export class OwnerUiOperations {
  readonly #process: OwnerUiProcess;
  readonly #scans: OwnerUiScans;
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #authority: OwnerUiAuthority;
  readonly #handle: Handle;
  readonly #confirmation: Confirmation;
  readonly #previews = new Map<string, Preview>();
  constructor(store: SentinelStore, ws: Workspace, handle: Handle, confirmation: Confirmation) {
    this.#store = store;
    this.#process = new OwnerUiProcess(store);
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
      processInspection: true,
    };
  }
  #preflight(binding: ReceiptBinding) {
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
        capability: () => ({ available: true, detail: 'exact implemented deterministic owner service operation' }),
        credential: () => ({ basis: 'local-only', detail: 'no provider/model admission is included' }),
      },
      proof,
      true,
    );
    if (decision.record.outcome === 'denied')
      return {
        refusal: result('owner-ui', 'configuration-failure', {
          verdicts: printed(decision.record),
          reasonCode: decision.record.verdicts.policy.allowed
            ? decision.record.verdicts.capability.reasonCode
            : decision.record.verdicts.policy.reasonCode,
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
                : op === 'owner-ui.runs'
                  ? []
                  : op === 'owner-ui.select'
                    ? ['key']
                    : op === 'owner-ui.process'
                      ? ['runId']
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
                                  : null;
    if (!base) throw new OwnerUiError();
    const f = bodyFields(
      body,
      ['proof', 'revision', ...base],
      op === 'owner-ui.preview' ? ['parentId'] : op === 'owner-ui.scans' ? ['before'] : [],
    );
    if (typeof f.proof !== 'string' || !/^([a-f0-9]{64})$/.test(f.proof) || !Number.isSafeInteger(f.revision))
      throw new OwnerUiError();
    if (op === 'owner-ui.runs' || op === 'owner-ui.select' || op === 'owner-ui.process')
      return this.#authority.with<unknown>(f.proof, f.revision, null, () => {
        const proof = activeOwnerUiProof()!;
        return op === 'owner-ui.runs'
          ? this.#process.runs(proof)
          : op === 'owner-ui.select'
            ? this.#process.resolve(proof, f.key)
            : this.#process.details(proof, runId(f.runId), context.signal);
      });
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
    if (op === 'owner-ui.control-preview') {
      const id = runId(f.runId);
      if (typeof f.action !== 'string' || !['start', 'pause', 'cancel'].includes(f.action)) throw new OwnerUiError();
      const action = `run.${f.action}` as OwnerUiAction;
      return this.#authority.with(f.proof, f.revision, action, async () => {
        const plan = await currentPlan(this.#store, id);
        if (!plan || plan.kind !== 'analysis') throw new OwnerUiError('sentinel.service.planUnknown');
        if (action === 'run.start' && plan.effects.includes('paid-inference'))
          return {
            unavailable: true,
            outcome: controlOutcome(
              result('run', 'configuration-failure', { reasonCode: 'sentinel.review.foregroundRequired' }),
            ),
          };
        const adopted = ownerUiPolicy(this.#ws);
        if ('refusal' in adopted) return { unavailable: true, outcome: controlOutcome(adopted.refusal) };
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
        };
        if (this.#previews.size >= 4 && !this.#previews.has(f.proof as string))
          this.#previews.delete(this.#previews.keys().next().value!);
        this.#previews.set(f.proof as string, preview);
        return {
          id: preview.id,
          runId: id,
          action,
          effects: binding.intent.effects,
          expiresAt: new Date(preview.expiresAt).toISOString(),
          modelAdmission: false,
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
      if (preview.action === 'run.start' && plan.effects.includes('paid-inference'))
        return controlOutcome(
          result('run', 'configuration-failure', { reasonCode: 'sentinel.review.foregroundRequired' }),
        );
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
      const receipt = issueOwnerUiReceipt(
        new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), activeOwnerUiProof()!),
        binding,
        new Date(),
      );
      return controlOutcome(
        await this.#handle(
          preview.action,
          {
            ...(preview.action === 'run.start' ? { planId: preview.runId } : { runId: preview.runId }),
            receiptId: receipt.id,
          },
          by,
          context,
        ),
      );
    });
  }
  get retaining() {
    return this.#authority.retaining;
  }
  close() {
    this.#process.close();
    this.#scans.close();
    this.#authority.close();
    this.#previews.clear();
  }
}
