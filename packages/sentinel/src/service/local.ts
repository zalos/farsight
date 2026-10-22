// The owner's local operations: adopt settings, plan, run in the foreground, bounded status and the preview report.
// Each runs in the owner's own process (the owner CLI entrypoint) against the workspace's store; the requester is
// the entrypoint's, never a request's. Every action that changes something is decided by PR 06's admission (three
// verdicts) first, and a receipt is issued and spent only here, after the owner's own confirm. The background
// service (owner-service.ts) reuses the store-level reads below; it holds the store while it runs.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionEffect, ActionIntent, AdmissionEnvelope } from '../contracts/index.js';
import { Coordinator, type RunSummary } from '../execution/coordinator.js';
import {
  adoptSettings, adoptionIntent, admit, effectivePolicy, loadPolicyInputs, ReceiptBook, trustDirectory, PolicyError,
  type EffectivePolicy,
} from '../policy/index.js';
import { issueReceipt } from '../policy/owner-receipts.js';
import { PREVIEW_FINDINGS_SCHEMA } from '../adapters/preview-detector.js';
import { checkPreviewReport, PREVIEW_LIMITATIONS, PREVIEW_REPORT_SCHEMA, type PreviewReport } from '../reports/preview.js';
import { captureSnapshot } from '../snapshot/capture.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { openStore, type SentinelStore } from '../store/index.js';
import { requestedByOf, assertMayConfirm } from '../cli/actor.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';
import { PREVIEW_ADAPTERS, PREVIEW_PROFILE, previewPlan, type PlanDisclosure, type PlanRecord } from './preview-plan.js';
import { candidateDigest, emptyLock, lockDigest, promote, promotionIntent, readPackDirectory, validatePack } from '../rules/index.js';
import { RuleLockBook } from './rule-locks.js';

export interface Workspace {
  readonly path: string;
  readonly storePath: string;
  readonly planDir: string;
  readonly trustDir: string;
}

/** The workspace's private Sentinel folders: the store and plan records beside the settings, trust outside it. */
export function workspaceOf(path: string, env: NodeJS.ProcessEnv = process.env): Workspace {
  return Object.freeze({
    path,
    storePath: join(path, '.farsight', 'sentinel', 'store'),
    planDir: join(path, '.farsight', 'sentinel', 'plans'),
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

export const intentOf = (action: ActionIntent['action'], input: string, effects: ActionEffect[]): ActionIntent => ({
  action, input, effects, budget: { maxTokens: null, maxCost: null, currency: null },
  scope: { profile: PREVIEW_PROFILE, provider: null, targets: [] },
});

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

export function readPlanRecord(ws: Workspace, planId: string): PlanRecord | undefined {
  if (!/^plan-[0-9a-f]{32}$/.test(planId)) return undefined;
  try {
    const st = lstatSync(join(ws.planDir, `${planId}.json`));
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    const v = JSON.parse(readFileSync(join(ws.planDir, `${planId}.json`), 'utf8')) as PlanRecord;
    return v?.schema === 'sentinel-plan-record/draft-1' && v.planId === planId ? v : undefined;
  } catch { return undefined; }
}

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
 * Captures the workspace and prepares the preview plan: admitted as `capture.source`, then a working-copy capture
 * (Sentinel's own folder excluded), the plan built and its run recorded as `planned`. Planning again with the same
 * snapshot, policy and adapter gives the same plan id; nothing runs.
 */
export async function planWorkspace(ws: Workspace, options: { confirm: boolean; now: Date }):
  Promise<CommandResult & { disclosure?: PlanDisclosure }> {
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  const decided = decide(ws, policy, intentOf('capture.source', sha(Buffer.from(ws.path)), ['local-artifacts']), policy.revision, options.confirm, options.now);
  if (!decided.admitted) return decided.result;
  return withStore(ws, async store => {
    const captured = await captureSnapshot(store, {
      mode: 'working-copy', sources: [{ sourceId: 'workspace', repositoryId: 'local-workspace', root: ws.path }],
      policy: { exclude: { '*': ['.farsight'] } },
    });
    const work = scratchUnder(ws);
    try {
      const plan = await previewPlan(store, { snapshotId: captured.record.snapshotId, policyRevision: policy.revision, workDir: join(work, 'plan'), now: options.now.toISOString() });
      try { store.ledger.createRun(plan.boundary.run as never); } catch (e) {
        if ((e as { code?: string }).code !== 'sentinel.store.conflict') throw e; // the same plan, already recorded
      }
      mkdirSync(ws.planDir, { recursive: true, mode: 0o700 });
      const record: PlanRecord = { schema: 'sentinel-plan-record/draft-1', planId: plan.disclosure.planId, planDigest: plan.disclosure.planDigest,
        snapshotId: captured.record.snapshotId, policyRevision: policy.revision };
      writeFileSync(join(ws.planDir, `${record.planId}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      return { ...result('plan', 'prepared', { verdicts: printed(decided.record), facts: { ...plan.disclosure } }), disclosure: plan.disclosure };
    } finally { removeScratch(work); }
  });
}

// ---- run (foreground) ----

/**
 * Runs a prepared plan in this process until it completes: admitted as `run.start` against the plan's digest, the
 * plan rebuilt from its snapshot and checked against what `plan` disclosed, then executed by the coordinator. A run
 * that already completed returns its result again without executing anything. A preview never satisfies required
 * coverage: its result is `required-coverage-incomplete` (exit 2) with every fact kept.
 */
export async function runPlan(ws: Workspace, options: { planId: string; confirm: boolean; now: Date }): Promise<CommandResult> {
  const record = readPlanRecord(ws, options.planId);
  if (!record) return result('run', 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts: { planId: options.planId } });
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return adopted.refusal;
  const { policy } = adopted;
  if (policy.revision !== record.policyRevision) {
    return result('run', 'configuration-failure', { reasonCode: 'sentinel.service.policyChanged', facts: { planId: record.planId } });
  }
  const decided = decide(ws, policy, intentOf('run.start', record.planDigest, ['local-artifacts']), record.planDigest, options.confirm, options.now);
  if (!decided.admitted) return decided.result;
  return withStore(ws, async store => {
    const work = scratchUnder(ws);
    let summary: RunSummary;
    try {
      const plan = await previewPlan(store, { snapshotId: record.snapshotId, policyRevision: record.policyRevision, workDir: join(work, 'plan'), now: options.now.toISOString() });
      if (plan.disclosure.planDigest !== record.planDigest || plan.disclosure.planId !== record.planId) {
        return result('run', 'configuration-failure', { reasonCode: 'sentinel.service.planChanged', facts: { planId: record.planId } });
      }
      const scratch = join(work, 'attempts');
      mkdirSync(scratch, { mode: 0o700 });
      const coordinator = await Coordinator.open({ store, plan: plan.boundary, scratchRoot: scratch, registry: PREVIEW_ADAPTERS });
      summary = await coordinator.run();
    } finally { removeScratch(work); }
    const findings = await previewFindings(store, record.planId);
    const facts = { runId: summary.runId, state: summary.state, runOutcome: summary.outcome ?? null, published: summary.published,
      failures: summary.failures.length, previewFindings: findings?.findings.length ?? null, label: 'foundation-preview' };
    const verdicts = printed(decided.record);
    if (summary.state !== 'completed') return result('run', 'configuration-failure', { verdicts, facts, reasonCode: 'sentinel.service.runNotCompleted' });
    // A run another process completed: the ledger records no outcome yet (PR 08), so it is read from the units.
    const outcome = summary.outcome ?? (summary.units.every(u => u.state === 'published') ? 'complete-coverage' : 'execution-failure');
    if (outcome !== 'complete-coverage') return result('run', 'configuration-failure', { verdicts, facts, reasonCode: 'sentinel.service.executionFailed' });
    return result('run', 'required-coverage-incomplete', { verdicts, facts, reasonCode: 'sentinel.service.previewNotCoverage' });
  });
}

// ---- the owner's confirmation, carried to the background service ----

/**
 * Confirms one write on a plan's run for the background service, as the owner, in this process: the action is
 * admitted here (three verdicts, the owner as requester), then, only with `confirm`, a receipt bound to exactly that
 * action, this plan's digest and the adopted policy revision is issued and not spent. The service spends it once; a
 * connection without one is an agent and gets what the adopted grants give agents, nothing implicit.
 */
export function confirmForService(ws: Workspace, options: { command: string; action: 'run.start' | 'run.pause' | 'run.cancel'; planId: string; confirm: boolean; now: Date }):
  { receiptId: string; verdicts: PrintedVerdicts } | { result: CommandResult } {
  const record = readPlanRecord(ws, options.planId);
  if (!record) return { result: result(options.command, 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts: { planId: options.planId } }) };
  const adopted = adoptedPolicy(ws);
  if ('refusal' in adopted) return { result: adopted.refusal };
  const { policy } = adopted;
  if (policy.revision !== record.policyRevision) {
    return { result: result(options.command, 'configuration-failure', { reasonCode: 'sentinel.service.policyChanged', facts: { planId: record.planId } }) };
  }
  const intent = intentOf(options.action, record.planDigest, ['local-artifacts']);
  const decision = admit({
    intent, requestedBy: OWNER as { principal: 'human'; channel: 'owner-cli' }, policy, stateDigest: record.planDigest, now: options.now,
    capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
    credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
  }).record;
  const verdicts = printed(decision);
  const facts = { planId: record.planId, action: intent.action, intentDigest: decision.intentDigest };
  if (decision.outcome === 'denied') {
    const v = decision.verdicts;
    return { result: result(options.command, 'configuration-failure', { verdicts, facts,
      reasonCode: v.policy.allowed ? (v.capability.allowed ? v.credential.reasonCode : v.capability.reasonCode) : v.policy.reasonCode }) };
  }
  if (!options.confirm) return { result: result(options.command, 'awaiting-confirmation', { verdicts, facts, reasonCode: 'sentinel.service.needsOwnerConfirm' }) };
  assertMayConfirm(OWNER);
  const receipt = issueReceipt(receiptBook(ws), OWNER, { intent, stateDigest: record.planDigest, policyRevision: policy.revision }, { now: options.now, ttlMs: RECEIPT_TTL_MS });
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
  const pack = validatePack(readPackDirectory(options.packDir));
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

/**
 * A run's result from the ledger and its stored artifacts alone, as `wait` and a repeated start print it: a
 * completed preview is required coverage incomplete (exit 2), a completed run without its findings an execution
 * failure, a canceled or paused run not completed. A run still under way is `submitted`; `executing` says whether
 * something is running it, so a run whose service stopped reads as interrupted, never as still running.
 */
export async function runResultIn(store: SentinelStore, command: string, planId: string, options: { executing: boolean; verdicts?: PrintedVerdicts; facts?: Record<string, unknown> }): Promise<CommandResult> {
  const state = runStateIn(store, planId);
  const base = { ...(options.verdicts ? { verdicts: options.verdicts } : {}) };
  if (state === null) return result(command, 'configuration-failure', { ...base, reasonCode: 'sentinel.service.runUnknown', facts: { runId: planId } });
  const findings = state === 'completed' ? await previewFindings(store, planId) : undefined;
  const facts = { ...(options.facts ?? {}), runId: planId, state, previewFindings: findings?.findings.length ?? null, label: 'foundation-preview' };
  if (state === 'completed') {
    return findings
      ? result(command, 'required-coverage-incomplete', { ...base, facts, reasonCode: 'sentinel.service.previewNotCoverage' })
      : result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.executionFailed' });
  }
  if (state === 'canceled' || (state === 'paused' && !options.executing)) {
    return result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.runNotCompleted' });
  }
  if (!options.executing) return result(command, 'configuration-failure', { ...base, facts, reasonCode: 'sentinel.service.runInterrupted' });
  return result(command, 'submitted', { ...base, facts });
}

export async function previewFindings(store: SentinelStore, planId: string): Promise<{ findings: unknown[]; checkedFiles: number } | undefined> {
  const pub = store.ledger.getPublication({ id: `work-${planId}`, revision: 1 });
  if (!pub) return undefined;
  for (const o of pub.outputs) {
    try {
      const v = JSON.parse((await store.readArtifact(o.id)).toString('utf8'));
      if (v?.schema === PREVIEW_FINDINGS_SCHEMA) return v;
    } catch { /* another output */ }
  }
  return undefined;
}

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
  const record = readPlanRecord(ws, options.runId);
  if (!record) return result('report', 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts: { runId: options.runId } });
  {
    const findings = await previewFindings(store, record.planId);
    if (!findings) return result('report', 'configuration-failure', { reasonCode: 'sentinel.service.runNotCompleted', facts: { runId: options.runId } });
    const opened = await openSnapshot(store, record.snapshotId);
    const unknown = opened.snapshot.entries.filter(e => e.kind === 'directory-boundary').length;
    const recheck = { cli: `farsight-sentinel report ${record.planId} --json` };
    const doc: PreviewReport = {
      schema: PREVIEW_REPORT_SCHEMA, label: 'foundation-preview', runId: record.planId, snapshotId: record.snapshotId,
      // Pinned to the run's own last committed event, so regenerating later reads the same facts at the same point.
      ledgerSequence: lastRunSequence(store, record.planId), generatedAt: options.now.toISOString(),
      counts: [
        { n: findings.findings.length, unit: 'sentinel.count.findings', scope: 'sentinel.scope.report', source: 'the foundation-preview detector', recheck },
        { n: unknown, unit: 'sentinel.count.unknownBoundaries', scope: 'sentinel.scope.inventory', source: 'the snapshot inventory', recheck },
      ],
      limitations: [...PREVIEW_LIMITATIONS],
    };
    return checkPreviewReport(doc);
  }
}

export { PolicyError };
