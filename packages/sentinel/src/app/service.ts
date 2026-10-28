// The Sentinel service facade: one set of operations — plan, scan, rerun, status, report, scans, a stage read and the
// start preview — that the command line, the owner service's socket and the viewer's transport call, each with a
// principal (app/principal.ts). Three implementations answer them:
//
// - LocalSentinelService: the owner's own process, with no service running. It opens the workspace's store for each
//   call and closes it after; the owner principal confirms here, which issues the owner's receipts in this process.
// - RemoteSentinelService: the owner's own process while the service holds the store. Reads go to the service; a
//   write the owner confirms is decided here first and carried to the service as the owner's receipts (for a start:
//   the composite start receipt and one per model envelope), which the service spends once.
// - HeldSentinelService: inside the owner service, over the store it holds, for its connections. Every caller is an
//   agent; it confirms nothing and spends only the owner's receipts it is handed. It never issues an owner receipt.
//
// `scan` is plan, then start: without --confirm it previews what it would do (the owner's setup still pending, each
// stage, where it runs and what it does, every model it calls with its budget) and waits; with it, the one confirmation
// covers that setup (each step with its own receipt), the capture, the plan's stages and each model binding (ADR 48 as
// amended).
import type { SentinelStore } from '../store/index.js';
import { openStore } from '../store/index.js';
import { result, type CommandResult } from './outcome.js';
import type { RequestedBy } from './actor.js';
import { loadPlan } from '../execution/plans.js';
import { expandStageTokens, unitsToRun } from '../execution/selection.js';
import type { PreviewReport } from '../reports/preview.js';
import type { ScannerReport } from '../reports/scanner.js';
import { loadPipeline, promotedPacks, type WorkspacePipeline } from './pipeline-adoption.js';
import { profilePipeline, PROFILES, PROFILE_PACKS } from './pipeline-profiles.js';
import { builtinPackDir } from '../service/package-paths.js';
import { effectivePolicy, loadPolicyInputs, parseSettings, SETTINGS_PATH } from '../policy/index.js';
import { canonicalDigest } from '../policy/digest.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readCheckoutFile } from '../policy/user-state.js';
import { MAX_SETTINGS_BYTES } from '../policy/settings.js';
import { join } from 'node:path';
import { checkPipeline, previewPipeline, type PipelineProblem } from './pipeline.js';
import { stageModel } from '../planner/pipeline.js';
import { readPackDirectory, validatePack } from '../rules/index.js';
import type { PipelineDefinition, SettingsEnvelope } from '../contracts/index.js';
import { isOwner, principalOf, type Principal } from './principal.js';
import {
  adoptedPolicy,
  adoptWorkspaceSettings,
  confirmForService,
  pipelineBytesOf,
  promoteRulePack,
  confirmPlanForService,
  heldWordsOf,
  pipelinePathOf,
  pipelineEnvironment,
  followWorkspaceRun,
  planWorkspace,
  planWorkspaceHeld,
  previewReport,
  reportIn,
  runPlan,
  runStatus,
  statusIn,
  type Workspace,
} from '../service/local.js';
import { currentPlan, type CurrentPlan } from '../service/canonical.js';
import type { CanonicalDisclosure } from '../service/canonical.js';

/** A retained scan, newest first: its run, its state, its current plan revision and when it was created. */
export interface ScanRow {
  readonly id: string;
  readonly state: string;
  readonly planRevision: number;
  readonly createdAt: string;
}

export type PlanAnswer = CommandResult & { disclosure?: CanonicalDisclosure };
export type ReportAnswer = PreviewReport | ScannerReport | CommandResult;

/** The facade. Every method takes the caller's principal; none reads one from a request. */
export interface SentinelService {
  /** What a scan would capture and run, and every model it would call: reads only, issues nothing. */
  scanPreview(by: Principal, o: { now: Date }): Promise<CommandResult>;
  /** Plan, then start: the preview without `confirm`; with it (the owner only), one confirmation covers both. */
  scan(by: Principal, o: { confirm: boolean; now: Date }): Promise<CommandResult>;
  plan(by: Principal, o: { confirm: boolean; receiptId?: string; now: Date }): Promise<PlanAnswer>;
  /** The composite a start of this run confirms: the plan digest, its stages, each model binding and its envelopes. */
  startPreview(by: Principal, o: { runId?: string; now: Date }): Promise<CommandResult>;
  rerun(
    by: Principal,
    o: { mode: 'retry' | 'rerun'; runId: string; stages: readonly string[]; confirm: boolean; now: Date },
  ): Promise<CommandResult>;
  status(by: Principal, o: { runId?: string; after?: number; limit?: number }): Promise<CommandResult>;
  report(by: Principal, o: { runId?: string; now: Date }): Promise<ReportAnswer>;
  scans(by: Principal, o: { limit?: number }): Promise<CommandResult>;
  stage(by: Principal, o: { runId?: string; stageId: string }): Promise<CommandResult>;
}

// ---- reads over a held store, shared by every implementation ----

/** The newest retained scans, at most `limit` (1 to 128, default 20). */
export function scansIn(store: SentinelStore, limit = 20): CommandResult {
  const rows: ScanRow[] = store.ledger
    .listRuns(Math.min(Math.max(1, limit), 128))
    .map((r) => Object.freeze({ id: r.id, state: r.state, planRevision: r.planRevision, createdAt: r.createdAt }));
  return result('scans', 'answered', { facts: { scans: rows } });
}

/** The newest retained scan's run id, or undefined when the store holds none. */
export const latestRunIn = (store: SentinelStore): string | undefined => store.ledger.listRuns(1)[0]?.id;

/** A run id the caller named, or the newest scan's; a refusal when there is none. */
function runIdOr(store: SentinelStore, command: string, runId?: string): string | CommandResult {
  if (runId !== undefined) return runId;
  const latest = latestRunIn(store);
  return latest ?? result(command, 'configuration-failure', { reasonCode: 'sentinel.service.noScans' });
}

/**
 * One stage of a run's current revision: each of its units, where it stands in the ledger, and why a held one is held.
 * A stage the revision does not plan is refused, with the stages it does.
 */
export async function stageIn(store: SentinelStore, runId: string, stageId: string): Promise<CommandResult> {
  const plan = await currentPlan(store, runId);
  if (!plan)
    return result('stage', 'configuration-failure', { reasonCode: 'sentinel.service.runUnknown', facts: { runId } });
  const admitted = await loadPlan(store, runId, plan.revision);
  const runs = admitted.selection ? unitsToRun(admitted.selection) : null;
  // A declared stage id, as the recorded pipeline names it (rerun --stage reads it the same way), or one unit's id.
  let expanded: ReturnType<typeof expandStageTokens>;
  try {
    expanded = expandStageTokens(admitted, [stageId]);
  } catch {
    expanded = { units: [], stages: null, empty: [], unknown: [stageId] };
  }
  if (expanded.unknown.length)
    return result('stage', 'configuration-failure', {
      reasonCode: 'sentinel.service.stageUnknown',
      facts: { runId, unknown: [...expanded.unknown], stages: [...(plan.stages ?? [])] },
    });
  const ids = new Set(expanded.units);
  const units = admitted.plan.units.filter((u) => ids.has(u.id));
  const words = heldWordsOf(admitted);
  return result('stage', 'answered', {
    facts: {
      runId,
      revision: plan.revision,
      stage: stageId,
      downstream: (expanded.stages?.downstream ?? []).map((d) => d.stage),
      units: units.map((u) => {
        const work = store.ledger.getWork({ id: u.id, revision: u.revision });
        const named = words(u.id);
        const published = store.ledger.getPublication({ id: u.id, revision: u.revision }) !== null;
        return Object.freeze({
          id: u.id,
          adapterId: u.adapterId,
          state: runs && !runs.has(u.id) ? 'held-by-selection' : (work?.state ?? 'not-created'),
          published,
          attempts: work ? store.ledger.countAttempts({ id: u.id, revision: u.revision }) : 0,
          ...(work?.reason
            ? {
                reasonCode: work.reason,
                // What the reason is about, for its words: the model a review asked for, or the check's adapter.
                detail: u.review
                  ? `${u.review.selection.providerId} ${u.review.selection.modelId}`
                  : String(u.adapterId ?? u.stage),
                ...named,
              }
            : {}),
        });
      }),
    },
  });
}

/**
 * The owner's setup a first scan still needs, in the order `scan --confirm` performs it: adopting the settings and
 * the pipeline (when either is not adopted, or changed since), then promoting each rule pack the workspace's profile
 * uses that the owner's rule lock does not hold yet. Each step keeps its own receipt for exactly its bytes; the scan's
 * one confirmation covers what the preview listed and nothing else. Reads only.
 */
export interface SetupStep {
  readonly kind: 'adopt' | 'promote';
  readonly detail: Readonly<Record<string, unknown>>;
}
export function ownerSetupOf(ws: Workspace, now: Date): readonly SetupStep[] {
  const steps: SetupStep[] = [];
  const settings = loadPolicyInputs({ workspace: ws.path, trustDir: ws.trustDir }).trust;
  const loaded = loadPipeline({ workspace: ws.path, trustDir: ws.trustDir, resolve: promotedPacks(ws.trustDir) });
  const pipelinePending = loaded.trust === 'not-adopted' || loaded.trust === 'changed';
  if (settings !== 'adopted' || pipelinePending) {
    const shown = adoptWorkspaceSettings(ws, { confirm: false, now });
    steps.push({
      kind: 'adopt',
      detail: {
        settingsDigest: shown.facts.settingsDigest,
        ...(shown.facts.pipeline ? { pipeline: shown.facts.pipeline } : {}),
      },
    });
  }
  for (const pack of profilePacksOf(loaded.read)) {
    const dir = builtinPackDir(pack);
    if (!dir) continue;
    // Before the settings are adopted the promotion cannot be decided yet; it is listed unless the lock holds it.
    const shown = promoteRulePack(ws, { packDir: realpathSync.native(dir), confirm: false, now });
    if (shown.outcome !== 'kept')
      steps.push({ kind: 'promote', detail: { pack, candidate: shown.facts.candidate, packId: shown.facts.packId } });
  }
  return Object.freeze(steps);
}

/** The rule packs the profile whose pipeline these exact bytes are uses (cli/init.ts PROFILE_PACKS); none otherwise. */
function profilePacksOf(read: WorkspacePipeline | undefined): readonly string[] {
  if (!read || read.packs.length) return [];
  for (const profile of PROFILES)
    if (read.fileDigest === sha256(pipelineBytesOf(profilePipeline(profile)))) return PROFILE_PACKS[profile];
  return [];
}
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** Performs the setup steps, as the owner, in order; the first that does not succeed is returned and nothing after. */
function runOwnerSetup(ws: Workspace, now: Date): CommandResult | undefined {
  const steps = ownerSetupOf(ws, now);
  if (steps.some((x) => x.kind === 'adopt')) {
    const r = adoptWorkspaceSettings(ws, { confirm: true, now });
    if (r.outcome !== 'prepared' && r.outcome !== 'kept') return { ...r, command: 'scan' };
  }
  // Each pack the preview listed, now that the settings are adopted; one the lock already holds is kept.
  for (const step of steps.filter((x) => x.kind === 'promote')) {
    const r = promoteRulePack(ws, {
      packDir: realpathSync.native(builtinPackDir(String(step.detail.pack))!),
      confirm: true,
      now,
    });
    if (r.outcome !== 'prepared' && r.outcome !== 'kept') return { ...r, command: 'scan' };
  }
  return undefined;
}

/**
 * What a scan would do, read from the workspace's settings and pipeline alone (the adopted ones, or the files the
 * setup would adopt): the setup it still needs, its stages in order with where each runs and what it does, and every
 * model the settings bind with its runner and budget. Nothing is captured, adopted or issued.
 */
export function scanPreviewOf(ws: Workspace, by: Principal, now: Date = new Date()): CommandResult {
  let setup: readonly SetupStep[];
  try {
    setup = ownerSetupOf(ws, now);
  } catch (e) {
    // Settings or a pipeline the setup could not adopt as they read now: refused with the reason adoption gives.
    const code = (e as { code?: unknown }).code;
    if (typeof code !== 'string' || !code.startsWith('sentinel.')) throw e;
    return result('scan', 'configuration-failure', { reasonCode: code });
  }
  const adopted = adoptedPolicy(ws);
  // The settings the scan runs under: the adopted ones, or (before the setup adopts them) the file as it reads now,
  // shown only, never decided on. A file that does not read is refused as adoption would refuse it.
  let settings: import('../contracts/index.js').SettingsEnvelope;
  if ('policy' in adopted) settings = adopted.policy.settings;
  else
    try {
      const bytes = readCheckoutFile(
        join(ws.path, SETTINGS_PATH),
        MAX_SETTINGS_BYTES,
        'sentinel.policy.settingsUnreadable',
      );
      if (!bytes) return { ...adopted.refusal, command: 'scan' };
      settings = parseSettings(bytes);
    } catch {
      return { ...adopted.refusal, command: 'scan' };
    }
  // A pipeline file the setup cannot adopt: the scan cannot run it, so the preview says why and offers nothing.
  const refusedPipeline = setup.find((x) => x.kind === 'adopt')?.detail.pipeline as
    { adopted?: boolean; reasonCode?: string; detail?: string } | undefined;
  if (refusedPipeline?.adopted === false && refusedPipeline.reasonCode)
    return result('scan', 'configuration-failure', {
      reasonCode: refusedPipeline.reasonCode,
      facts: { setup: setup.map((x) => ({ kind: x.kind, ...x.detail })), detail: refusedPipeline.detail ?? '' },
    });
  const loaded = loadPipeline({ workspace: ws.path, trustDir: ws.trustDir, resolve: promotedPacks(ws.trustDir) });
  const pipeline = loaded.read?.pipeline;
  const path = loaded.read ? pipelinePathOf(loaded.read) : null;
  // Every problem with the pipeline under these settings, as plan will see it once the setup is done: the rule packs
  // the setup promotes count as promoted. A refused one means plan stops, so the scan is refused here.
  // The rules planning would select under these settings: the adopted policy's (the owner's mandatory rules and what
  // the repository requests), or, for settings the setup adopts first, the same merge over the file as it reads now.
  const rules = new Set('policy' in adopted ? adopted.policy.rules : effectiveRulesOf(ws, settings));
  const problems = pipeline ? previewProblems(ws, pipeline, settings, rules, setup) : [];
  const refused = problems.find((x) => x.class === 'refused');
  const stages = pipeline
    ? previewPipeline(pipeline, pipeline).stages.map((s) => ({
        id: s.id,
        kind: s.kind,
        order: s.order,
        where: s.where,
        effects: [...s.effects],
      }))
    : null;
  const models = path?.kind === 'declared' ? declaredModels(pipeline!, settings) : configuredModels(settings);
  const effects = [...new Set(stages ? stages.flatMap((s) => s.effects) : ['local-artifacts'])].sort();
  return result('scan', refused ? 'configuration-failure' : 'awaiting-confirmation', {
    reasonCode: refused ? refused.code : 'sentinel.service.scanWaits',
    facts: {
      setup: setup.map((x) => ({ kind: x.kind, ...x.detail })),
      pipeline: pipeline
        ? {
            id: pipeline.id,
            revision: pipeline.revision,
            digest: loaded.read!.digest,
            trust: loaded.trust,
            // A profile's own pipeline plans as the default for the settings (service/local.ts pipelinePathOf).
            path: path!,
            // Each problem as plan will see it under these settings (refused: the scan is refused above).
            problems,
          }
        : null,
      stages,
      effects,
      models,
      // An agent sees what would run; only the owner's command line can confirm it (and nothing, when it is refused).
      ...(refused ? {} : isOwner(by) ? { confirmWith: 'scan --confirm' } : { ownerOnly: true }),
    },
  });
}

/** A model the scan calls: the stage, the runner and model, and the provider binding with its budget (null: none). */
interface PreviewModel {
  readonly stage: string;
  /** The review the stage plans (a declared agent stage: `general` or `guided`); absent for a settings stage. */
  readonly review?: string;
  readonly segmentId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly runner: string | null;
  readonly model: string | null;
  readonly budget: unknown;
  /** What the pipeline declares when the binding that runs names another runner or model. */
  readonly declared?: { readonly runner: string; readonly model: string };
}

/**
 * Every binding the plan can use for review, exactly as review/plan.ts resolves one (a segment's own selection, else
 * its stage's): each stage-wide selection and each segment selection, with its runner (the provider's kind), the
 * model as the provider spells it and the provider's budget. What confirming the scan confirms.
 */
function configuredModels(settings: Readonly<SettingsEnvelope>): PreviewModel[] {
  const configured = settings.reviewModels;
  return [
    ...(configured?.stages ?? []).map((x) => ({ ...x, segmentId: null as string | null })),
    ...(configured?.segments ?? []).map((x) => ({ ...x, segmentId: x.segmentId as string | null })),
  ].map((x) => boundModel(settings, x.stage, x.segmentId, x.providerId, x.modelId));
}

function boundModel(
  settings: Readonly<SettingsEnvelope>,
  stage: string,
  segmentId: string | null,
  providerId: string,
  modelId: string,
): PreviewModel {
  const provider = settings.providers.find((p) => p.id === providerId);
  const model = provider?.models?.find((m) => m.id === modelId);
  return {
    stage,
    segmentId,
    providerId,
    modelId,
    runner: provider?.kind ?? null,
    model: model?.model ?? null,
    budget: provider?.budget ?? null,
  };
}

/**
 * The models a declared pipeline's agent stages call: each stage by its own id, the review it plans (its fan-out), and
 * the settings' binding for that review (its stage-wide selection and each segment selection), which is what runs. A
 * stage no binding serves is listed with its declared runner and model and no provider; one whose binding names another
 * runner or model says what it declared.
 */
function declaredModels(pipeline: PipelineDefinition, settings: Readonly<SettingsEnvelope>): PreviewModel[] {
  let roles: ReturnType<typeof stageModel>['roles'];
  try {
    roles = stageModel(pipeline).roles;
  } catch {
    return configuredModels(settings);
  }
  const out: PreviewModel[] = [];
  for (const s of pipeline.stages) {
    const role = roles.get(s.id);
    if (s.kind !== 'agent' || role?.role !== 'agent' || role.review === null) continue;
    const review = role.review;
    const bound = [
      ...(settings.reviewModels?.stages ?? [])
        .filter((x) => x.stage === review)
        .map((x) => ({ ...x, segmentId: null as string | null })),
      ...(settings.reviewModels?.segments ?? [])
        .filter((x) => x.stage === review)
        .map((x) => ({ ...x, segmentId: x.segmentId as string | null })),
    ];
    if (!bound.length)
      out.push({
        stage: s.id,
        review,
        segmentId: null,
        providerId: null,
        modelId: null,
        runner: s.runner,
        model: s.model,
        budget: null,
      });
    for (const b of bound) {
      const m = boundModel(settings, s.id, b.segmentId, b.providerId, b.modelId);
      const provider = settings.providers.find((p) => p.id === b.providerId);
      const differs = runnerServing(provider) !== s.runner || m.model !== s.model;
      out.push({ ...m, review, ...(differs ? { declared: { runner: s.runner, model: s.model } } : {}) });
    }
  }
  return out;
}

/**
 * The pipeline runner an adopted provider serves (app/pipeline.ts runnerConfigured reads the same): a CLI kind its own
 * runner, an Ollama provider that keeps the source here the local model server, any other HTTP provider the hosted
 * APIs.
 */
function runnerServing(p: Readonly<SettingsEnvelope>['providers'][number] | undefined): string | null {
  if (!p) return null;
  if (p.kind === 'claude-cli' || p.kind === 'copilot-cli') return p.kind;
  return p.kind === 'ollama' && p.disclosure === 'local-only' ? 'ollama' : 'hosted-api';
}

/**
 * The rule families the effective policy would select for these settings once adopted: the owner's mandatory rules
 * and the repository's requested ones, less what it disables (policy/settings.ts effectivePolicy, the one merge). A
 * repository file that does not read leaves the owner's rules alone.
 */
function effectiveRulesOf(ws: Workspace, settings: Readonly<SettingsEnvelope>): readonly string[] {
  try {
    const inputs = loadPolicyInputs({ workspace: ws.path, trustDir: ws.trustDir });
    return effectivePolicy({
      trust: 'adopted',
      settings: settings as SettingsEnvelope,
      settingsDigest: canonicalDigest(settings),
      repoConfig: inputs.repoConfig,
      repoConfigDigest: inputs.repoConfigDigest,
    }).rules;
  } catch {
    return settings.mandatoryRules;
  }
}

/** The pipeline's problems under these settings once the setup is done: the packs it promotes count as locked. */
function previewProblems(
  ws: Workspace,
  pipeline: PipelineDefinition,
  settings: Readonly<SettingsEnvelope>,
  rules: ReadonlySet<string>,
  setup: readonly SetupStep[],
): readonly PipelineProblem[] {
  const env = pipelineEnvironment(ws, null);
  const locked = new Map(env.locked ?? []);
  for (const step of setup) {
    if (step.kind !== 'promote') continue;
    const dir = builtinPackDir(String(step.detail.pack));
    if (!dir) continue;
    for (const r of validatePack(readPackDirectory(realpathSync.native(dir))).manifest.rules)
      locked.set(r.familyId, r.implementation.adapterId);
  }
  return checkPipeline(pipeline, { ...env, settings, locked, rules });
}

/** The composite a start confirms, read from the run's current revision (no receipt is issued). */
function startPreviewOf(
  ws: Workspace,
  plan: CurrentPlan | undefined,
  runId: string,
  now: Date,
  storeId?: string,
): CommandResult {
  const shown = confirmForService(ws, {
    command: 'start',
    action: 'run.start',
    plan,
    planId: runId,
    confirm: false,
    now,
    ...(storeId ? { storeId } : {}),
  });
  return 'result' in shown ? { ...shown.result, command: 'start' } : result('start', 'refused');
}

const ownerOnly = (command: string) =>
  result(command, 'configuration-failure', { reasonCode: 'sentinel.admission.ownerOnly' });

async function withStore<T>(ws: Workspace, body: (store: SentinelStore) => Promise<T>): Promise<T> {
  const store = await openStore(ws.storePath);
  try {
    return await body(store);
  } finally {
    store.close();
  }
}

/** Combines a plan and the start that followed it into one scan result: the start decides the outcome. */
function scanResult(plan: PlanAnswer, start: CommandResult): CommandResult {
  return result('scan', start.outcome, {
    verdicts: start.verdicts,
    facts: {
      ...start.facts,
      planId: plan.disclosure?.planId ?? plan.facts.planId,
      planDigest: plan.disclosure?.planDigest ?? plan.facts.planDigest,
      plan: plan.outcome,
    },
    ...(start.reasonCode ? { reasonCode: start.reasonCode } : {}),
  });
}

// ---- in the owner's process, with no service running ----

export class LocalSentinelService implements SentinelService {
  constructor(readonly ws: Workspace) {}

  async scanPreview(by: Principal, o: { now: Date }): Promise<CommandResult> {
    return scanPreviewOf(this.ws, principalOf(by), o.now);
  }

  async scan(by: Principal, o: { confirm: boolean; now: Date }): Promise<CommandResult> {
    const who = principalOf(by);
    if (!o.confirm) return scanPreviewOf(this.ws, who, o.now);
    if (!isOwner(who)) return ownerOnly('scan');
    const setup = runOwnerSetup(this.ws, o.now);
    if (setup) return setup;
    const plan = await planWorkspace(this.ws, { confirm: true, now: o.now });
    if (!plan.disclosure) return { ...plan, command: 'scan' };
    // The preview named every model with its budget: the same confirmation covers them (run --confirm-models).
    const run = await runPlan(this.ws, {
      planId: plan.disclosure.planId,
      confirm: true,
      confirmModels: true,
      now: o.now,
    });
    return scanResult(plan, run);
  }

  async plan(by: Principal, o: { confirm: boolean; now: Date }): Promise<PlanAnswer> {
    if (!isOwner(principalOf(by))) return ownerOnly('plan');
    return planWorkspace(this.ws, { confirm: o.confirm, now: o.now });
  }

  async startPreview(by: Principal, o: { runId?: string; now: Date }): Promise<CommandResult> {
    principalOf(by);
    return withStore(this.ws, async (store) => {
      const runId = runIdOr(store, 'start', o.runId);
      if (typeof runId !== 'string') return runId;
      // Bound to this store, as the service shows it: the same composite whichever side answers.
      return startPreviewOf(this.ws, await currentPlan(store, runId), runId, o.now, store.storeId);
    });
  }

  async rerun(
    by: Principal,
    o: { mode: 'retry' | 'rerun'; runId: string; stages: readonly string[]; confirm: boolean; now: Date },
  ): Promise<CommandResult> {
    if (!isOwner(principalOf(by))) return ownerOnly(o.mode);
    return followWorkspaceRun(this.ws, { ...o, stages: [...o.stages] });
  }

  async status(by: Principal, o: { runId?: string; after?: number; limit?: number }): Promise<CommandResult> {
    principalOf(by);
    const runId = o.runId ?? (await withStore(this.ws, async (store) => latestRunIn(store)));
    if (!runId) return result('status', 'configuration-failure', { reasonCode: 'sentinel.service.noScans' });
    return runStatus(this.ws, { ...o, runId });
  }

  async report(by: Principal, o: { runId?: string; now: Date }): Promise<ReportAnswer> {
    principalOf(by);
    const runId = o.runId ?? (await withStore(this.ws, async (store) => latestRunIn(store)));
    if (!runId) return result('report', 'configuration-failure', { reasonCode: 'sentinel.service.noScans' });
    return previewReport(this.ws, { runId, now: o.now });
  }

  async scans(by: Principal, o: { limit?: number }): Promise<CommandResult> {
    principalOf(by);
    return withStore(this.ws, async (store) => scansIn(store, o.limit));
  }

  async stage(by: Principal, o: { runId?: string; stageId: string }): Promise<CommandResult> {
    principalOf(by);
    return withStore(this.ws, async (store) => {
      const runId = runIdOr(store, 'stage', o.runId);
      return typeof runId === 'string' ? stageIn(store, runId, o.stageId) : runId;
    });
  }
}

// ---- in the owner's process, while the service holds the store ----

/** One connection to the owner service, as the transport (transport/ipc.ts ServiceClient) gives it. */
export interface ServiceConnection {
  readonly storeId: string;
  request(op: string, body: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  close(): void;
}

/** Opens one connection per call; the run continues whatever happens to this process. */
export type Connect = () => Promise<ServiceConnection | undefined>;

export class RemoteSentinelService implements SentinelService {
  constructor(
    readonly ws: Workspace,
    readonly connect: Connect,
  ) {}

  async #ask(op: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const client = await this.connect();
    if (!client) return result(op, 'configuration-failure', { reasonCode: 'sentinel.service.notRunning' });
    try {
      return await client.request(op, body, timeoutMs === undefined ? {} : { timeoutMs });
    } finally {
      client.close();
    }
  }

  async #storeId(): Promise<string | undefined> {
    const client = await this.connect();
    if (!client) return undefined;
    client.close();
    return client.storeId;
  }

  async scanPreview(by: Principal, o: { now: Date }): Promise<CommandResult> {
    return scanPreviewOf(this.ws, principalOf(by), o.now);
  }

  async scan(by: Principal, o: { confirm: boolean; now: Date }): Promise<CommandResult> {
    const who = principalOf(by);
    if (!o.confirm) return scanPreviewOf(this.ws, who, o.now);
    if (!isOwner(who)) return ownerOnly('scan');
    // The setup is the owner's own state (the trust folder): performed here, never by the service.
    const setup = runOwnerSetup(this.ws, o.now);
    if (setup) return setup;
    const plan = await this.plan(who, { confirm: true, now: o.now });
    if (!plan.disclosure && !plan.facts.planId) return { ...plan, command: 'scan' };
    const planId = String(plan.disclosure?.planId ?? plan.facts.planId);
    const start = await this.start(who, { planId, confirm: true, models: true, now: o.now });
    return scanResult(plan, start);
  }

  async plan(by: Principal, o: { confirm: boolean; now: Date }): Promise<PlanAnswer> {
    if (!isOwner(principalOf(by))) return ownerOnly('plan');
    const storeId = await this.#storeId();
    if (!storeId) return result('plan', 'configuration-failure', { reasonCode: 'sentinel.service.notRunning' });
    const shown = confirmPlanForService(this.ws, { storeId, confirm: o.confirm, now: o.now });
    if ('result' in shown) return shown.result;
    return (await this.#ask('plan', { receiptId: shown.receiptId })) as PlanAnswer;
  }

  /**
   * A start through the service: the run's current revision read from the service, the owner's composite confirmed
   * here against it (with `models`, every model envelope too), then the receipts handed to the service to spend.
   */
  async start(
    by: Principal,
    o: { planId: string; confirm: boolean; models: boolean; now: Date },
  ): Promise<CommandResult> {
    if (!isOwner(principalOf(by))) return ownerOnly('run');
    const client = await this.connect();
    if (!client) return result('run', 'configuration-failure', { reasonCode: 'sentinel.service.startFailed' });
    try {
      const plan = ((await client.request('run.describe', { runId: o.planId })) as CurrentPlan | null) ?? undefined;
      const confirmed = confirmForService(this.ws, {
        command: 'run',
        action: 'run.start',
        plan,
        planId: o.planId,
        confirm: o.confirm,
        now: o.now,
        storeId: client.storeId,
        models: o.models,
      });
      if ('result' in confirmed) return confirmed.result;
      return (await client.request('run.start', {
        planId: o.planId,
        receiptId: confirmed.receiptId,
        ...(confirmed.envelopeReceipts.length ? { envelopeReceipts: [...confirmed.envelopeReceipts] } : {}),
      })) as CommandResult;
    } finally {
      client.close();
    }
  }

  async startPreview(by: Principal, o: { runId?: string; now: Date }): Promise<CommandResult> {
    principalOf(by);
    return (await this.#ask('start.preview', o.runId ? { runId: o.runId } : {})) as CommandResult;
  }

  async rerun(
    by: Principal,
    o: { mode: 'retry' | 'rerun'; runId: string; stages: readonly string[]; confirm: boolean; now: Date },
  ): Promise<CommandResult> {
    principalOf(by);
    // A rerun captures nothing new but plans a new run in the store: while the service holds it, nothing is planned
    // from here (a follow-up carries it through the service).
    return result(o.mode, 'configuration-failure', { reasonCode: 'sentinel.service.ownerServiceRunning' });
  }

  async status(by: Principal, o: { runId?: string; after?: number; limit?: number }): Promise<CommandResult> {
    principalOf(by);
    return (await this.#ask('run.status', {
      ...(o.runId ? { runId: o.runId } : {}),
      ...(o.after === undefined ? {} : { after: o.after }),
      ...(o.limit === undefined ? {} : { limit: o.limit }),
    })) as CommandResult;
  }

  async report(by: Principal, o: { runId?: string; now: Date }): Promise<ReportAnswer> {
    principalOf(by);
    return (await this.#ask('report', o.runId ? { runId: o.runId } : {})) as ReportAnswer;
  }

  async scans(by: Principal, o: { limit?: number }): Promise<CommandResult> {
    principalOf(by);
    return (await this.#ask('scans', o.limit === undefined ? {} : { limit: o.limit })) as CommandResult;
  }

  async stage(by: Principal, o: { runId?: string; stageId: string }): Promise<CommandResult> {
    principalOf(by);
    return (await this.#ask('stage.read', {
      stageId: o.stageId,
      ...(o.runId ? { runId: o.runId } : {}),
    })) as CommandResult;
  }
}

// ---- inside the owner service, over the store it holds ----

/** What the owner service lends the facade: whether it executes a run now, and its trusted registry, built lazily. */
export interface HeldHooks {
  readonly executing: (runId: string) => boolean;
  readonly registry: () => import('../execution/registry.js').AdapterRegistry;
}

export class HeldSentinelService implements SentinelService {
  constructor(
    readonly store: SentinelStore,
    readonly ws: Workspace,
    readonly hooks: HeldHooks,
  ) {}

  /** Every caller here is a connection: an agent. An owner principal never reaches a held store's facade. */
  #agent(by: Principal): RequestedBy | undefined {
    const who = principalOf(by);
    return isOwner(who) ? undefined : who.requestedBy;
  }

  async scanPreview(by: Principal, o: { now: Date }): Promise<CommandResult> {
    return scanPreviewOf(this.ws, principalOf(by), o.now);
  }

  async scan(by: Principal, o: { confirm: boolean; now: Date }): Promise<CommandResult> {
    const who = principalOf(by);
    // A connection confirms nothing: the owner's own command line plans and starts with its receipts.
    if (o.confirm) return ownerOnly('scan');
    return scanPreviewOf(this.ws, who, o.now);
  }

  async plan(by: Principal, o: { confirm: boolean; receiptId?: string; now: Date }): Promise<PlanAnswer> {
    const agent = this.#agent(by);
    if (!agent || o.confirm) return ownerOnly('plan');
    return planWorkspaceHeld(this.store, this.ws, {
      ...(o.receiptId === undefined ? {} : { receiptId: o.receiptId }),
      by: agent,
      now: o.now,
    });
  }

  async startPreview(by: Principal, o: { runId?: string; now: Date }): Promise<CommandResult> {
    principalOf(by);
    const runId = runIdOr(this.store, 'start', o.runId);
    if (typeof runId !== 'string') return runId;
    return startPreviewOf(this.ws, await currentPlan(this.store, runId), runId, o.now, this.store.storeId);
  }

  async rerun(
    by: Principal,
    o: { mode: 'retry' | 'rerun'; runId: string; stages: readonly string[]; confirm: boolean; now: Date },
  ): Promise<CommandResult> {
    principalOf(by);
    return result(o.mode, 'configuration-failure', { reasonCode: 'sentinel.service.ownerServiceRunning' });
  }

  async status(by: Principal, o: { runId?: string; after?: number; limit?: number }): Promise<CommandResult> {
    principalOf(by);
    const runId = runIdOr(this.store, 'status', o.runId);
    if (typeof runId !== 'string') return runId;
    return statusIn(this.store, {
      runId,
      executing: this.hooks.executing(runId),
      registry: this.hooks.registry,
      ...(o.after === undefined ? {} : { after: o.after }),
      ...(o.limit === undefined ? {} : { limit: o.limit }),
    });
  }

  async report(by: Principal, o: { runId?: string; now: Date }): Promise<ReportAnswer> {
    principalOf(by);
    const runId = runIdOr(this.store, 'report', o.runId);
    if (typeof runId !== 'string') return runId;
    return reportIn(this.store, this.ws, { runId, now: o.now });
  }

  async scans(by: Principal, o: { limit?: number }): Promise<CommandResult> {
    principalOf(by);
    return scansIn(this.store, o.limit);
  }

  async stage(by: Principal, o: { runId?: string; stageId: string }): Promise<CommandResult> {
    principalOf(by);
    const runId = runIdOr(this.store, 'stage', o.runId);
    return typeof runId === 'string' ? stageIn(this.store, runId, o.stageId) : runId;
  }
}
