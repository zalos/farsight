import { assertNativeClaudeReviewEnabled } from '../review/providers/selection.js';
import { reviewRuntime } from './review-adapter.js';
import { preparePathTask, acceptPathTask, type PathTaskCandidate } from './path-task.js';
import { readPathRequestFile } from './path-request-file.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { pathUnitsFor } from '../analysis/paths/admission.js';
import { pathRequestOf, PathRequestError } from '../analysis/paths/request.js';
import { ExecutionError } from '../execution/errors.js';
import { publicRegistry } from './scanner-profile.js';
// The owner's local operations: adopt settings, plan, run in the foreground, bounded status and the preview report.
// Each runs in the owner's own process (the owner CLI entrypoint) against the workspace's store; the requester is
// the entrypoint's, never a request's. Every action that changes something is decided by PR 06's admission (three
// verdicts) first, and a receipt is issued and spent only here, after the owner's own confirm. The background
// service (owner-service.ts) reuses the store-level reads below; it holds the store while it runs.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionEffect, ActionIntent, AdmissionEnvelope } from '../contracts/index.js';
import {
  adoptSettings,
  adoptionIntent,
  admit,
  workspaceIdentity,
  effectivePolicy,
  loadPolicyInputs,
  ReceiptBook,
  trustDirectory,
  PolicyError,
  type EffectivePolicy,
} from '../policy/index.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { assertTrustOutside } from '../policy/adoption.js';
import {
  checkPreviewReport,
  PREVIEW_LIMITATIONS,
  PREVIEW_REPORT_SCHEMA,
  type PreviewReport,
} from '../reports/preview.js';
import { scannerReportOf, type ScannerReport } from '../reports/scanner.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { openStore, type SentinelStore } from '../store/index.js';
import { requestedByOf, assertMayConfirm } from '../cli/actor.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';

import {
  candidateDigest,
  emptyLock,
  lockDigest,
  promote,
  promotionIntent,
  readPackDirectory,
  validatePack,
} from '../rules/index.js';
import { RuleLockBook } from './rule-locks.js';
import { loadPlan } from '../execution/plans.js';
import { expandStageTokens, unitsToRun } from '../execution/selection.js';
import type { StageSelection } from '../planner/pipeline.js';
import { ServiceError } from './owner-service.js';
import { runFailureFacts } from './run-failure.js';
import type { AdapterRegistry } from '../execution/registry.js';
import {
  assessRun,
  contextIntentFor,
  fullReport,
  FullReportError,
  readContextGraph,
  renderingOf,
  writeNewFile,
  type ReportFormat,
} from './full-report.js';
import type { DisclosureProfile } from '../reports/index.js';
import { openScratchLease, releaseScratchLease, type ScratchLease, type ScratchRelease } from './scratch-lease.js';
import {
  canonicalResult,
  currentPlan,
  executeRun,
  notExecutableHere,
  rerunRun,
  planWorkspaceCanonical,
  previewFindingsOf,
  type CanonicalDisclosure,
  type CurrentPlan,
} from './canonical.js';

export interface Workspace {
  readonly path: string;
  readonly storePath: string;
  readonly trustDir: string;
}

/** The workspace's private Sentinel folders: the store and plan records beside the settings, trust outside it. */
export function workspaceOf(path: string, env: NodeJS.ProcessEnv = process.env): Workspace {
  return Object.freeze({
    path,
    storePath: join(path, '.farsight', 'sentinel', 'store'),
    trustDir: trustDirectory(env),
  });
}

export const OWNER = requestedByOf({ kind: 'owner-cli' });
const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const RECEIPT_TTL_MS = 10 * 60 * 1000;

export const printed = (r: AdmissionEnvelope): PrintedVerdicts =>
  Object.freeze({
    policy: Object.freeze({
      allowed: r.verdicts.policy.allowed,
      asked: r.verdicts.policy.asked,
      reasonCode: r.verdicts.policy.reasonCode,
    }),
    capability: Object.freeze({
      allowed: r.verdicts.capability.allowed,
      asked: r.verdicts.capability.asked,
      reasonCode: r.verdicts.capability.reasonCode,
    }),
    credential: Object.freeze({
      allowed: r.verdicts.credential.allowed,
      asked: r.verdicts.credential.asked,
      reasonCode: r.verdicts.credential.reasonCode,
    }),
  });

/**
 * Refuses, creating nothing, a layout whose owner trust state would sit in the workspace it captures: the trust
 * folder is, contains or lies inside the checkout. Called before anything writes trust state or starts a service.
 */
export function checkWorkspaceLayout(ws: Workspace): void {
  assertTrustOutside(ws.trustDir, ws.path);
}

function trustFolder(ws: Workspace): string {
  checkWorkspaceLayout(ws);
  mkdirSync(ws.trustDir, { recursive: true, mode: 0o700 });
  return ws.trustDir;
}

export function receiptBook(ws: Workspace): ReceiptBook {
  const dir = join(trustFolder(ws), 'receipts');
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return new ReceiptBook(dir);
}

/** The adopted policy, or a refusal naming why there is none. */
export function adoptedPolicy(ws: Workspace): { policy: EffectivePolicy } | { refusal: CommandResult } {
  const inputs = loadPolicyInputs({ workspace: ws.path, trustDir: trustFolder(ws) });
  if (inputs.trust !== 'adopted') {
    return {
      refusal: result('policy', 'configuration-failure', {
        reasonCode: 'sentinel.service.settingsNotAdopted',
        facts: { trust: inputs.trust },
      }),
    };
  }
  return { policy: effectivePolicy(inputs) };
}

/**
 * Decides one action by admission, as the owner. Without `confirm` an action that needs confirmation stops at
 * awaiting-confirmation (exit 4); with it, the owner's receipt is issued here and spent by the same admission.
 */
function decide(
  ws: Workspace,
  policy: EffectivePolicy,
  intent: ActionIntent,
  stateDigest: string,
  confirm: boolean,
  now: Date,
): { admitted: true; record: AdmissionEnvelope } | { admitted: false; result: CommandResult } {
  const request = {
    intent,
    requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' },
    policy,
    stateDigest,
    now,
    capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  };
  let decision = admit(request);
  if (decision.record.outcome === 'awaiting-confirmation' && confirm) {
    assertMayConfirm(OWNER);
    const book = receiptBook(ws);
    const receipt = issueReceipt(
      book,
      OWNER,
      { intent, stateDigest, policyRevision: policy.revision },
      { now, ttlMs: RECEIPT_TTL_MS },
    );
    decision = admit({ ...request, receipt: { book, id: receipt.id } });
  }
  const r = decision.record;
  if (r.outcome === 'admitted') return { admitted: true, record: r };
  const facts = { action: intent.action, effects: intent.effects, intentDigest: r.intentDigest };
  return {
    admitted: false,
    result:
      r.outcome === 'awaiting-confirmation'
        ? result(intent.action, 'awaiting-confirmation', { verdicts: printed(r), facts })
        : result(intent.action, 'configuration-failure', {
            verdicts: printed(r),
            facts,
            reasonCode: r.verdicts.policy.allowed
              ? r.verdicts.capability.allowed
                ? r.verdicts.credential.reasonCode
                : r.verdicts.capability.reasonCode
              : r.verdicts.policy.reasonCode,
          }),
  };
}

/** The settings profile a write is scoped to: the one init grants the owner (cli/init.ts PROFILES). */
export const SCAN_PROFILE = 'static';

export const intentOf = (
  action: ActionIntent['action'],
  input: string,
  effects: ActionEffect[],
  targets: string[] = [],
): ActionIntent => ({
  action,
  input,
  effects,
  budget: { maxTokens: null, maxCost: null, currency: null },
  scope: { profile: SCAN_PROFILE, provider: null, targets },
});

/** The exact instance a write on a run acts on: this workspace (path, device and inode), this store, this run. */
export interface RunInstance {
  readonly storeId: string;
  readonly runId: string;
}

/**
 * A write on a run, bound to the instance it acts on. Two workspaces with the same content, settings and plan digest
 * still differ in workspace identity and store: a receipt confirmed for one is a mismatch in the other.
 */
export function runWriteBinding(
  ws: Workspace,
  action: 'run.start' | 'run.pause' | 'run.cancel',
  plan: CurrentPlan,
  instance: RunInstance,
): { intent: ActionIntent; stateDigest: string } {
  const workspace = workspaceIdentity(ws.path).digest;
  const intent = intentOf(action, plan.planDigest, action === 'run.start' ? [...plan.effects] : ['local-artifacts'], [
    `sentinel.workspace:${workspace}`,
    `sentinel.store:${instance.storeId}`,
    `sentinel.run:${instance.runId}`,
  ]);
  if (action === 'run.start' && plan.model) {
    intent.scope.provider = plan.model.providerId;
    intent.budget = { ...plan.model.budget };
  }
  return {
    intent,
    stateDigest: sha(
      canonicalJsonBytes({
        kind: 'sentinel-run-write/1',
        plan: plan.planDigest,
        workspace,
        store: instance.storeId,
        run: instance.runId,
      }),
    ),
  };
}

// ---- settings adoption (an owner action) ----

export function adoptWorkspaceSettings(ws: Workspace, options: { confirm: boolean; now: Date }): CommandResult {
  const { intent, settingsDigest } = adoptionIntent(ws.path);
  if (!options.confirm) {
    return result('settings.adopt', 'awaiting-confirmation', {
      facts: { settingsDigest, intentDigest: sha(canonicalJsonBytes(intent)) },
    });
  }
  assertMayConfirm(OWNER);
  const book = receiptBook(ws);
  const inputs = loadPolicyInputs({ workspace: ws.path, trustDir: trustFolder(ws) });
  const policyRevision = effectivePolicy(inputs).revision;
  const receipt = issueReceipt(
    book,
    OWNER,
    { intent, stateDigest: settingsDigest, policyRevision },
    { now: options.now, ttlMs: RECEIPT_TTL_MS },
  );
  const spent = book.consume(receipt.id, { intent, stateDigest: settingsDigest, policyRevision }, options.now);
  const adoption = adoptSettings({ workspace: ws.path, trustDir: ws.trustDir, receipt: spent, now: options.now });
  return result('settings.adopt', 'prepared', {
    facts: { settingsDigest: adoption.settingsDigest, adoptedAt: adoption.adoptedAt },
  });
}

// ---- plan ----

/**
 * Runs `body` with a fresh scratch lease inside the exact store this process holds (scratch-lease.ts), then releases
 * it. A lease whose consumers are not all proven stopped is retained, and a result says so; the body's own error is
 * never replaced by its release.
 */
export async function withScratch<T extends CommandResult>(
  store: SentinelStore,
  body: (lease: ScratchLease) => Promise<T>,
): Promise<T> {
  const lease = openScratchLease(store);
  let out: T;
  try {
    out = await body(lease);
  } catch (error) {
    try {
      releaseScratchLease(store, lease);
    } catch {
      /* the original failure is the one reported */
    }
    throw error;
  }
  const released = releaseScratchLease(store, lease);
  return released.removed ? out : { ...out, facts: { ...out.facts, scratchRetained: retainedFact(released) } };
}

/** The fact a retained lease leaves in a result: which lease, why, and whether some of it was already removed. */
export const retainedFact = (r: Extract<ScratchRelease, { removed: false }>) =>
  Object.freeze({ lease: r.lease, reasonCode: `sentinel.service.scratch.${r.reason}`, partial: r.partial });

async function withStore<T>(ws: Workspace, body: (store: SentinelStore) => Promise<T>): Promise<T> {
  const store = await openStore(ws.storePath);
  try {
    return await body(store);
  } finally {
    store.close();
  }
}

/**
 * Plans the workspace canonically (canonical.ts): admitted as `capture.source`, then capture, the admitted bootstrap
 * published by the coordinator's own operations, and the analysis planned from that evidence under the owner's
 * promoted rule lock and the adopted policy, admitted and made the run's current revision. Nothing is checked yet.
 * The same content under the same lock, policy and profile is the same run (`kept`).
 */
export async function planWorkspace(
  ws: Workspace,
  options: { confirm: boolean; now: Date; parentId?: string | null },
): Promise<CommandResult & { disclosure?: CanonicalDisclosure }> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  const decided = decide(
    ws,
    policy,
    intentOf('capture.source', sha(Buffer.from(ws.path)), ['local-artifacts']),
    policy.revision,
    options.confirm,
    options.now,
  );
  if (!decided.admitted) return decided.result;
  return withStore(ws, (store) =>
    withScratch(store, async (lease) => {
      let planned;
      try {
        planned = await planWorkspaceCanonical(store, {
          workspace: ws.path,
          trustDir: trustFolder(ws),
          policy,
          scratchRoot: lease.path,
          wrapRunner: lease.wrapRunner,
          now: options.now,
          ...(options.parentId ? { parentId: options.parentId } : {}),
        });
      } catch (e) {
        if (
          e instanceof ServiceError &&
          (e.code === 'sentinel.service.bootstrapFailed' || e.code === 'sentinel.service.ruleUnsupported')
        ) {
          return result('plan', 'configuration-failure', {
            verdicts: printed(decided.record),
            reasonCode: e.code,
            facts: { ...e.facts },
          });
        }
        throw e;
      }
      return {
        ...result('plan', planned.outcome, { verdicts: printed(decided.record), facts: { ...planned.disclosure } }),
        disclosure: planned.disclosure,
      };
    }),
  );
}

/**
 * Rerun or retry an ended run as a new linked run over its retained snapshot (canonical.ts rerunRun): `rerun` the
 * named units (all when none are named), `retry` the units that did not publish. Admitted as `capture.source` like
 * any planning; the dependency preview (selected, downstream, reused prerequisites) is in the result either way.
 */
export async function followWorkspaceRun(
  ws: Workspace,
  options: { mode: 'retry' | 'rerun'; runId: string; stages?: readonly string[]; confirm: boolean; now: Date },
): Promise<CommandResult> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  const intent = intentOf('capture.source', sha(Buffer.from(ws.path)), ['local-artifacts']);
  const preflight = admit({
    intent,
    requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' },
    policy,
    stateDigest: policy.revision,
    now: options.now,
    capability: () => ({ available: true, detail: 'policy preflight only' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider contacted' }),
  });
  if (!preflight.record.verdicts.policy.allowed)
    return result(options.mode, 'configuration-failure', {
      verdicts: printed(preflight.record),
      reasonCode: preflight.record.verdicts.policy.reasonCode,
    });
  return withStore(ws, async (store) => {
    const parent = store.ledger.getRun(options.runId);
    const recorded = parent ? await loadPlan(store, options.runId, parent.planRevision) : null;
    if (recorded?.pathRequest) return followPathTaskIn(store, ws, recorded, policy, options);
    let stages = [...(options.stages ?? [])];
    // `rerun --stage` names declared stages or units: a stage expands to its units in the parent's admitted revision,
    // with the stages downstream of it previewed; a unit id stays as it is.
    let stagePreview: StageSelection | null = null;
    if (options.mode === 'rerun' && stages.length && recorded) {
      const expanded = expandStageTokens(recorded, stages);
      if (expanded.unknown.length || !expanded.units.length)
        return result('rerun', 'configuration-failure', {
          reasonCode: 'sentinel.service.stageUnknown',
          facts: { runId: options.runId, unknown: expanded.unknown, empty: expanded.empty },
        });
      stages = expanded.units;
      stagePreview = expanded.stages;
    }
    const stageFacts = stagePreview ? { stages: stagePreview } : {};
    const decided = decide(ws, policy, intent, policy.revision, options.confirm, options.now);
    if (!decided.admitted) return { ...decided.result, facts: { ...decided.result.facts, ...stageFacts } };
    const verdicts = printed(decided.record);
    if (options.mode === 'retry') {
      // The units that did not publish: what a retry runs again. A selected rerun's held units were never chosen, so
      // a retry of it runs again only what it selected, never widening to them.
      const plan = await currentPlan(store, options.runId);
      if (plan?.kind === 'analysis') {
        const { plan: revision, selection } = await loadPlan(store, options.runId, plan.revision);
        const chosen = selection ? unitsToRun(selection) : null;
        stages = revision.units
          .filter(
            (u) => (!chosen || chosen.has(u.id)) && !store.ledger.getPublication({ id: u.id, revision: u.revision }),
          )
          .map((u) => u.id);
        if (!stages.length)
          return result('retry', 'refused', {
            verdicts,
            reasonCode: 'sentinel.service.nothingToRetry',
            facts: { runId: options.runId },
          });
      }
    }
    return withScratch(store, async (lease) => {
      const followed = await rerunRun(store, options.runId, stages, {
        workspace: ws.path,
        trustDir: trustFolder(ws),
        policy,
        scratchRoot: lease.path,
        wrapRunner: lease.wrapRunner,
        now: options.now,
      });
      if ('reasonCode' in followed)
        return result(options.mode, 'configuration-failure', {
          verdicts,
          reasonCode: followed.reasonCode,
          facts: { runId: options.runId, ...(followed.facts ?? {}) },
        });
      return result(options.mode, followed.outcome, {
        verdicts,
        facts: { ...followed.disclosure, parentId: options.runId, preview: followed.preview, ...stageFacts },
      });
    });
  });
}

/** The run's current admitted plan, read from the workspace's store (used when no service holds it). */
export async function describeRun(ws: Workspace, runId: string): Promise<CurrentPlan | undefined> {
  return withStore(ws, (store) => currentPlan(store, runId));
}

// ---- run (foreground) ----

/**
 * Runs the run's current admitted revision in this process: admitted as `run.start` against that revision's digest
 * (and only under the policy it was admitted with), then executed by the coordinator. A run that already completed
 * returns its result again without executing anything. The result is read back from the ledger (canonicalResult).
 */
export async function runPlan(
  ws: Workspace,
  options: { planId: string; confirm: boolean; confirmModels?: boolean; now: Date },
): Promise<CommandResult> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  return withStore(ws, async (store) => {
    const plan = await currentPlan(store, options.planId);
    if (!plan || plan.kind !== 'analysis')
      return result('run', 'configuration-failure', {
        reasonCode: 'sentinel.service.planUnknown',
        facts: { planId: options.planId },
      });
    if (policy.revision !== plan.policyRevision)
      return result('run', 'configuration-failure', {
        reasonCode: 'sentinel.service.policyChanged',
        facts: { planId: plan.runId },
      });
    if (plan.modelConflict)
      return result('run', 'configuration-failure', {
        reasonCode: 'sentinel.provider.bindingChanged',
        facts: { limitation: 'one-model-binding-per-run' },
      });
    const admittedReview = await loadPlan(store, plan.runId, plan.revision),
      reviews = admittedReview.plan.units
        .filter((u) => u.review)
        .map((u) => ({
          kind: u.stage,
          segmentId: u.review!.segmentId,
          selection: u.review!.selection,
          terms: u.review!.terms,
          instructions: u.review!.instructionDigest,
          skills: 'none-selected',
          vendorInstructions: 'unobserved',
        }));
    for (const review of reviews) assertNativeClaudeReviewEnabled(policy, review.selection.providerId);
    if (reviews.length && (!options.confirmModels || !options.confirm))
      return result('run', 'awaiting-confirmation', {
        reasonCode: 'sentinel.service.needsOwnerConfirm',
        facts: { runId: plan.runId, modelReviews: reviews, requiredFlag: '--confirm-models' },
      });
    const binding = runWriteBinding(ws, 'run.start', plan, { storeId: store.storeId, runId: plan.runId });
    const decided = decide(ws, policy, binding.intent, binding.stateDigest, options.confirm, options.now);
    if (!decided.admitted) return decided.result;
    const verdicts = printed(decided.record);
    if (!isFinalRunState(runStateIn(store, plan.runId))) {
      // A plan this installation cannot execute (another build's adapters, a rule no shipped adapter implements):
      // refused before anything starts; canonicalResult says why.
      if (await notExecutableHere(store, plan.runId, publicRegistry(ws.trustDir)))
        return canonicalResult(store, 'run', plan.runId, {
          executing: false,
          verdicts,
          registry: publicRegistry(ws.trustDir),
          trustDir: ws.trustDir,
        });
      return withScratch(store, async (lease) => {
        const admitted = await loadPlan(store, plan.runId, plan.revision),
          review = admitted.plan.units.some((u) => u.review)
            ? await reviewRuntime(store, ws, options.confirmModels === true)
            : undefined;
        try {
          await executeRun(store, plan.runId, {
            scratchRoot: lease.path,
            wrapRunner: lease.wrapRunner,
            trustDir: ws.trustDir,
            ...(review ? { review } : {}),
          });
        } finally {
          review?.close();
        }
        return canonicalResult(store, 'run', plan.runId, {
          executing: false,
          verdicts,
          registry: publicRegistry(ws.trustDir),
          trustDir: ws.trustDir,
        });
      });
    }
    return canonicalResult(store, 'run', plan.runId, {
      executing: false,
      verdicts,
      registry: publicRegistry(ws.trustDir),
      trustDir: ws.trustDir,
    });
  });
}

// ---- the owner's confirmation, carried to the background service ----

/**
 * Confirms one write on a plan's run for the background service, as the owner, in this process: the action is
 * admitted here (three verdicts, the owner as requester), then, only with `confirm`, a receipt bound to exactly that
 * action, this plan's digest and the adopted policy revision is issued and not spent. The service spends it once; a
 * connection without one is an agent and gets what the adopted grants give agents, nothing implicit.
 */
export function confirmForService(
  ws: Workspace,
  options: {
    command: string;
    action: 'run.start' | 'run.pause' | 'run.cancel';
    plan: CurrentPlan | undefined;
    planId: string;
    confirm: boolean;
    now: Date;
    /** The store the running service holds, from its verified welcome. Needed to confirm; not to show what would happen. */
    storeId?: string;
  },
): { receiptId: string; verdicts: PrintedVerdicts } | { result: CommandResult } {
  const record = options.plan;
  if (!record || record.kind !== 'analysis')
    return {
      result: result(options.command, 'configuration-failure', {
        reasonCode: 'sentinel.service.planUnknown',
        facts: { planId: options.planId },
      }),
    };
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return { result: adopted.refusal };
  const { policy } = adopted;
  if (policy.revision !== record.policyRevision) {
    return {
      result: result(options.command, 'configuration-failure', {
        reasonCode: 'sentinel.service.policyChanged',
        facts: { planId: record.runId },
      }),
    };
  }
  // Bound to this workspace, this run and, once a service answered, its store; without a store yet the decision is
  // shown against the unbound intent and nothing is issued.
  const { intent, stateDigest } =
    options.storeId === undefined
      ? {
          intent: intentOf(
            options.action,
            record.planDigest,
            options.action === 'run.start' ? [...record.effects] : ['local-artifacts'],
          ),
          stateDigest: record.planDigest,
        }
      : runWriteBinding(ws, options.action, record, { storeId: options.storeId, runId: record.runId });
  const decision = admit({
    intent,
    requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' },
    policy,
    stateDigest,
    now: options.now,
    capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  }).record;
  const verdicts = printed(decision);
  const facts = {
    planId: record.runId,
    action: intent.action,
    effects: intent.effects,
    intentDigest: decision.intentDigest,
  };
  if (decision.outcome === 'denied') {
    const v = decision.verdicts;
    return {
      result: result(options.command, 'configuration-failure', {
        verdicts,
        facts,
        reasonCode: v.policy.allowed
          ? v.capability.allowed
            ? v.credential.reasonCode
            : v.capability.reasonCode
          : v.policy.reasonCode,
      }),
    };
  }
  if (!options.confirm)
    return {
      result: result(options.command, 'awaiting-confirmation', {
        verdicts,
        facts,
        reasonCode: 'sentinel.service.needsOwnerConfirm',
      }),
    };
  assertMayConfirm(OWNER);
  if (options.storeId === undefined) {
    // Never a receipt that names no store: it could be spent by any service that holds a plan with this digest.
    return {
      result: result(options.command, 'configuration-failure', {
        verdicts,
        facts,
        reasonCode: 'sentinel.service.notRunning',
      }),
    };
  }
  const receipt = issueReceipt(
    receiptBook(ws),
    OWNER,
    { intent, stateDigest, policyRevision: policy.revision },
    { now: options.now, ttlMs: RECEIPT_TTL_MS },
  );
  return { receiptId: receipt.id, verdicts };
}

// ---- rule packs: the owner promotes one into a new lock revision ----

/**
 * Promotes a rule pack (a folder validated by E's validatePack) into a new revision of the owner's rule lock. An
 * owner action: admitted here as the owner, and only with `confirm` is a receipt issued for exactly this candidate
 * against exactly the current lock revision (its digest), and spent by the same admission. The new revision names
 * its predecessor, is filed under its own digest and becomes current only if no other promotion landed meanwhile.
 * Without `confirm` it shows the candidate and the lock it would replace, and waits (exit 4). A pack the current
 * revision already locks byte for byte is `kept`: promoting it again issues nothing and files nothing.
 */
export function promoteRulePack(
  ws: Workspace,
  options: { packDir: string; confirm: boolean; now: Date },
): CommandResult {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  const files = readPackDirectory(options.packDir);
  const pack = validatePack(files);
  const book = new RuleLockBook(trustFolder(ws));
  const selected = book.current();
  const previous = selected?.lock ?? emptyLock(options.now);
  const previousDigest = lockDigest(previous);
  const candidate = { kind: 'pack' as const, pack };
  const intent = promotionIntent(previous, candidate);
  const facts = {
    packId: pack.entry.packId,
    version: pack.entry.version,
    rules: pack.entry.rules.map((r) => r.familyId),
    candidate: candidateDigest(candidate),
    previousLock: previousDigest,
    previousRevision: previous.revision,
  };
  // Promoting exactly what the current revision already locks changes nothing: no receipt, no new revision.
  const locked = previous.packs.find((p) => p.packId === pack.entry.packId);
  if (selected && locked && locked.packDigest === pack.entry.packDigest && locked.version === pack.entry.version) {
    return result('rules', 'kept', { facts: { ...facts, lock: selected.digest, revision: previous.revision } });
  }
  const request = {
    intent,
    requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' },
    policy,
    stateDigest: previousDigest,
    now: options.now,
    capability: () => ({ available: true, detail: 'a validated pack folder; nothing is executed' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  };
  let decision = admit(request);
  if (decision.record.outcome === 'denied') {
    const v = decision.record.verdicts;
    return result('rules', 'configuration-failure', {
      verdicts: printed(decision.record),
      facts,
      reasonCode: v.policy.allowed
        ? v.capability.allowed
          ? v.credential.reasonCode
          : v.capability.reasonCode
        : v.policy.reasonCode,
    });
  }
  if (!options.confirm) return result('rules', 'awaiting-confirmation', { verdicts: printed(decision.record), facts });
  assertMayConfirm(OWNER);
  const receipts = receiptBook(ws);
  const receipt = issueReceipt(
    receipts,
    OWNER,
    { intent, stateDigest: previousDigest, policyRevision: policy.revision },
    { now: options.now, ttlMs: RECEIPT_TTL_MS },
  );
  decision = admit({ ...request, receipt: { book: receipts, id: receipt.id } });
  if (decision.record.outcome !== 'admitted' || !decision.receipt) {
    return result('rules', 'configuration-failure', {
      verdicts: printed(decision.record),
      facts,
      reasonCode: decision.record.verdicts.policy.reasonCode,
    });
  }
  const next = promote(previous, candidate, decision.receipt, options.now);
  // The pack's exact bytes are kept first: a lock revision is never current without the files it was promoted from.
  book.storePack(files);
  // The first promotion files and selects the empty revision it was confirmed against, so the chain starts where every
  // revision's `previous` leads. If another first promotion got there first, this one raced it and is refused.
  if (!selected) book.select(book.store(previous), null);
  const digest = book.store(next);
  book.select(digest, previousDigest);
  return result('rules', 'prepared', {
    verdicts: printed(decision.record),
    facts: { ...facts, lock: digest, revision: next.revision, receipt: decision.record.receipt },
  });
}

/** The owner's current rule lock: its digest, revision and packs, read back and verified. */
export function currentRules(ws: Workspace): CommandResult {
  const current = new RuleLockBook(trustFolder(ws)).current();
  if (!current) return result('rules', 'answered', { facts: { lock: null, packs: [] } });
  return result('rules', 'answered', {
    facts: {
      lock: current.digest,
      revision: current.lock.revision,
      previous: current.lock.previous,
      packs: current.lock.packs.map((p) => ({
        packId: p.packId,
        version: p.version,
        rules: p.rules.map((r) => r.familyId),
      })),
    },
  });
}

// ---- status and report ----

const MAX_STATUS_EVENTS = 50;

/** The run's state and a bounded page of its committed events. Reads only. */
export async function runStatus(
  ws: Workspace,
  options: { runId: string; after?: number; limit?: number },
): Promise<CommandResult> {
  return withStore(ws, async (store) => statusIn(store, { ...options, registry: publicRegistry(ws.trustDir) }));
}

/** The last committed state of a run, read in bounded pages, or null when the store has no such run. */
export function runStateIn(store: SentinelStore, runId: string): string | null {
  let state: string | null = null;
  for (let after = 0; ;) {
    const p = store.ledger.readEvents({ runId, after, limit: 500 });
    for (const e of p.events) {
      if (e.kind === 'run-created') state = String((e.payload as { state?: unknown }).state ?? state);
      if (e.kind === 'run-state') state = String((e.payload as { to?: unknown }).to ?? state);
    }
    if (!p.more) return state;
    after = p.cursor;
  }
}

/** `runStatus` against a store this process already holds (the background service's). */
export async function statusIn(
  store: SentinelStore,
  options: {
    runId: string;
    after?: number;
    limit?: number;
    /** Something executes it now (the service says so); otherwise whether this installation could is part of the answer. */
    executing?: boolean;
    registry?: AdapterRegistry;
  },
): Promise<CommandResult> {
  {
    const limit = Math.min(Math.max(1, options.limit ?? 20), MAX_STATUS_EVENTS);
    const page = store.ledger.readEvents({ runId: options.runId, after: options.after ?? 0, limit });
    // The state is the last committed run event's; the whole history is read in bounded pages without keeping it.
    const state = runStateIn(store, options.runId);
    if (state === null) {
      // A selected rerun is admitted before it is first run: it waits for `run`, with exactly its selection.
      const plan = await currentPlan(store, options.runId);
      const admitted = plan ? await loadPlan(store, options.runId, plan.revision) : undefined;
      if (admitted?.selection) {
        return result('status', 'answered', {
          reasonCode: 'sentinel.service.runAwaiting',
          facts: {
            runId: options.runId,
            state: 'planned',
            revision: plan!.revision,
            parentId: admitted.selection.parent.runId,
            units: unitsToRun(admitted.selection).size,
            held: admitted.selection.held.length,
            events: [],
            more: false,
          },
        });
      }
      return result('status', 'configuration-failure', {
        reasonCode: 'sentinel.service.runUnknown',
        facts: { runId: options.runId },
      });
    }
    // Not ended and not executing: a run this installation cannot execute says so here, not only once `run` is tried.
    const blocked =
      !options.executing && !isFinalRunState(state)
        ? await notExecutableHere(store, options.runId, options.registry)
        : undefined;
    return result('status', 'answered', {
      ...(blocked ? { reasonCode: 'sentinel.service.runNotExecutable' } : {}),
      facts: {
        ...runFailureFacts(store, options.runId),
        runId: options.runId,
        state,
        cursor: page.cursor,
        more: page.more,
        events: page.events.map((e) => ({ sequence: e.sequence, kind: e.kind, at: e.at })),
        ...(blocked ? { notExecutable: blocked } : {}),
      },
    });
  }
}

const FINAL_STATES = new Set(['completed', 'canceled']);
export const isFinalRunState = (state: string | null) => state !== null && FINAL_STATES.has(state);

function lastRunSequence(store: SentinelStore, runId: string): number {
  let last = 0;
  for (let after = 0; ;) {
    const page = store.ledger.readEvents({ runId, after, limit: 500 });
    for (const e of page.events) last = e.sequence;
    if (!page.more) return last;
    after = page.cursor;
  }
}

/** The preview report of a completed run, rendered from the ledger and the stored artifacts only; nothing executes. */
export async function previewReport(
  ws: Workspace,
  options: { runId: string; now: Date },
): Promise<PreviewReport | ScannerReport | CommandResult> {
  return withStore(ws, (store) => reportIn(store, ws, options));
}

/** `previewReport` against a store this process already holds (the background service's). */
export async function reportIn(
  store: SentinelStore,
  ws: Workspace,
  options: { runId: string; now: Date },
): Promise<PreviewReport | ScannerReport | CommandResult> {
  void ws;
  const recorded = store.ledger.getRun(options.runId);
  if (!recorded)
    return result('report', 'configuration-failure', {
      reasonCode: 'sentinel.service.runUnknown',
      facts: { runId: options.runId },
    });
  const scanner = await scannerReportOf(store, options.runId, options.now, { trustDir: ws.trustDir });
  if (scanner) return scanner;
  const findings = recorded.state === 'completed' ? await previewFindingsOf(store, options.runId) : undefined;
  if (!findings)
    return result('report', 'configuration-failure', {
      reasonCode: 'sentinel.service.runNotCompleted',
      facts: { runId: options.runId, ...runFailureFacts(store, options.runId) },
    });
  const snapshotId = recorded.envelope.snapshotId;
  const opened = await openSnapshot(store, snapshotId);
  const unknown = opened.snapshot.entries.filter((e) => e.kind === 'directory-boundary').length;
  const recheck = { cli: `farsight-sentinel report ${options.runId} --json` };
  const doc: PreviewReport = {
    schema: PREVIEW_REPORT_SCHEMA,
    label: 'foundation-preview',
    runId: options.runId,
    snapshotId,
    // Pinned to the run's own last committed event, so regenerating later reads the same facts at the same point.
    ledgerSequence: lastRunSequence(store, options.runId),
    generatedAt: options.now.toISOString(),
    counts: [
      {
        n: findings.findings.length,
        unit: 'sentinel.count.findings',
        scope: 'sentinel.scope.report',
        source: 'the foundation-preview detector',
        recheck,
      },
      {
        n: unknown,
        unit: 'sentinel.count.unknownBoundaries',
        scope: 'sentinel.scope.inventory',
        source: 'the snapshot inventory',
        recheck,
      },
    ],
    limitations: [...PREVIEW_LIMITATIONS],
  };
  return checkPreviewReport(doc);
}

// ---- the full report (PR 19 over this command path) ----

export interface FullReportOptions {
  readonly runId: string;
  readonly baselineRunId?: string;
  readonly disclosure: DisclosureProfile;
  readonly format: ReportFormat;
  /** An application graph the owner supplies, pinned only with the owner's confirmation of exactly it. */
  readonly contextFile?: string;
  readonly repo?: string;
  /** Write the rendering to this new file (never over an existing one) instead of returning it. */
  readonly out?: string;
  readonly confirm: boolean;
  readonly now: Date;
}

/**
 * The full report (or comparison) of a completed run, from its accepted evidence alone (full-report.ts). An owner
 * graph is placed only after the owner confirms the exact `context.pin` intent for this snapshot and source (exit 4
 * without `--confirm`, nothing is read into the report); the spent receipt is the pin's authority and lives only in
 * this process. The counts, gaps and placement verdict are in the result's facts; the rendering is returned (or
 * written once to `out`).
 */
export async function fullReportIn(
  ws: Workspace,
  options: FullReportOptions,
): Promise<{ result: CommandResult; text?: string }> {
  const command = options.baselineRunId ? 'compare' : 'report';
  return withStore(ws, async (store) => {
    let context: { graph: any; repo: string; authorization?: unknown } | undefined;
    let verdicts: PrintedVerdicts | undefined;
    if (options.contextFile) {
      const adopted = adoptedPolicy(ws);
      if ('refusal' in adopted) return { result: adopted.refusal };
      const { policy } = adopted;
      const { graph, repo } = readContextGraph({
        path: options.contextFile,
        ...(options.repo ? { repo: options.repo } : {}),
      });
      const current = await assessRun(store, options.runId, { trustDir: trustFolder(ws) });
      const sourceIds = [...new Set(current.snapshot.entries.map((e) => e.sourceId))];
      const sourceId = sourceIds.length === 1 ? sourceIds[0]! : 'workspace';
      const { intent } = contextIntentFor(current.snapshot, sourceId, ws.path, graph, repo);
      const stateDigest = sha(Buffer.from(`${current.snapshot.id}\u0000${sourceId}`));
      const request = {
        intent,
        requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' },
        policy,
        stateDigest,
        now: options.now,
        capability: () => ({
          available: true,
          detail: 'a local application graph checked against the captured bytes; nothing is executed',
        }),
        credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
      };
      let decision = admit(request);
      const facts = { runId: options.runId, contextIntent: decision.record.intentDigest, repo, sourceId };
      if (decision.record.outcome === 'denied') {
        const v = decision.record.verdicts;
        return {
          result: result(command, 'configuration-failure', {
            verdicts: printed(decision.record),
            facts,
            reasonCode: v.policy.allowed
              ? v.capability.allowed
                ? v.credential.reasonCode
                : v.capability.reasonCode
              : v.policy.reasonCode,
          }),
        };
      }
      if (!options.confirm)
        return { result: result(command, 'awaiting-confirmation', { verdicts: printed(decision.record), facts }) };
      assertMayConfirm(OWNER);
      const receipts = receiptBook(ws);
      const receipt = issueReceipt(
        receipts,
        OWNER,
        { intent, stateDigest, policyRevision: policy.revision },
        { now: options.now, ttlMs: RECEIPT_TTL_MS },
      );
      decision = admit({ ...request, receipt: { book: receipts, id: receipt.id } });
      if (decision.record.outcome !== 'admitted' || !decision.receipt) {
        return {
          result: result(command, 'configuration-failure', {
            verdicts: printed(decision.record),
            facts,
            reasonCode: decision.record.verdicts.policy.reasonCode,
          }),
        };
      }
      verdicts = printed(decision.record);
      context = { graph, repo, authorization: decision.receipt };
    }
    try {
      const r = await fullReport({
        store,
        runId: options.runId,
        workspace: ws.path,
        trustDir: trustFolder(ws),
        disclosure: options.disclosure,
        now: options.now,
        ...(options.baselineRunId ? { baselineRunId: options.baselineRunId } : {}),
        ...(context ? { context } : {}),
      });
      const doc = r.document;
      const text = renderingOf(r, options.format);
      if (options.out) writeNewFile(options.out, text);
      const facts = {
        runId: options.runId,
        reportId: doc.id,
        disclosure: doc.disclosure.profile,
        completeness: doc.completeness,
        counts: doc.counts,
        gaps: doc.gaps.length,
        findings: doc.findings.length,
        format: options.format,
        context: r.context,
        ...(options.baselineRunId ? { baselineRunId: options.baselineRunId, comparison: r.comparison } : {}),
        ...(options.out ? { written: options.out } : {}),
        // Never a policy result: findings are not judged against a finding policy here, and dispositions are PR 20.
        limitations: [
          'sentinel.service.policyNotEvaluated',
          ...(r.withheldForSecrets ? ['sentinel.report.withheld.secretRun'] : []),
        ],
      };
      return {
        result: result(command, 'answered', { ...(verdicts ? { verdicts } : {}), facts }),
        ...(options.out ? {} : { text }),
      };
    } catch (e) {
      if (e instanceof FullReportError)
        return {
          result: result(command, 'configuration-failure', {
            reasonCode: e.code,
            facts: { runId: options.runId, ...e.facts },
          }),
        };
      throw e;
    }
  });
}

export { PolicyError };

/** Prepare one retained structural task only. The exact owner decision precedes admission; execution separately
 * requires run.start. No-confirm/denied/malformed requests create no plan, run, work, attempt or staging records. */
export async function prepareWorkspacePaths(
  ws: Workspace,
  options: { ancestorRunId: string; requestFile: string; confirm: boolean; now: Date; signal?: AbortSignal },
): Promise<CommandResult> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const policy = adopted.policy,
    signal = options.signal ?? new AbortController().signal,
    deadlineAt = performance.now() + 120000;
  const boundary = () => {
    if (signal.aborted)
      throw new ExecutionError('sentinel.execution.canceled', { reason: 'structural preparation canceled' });
    if (performance.now() >= deadlineAt)
      throw new ExecutionError('sentinel.execution.deadlineExceeded', { reason: 'structural preparation deadline' });
    const current = adoptedPolicy(ws);
    if ('refusal' in current || current.policy.revision !== policy.revision)
      throw new ExecutionError('sentinel.execution.planInvalid', {
        reason: 'the owner policy changed during structural preparation',
      });
  };
  const workspace = workspaceIdentity(ws.path).digest;
  const preflight = admit({
    intent: intentOf('capture.source', workspace, ['local-artifacts']),
    requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' },
    policy,
    stateDigest: policy.revision,
    now: options.now,
    capability: () => ({ available: true, detail: 'policy preflight only; no caller file or execution backend read' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider contacted' }),
  });
  if (!preflight.record.verdicts.policy.allowed)
    return result('paths', 'configuration-failure', {
      verdicts: printed(preflight.record),
      reasonCode: preflight.record.verdicts.policy.reasonCode,
    });
  const request = readPathRequestFile(options.requestFile, boundary);
  if (request.value.ancestor.runId !== options.ancestorRunId) throw new PathRequestError('unbound');
  return withStore(ws, async (store) => {
    const terms = { trustDir: trustFolder(ws), policy, now: options.now };
    const candidate = await preparePathTask(store, request.value, terms, { signal, deadlineAt, stillWithin: boundary });
    return decidePathTaskIn(store, ws, candidate, policy, {
      command: 'paths',
      confirm: options.confirm,
      now: options.now,
    });
  });
}

async function decidePathTaskIn(
  store: SentinelStore,
  ws: Workspace,
  candidate: PathTaskCandidate,
  policy: EffectivePolicy,
  options: { command: 'paths' | 'retry' | 'rerun'; confirm: boolean; now: Date; parentSelection?: string[] },
): Promise<CommandResult> {
  const terms = { trustDir: trustFolder(ws), policy, now: options.now },
    workspace = workspaceIdentity(ws.path).digest;
  // Current ancestor and its authenticated request/selection edges are used only as a privacy withholding flag.
  // The reader authenticates accepted secret publications even when that ended ancestor was canceled.
  const ancestor = await loadPlan(
    store,
    candidate.request.value.ancestor.runId,
    candidate.request.value.ancestor.revision,
  );
  const privacy = await selectedSecretPrivacy(store, candidate.request.value.ancestor.runId, ancestor, true);
  candidate.boundary();
  const preview = privacy.hasMatches
    ? {
        ...candidate.preview,
        queries: candidate.preview.queries.map(() => ({ detailsWithheld: true })),
        detailLoss: 'sentinel.report.withheld.secretRun',
      }
    : candidate.preview;
  const facts = {
    runId: candidate.plan.runId,
    planId: candidate.plan.runId,
    revision: 1,
    planDigest: candidate.plan.digest,
    snapshotId: candidate.request.value.snapshotId,
    request: candidate.request.id,
    generation: candidate.generation,
    parentId: candidate.request.value.ancestor.runId,
    unitIds: candidate.preview.selected,
    preview: { ...preview, ...(options.parentSelection ? { parentSelection: options.parentSelection } : {}) },
    effects: ['local-artifacts'],
    executionRequires: 'run.start',
    usage: candidate.usage,
  };
  const intent = intentOf(
    'capture.source',
    candidate.plan.digest,
    ['local-artifacts'],
    [`sentinel.workspace:${workspace}`, `sentinel.store:${store.storeId}`, `sentinel.request:${candidate.request.id}`],
  );
  const decided = decide(
    ws,
    policy,
    intent,
    sha(canonicalJsonBytes({ candidate: candidate.stateDigest, parentSelection: options.parentSelection ?? null })),
    options.confirm,
    options.now,
  );
  if (!decided.admitted)
    return { ...decided.result, command: options.command, facts: { ...decided.result.facts, ...facts } };
  candidate.boundary();
  const accepted = await acceptPathTask(store, candidate, terms);
  return result(options.command, accepted.outcome, { verdicts: printed(decided.record), facts });
}
async function followPathTaskIn(
  store: SentinelStore,
  ws: Workspace,
  admitted: Awaited<ReturnType<typeof loadPlan>>,
  policy: EffectivePolicy,
  options: { mode: 'retry' | 'rerun'; runId: string; stages?: readonly string[]; confirm: boolean; now: Date },
): Promise<CommandResult> {
  const parent = store.ledger.getRun(options.runId)!;
  if (parent.state !== 'completed' && parent.state !== 'canceled')
    return result(options.mode, 'kept', {
      facts: {
        runId: parent.id,
        planDigest: admitted.plan.digest,
        state: parent.state,
        joined: true,
        executionRequires: 'run.start',
      },
    });
  const original = pathRequestOf(admitted.pathRequest),
    active = pathUnitsFor(admitted.plan, original),
    chosen = [...(options.stages?.length ? options.stages : active)].sort();
  if (new Set(chosen).size !== chosen.length || chosen.some((id) => !active.has(id)))
    return result(options.mode, 'configuration-failure', {
      reasonCode: 'sentinel.service.stageUnknown',
      facts: { runId: parent.id },
    });
  const selected =
    options.mode === 'retry'
      ? chosen.filter((id) => {
          const unit = admitted.plan.units.find((u) => u.id === id)!;
          return !store.ledger.getPublication(unit);
        })
      : chosen;
  if (!selected.length)
    return result(options.mode, 'refused', {
      reasonCode: 'sentinel.service.nothingToRetry',
      facts: { runId: parent.id },
    });
  // The shipped structural unit contains all pairs of its one bound source. A distinct request rerun keeps that
  // exact unit's queries/bounds, with a genuine immediate request ancestor; no legacy parentUnit map is invented.
  if (selected.length !== active.size)
    return result(options.mode, 'configuration-failure', {
      reasonCode: 'sentinel.service.selectionStale',
      facts: { runId: parent.id },
    });
  const request = pathRequestOf({
    ...original.value,
    ancestor: { runId: parent.id, revision: parent.planRevision, planDigest: admitted.plan.digest },
  });
  const signal = new AbortController().signal,
    deadlineAt = performance.now() + 120000;
  const stillWithin = () => {
    const current = adoptedPolicy(ws);
    if ('refusal' in current || current.policy.revision !== policy.revision)
      throw new ExecutionError('sentinel.execution.planInvalid', {
        reason: 'the owner policy changed during structural rerun preparation',
      });
  };
  const candidate = await preparePathTask(
    store,
    request.value,
    { trustDir: trustFolder(ws), policy, now: options.now },
    { signal, deadlineAt, stillWithin },
  );
  return decidePathTaskIn(store, ws, candidate, policy, {
    command: options.mode,
    confirm: options.confirm,
    now: options.now,
    parentSelection: selected,
  });
}

/** Closed owner-only private trace, read from genuine accepted review work. No artifact/path lookup input. */
export async function privateReviewTrace(ws: Workspace, runId: string): Promise<CommandResult> {
  checkWorkspaceLayout(ws);
  return withStore(ws, async (store) => {
    const run = store.ledger.getRun(runId);
    if (!run) return result('report', 'configuration-failure', { reasonCode: 'sentinel.execution.planInvalid' });
    const plan = await loadPlan(store, runId, run.planRevision),
      deadlineAt = Date.now() + 20000,
      signal = AbortSignal.timeout(20000);
    const { reviewSecretsKnown } = await import('../review/dispatch.js');
    if (await reviewSecretsKnown(store, runId, plan))
      return result('report', 'answered', {
        facts: { runId, disclosure: 'private-only', privacy: 'withheld', traces: [] },
      });
    const { readPublishedInstructions } = await import('../review/instructions.js'),
      traces = [];
    let bytes = 0;
    const units = plan.plan.units.filter((u) => u.review);
    if (units.length > 32) throw new ExecutionError('sentinel.execution.planInvalid', {});
    for (const unit of units) {
      const trace = await readPublishedInstructions(store, unit, { signal, deadlineAt });
      const value = {
        work: { id: unit.id, revision: unit.revision },
        record: trace.record,
        instructions: trace.instructions,
        requests: trace.requests,
        observations: trace.observations,
        contents: trace.contents.map((c) => ({
          id: c.id,
          text: new TextDecoder('utf8', { fatal: true }).decode(c.bytes),
        })),
      };
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > 8 * 1024 * 1024) throw new ExecutionError('sentinel.execution.outputTooLarge', {});
      traces.push(value);
    }
    store.assertHeld();
    if (signal.aborted || Date.now() >= deadlineAt) throw new ExecutionError('sentinel.execution.deadlineExceeded', {});
    if (await reviewSecretsKnown(store, runId, plan))
      return result('report', 'answered', {
        facts: { runId, disclosure: 'private-only', privacy: 'withheld', traces: [] },
      });
    const response = result('report', 'answered', {
      facts: {
        runId,
        disclosure: 'private-only',
        privacy: 'private-owner-view',
        vendorInstructions: 'unobserved',
        traces,
      },
    });
    if (Buffer.byteLength(JSON.stringify(response)) > 8 * 1024 * 1024)
      throw new ExecutionError('sentinel.execution.outputTooLarge', {});
    return response;
  });
}
