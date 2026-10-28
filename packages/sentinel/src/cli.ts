#!/usr/bin/env node
// The owner's executable: initialization, adoption, exact rule/asset promotion, canonical local and detached runs,
// bounded lifecycle controls and retained reports. External scanners use the reviewed container drivers only.
// Acquisition is a separate explicit owner action; no plan or scan downloads or uses a host scanner.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ownerDecisionCommand, decisionWire } from './findings/owner-cli.js';
import { ownerEvidenceCommand, evidenceWire } from './evidence/owner-cli.js';
import { REPORT_FORMATS, writeNewFile, type ReportFormat } from './service/full-report.js';
import { createHash } from 'node:crypto';
import {
  privateReviewTrace,
  adoptWorkspaceSettings,
  adoptWorkspacePipeline,
  showWorkspacePipeline,
  confirmForService,
  currentRules,
  followWorkspaceRun,
  promoteRulePack,
  prepareWorkspacePaths,
  runPlan,
  describeRun,
  workspaceOf,
  checkWorkspaceLayout,
  PolicyError,
  fullReportIn,
  type Workspace,
} from './service/local.js';
import { connectService, readServiceDescriptor, serveWorkspace } from './service/owner-service.js';
import { LocalSentinelService, RemoteSentinelService, type SentinelService } from './app/service.js';
import { claimOwnerMint, type OwnerPrincipal } from './app/principal.js';
import { canonicalResult, type CurrentPlan } from './service/canonical.js';
import { launchService } from './service/launch.js';
import { builtinPackDir } from './service/package-paths.js';
import { openStore } from './store/index.js';
import type { ServiceClient } from './transport/ipc.js';
import { renderScannerMarkdown, type ScannerReport } from './reports/scanner.js';
import type { PreviewReport } from './reports/preview.js';
import { renderPreviewJson, renderPreviewMarkdown } from './reports/preview.js';
import { PREVIEW_DETECTOR_ID, runPreviewWorker } from './adapters/preview-detector.js';
import { adoptScannerAsset, acquireScannerDatabase } from './service/scanner-assets.js';
import { CAPABILITIES } from './capabilities.js';
import { parseArgs, plannedIn, COMMANDS, type ParsedCommand } from './cli/args.js';
import { initWorkspace, InitError, PROFILE_PACKS } from './cli/init.js';
import { checkPipeline, parsePipeline, PipelineError, PIPELINE_PATH, type PipelineProblem } from './app/pipeline.js';
import { featureOf } from './policy/features.js';
import { PLAN_SHAPE_KEYS } from './planner/pipeline.js';
import { promoteStagePack, validateStagePack, STAGE_PACK_LIMITS } from './review/packs.js';
import { ReviewError } from './review/errors.js';
import { readPackDirectory } from './rules/pack.js';
import { result, type CommandResult } from './cli/outcome.js';
import { ENVELOPES, ENVELOPE_KINDS, MAX_ENVELOPE_BYTES, type EnvelopeKind } from './contracts/index.js';
import { parseEnvelope } from './validate.js';
// Every printed word comes from the shared catalog (strings-sentinel-cli.ts and strings-sentinel-service.ts).
import { sentinelWord, SENTINEL_CLI_STRINGS } from '@farsight/core/dist/strings-sentinel-cli.js';
import { SENTINEL_DECISION_STRINGS } from '@farsight/core/dist/strings-sentinel-decisions.js';
import { SENTINEL_OWNER_UI_STRINGS } from '@farsight/core/dist/strings-sentinel-owner-ui.js';
import { sentinelServiceWord, SENTINEL_SERVICE_STRINGS } from '@farsight/core/dist/strings-sentinel-service.js';
import { STRINGS } from '@farsight/core/dist/strings.js';

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((t, [name, value]) => t.replaceAll(`{${name}}`, String(value)), text);
/**
 * A printed word, from the catalog. The decision, CLI and service catalogs come first, as before; any other Sentinel
 * reason (a review, capture or execution code) is read from the shared catalog, and a key no catalog has is printed as
 * itself, so a refusal is always shown and never turns into "the command could not finish".
 */
const word = (key: string, values: Record<string, string | number> = {}) =>
  Object.hasOwn(SENTINEL_DECISION_STRINGS, key)
    ? SENTINEL_DECISION_STRINGS[key]!.hud.replace(/\{([a-zA-Z]+)\}/g, (_, k: string) => String(values[k] ?? ''))
    : Object.hasOwn(SENTINEL_CLI_STRINGS, key)
      ? sentinelWord(key, values)
      : Object.hasOwn(SENTINEL_SERVICE_STRINGS, key)
        ? sentinelServiceWord(key, values)
        : Object.hasOwn(STRINGS, key)
          ? fill(STRINGS[key]!.professional, values)
          : key;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function help(): string {
  const planned = (Object.keys(COMMANDS) as (keyof typeof COMMANDS)[]).filter((c) => COMMANDS[c] !== null);
  return [
    word('sentinel.cli.title'),
    '',
    word('sentinel.cli.scope'),
    '',
    word('sentinel.cli.usageHeading'),
    `  ${word('sentinel.cli.usageHelp')}`,
    `  ${word('sentinel.cli.usageCapabilities')}`,
    `  ${word('sentinel.cli.usageValidate')}`,
    `      ${word('sentinel.cli.kinds', { kinds: ENVELOPE_KINDS.join(', ') })}`,
    `  ${word('sentinel.cli.usageInit')}`,
    `  ${word('sentinel.cli.usageSettings')}`,
    `  ${word('sentinel.cli.usagePipeline')}`,
    `  ${word('sentinel.cli.usageStage')}`,
    `  ${word('sentinel.cli.usageScan')}`,
    `  ${word('sentinel.cli.usageScans')}`,
    `  ${word('sentinel.cli.usagePlan')}`,
    `  ${word('sentinel.cli.usagePaths')}`,
    `  ${word('sentinel.cli.usageRun')}`,
    `  ${word('sentinel.cli.usageDetach')}`,
    `  ${word('sentinel.cli.usageStatus')}`,
    `  ${word('sentinel.cli.usageWait')}`,
    `  ${word('sentinel.cli.usageControls')}`,
    `  ${word('sentinel.cli.usageReport')}`,
    `  ${word('sentinel.cli.usageFullReport')}`,
    `  ${word('sentinel.cli.usageServe')}`,
    `  ${word('sentinel.service.mcpUsage')}`,
    `  ${word('sentinel.preparation.usage')}`,
    `  ${SENTINEL_OWNER_UI_STRINGS['sentinel.ownerUi.usage']!.professional}`,
    `  ${word('sentinel.cli.usageRules')}`,
    `  ${word('sentinel.cli.usageAssets')}`,
    `  ${word('sentinel.decision.usage')}`,
    `  ${word('sentinel.evidence.usage')}`,
    `  ${word('sentinel.cli.usageFollow')}`,
    '',
    word('sentinel.cli.planned', { commands: planned.join(', ') }),
    '',
    word('sentinel.cli.exitCodes'),
  ].join('\n');
}

let jsonOut = false;
function out(text: string) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}
function errOut(text: string) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}
function finish(r: CommandResult): number {
  if (jsonOut) out(JSON.stringify(r, null, 2));
  return r.exitCode;
}

async function capabilities(p: ParsedCommand): Promise<number> {
  if (p.flags['--models'] === true) {
    const modelProfiles: unknown[] = [];
    let timedOut = false;
    try {
      const { qualifyInstalledNativeClaude, CLAUDE_NATIVE_PROFILE } =
        await import('./review/providers/cli-native-profile.js');
      const runtime = await qualifyInstalledNativeClaude({ deadlineAt: Date.now() + 5000 });
      modelProfiles.push({
        kind: 'claude-cli',
        model: 'claude-haiku-4-5-20251001',
        version: CLAUDE_NATIVE_PROFILE.version,
        platform: 'darwin',
        architecture: 'arm64',
        nativeProfile: {
          id: runtime.profileId,
          executableDigest: runtime.executableDigest,
          helperDigest: runtime.helperDigest,
          profileDigest: runtime.profileDigest,
        },
        qualification: 'local-bytes-only',
        authentication: 'unobserved',
        inference: 'unobserved',
      });
    } catch (e) {
      timedOut ||= (e as { code?: string })?.code === 'sentinel.provider.timeout';
    }
    try {
      const { qualifyInstalledNativeCopilot, COPILOT_NATIVE_PROFILE } =
        await import('./review/providers/cli-copilot-profile.js');
      const runtime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 5000 });
      modelProfiles.push({
        kind: 'copilot-cli',
        model: COPILOT_NATIVE_PROFILE.model,
        version: COPILOT_NATIVE_PROFILE.version,
        platform: 'darwin',
        architecture: 'arm64',
        copilotProfile: {
          id: runtime.profileId,
          executableDigest: runtime.executableDigest,
          runtimeDigest: runtime.runtimeDigest,
          profileDigest: runtime.profileDigest,
        },
        qualification: 'local-code-closure-only',
        authentication: 'unobserved',
        inference: 'unobserved',
      });
    } catch (e) {
      timedOut ||= (e as { code?: string })?.code === 'sentinel.provider.timeout';
    }
    return finish(
      modelProfiles.length
        ? result('capabilities', 'answered', { facts: { version: version(), modelProfiles } })
        : result('capabilities', 'unavailable', {
            reasonCode: timedOut ? 'sentinel.provider.timeout' : 'sentinel.provider.capabilityUntested',
            facts: {
              modelProfiles: [],
              qualification: 'unavailable',
              authentication: 'unobserved',
              inference: 'unobserved',
            },
          }),
    );
  }
  if (p.json)
    return finish(result('capabilities', 'answered', { facts: { version: version(), capabilities: CAPABILITIES } }));
  const state = (c: (typeof CAPABILITIES)[number]) =>
    word(c.state === 'unavailable' ? 'sentinel.cli.stateUnavailable' : 'sentinel.cli.stateDraft');
  const width = Math.max(...CAPABILITIES.map((c) => state(c).length));
  for (const c of CAPABILITIES) {
    out(
      `${state(c).padEnd(width)}  ${c.id.padEnd(26)} ${word(c.reasonCode)} · ${word('sentinel.cli.plannedIn', { change: c.plannedIn })}`,
    );
  }
  return 0;
}

function validate(p: ParsedCommand): number {
  const kind = p.args.kind;
  const file = p.args.file;
  const refuse = (reasonCode: string, values: Record<string, string | number> = {}) => {
    errOut(word(reasonCode, values));
    return finish(result('validate', 'refused', { reasonCode, facts: { kind: kind ?? null } }));
  };
  if (!kind || !file || !(ENVELOPE_KINDS as string[]).includes(kind))
    return refuse('sentinel.cli.validateUsage', { kinds: ENVELOPE_KINDS.join('|') });
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_ENVELOPE_BYTES) return refuse('sentinel.cli.refusedTooLarge', { bytes: MAX_ENVELOPE_BYTES });
    text = readFileSync(file, 'utf8');
  } catch {
    return refuse('sentinel.cli.refusedUnreadable');
  }
  const r = parseEnvelope(kind as EnvelopeKind, text);
  const schema = ENVELOPES[kind as EnvelopeKind].schema;
  if (p.json) {
    return finish(
      r.ok
        ? result('validate', 'answered', { facts: { ok: true, schema } })
        : result('validate', 'refused', {
            reasonCode: 'sentinel.cli.invalid',
            facts: { ok: false, schema, errors: r.errors },
          }),
    );
  }
  if (r.ok) out(word('sentinel.cli.valid', { schema }));
  else {
    errOut(word('sentinel.cli.invalid', { schema }));
    // Printed words come from the catalog only; the validator's diagnostic detail stays in --json output.
    for (const e of r.errors.slice(0, 50)) errOut(`  ${e.code} ${e.path || '/'} ${word(e.code)}`);
    if (r.errors.length > 50) errOut(`  ${word('sentinel.cli.more', { count: r.errors.length - 50 })}`);
  }
  return r.ok ? 0 : 3;
}

function init(p: ParsedCommand): number {
  const workspace = typeof p.flags['--workspace'] === 'string' ? p.flags['--workspace'] : process.cwd();
  const profile = typeof p.flags['--profile'] === 'string' ? p.flags['--profile'] : undefined;
  let done;
  try {
    done = initWorkspace({ workspace, ...(profile === undefined ? {} : { profile }) });
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    errOut(word(e.code, { detail: e.detail }));
    return finish(result('init', 'refused', { reasonCode: e.code, facts: { workspace } }));
  }
  const file = (f: typeof done.settings) => ({ outcome: f.outcome, path: f.path, digest: f.digest, holds: f.holds });
  const facts = {
    path: done.path,
    digest: done.digest,
    profile: done.profile,
    recognised: done.recognised,
    settings: file(done.settings),
    pipeline: file(done.pipeline),
    downloads: 0,
    scansStarted: 0,
  };
  if (!done.recognised) {
    errOut(word('sentinel.init.unrecognised'));
    return finish(result('init', 'refused', { reasonCode: 'sentinel.init.unrecognised', facts }));
  }
  if (!done.pipeline.recognised) {
    errOut(word('sentinel.init.pipelineUnrecognised'));
    return finish(result('init', 'refused', { reasonCode: 'sentinel.init.pipelineUnrecognised', facts }));
  }
  if (!jsonOut) {
    // A kept file is used as it is: say which profile it holds when that is not the one asked for.
    const holds = (f: typeof done.settings) => {
      if (f.outcome === 'prepared' || f.holds === done.profile) return;
      out(
        f.holds === null
          ? word('sentinel.init.edited')
          : word('sentinel.init.holdsOther', { holds: f.holds, profile: done.profile }),
      );
    };
    out(
      word(done.settings.outcome === 'prepared' ? 'sentinel.init.created' : 'sentinel.init.kept', { path: done.path }),
    );
    holds(done.settings);
    out(
      done.pipeline.outcome === 'prepared'
        ? word('sentinel.init.pipelineCreated', { path: done.pipeline.path, profile: done.profile })
        : word('sentinel.init.kept', { path: done.pipeline.path }),
    );
    holds(done.pipeline);
    // The profile in effect is what the settings file holds: a kept file is used as it is, whatever was asked for.
    const kept = done.settings.outcome === 'kept';
    const inEffect = kept ? done.settings.holds : done.profile;
    out(
      inEffect === done.profile
        ? word('sentinel.init.profile', { profile: done.profile })
        : inEffect === null
          ? word('sentinel.init.profileEdited', { asked: done.profile })
          : word('sentinel.init.profileKept', { profile: inEffect, asked: done.profile }),
    );
    out(word('sentinel.init.prerequisites'));
    out(word('sentinel.init.credentials'));
    out(word('sentinel.init.noEffects'));
    const packs = inEffect === null ? [] : (PROFILE_PACKS[inEffect as keyof typeof PROFILE_PACKS] ?? []);
    out(
      packs.length
        ? word('sentinel.init.next', { packs: packs.map((p) => `rules promote builtin:${p} --confirm`).join('; ') })
        : word('sentinel.init.nextEdited'),
    );
  }
  return finish(result('init', done.outcome, { facts }));
}

/** The workspace a command acts on: --workspace or the current folder, by its canonical path. */
function workspaceFor(p: ParsedCommand) {
  const given = typeof p.flags['--workspace'] === 'string' ? p.flags['--workspace'] : process.cwd();
  const ws = workspaceOf(realpathSync.native(given));
  // Before any command touches trust state or starts a service: trust state never lives in the captured checkout.
  checkWorkspaceLayout(ws);
  return ws;
}

/** Prints a service result: JSON whole, or its outcome words, reason and the facts a reader needs. */
function serviceOut(r: CommandResult, lines: string[] = [], values: Record<string, string | number> = {}): number {
  if (!jsonOut) {
    for (const l of lines) out(l);
    const head = word(`sentinel.outcome.${r.outcome.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`);
    (r.exitCode === 0 ? out : errOut)(
      r.reasonCode && r.reasonCode !== 'sentinel.outcome.unavailable' ? `${head}: ${word(r.reasonCode, values)}` : head,
    );
  }
  return finish(r);
}

/** `stage promote <folder> [--confirm]`. A promoted revision is write-once; the same bytes again are kept. */
function stagePromote(ws: Workspace, folder: string, confirm: boolean): number {
  checkWorkspaceLayout(ws);
  let source: string;
  try {
    source = realpathSync.native(folder);
  } catch {
    return serviceOut(result('stage.promote', 'refused', { reasonCode: 'sentinel.review.packInvalid' }), [], {
      detail: 'the folder does not exist',
    });
  }
  try {
    const pack = confirm
      ? promoteStagePack(ws.trustDir, source, { confirm: true })
      : validateStagePack(readPackDirectory(source, STAGE_PACK_LIMITS));
    const ref = `${pack.kind}s/${pack.id}@${pack.revision}`;
    const facts = { ref, digest: pack.digest, files: pack.files.length };
    const r = result('stage.promote', confirm ? 'prepared' : 'awaiting-confirmation', { facts });
    const lines = [`${ref} · ${pack.digest}`];
    if (!confirm) lines.push(word('sentinel.cli.confirmWith', { command: `stage promote ${folder} --confirm` }));
    return serviceOut(r, lines);
  } catch (e) {
    if (!(e instanceof ReviewError)) throw e;
    return serviceOut(result('stage.promote', 'configuration-failure', { reasonCode: e.code }), [], {
      detail: e.message.replace(/^[^:]*: /, ''),
    });
  }
}

/** A declared pipeline's problems, one line each, in the catalog's words with their safe detail. */
function problemLines(problems: unknown): string[] {
  return Array.isArray(problems)
    ? (problems as PipelineProblem[]).map((p) => `  ${p.stage ?? 'pipeline'}: ${word(p.code, { detail: p.detail })}`)
    : [];
}

/** One line per feature the adopted pipeline waits on, naming the setting that turns it on. */
function waitingLines(waiting: unknown): string[] {
  return Array.isArray(waiting)
    ? (waiting as string[]).flatMap((name) => {
        const f = featureOf(name);
        return f ? [word('sentinel.cli.pipelineWaitsOn', { feature: name, setting: f.setting ?? '(none)' })] : [];
      })
    : [];
}

/** The detail of the problem a refusal names, for its reason line. */
function refusedDetail(r: CommandResult): Record<string, string> {
  const view = (r.facts.pipeline ?? r.facts) as { problems?: PipelineProblem[]; detail?: string };
  const first = view.problems?.find((x) => x.code === r.reasonCode);
  return { detail: first?.detail ?? view.detail ?? '' };
}

/** `pipeline show | validate | adopt`: read, check or adopt the declared pipeline. None of them runs anything. */
function pipelineCommand(p: ParsedCommand, ws: Workspace, confirm: boolean, now: Date): number {
  if (p.args.action === 'validate') {
    const file = typeof p.flags['--file'] === 'string' ? resolve(p.flags['--file']) : resolve(ws.path, PIPELINE_PATH);
    let bytes: Buffer;
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      bytes = readFileSync(file);
    } catch {
      errOut(word('sentinel.pipeline.unreadable', { detail: file }));
      return finish(result('pipeline.validate', 'refused', { reasonCode: 'sentinel.pipeline.unreadable' }));
    }
    let problems: readonly PipelineProblem[];
    try {
      problems = checkPipeline(parsePipeline(bytes));
    } catch (e) {
      if (!(e instanceof PipelineError)) throw e;
      errOut(word(e.code, { detail: e.detail }));
      return finish(result('pipeline.validate', 'refused', { reasonCode: e.code, facts: { detail: e.detail } }));
    }
    const refused = problems.find((x) => x.class === 'refused');
    const r = refused
      ? result('pipeline.validate', 'refused', { reasonCode: refused.code, facts: { problems } })
      : result('pipeline.validate', 'answered', { facts: { problems } });
    if (!jsonOut && !refused) out(word('sentinel.cli.pipelineSound'));
    return serviceOut(r, problemLines(problems), refusedDetail(r));
  }
  if (p.args.action === 'adopt') {
    const r = adoptWorkspacePipeline(ws, { confirm, now });
    const lines = [
      ...(r.facts.digest ? [`pipeline ${String(r.facts.digest)}`] : []),
      ...problemLines(r.facts.problems),
      ...waitingLines(r.facts.waitingOn),
    ];
    if (r.outcome === 'awaiting-confirmation')
      lines.push(word('sentinel.cli.confirmWith', { command: 'pipeline adopt --confirm' }));
    return serviceOut(r, lines, refusedDetail(r));
  }
  const r = showWorkspacePipeline(ws);
  const f = r.facts as Record<string, unknown>;
  const lines =
    f.id === undefined
      ? []
      : [
          word('sentinel.cli.pipelineShown', {
            id: String(f.id),
            revision: String(f.revision),
            stages: String(f.stages),
            digest: String(f.digest),
            trust: String(f.trust),
          }),
          ...problemLines(f.problems),
        ];
  if (f.id !== undefined && Array.isArray(f.problems) && f.problems.length === 0)
    lines.push(word('sentinel.cli.pipelineSound'));
  return serviceOut(r, lines, refusedDetail(r));
}

/**
 * The owner mint, claimed by this entry as it loads (once per process; no other module can claim it), and the owner
 * of this command, minted only on the owner's own command path (never in `serve`, `mcp` or `owner-ui`).
 */
const mintOwner = claimOwnerMint();
let ownerOfCommand: OwnerPrincipal | undefined;
const me = (): OwnerPrincipal => (ownerOfCommand ??= mintOwner());

/** Each model a start would call, in words: provider, model, runner and budget. */
function modelLines(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  // One line per stage and model: a review stage of many units names its model once.
  return [
    ...new Set(
      models.map((m: Record<string, unknown>) =>
        word('sentinel.cli.scanModel', {
          stage: m.segmentId ? `${String(m.stage ?? 'review')} ${String(m.segmentId)}` : String(m.stage ?? 'review'),
          runner: String(m.runner ?? m.providerId),
          model: String(m.model ?? m.modelId),
          provider: String(m.providerId),
          budget: budgetWords(m.budget),
        }),
      ),
    ),
  ];
}

const budgetWords = (b: unknown): string => {
  const x = (b ?? {}) as { maxTokens?: unknown; maxCost?: unknown; currency?: unknown };
  const parts = [
    x.maxTokens === null || x.maxTokens === undefined ? null : `${String(x.maxTokens)} tokens`,
    x.maxCost === null || x.maxCost === undefined ? null : `${String(x.maxCost)} ${String(x.currency ?? '')}`.trim(),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : word('sentinel.cli.budgetNone');
};

/**
 * Which stages a plan runs, in words: a profile's own pipeline plans as that profile's defaults (with the reviews the
 * settings configure); any other adopted file as declared. `status` reads it from the run's recorded profile.
 */
function stagesLine(path: unknown): string[] {
  const p = path as { kind?: string; profile?: string; digest?: string; path?: string; id?: string; revision?: number };
  if (!p) return [];
  if (p.kind === 'default-of') return [word('sentinel.cli.stagesDefault', { profile: String(p.profile) })];
  if (p.kind === 'declared') return [word('sentinel.cli.stagesDeclared', { digest: String(p.digest) })];
  if (p.path === 'default-of') return [word('sentinel.cli.stagesDefault', { profile: String(p.profile) })];
  if (p.path === 'default') return [word('sentinel.cli.stagesDefaultRun')];
  if (p.path === 'declared')
    return [
      word('sentinel.cli.stagesDeclaredRun', {
        id: String(p.id),
        revision: Number(p.revision),
        digest: String(p.digest),
      }),
    ];
  return [];
}

/** The units a run holds, each with why. */
function heldLines(held: unknown): string[] {
  if (!Array.isArray(held)) return [];
  return held.map((h: Record<string, unknown>) =>
    word('sentinel.cli.held', { unit: String(h.unit), stage: String(h.stage), reason: word(String(h.reasonCode)) }),
  );
}

/** What a foreground run printed: its state when it ran, or the exact command that confirms what it waits for. */
function runLines(r: CommandResult, command: string): string[] {
  const f = r.facts as Record<string, unknown>;
  if (r.outcome === 'awaiting-confirmation')
    return [
      ...modelLines(
        Array.isArray(f.modelReviews)
          ? (
              f.modelReviews as {
                kind: string;
                selection: { providerId: string; modelId: string };
                terms?: { budget?: unknown };
              }[]
            ).map((m) => ({
              stage: m.kind,
              providerId: m.selection.providerId,
              modelId: m.selection.modelId,
              budget: m.terms?.budget,
            }))
          : f.models,
      ),
      word('sentinel.cli.confirmWith', {
        command: `${command} --confirm${f.requiredFlag === '--confirm-models' ? ' --confirm-models' : ''}`,
      }),
    ];
  if (!f.runId || f.state === undefined) return [];
  return [
    `run ${String(f.runId)} · ${String(f.state)}${f.previewFindings === undefined ? '' : ` · preview findings: ${String(f.previewFindings)}`}`,
  ];
}

/**
 * `scan [--confirm] [--detach]`: plan, then start, through the facade. Without --confirm it previews every stage and
 * model and waits; with it the one confirmation plans and starts (in this process, or through the service when one
 * runs or --detach starts it), and the next command is printed with no id to retype.
 */
async function scanCommand(
  p: ParsedCommand,
  ws: Workspace,
  facade: SentinelService,
  confirm: boolean,
  now: Date,
): Promise<number> {
  let svc = facade;
  if (confirm && p.flags['--detach'] === true && facade instanceof LocalSentinelService) {
    const client = await ensureService(ws);
    if (!client)
      return serviceOut(result('scan', 'configuration-failure', { reasonCode: 'sentinel.service.startFailed' }));
    client.close();
    svc = new RemoteSentinelService(ws, () => connectService(ws));
  }
  const r = await svc.scan(me(), { confirm, now });
  const f = r.facts as Record<string, unknown>;
  if (!confirm || r.outcome === 'awaiting-confirmation') {
    const stages =
      (f.stages as { id: string; kind: string; order: number; where: string; effects: string[] }[] | null) ?? null;
    const setup = (f.setup as Record<string, unknown>[] | undefined) ?? [];
    return serviceOut(
      r,
      [
        ...setup.map((x) =>
          x.kind === 'adopt'
            ? word('sentinel.cli.setupAdopt', {
                settings: String(x.settingsDigest),
                pipeline: String(
                  (x.pipeline as { digest?: string } | undefined)?.digest ?? word('sentinel.cli.noPipelineFile'),
                ),
              })
            : x.candidate
              ? word('sentinel.cli.setupPromote', { pack: String(x.pack), candidate: String(x.candidate) })
              : word('sentinel.cli.setupPromoteAfter', { pack: String(x.pack) }),
        ),
        ...(stages
          ? stages
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((s) =>
                word('sentinel.cli.scanStage', {
                  order: s.order + 1,
                  stage: s.id,
                  kind: s.kind,
                  where: s.where,
                  effects: s.effects.join(', ') || word('sentinel.cli.effectsNone'),
                }),
              )
          : f.effects
            ? [word('sentinel.cli.scanDefaultStages')]
            : []),
        ...stagesLine((f.pipeline as { path?: unknown } | null)?.path),
        ...modelLines(f.models),
        ...(r.outcome === 'awaiting-confirmation'
          ? [
              word('sentinel.cli.confirmWith', {
                command: `scan --confirm${p.flags['--detach'] === true ? ' --detach' : ''}`,
              }),
            ]
          : []),
      ],
      refusedDetail(r),
    );
  }
  const lines: string[] = [];
  if (f.planId) lines.push(`plan ${String(f.planId)} · ${String(f.planDigest)}`);
  if (f.runId) lines.push(`run ${String(f.runId)} · ${String(f.state)}${f.joined === true ? ' · joined' : ''}`);
  if (f.runId) lines.push(word('sentinel.cli.nextReport', { command: r.outcome === 'submitted' ? 'wait' : 'report' }));
  return serviceOut(r, lines, refusedDetail(r));
}

const SERVICE_START_MS = 15_000;
const DETACHED_IDLE_MS = 15_000;
const DEFAULT_WAIT_MS = 600_000;

/** The workspace's running service, started detached (as this same executable, `serve`) when none answers. */
async function ensureService(ws: Workspace): Promise<ServiceClient | undefined> {
  const live = await connectService(ws);
  if (live) return live;
  const launched = launchService(ws.path, DETACHED_IDLE_MS);
  // Two commands may start a service at once; the loser cannot open the store and exits, and both reach the winner.
  try {
    for (const end = Date.now() + SERVICE_START_MS; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 100));
      const c = await connectService(ws);
      if (c) {
        // Another command's service won the race: this command's own launch is redundant and is stopped by its own
        // handle, so it cannot take the store later, after the winner stops.
        if (readServiceDescriptor(ws)?.pid !== launched.pid) launched.stop();
        return c;
      }
    }
  } catch (e) {
    launched.stop();
    throw e;
  }
  // Nothing answered in time: stop exactly the process this command started, by its own handle.
  launched.stop();
  return undefined;
}

/** Sends one request and closes the connection: the run continues whatever happens to this command. */
async function ask(
  client: ServiceClient,
  op: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<CommandResult> {
  try {
    return (await client.request(op, body, timeoutMs === undefined ? {} : { timeoutMs })) as CommandResult;
  } finally {
    client.close();
  }
}

async function owner(p: ParsedCommand): Promise<number> {
  const now = new Date();
  const confirm = p.flags['--confirm'] === true;
  try {
    const ws = workspaceFor(p);
    const format = typeof p.flags['--format'] === 'string' ? p.flags['--format'] : 'md';
    if (p.command === 'report' && p.flags['--instructions'] === true) {
      const live = await connectService(ws);
      if (live) {
        live.close();
        return serviceOut(
          result('report', 'configuration-failure', { reasonCode: 'sentinel.service.ownerServiceRunning' }),
        );
      }
      return serviceOut(await privateReviewTrace(ws, p.args.runId!));
    }
    if (p.command === 'compare' || (p.command === 'report' && p.flags['--full'] === true))
      return await fullReportCommand(p, ws, format, confirm, now);
    // The flags of the full report change nothing in the minimal report: refused rather than ignored.
    for (const flag of ['--disclosure', '--context', '--repo', '--out', '--confirm']) {
      if (p.command === 'report' && p.flags[flag] !== undefined) {
        errOut(word('sentinel.args.unexpectedArgument', { detail: `${flag} (with --full)` }));
        return finish(result('report', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
    }
    if (p.command === 'report' && format !== 'md' && format !== 'json') {
      errOut(word('sentinel.args.unexpectedArgument', { detail: format }));
      return finish(result('report', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
    }
    if (p.command === 'assets') {
      if (p.args.action === 'acquire-database') {
        if (p.flags['--archive'] || p.flags['--manifest'] || p.flags['--license'])
          return serviceOut(result('assets', 'configuration-failure', { reasonCode: 'sentinel.assets.invalid' }));
        return serviceOut(
          await acquireScannerDatabase(ws, {
            id: p.args.assetId!,
            maxBytes: typeof p.flags['--max-bytes'] === 'string' ? Number(p.flags['--max-bytes']) : undefined,
            confirm,
            now,
          }),
        );
      }
      if (p.flags['--max-bytes'])
        return serviceOut(result('assets', 'configuration-failure', { reasonCode: 'sentinel.assets.invalid' }));
      const kind =
        p.args.action === 'adopt-tool' ? 'tool' : p.args.action === 'adopt-database' ? 'database' : undefined;
      if (!kind)
        return serviceOut(result('assets', 'configuration-failure', { reasonCode: 'sentinel.assets.unsupported' }));
      const adopted = await adoptScannerAsset(ws, {
        kind,
        id: p.args.assetId!,
        license: typeof p.flags['--license'] === 'string' ? p.flags['--license'] : undefined,
        archive: typeof p.flags['--archive'] === 'string' ? p.flags['--archive'] : undefined,
        manifest: typeof p.flags['--manifest'] === 'string' ? p.flags['--manifest'] : undefined,
        confirm,
        now,
      });
      return serviceOut(
        adopted,
        adopted.facts.candidate
          ? [
              word('sentinel.assets.disclosure', {
                id: String(adopted.facts.id),
                candidate: String(adopted.facts.candidate),
                metadata: String(adopted.facts.metadataDigest),
              }),
            ]
          : [],
      );
    }
    if (p.command === 'serve') return await serve(p, ws);
    if (p.command === 'wait') return await waitFor(p, ws);
    if (
      (p.command === 'run' && p.flags['--detach'] === true) ||
      p.command === 'resume' ||
      p.command === 'pause' ||
      p.command === 'cancel'
    ) {
      // Writes on a run. First the owner's decision against the plan (without --confirm it stops here, exit 4, and
      // starts nothing); then the service is reached and the owner's receipt is minted for exactly its store and this
      // run, and spent there once. Pause needs a run the service is executing; start, resume and cancel may start it.
      const runId = (p.args.planId ?? p.args.runId)!;
      const action =
        p.command === 'pause'
          ? ('run.pause' as const)
          : p.command === 'cancel'
            ? ('run.cancel' as const)
            : ('run.start' as const);
      // The run's current admitted plan: from the service when one holds the store, else read from the store.
      const describe = async (client?: ServiceClient) =>
        client
          ? (((await client.request('run.describe', { runId })) as CurrentPlan | null) ?? undefined)
          : describeRun(ws, runId);
      // From the service when one holds the store; else from the store. A service that another command has just
      // started holds the store before it answers: then this command waits for it and asks it, rather than failing.
      const describeNow = async (): Promise<CurrentPlan | undefined> => {
        for (const end = Date.now() + SERVICE_START_MS; ;) {
          const live = await connectService(ws);
          if (live) {
            try {
              return await describe(live);
            } finally {
              live.close();
            }
          }
          try {
            return await describe();
          } catch (e) {
            if ((e as { code?: string }).code !== 'sentinel.store.ownedElsewhere' || Date.now() >= end) throw e;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const planNow = await describeNow();
      // A plan with model stages starts as one composite the owner confirms with --confirm-models: the start and
      // every model envelope it opens (ADR 48 as amended). Without it the start waits and nothing is issued.
      const models = p.flags['--confirm-models'] === true;
      const shown = confirmForService(ws, {
        command: p.command,
        action,
        plan: planNow,
        planId: runId,
        confirm: false,
        now,
        models,
      });
      const needsModels = 'result' in shown && shown.result.facts.requiredFlag === '--confirm-models';
      if (!confirm || needsModels || ('result' in shown && shown.result.outcome !== 'awaiting-confirmation')) {
        const waiting = 'result' in shown && shown.result.outcome === 'awaiting-confirmation';
        const again = `${p.command} ${runId}${p.command === 'run' ? ' --detach' : ''} --confirm${needsModels || models ? ' --confirm-models' : ''}`;
        return serviceOut('result' in shown ? shown.result : result(p.command, 'refused'), [
          ...modelLines(('result' in shown ? shown.result.facts.models : undefined) as unknown),
          ...(waiting ? [word('sentinel.cli.confirmWith', { command: again })] : []),
        ]);
      }
      const client = p.command === 'pause' ? await connectService(ws) : await ensureService(ws);
      if (!client) {
        return serviceOut(
          result(p.command, p.command === 'pause' ? 'refused' : 'configuration-failure', {
            reasonCode: p.command === 'pause' ? 'sentinel.service.notRunning' : 'sentinel.service.startFailed',
            facts: { runId },
          }),
        );
      }
      const confirmed = confirmForService(ws, {
        command: p.command,
        action,
        plan: await describe(client),
        planId: runId,
        confirm: true,
        now,
        storeId: client.storeId,
        models,
      });
      if ('result' in confirmed) {
        client.close();
        return serviceOut(confirmed.result);
      }
      const r =
        action === 'run.start'
          ? await ask(client, 'run.start', {
              planId: runId,
              receiptId: confirmed.receiptId,
              ...(confirmed.envelopeReceipts.length ? { envelopeReceipts: [...confirmed.envelopeReceipts] } : {}),
            })
          : await ask(client, action, { runId, receiptId: confirmed.receiptId });
      return serviceOut(
        r,
        r.facts.runId
          ? [`run ${String(r.facts.runId)} · ${String(r.facts.state)}${r.facts.joined === true ? ' · joined' : ''}`]
          : [],
      );
    }
    // While the service runs it alone holds the store: reads and plans go through it (the facade's remote side), and
    // nothing is run or rerun in this process.
    const live = await connectService(ws);
    if (live && (p.command === 'paths' || p.command === 'run' || p.command === 'retry' || p.command === 'rerun')) {
      live.close();
      return serviceOut(
        result(p.command, 'configuration-failure', { reasonCode: 'sentinel.service.ownerServiceRunning' }),
      );
    }
    live?.close();
    const facade: SentinelService = live
      ? new RemoteSentinelService(ws, () => connectService(ws))
      : new LocalSentinelService(ws);
    if (p.command === 'scan') return await scanCommand(p, ws, facade, confirm, now);
    if (p.command === 'scans') {
      const limit = typeof p.flags['--limit'] === 'string' ? Number(p.flags['--limit']) : undefined;
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 128)) {
        errOut(word('sentinel.args.missingValue', { detail: '--limit (1 to 128)' }));
        return finish(result('scans', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
      }
      const r = await facade.scans(me(), limit === undefined ? {} : { limit });
      const rows = (r.facts.scans as { id: string; state: string; planRevision: number; createdAt: string }[]) ?? [];
      return serviceOut(
        r,
        rows.length
          ? rows.map((x) =>
              word('sentinel.cli.scanRow', {
                id: x.id,
                state: x.state,
                revision: x.planRevision,
                created: x.createdAt,
              }),
            )
          : [word('sentinel.service.noScans')],
      );
    }
    if (p.command === 'stage' && p.args.action === 'show') {
      const r = await facade.stage(me(), {
        stageId: p.args.target!,
        ...(typeof p.flags['--run'] === 'string' ? { runId: p.flags['--run'] as string } : {}),
      });
      const units = (r.facts.units as Record<string, unknown>[] | undefined) ?? [];
      return serviceOut(
        r,
        units.map(
          (u) =>
            word('sentinel.cli.stageUnit', {
              unit: String(u.id),
              adapter: String(u.adapterId),
              state: String(u.state),
              attempts: Number(u.attempts),
            }) + (u.reasonCode ? ` · ${word(String(u.reasonCode))}` : ''),
        ),
        refusedDetail(r),
      );
    }
    if (p.command === 'status') {
      const num = (f: string) => (typeof p.flags[f] === 'string' ? Number(p.flags[f]) : undefined);
      const after = num('--after');
      const limit = num('--limit');
      if (
        (after !== undefined && !(Number.isSafeInteger(after) && after >= 0)) ||
        (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0))
      ) {
        errOut(word('sentinel.args.missingValue', { detail: '--after/--limit' }));
        return finish(result('status', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
      }
      const r = await facade.status(me(), {
        ...(p.args.runId === undefined ? {} : { runId: p.args.runId }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      });
      return serviceOut(r, [
        ...(r.facts.state ? [`run ${String(r.facts.runId)} · ${String(r.facts.state)}`] : []),
        ...stagesLine(r.facts.pipeline),
        ...heldLines(r.facts.held),
      ]);
    }
    if (p.command === 'report') {
      return printReport(
        p,
        await facade.report(me(), { ...(p.args.runId === undefined ? {} : { runId: p.args.runId }), now }),
      );
    }
    if (p.command === 'plan') {
      const r = await facade.plan(me(), { confirm, now });
      const pipeline = r.facts.pipeline as { problems?: unknown } | undefined;
      const disclosure = r.disclosure ?? (r.facts.planDigest ? (r.facts as unknown as typeof r.disclosure) : undefined);
      if (!disclosure)
        return serviceOut(
          r,
          [
            ...problemLines(pipeline?.problems),
            ...(r.outcome === 'awaiting-confirmation'
              ? [word('sentinel.cli.confirmWith', { command: 'plan --confirm' })]
              : []),
          ],
          refusedDetail(r),
        );
      return serviceOut(r, [
        `plan ${disclosure.planId} · ${disclosure.planDigest} · ${disclosure.shape ? `${word(PLAN_SHAPE_KEYS[disclosure.shape])} · ` : ''}effects: ${disclosure.effects.join(', ')} · ${word(disclosure.label === 'foundation-preview' ? 'sentinel.report.previewOnly' : 'sentinel.report.scannerSlice')}`,
        ...stagesLine((pipeline as { path?: unknown } | undefined)?.path),
      ]);
    }
    if (p.command === 'settings') {
      if (p.args.action !== 'adopt') {
        errOut(word('sentinel.args.unexpectedArgument', { detail: String(p.args.action) }));
        return finish(result('settings', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      const r = adoptWorkspaceSettings(ws, { confirm, now });
      const pipeline = r.facts.pipeline as { digest?: string; reasonCode?: string; detail?: string } | undefined;
      const lines = [`settings ${String(r.facts.settingsDigest)}`];
      if (pipeline?.digest) lines.push(`pipeline ${pipeline.digest}`);
      if (pipeline?.reasonCode) lines.push(`pipeline: ${word(pipeline.reasonCode, { detail: pipeline.detail ?? '' })}`);
      lines.push(...problemLines((r.facts.pipeline as { problems?: unknown } | undefined)?.problems));
      lines.push(...waitingLines((r.facts.pipeline as { waitingOn?: unknown } | undefined)?.waitingOn));
      if (r.outcome === 'awaiting-confirmation')
        lines.push(word('sentinel.cli.confirmWith', { command: 'settings adopt --confirm' }));
      return serviceOut(r, lines);
    }
    if (p.command === 'pipeline') {
      if (live) live.close();
      return pipelineCommand(p, ws, confirm, now);
    }
    if (p.command === 'stage') {
      // `stage promote <folder>`: the owner promotes a stage or skill pack's exact bytes into the trust folder, where
      // a pipeline's prompts, instructions and skills are read from (review/packs.ts). Without --confirm it shows the
      // pack it would promote and waits.
      live?.close();
      return stagePromote(ws, p.args.target!, confirm);
    }
    if (p.command === 'rules') {
      // The owner's rule lock lives in the owner's private state, not the store: it works with or without a service.
      if (p.args.action === 'show' && p.args.packDir === undefined) return serviceOut(currentRules(ws), []);
      if (p.args.action !== 'promote' || p.args.packDir === undefined) {
        errOut(word('sentinel.args.unexpectedArgument', { detail: String(p.args.action) }));
        return finish(result('rules', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      // `builtin:<name>` is a pack this package ships; anything else is a folder the owner names.
      const named = p.args.packDir.startsWith('builtin:')
        ? builtinPackDir(p.args.packDir.slice('builtin:'.length))
        : p.args.packDir;
      if (named === undefined) {
        errOut(word('sentinel.args.unexpectedArgument', { detail: p.args.packDir }));
        return finish(result('rules', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      const r = promoteRulePack(ws, { packDir: realpathSync.native(named), confirm, now });
      return serviceOut(r, [
        `pack ${String(r.facts.packId)} ${String(r.facts.version)} · candidate ${String(r.facts.candidate)} · replaces lock ${String(r.facts.previousLock)}${r.facts.lock ? ` · now lock ${String(r.facts.lock)}` : ''}`,
      ]);
    }
    if (p.command === 'retry' || p.command === 'rerun') {
      const stages =
        typeof p.flags['--stage'] === 'string'
          ? p.flags['--stage']
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
          : [];
      const r = await followWorkspaceRun(ws, { mode: p.command, runId: p.args.runId!, stages, confirm, now });
      return serviceOut(
        r,
        r.facts.runId && r.facts.parentId
          ? [`run ${String(r.facts.runId)} · follows ${String(r.facts.parentId)} · ${String(r.facts.planDigest)}`]
          : [],
      );
    }
    if (p.command === 'paths') {
      const r = await prepareWorkspacePaths(ws, {
        ancestorRunId: p.args.ancestorRunId!,
        requestFile: p.flags['--request'] as string,
        confirm,
        now,
      });
      return serviceOut(
        r,
        r.facts.runId
          ? [word('sentinel.cli.pathsPrepared', { run: String(r.facts.runId), request: String(r.facts.request) })]
          : [],
      );
    }
    if (p.command === 'run') {
      const r = await runPlan(ws, {
        planId: p.args.planId!,
        confirm,
        confirmModels: p.flags['--confirm-models'] === true,
        now,
      });
      return serviceOut(r, runLines(r, `run ${p.args.planId}`));
    }
    return finish(result(p.command, 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof PolicyError || (typeof code === 'string' && code.startsWith('sentinel.'))) {
      // The reason in words when the catalog has them (a raw code repeated is no help); the safe message otherwise.
      const message = (e as Error).message;
      let said: string;
      try {
        const plain = word(code!);
        const detailed = word(code!, { detail: message });
        said = detailed !== plain ? detailed : message && message !== code ? `${plain} (${message})` : plain;
      } catch {
        said = `${code}: ${message}`;
      }
      errOut(said);
      return finish(result(p.command, 'configuration-failure', { reasonCode: code }));
    }
    throw e;
  }
}

/**
 * `report <run> --full` and `compare <run> <baseline>`: the full report of a completed run from its accepted evidence,
 * in the store this process holds. While the background service holds the store nothing is read here.
 */
async function fullReportCommand(
  p: ParsedCommand,
  ws: Workspace,
  format: string,
  confirm: boolean,
  now: Date,
): Promise<number> {
  const disclosure = typeof p.flags['--disclosure'] === 'string' ? p.flags['--disclosure'] : 'shareable';
  for (const [flag, value, allowed] of [
    ['--format', format, REPORT_FORMATS],
    ['--disclosure', disclosure, ['private', 'shareable']],
  ] as const) {
    if (!(allowed as readonly string[]).includes(value)) {
      errOut(word('sentinel.args.unexpectedArgument', { detail: `${flag} ${value}` }));
      return finish(result(p.command, 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
    }
  }
  if (p.flags['--repo'] !== undefined && p.flags['--context'] === undefined) {
    errOut(word('sentinel.args.unexpectedArgument', { detail: '--repo (with --context)' }));
    return finish(result(p.command, 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
  }
  const path = (flag: string) =>
    typeof p.flags[flag] === 'string' ? resolve(process.cwd(), p.flags[flag] as string) : undefined;
  const contextFile = path('--context');
  const outFile = path('--out');
  const live = await connectService(ws);
  // Without a run id: the newest scan's report, through whichever side holds the store.
  let runId = p.args.runId;
  if (runId === undefined) {
    live?.close();
    const facade: SentinelService = live
      ? new RemoteSentinelService(ws, () => connectService(ws))
      : new LocalSentinelService(ws);
    runId = ((await facade.scans(me(), { limit: 1 })).facts.scans as { id: string }[] | undefined)?.[0]?.id;
    if (!runId)
      return serviceOut(result(p.command, 'configuration-failure', { reasonCode: 'sentinel.service.noScans' }));
    if (live) return await fullReportThroughService(p, ws, runId, format, outFile, contextFile, disclosure);
  } else if (live) {
    live.close();
    return await fullReportThroughService(p, ws, runId, format, outFile, contextFile, disclosure);
  }
  const r = await fullReportIn(ws, {
    runId,
    ...(p.args.baselineRunId ? { baselineRunId: p.args.baselineRunId } : {}),
    disclosure: disclosure as 'private' | 'shareable',
    format: format as ReportFormat,
    ...(contextFile ? { contextFile } : {}),
    ...(typeof p.flags['--repo'] === 'string' ? { repo: p.flags['--repo'] as string } : {}),
    ...(outFile ? { out: outFile } : {}),
    confirm,
    now,
  });
  if (jsonOut || r.text === undefined) {
    const f = r.result.facts as Record<string, any>;
    return serviceOut(
      r.result,
      f.reportId
        ? [
            `report ${String(f.reportId)} · ${String(f.completeness)} · ${String(f.findings)} findings · ${String(f.gaps)} gaps${f.written ? ` · written ${String(f.written)}` : ''}`,
          ]
        : [],
    );
  }
  out(r.text.endsWith('\n') ? r.text.slice(0, -1) : r.text);
  return r.result.exitCode;
}

/**
 * `report --full` (and `compare`) while the service holds the store: the shareable report the service builds from the
 * accepted evidence (`report.open`), read back in bounded chunks (`delivery.read`) and checked against the digest it
 * names. A private disclosure or an owner graph needs the owner's own process and store: refused while it runs.
 */
async function fullReportThroughService(
  p: ParsedCommand,
  ws: Workspace,
  runId: string,
  format: string,
  outFile: string | undefined,
  contextFile: string | undefined,
  disclosure: string,
): Promise<number> {
  if (contextFile || disclosure !== 'shareable' || p.flags['--confirm'] === true)
    return serviceOut(
      result(p.command, 'configuration-failure', {
        reasonCode: 'sentinel.service.ownerServiceRunning',
        facts: { runId, through: 'service', shareableOnly: true },
      }),
    );
  const client = await connectService(ws);
  if (!client)
    return serviceOut(result(p.command, 'configuration-failure', { reasonCode: 'sentinel.service.notRunning' }));
  let manifest: {
    deliveryId: string;
    reportId: string;
    formatDigest: string;
    formatBytes: number;
    disclosure: { profile: string };
  };
  const chunks: Buffer[] = [];
  try {
    manifest = (await client.request('report.open', {
      runId,
      format,
      ...(p.args.baselineRunId ? { baselineRunId: p.args.baselineRunId } : {}),
    })) as typeof manifest;
    for (let offset: number | null = 0; offset !== null;) {
      const chunk = (await client.request('delivery.read', {
        deliveryId: manifest.deliveryId,
        offset,
        maxBytes: 64 * 1024,
      })) as { base64: string; nextOffset: number | null };
      chunks.push(Buffer.from(chunk.base64, 'base64'));
      offset = chunk.nextOffset;
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return serviceOut(
      result(p.command, 'configuration-failure', {
        reasonCode: typeof code === 'string' && code.startsWith('sentinel.') ? code : 'sentinel.service.notRunning',
        facts: { runId },
      }),
    );
  } finally {
    client.close();
  }
  const bytes = Buffer.concat(chunks);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.length !== manifest.formatBytes || digest !== manifest.formatDigest)
    return serviceOut(
      result(p.command, 'configuration-failure', { reasonCode: 'sentinel.service.deliveryInvalid', facts: { runId } }),
    );
  const text = bytes.toString('utf8');
  if (outFile) writeNewFile(outFile, text);
  const r = result(p.command, 'answered', {
    facts: {
      runId,
      reportId: manifest.reportId,
      disclosure: manifest.disclosure.profile,
      format,
      formatDigest: manifest.formatDigest,
      bytes: bytes.length,
      through: 'service',
      ...(outFile ? { written: outFile } : {}),
      ...(p.args.baselineRunId ? { baselineRunId: p.args.baselineRunId } : {}),
    },
  });
  if (jsonOut || outFile)
    return serviceOut(r, [
      `report ${manifest.reportId} · ${format} · ${bytes.length} bytes${outFile ? ` · written ${outFile}` : ''}`,
    ]);
  out(text.endsWith('\n') ? text.slice(0, -1) : text);
  return r.exitCode;
}

function printReport(p: ParsedCommand, doc: PreviewReport | ScannerReport | CommandResult): number {
  const format = typeof p.flags['--format'] === 'string' ? p.flags['--format'] : 'md';
  {
    if ('outcome' in doc) return serviceOut(doc);
    // --json is the typed result with the report inside it; --format json alone prints the report document.
    if (jsonOut) return finish(result('report', 'answered', { facts: { report: doc } }));
    if (doc.schema === 'sentinel-scanner-report/draft-1')
      out(format === 'json' ? JSON.stringify(doc, null, 2) : renderScannerMarkdown(doc));
    else out(format === 'json' ? renderPreviewJson(doc) : renderPreviewMarkdown(doc));
    return 0;
  }
}

/** `serve`: the owner's background service for this workspace, until it is stopped or idle. */
async function serve(p: ParsedCommand, ws: Workspace): Promise<number> {
  const idle = typeof p.flags['--idle-ms'] === 'string' ? Number(p.flags['--idle-ms']) : 0;
  if (!Number.isSafeInteger(idle) || idle < 0 || idle > 86_400_000) {
    errOut(word('sentinel.args.missingValue', { detail: '--idle-ms' }));
    return finish(result('serve', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await serveWorkspace(ws, {
      idleMs: idle,
      signal: stop.signal,
      onListening: () => {
        if (!jsonOut)
          out(
            word(idle > 0 ? 'sentinel.service.serving' : 'sentinel.service.servingForever', {
              workspace: ws.path,
              idle,
            }),
          );
      },
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return finish(result('serve', 'answered', { facts: { workspace: ws.path, stopped: true } }));
}

/** `wait`: the run's result once it ends, or `submitted` (still running) when the wait does. */
async function waitFor(p: ParsedCommand, ws: Workspace): Promise<number> {
  // Without a run id: the newest scan, through whichever side holds the store.
  let runId = p.args.runId;
  if (runId === undefined) {
    const live = await connectService(ws);
    live?.close();
    const facade: SentinelService = live
      ? new RemoteSentinelService(ws, () => connectService(ws))
      : new LocalSentinelService(ws);
    runId = ((await facade.scans(me(), { limit: 1 })).facts.scans as { id: string }[] | undefined)?.[0]?.id;
    if (!runId) return serviceOut(result('wait', 'configuration-failure', { reasonCode: 'sentinel.service.noScans' }));
  }
  const total = typeof p.flags['--timeout'] === 'string' ? Number(p.flags['--timeout']) : DEFAULT_WAIT_MS;
  if (!Number.isSafeInteger(total) || total < 0) {
    errOut(word('sentinel.args.missingValue', { detail: '--timeout' }));
    return finish(result('wait', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
  }
  const end = Date.now() + total;
  for (;;) {
    const client = await connectService(ws);
    if (!client) {
      // Nothing is executing it: the store says whether it finished, stopped or was interrupted.
      const store = await openStore(ws.storePath);
      try {
        return serviceOut(await canonicalResult(store, 'wait', runId, { executing: false }));
      } finally {
        store.close();
      }
    }
    const slice = Math.max(0, Math.min(end - Date.now(), 20_000));
    const r = await ask(client, 'run.wait', { runId, timeoutMs: slice }, slice + 10_000);
    if (r.outcome !== 'submitted' || Date.now() >= end)
      return serviceOut(r, r.facts.state ? [`run ${runId} · ${String(r.facts.state)}`] : []);
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  jsonOut = parsed.ok ? parsed.parsed.json : parsed.json;
  if (!parsed.ok) {
    const name = argv.find((a) => a !== '--json'),
      evidence = name === 'evidence' || name === 'decision',
      code = evidence
        ? name === 'decision'
          ? 'sentinel.decision.inputRefused'
          : 'sentinel.evidence.inputRefused'
        : parsed.code;
    errOut(evidence ? word(code) : word(code, { detail: parsed.detail }));
    return finish(result(evidence ? name! : 'unknown', 'refused', { reasonCode: code }));
  }
  const p = parsed.parsed;
  try {
    return await dispatch(p);
  } catch (e) {
    // Whatever failed, the caller gets a typed result and a catalog word, not a stack trace.
    errOut(
      word('sentinel.cli.unexpected', {
        detail:
          (e as { code?: unknown }).code !== undefined
            ? String((e as { code?: unknown }).code)
            : ((e as Error)?.name ?? 'error'),
      }),
    );
    return finish(result(p.command, 'configuration-failure', { reasonCode: 'sentinel.cli.unexpected' }));
  }
}

async function dispatch(p: ParsedCommand): Promise<number> {
  switch (p.command) {
    case 'help':
      if (p.json) return finish(result('help', 'answered', { facts: { text: help() } }));
      out(help());
      return 0;
    case 'version': {
      const facts = { version: version(), contracts: ENVELOPES.run.schema.split('/')[1]! };
      if (p.json) return finish(result('version', 'answered', { facts }));
      out(word('sentinel.cli.version', { version: facts.version, draft: facts.contracts }));
      return 0;
    }
    case 'decision': {
      try {
        const wire = decisionWire(await ownerDecisionCommand(workspaceFor(p), p), p.json);
        (p.json || wire.result.exitCode === 0 ? out : errOut)(wire.text);
        return wire.result.exitCode;
      } catch {
        const wire = decisionWire(
          { result: result('decision', 'refused', { reasonCode: 'sentinel.decision.unavailable' }) },
          p.json,
        );
        (p.json ? out : errOut)(wire.text);
        return wire.result.exitCode;
      }
    }
    case 'evidence': {
      try {
        const wire = evidenceWire(await ownerEvidenceCommand(workspaceFor(p), p), p.json);
        (p.json || wire.result.exitCode === 0 ? out : errOut)(wire.text);
        return wire.result.exitCode;
      } catch {
        const wire = evidenceWire(
          { result: result('evidence', 'refused', { reasonCode: 'sentinel.evidence.storageRefused' }) },
          p.json,
        );
        (p.json ? out : errOut)(wire.text);
        return wire.result.exitCode;
      }
    }
    case 'capabilities':
      return capabilities(p);
    case 'owner-ui': {
      const origin = p.flags['--farsight-origin'];
      if (typeof origin !== 'string')
        return finish(result('owner-ui', 'configuration-failure', { reasonCode: 'sentinel.ownerUi.invalid' }));
      return (await import('./owner-ui/server.js')).runOwnerUi(workspaceFor(p), origin);
    }
    case 'mcp':
      return (await import('./service/mcp.js')).runMcp(workspaceFor(p));
    case 'prepare':
      return serviceOut(
        await (
          await import('./service/preparation-client.js')
        ).prepareCommand(workspaceFor(p), {
          action: p.args.action,
          confirm: p.flags['--confirm'] === true,
          requestKey: typeof p.flags['--request-key'] === 'string' ? p.flags['--request-key'] : undefined,
          parentId: typeof p.flags['--parent'] === 'string' ? p.flags['--parent'] : undefined,
        }),
      );
    case 'validate':
      return validate(p);
    case 'init':
      return init(p);
    case 'settings':
    case 'pipeline':
    case 'stage':
    case 'plan':
    case 'scan':
    case 'scans':
    case 'paths':
    case 'run':
    case 'status':
    case 'report':
    case 'compare':
    case 'serve':
    case 'wait':
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'rules':
    case 'assets':
    case 'retry':
    case 'rerun':
      return owner(p);
    default: {
      const change = plannedIn(p.command)!;
      errOut(word('sentinel.cli.unavailable', { command: p.command, change }));
      return finish(
        result(p.command, 'unavailable', { reasonCode: 'sentinel.outcome.unavailable', facts: { plannedIn: change } }),
      );
    }
  }
}

// The coordinator starts the preview detector as this same executable, with its adapter identity in the (otherwise
// empty) environment: then this process is that worker, not the command line. Nothing else selects it.
if (process.env.SENTINEL_ADAPTER_ID === PREVIEW_DETECTOR_ID) await runPreviewWorker();
else process.exitCode = await main(process.argv.slice(2));
