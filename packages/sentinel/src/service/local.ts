// The owner's local operations: adopt settings, plan, run in the foreground, bounded status and the preview report.
// Each runs in the owner's own process (the owner CLI entrypoint) against the workspace's store; the requester is
// the entrypoint's, never a request's. Every action that changes something is decided by PR 06's admission (three
// verdicts) first, and a receipt is issued and spent only here, after the owner's own confirm. The background
// service (owner-service.ts) reuses the store-level reads below; it holds the store while it runs.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionEffect, ActionIntent, AdmissionEnvelope } from '../contracts/index.js';
import {
  adoptSettings, adoptionIntent, admit, workspaceIdentity, effectivePolicy, loadPolicyInputs, ReceiptBook, trustDirectory, PolicyError,
  type EffectivePolicy,
} from '../policy/index.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { checkPreviewReport, PREVIEW_LIMITATIONS, PREVIEW_REPORT_SCHEMA, type PreviewReport } from '../reports/preview.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { openStore, type SentinelStore } from '../store/index.js';
import { requestedByOf, assertMayConfirm } from '../cli/actor.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';

import { candidateDigest, emptyLock, lockDigest, promote, promotionIntent, readPackDirectory, validatePack } from '../rules/index.js';
import { RuleLockBook } from './rule-locks.js';
import { loadPlan } from '../execution/plans.js';
import { ServiceError } from './owner-service.js';
import { canonicalResult, currentPlan, executeRun, rerunRun, planWorkspaceCanonical, previewFindingsOf, type CanonicalDisclosure, type CurrentPlan } from './canonical.js';

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

export const printed = (r: AdmissionEnvelope): PrintedVerdicts => Object.freeze({
  policy: Object.freeze({ allowed: r.verdicts.policy.allowed, asked: r.verdicts.policy.asked, reasonCode: r.verdicts.policy.reasonCode }),
  capability: Object.freeze({ allowed: r.verdicts.capability.allowed, asked: r.verdicts.capability.asked, reasonCode: r.verdicts.capability.reasonCode }),
  credential: Object.freeze({ allowed: r.verdicts.credential.allowed, asked: r.verdicts.credential.asked, reasonCode: r.verdicts.credential.reasonCode }),
});

function trustFolder(ws: Workspace): string {
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
    return { refusal: result('policy', 'configuration-failure', { reasonCode: 'sentinel.service.settingsNotAdopted', facts: { trust: inputs.trust } }) };
  }
  return { policy: effectivePolicy(inputs) };
}

/**
 * Decides one action by admission, as the owner. Without `confirm` an action that needs confirmation stops at
 * awaiting-confirmation (exit 4); with it, the owner's receipt is issued here and spent by the same admission.
 */
function decide(ws: Workspace, policy: EffectivePolicy, intent: ActionIntent, stateDigest: string, confirm: boolean, now: Date):
  { admitted: true; record: AdmissionEnvelope } | { admitted: false; result: CommandResult } {
  const request = {
    intent, requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' }, policy, stateDigest, now,
    capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  };
  let decision = admit(request);
  if (decision.record.outcome === 'awaiting-confirmation' && confirm) {
    assertMayConfirm(OWNER);
    const book = receiptBook(ws);
    const receipt = issueReceipt(book, OWNER, { intent, stateDigest, policyRevision: policy.revision }, { now, ttlMs: RECEIPT_TTL_MS });
    decision = admit({ ...request, receipt: { book, id: receipt.id } });
  }
  const r = decision.record;
  if (r.outcome === 'admitted') return { admitted: true, record: r };
  const facts = { action: intent.action, intentDigest: r.intentDigest };
  return {
    admitted: false,
    result: r.outcome === 'awaiting-confirmation'
      ? result(intent.action, 'awaiting-confirmation', { verdicts: printed(r), facts })
      : result(intent.action, 'configuration-failure', { verdicts: printed(r), facts, reasonCode: r.verdicts.policy.allowed ? (r.verdicts.capability.allowed ? r.verdicts.credential.reasonCode : r.verdicts.capability.reasonCode) : r.verdicts.policy.reasonCode }),
  };
}

/** The settings profile a write is scoped to: the one init grants the owner (cli/init.ts PROFILES). */
export const SCAN_PROFILE = 'static';

export const intentOf = (action: ActionIntent['action'], input: string, effects: ActionEffect[], targets: string[] = []): ActionIntent => ({
  action, input, effects, budget: { maxTokens: null, maxCost: null, currency: null },
  scope: { profile: SCAN_PROFILE, provider: null, targets },
});

/** The exact instance a write on a run acts on: this workspace (path, device and inode), this store, this run. */
export interface RunInstance { readonly storeId: string; readonly runId: string }

/**
 * A write on a run, bound to the instance it acts on. Two workspaces with the same content, settings and plan digest
 * still differ in workspace identity and store: a receipt confirmed for one is a mismatch in the other.
 */
export function runWriteBinding(ws: Workspace, action: 'run.start' | 'run.pause' | 'run.cancel', planDigest: string, instance: RunInstance):
  { intent: ActionIntent; stateDigest: string } {
  const workspace = workspaceIdentity(ws.path).digest;
  const intent = intentOf(action, planDigest, ['local-artifacts'], [`sentinel.workspace:${workspace}`, `sentinel.store:${instance.storeId}`, `sentinel.run:${instance.runId}`]);
  return { intent, stateDigest: sha(canonicalJsonBytes({ kind: 'sentinel-run-write/1', plan: planDigest, workspace, store: instance.storeId, run: instance.runId })) };
}

// ---- settings adoption (an owner action) ----

export function adoptWorkspaceSettings(ws: Workspace, options: { confirm: boolean; now: Date }): CommandResult {
  const { intent, settingsDigest } = adoptionIntent(ws.path);
  if (!options.confirm) {
    return result('settings.adopt', 'awaiting-confirmation', { facts: { settingsDigest, intentDigest: sha(canonicalJsonBytes(intent)) } });
  }
  assertMayConfirm(OWNER);
  const book = receiptBook(ws);
  const inputs = loadPolicyInputs({ workspace: ws.path, trustDir: trustFolder(ws) });
  const policyRevision = effectivePolicy(inputs).revision;
  const receipt = issueReceipt(book, OWNER, { intent, stateDigest: settingsDigest, policyRevision }, { now: options.now, ttlMs: RECEIPT_TTL_MS });
  const spent = book.consume(receipt.id, { intent, stateDigest: settingsDigest, policyRevision }, options.now);
  const adoption = adoptSettings({ workspace: ws.path, trustDir: ws.trustDir, receipt: spent, now: options.now });
  return result('settings.adopt', 'prepared', { facts: { settingsDigest: adoption.settingsDigest, adoptedAt: adoption.adoptedAt } });
}

// ---- plan ----

export function scratchUnder(ws: Workspace): string {
  const root = join(ws.path, '.farsight', 'sentinel', 'scratch');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, 'w-'));
}

export function removeScratch(dir: string): void {
  const open = (p: string) => {
    try { chmodSync(p, 0o700); } catch { return; }
    for (const name of readdirSync(p)) {
      const c = join(p, name);
      const st = lstatSync(c);
      if (st.isDirectory()) open(c); else if (st.isFile()) chmodSync(c, 0o600);
    }
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}

async function withStore<T>(ws: Workspace, body: (store: SentinelStore) => Promise<T>): Promise<T> {
  const store = await openStore(ws.storePath);
  try { return await body(store); } finally { store.close(); }
}

/**
 * Plans the workspace canonically (canonical.ts): admitted as `capture.source`, then capture, the admitted bootstrap
 * published by the coordinator's own operations, and the analysis planned from that evidence under the owner's
 * promoted rule lock and the adopted policy, admitted and made the run's current revision. Nothing is checked yet.
 * The same content under the same lock, policy and profile is the same run (`kept`).
 */
export async function planWorkspace(ws: Workspace, options: { confirm: boolean; now: Date; parentId?: string | null }):
  Promise<CommandResult & { disclosure?: CanonicalDisclosure }> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  const decided = decide(ws, policy, intentOf('capture.source', sha(Buffer.from(ws.path)), ['local-artifacts']), policy.revision, options.confirm, options.now);
  if (!decided.admitted) return decided.result;
  return withStore(ws, async store => {
    const work = scratchUnder(ws);
    try {
      let planned;
      try {
        planned = await planWorkspaceCanonical(store, { workspace: ws.path, trustDir: trustFolder(ws), policy, scratchRoot: work, now: options.now,
          ...(options.parentId ? { parentId: options.parentId } : {}) });
      } catch (e) {
        if (e instanceof ServiceError && (e.code === 'sentinel.service.bootstrapFailed' || e.code === 'sentinel.service.ruleUnsupported')) {
          return result('plan', 'configuration-failure', { verdicts: printed(decided.record), reasonCode: e.code, facts: { ...e.facts } });
        }
        throw e;
      }
      return { ...result('plan', planned.outcome, { verdicts: printed(decided.record), facts: { ...planned.disclosure } }), disclosure: planned.disclosure };
    } finally { removeScratch(work); }
  });
}

/**
 * Rerun or retry an ended run as a new linked run over its retained snapshot (canonical.ts rerunRun): `rerun` the
 * named units (all when none are named), `retry` the units that did not publish. Admitted as `capture.source` like
 * any planning; the dependency preview (selected, downstream, reused prerequisites) is in the result either way.
 */
export async function followWorkspaceRun(ws: Workspace, options: { mode: 'retry' | 'rerun'; runId: string; stages?: readonly string[]; confirm: boolean; now: Date }):
  Promise<CommandResult> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  const decided = decide(ws, policy, intentOf('capture.source', sha(Buffer.from(ws.path)), ['local-artifacts']), policy.revision, options.confirm, options.now);
  if (!decided.admitted) return decided.result;
  const verdicts = printed(decided.record);
  return withStore(ws, async store => {
    let stages = [...(options.stages ?? [])];
    if (options.mode === 'retry') {
      // The units that did not publish: what a retry runs again.
      const plan = await currentPlan(store, options.runId);
      if (plan?.kind === 'analysis') {
        const { plan: revision } = await loadPlan(store, options.runId, plan.revision);
        stages = revision.units.filter(u => !store.ledger.getPublication({ id: u.id, revision: u.revision })).map(u => u.id);
        if (!stages.length) return result('retry', 'refused', { verdicts, reasonCode: 'sentinel.service.nothingToRetry', facts: { runId: options.runId } });
      }
    }
    const work = scratchUnder(ws);
    try {
      const followed = await rerunRun(store, options.runId, stages, { workspace: ws.path, trustDir: trustFolder(ws), policy, scratchRoot: work, now: options.now });
      if ('reasonCode' in followed) return result(options.mode, 'configuration-failure', { verdicts, reasonCode: followed.reasonCode, facts: { runId: options.runId, ...(followed.facts ?? {}) } });
      return result(options.mode, followed.outcome, { verdicts, facts: { ...followed.disclosure, parentId: options.runId, preview: followed.preview } });
    } finally { removeScratch(work); }
  });
}

/** The run's current admitted plan, read from the workspace's store (used when no service holds it). */
export async function describeRun(ws: Workspace, runId: string): Promise<CurrentPlan | undefined> {
  return withStore(ws, store => currentPlan(store, runId));
}

// ---- run (foreground) ----

/**
 * Runs the run's current admitted revision in this process: admitted as `run.start` against that revision's digest
 * (and only under the policy it was admitted with), then executed by the coordinator. A run that already completed
 * returns its result again without executing anything. The result is read back from the ledger (canonicalResult).
 */
export async function runPlan(ws: Workspace, options: { planId: string; confirm: boolean; now: Date }): Promise<CommandResult> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  return withStore(ws, async store => {
    const plan = await currentPlan(store, options.planId);
    if (!plan || plan.kind !== 'analysis') return result('run', 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts: { planId: options.planId } });
    if (policy.revision !== plan.policyRevision) return result('run', 'configuration-failure', { reasonCode: 'sentinel.service.policyChanged', facts: { planId: plan.runId } });
    const decided = decide(ws, policy, intentOf('run.start', plan.planDigest, ['local-artifacts']), plan.planDigest, options.confirm, options.now);
    if (!decided.admitted) return decided.result;
    const verdicts = printed(decided.record);
    if (!isFinalRunState(runStateIn(store, plan.runId))) {
      const work = scratchUnder(ws);
      try { await executeRun(store, plan.runId, { scratchRoot: work }); } finally { removeScratch(work); }
    }
    return canonicalResult(store, 'run', plan.runId, { executing: false, verdicts });
  });
}

// ---- the owner's confirmation, carried to the background service ----

/**
 * Confirms one write on a plan's run for the background service, as the owner, in this process: the action is
 * admitted here (three verdicts, the owner as requester), then, only with `confirm`, a receipt bound to exactly that
 * action, this plan's digest and the adopted policy revision is issued and not spent. The service spends it once; a
 * connection without one is an agent and gets what the adopted grants give agents, nothing implicit.
 */
export function confirmForService(ws: Workspace, options: { command: string; action: 'run.start' | 'run.pause' | 'run.cancel'; plan: CurrentPlan | undefined;
  planId: string; confirm: boolean; now: Date;
  /** The store the running service holds, from its verified welcome. Needed to confirm; not to show what would happen. */
  storeId?: string }):
  { receiptId: string; verdicts: PrintedVerdicts } | { result: CommandResult } {
  const record = options.plan;
  if (!record || record.kind !== 'analysis') return { result: result(options.command, 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts: { planId: options.planId } }) };
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return { result: adopted.refusal };
  const { policy } = adopted;
  if (policy.revision !== record.policyRevision) {
    return { result: result(options.command, 'configuration-failure', { reasonCode: 'sentinel.service.policyChanged', facts: { planId: record.runId } }) };
  }
  // Bound to this workspace, this run and, once a service answered, its store; without a store yet the decision is
  // shown against the unbound intent and nothing is issued.
  const { intent, stateDigest } = options.storeId === undefined
    ? { intent: intentOf(options.action, record.planDigest, ['local-artifacts']), stateDigest: record.planDigest }
    : runWriteBinding(ws, options.action, record.planDigest, { storeId: options.storeId, runId: record.runId });
  const decision = admit({
    intent, requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' }, policy, stateDigest, now: options.now,
    capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  }).record;
  const verdicts = printed(decision);
  const facts = { planId: record.runId, action: intent.action, intentDigest: decision.intentDigest };
  if (decision.outcome === 'denied') {
    const v = decision.verdicts;
    return { result: result(options.command, 'configuration-failure', { verdicts, facts,
      reasonCode: v.policy.allowed ? (v.capability.allowed ? v.credential.reasonCode : v.capability.reasonCode) : v.policy.reasonCode }) };
  }
  if (!options.confirm) return { result: result(options.command, 'awaiting-confirmation', { verdicts, facts, reasonCode: 'sentinel.service.needsOwnerConfirm' }) };
  assertMayConfirm(OWNER);
  if (options.storeId === undefined) {
    // Never a receipt that names no store: it could be spent by any service that holds a plan with this digest.
    return { result: result(options.command, 'configuration-failure', { verdicts, facts, reasonCode: 'sentinel.service.notRunning' }) };
  }
  const receipt = issueReceipt(receiptBook(ws), OWNER, { intent, stateDigest, policyRevision: policy.revision }, { now: options.now, ttlMs: RECEIPT_TTL_MS });
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
export function promoteRulePack(ws: Workspace, options: { packDir: string; confirm: boolean; now: Date }): CommandResult {
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
    packId: pack.entry.packId, version: pack.entry.version, rules: pack.entry.rules.map(r => r.familyId),
    candidate: candidateDigest(candidate), previousLock: previousDigest, previousRevision: previous.revision,
  };
  // Promoting exactly what the current revision already locks changes nothing: no receipt, no new revision.
  const locked = previous.packs.find(p => p.packId === pack.entry.packId);
  if (selected && locked && locked.packDigest === pack.entry.packDigest && locked.version === pack.entry.version) {
    return result('rules', 'kept', { facts: { ...facts, lock: selected.digest, revision: previous.revision } });
  }
  const request = {
    intent, requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' }, policy, stateDigest: previousDigest, now: options.now,
    capability: () => ({ available: true, detail: 'a validated pack folder; nothing is executed' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  };
  let decision = admit(request);
  if (decision.record.outcome === 'denied') {
    const v = decision.record.verdicts;
    return result('rules', 'configuration-failure', { verdicts: printed(decision.record), facts,
      reasonCode: v.policy.allowed ? (v.capability.allowed ? v.credential.reasonCode : v.capability.reasonCode) : v.policy.reasonCode });
  }
  if (!options.confirm) return result('rules', 'awaiting-confirmation', { verdicts: printed(decision.record), facts });
  assertMayConfirm(OWNER);
  const receipts = receiptBook(ws);
  const receipt = issueReceipt(receipts, OWNER, { intent, stateDigest: previousDigest, policyRevision: policy.revision }, { now: options.now, ttlMs: RECEIPT_TTL_MS });
  decision = admit({ ...request, receipt: { book: receipts, id: receipt.id } });
  if (decision.record.outcome !== 'admitted' || !decision.receipt) {
    return result('rules', 'configuration-failure', { verdicts: printed(decision.record), facts, reasonCode: decision.record.verdicts.policy.reasonCode });
  }
  const next = promote(previous, candidate, decision.receipt, options.now);
  // The pack's exact bytes are kept first: a lock revision is never current without the files it was promoted from.
  book.storePack(files);
  // The first promotion files and selects the empty revision it was confirmed against, so the chain starts where every
  // revision's `previous` leads. If another first promotion got there first, this one raced it and is refused.
  if (!selected) book.select(book.store(previous), null);
  const digest = book.store(next);
  book.select(digest, previousDigest);
  return result('rules', 'prepared', { verdicts: printed(decision.record), facts: { ...facts, lock: digest, revision: next.revision, receipt: decision.record.receipt } });
}

/** The owner's current rule lock: its digest, revision and packs, read back and verified. */
export function currentRules(ws: Workspace): CommandResult {
  const current = new RuleLockBook(trustFolder(ws)).current();
  if (!current) return result('rules', 'answered', { facts: { lock: null, packs: [] } });
  return result('rules', 'answered', { facts: { lock: current.digest, revision: current.lock.revision, previous: current.lock.previous,
    packs: current.lock.packs.map(p => ({ packId: p.packId, version: p.version, rules: p.rules.map(r => r.familyId) })) } });
}

// ---- status and report ----

const MAX_STATUS_EVENTS = 50;

/** The run's state and a bounded page of its committed events. Reads only. */
export async function runStatus(ws: Workspace, options: { runId: string; after?: number; limit?: number }): Promise<CommandResult> {
  return withStore(ws, async store => statusIn(store, options));
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
export async function statusIn(store: SentinelStore, options: { runId: string; after?: number; limit?: number }): Promise<CommandResult> {
  {
    const limit = Math.min(Math.max(1, options.limit ?? 20), MAX_STATUS_EVENTS);
    const page = store.ledger.readEvents({ runId: options.runId, after: options.after ?? 0, limit });
    // The state is the last committed run event's; the whole history is read in bounded pages without keeping it.
    const state = runStateIn(store, options.runId);
    if (state === null) return result('status', 'configuration-failure', { reasonCode: 'sentinel.service.runUnknown', facts: { runId: options.runId } });
    return result('status', 'answered', { facts: {
      runId: options.runId, state, cursor: page.cursor, more: page.more,
      events: page.events.map(e => ({ sequence: e.sequence, kind: e.kind, at: e.at })),
    } });
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
export async function previewReport(ws: Workspace, options: { runId: string; now: Date }): Promise<PreviewReport | CommandResult> {
  return withStore(ws, store => reportIn(store, ws, options));
}

/** `previewReport` against a store this process already holds (the background service's). */
export async function reportIn(store: SentinelStore, ws: Workspace, options: { runId: string; now: Date }): Promise<PreviewReport | CommandResult> {
  void ws;
  const recorded = store.ledger.getRun(options.runId);
  if (!recorded) return result('report', 'configuration-failure', { reasonCode: 'sentinel.service.runUnknown', facts: { runId: options.runId } });
  const findings = recorded.state === 'completed' ? await previewFindingsOf(store, options.runId) : undefined;
  if (!findings) return result('report', 'configuration-failure', { reasonCode: 'sentinel.service.runNotCompleted', facts: { runId: options.runId } });
  const snapshotId = recorded.envelope.snapshotId;
  const opened = await openSnapshot(store, snapshotId);
  const unknown = opened.snapshot.entries.filter(e => e.kind === 'directory-boundary').length;
  const recheck = { cli: `farsight-sentinel report ${options.runId} --json` };
  const doc: PreviewReport = {
    schema: PREVIEW_REPORT_SCHEMA, label: 'foundation-preview', runId: options.runId, snapshotId,
    // Pinned to the run's own last committed event, so regenerating later reads the same facts at the same point.
    ledgerSequence: lastRunSequence(store, options.runId), generatedAt: options.now.toISOString(),
    counts: [
      { n: findings.findings.length, unit: 'sentinel.count.findings', scope: 'sentinel.scope.report', source: 'the foundation-preview detector', recheck },
      { n: unknown, unit: 'sentinel.count.unknownBoundaries', scope: 'sentinel.scope.inventory', source: 'the snapshot inventory', recheck },
    ],
    limitations: [...PREVIEW_LIMITATIONS],
  };
  return checkPreviewReport(doc);
}

export { PolicyError };
