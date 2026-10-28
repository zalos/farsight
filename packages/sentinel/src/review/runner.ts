// AgentRunner: one interface over what an `agent` stage can run on — Copilot CLI, Claude Code, and the HTTP model
// APIs (Ollama, an OpenAI-compatible endpoint) behind their own flag.
//
// A runner qualifies its installed code (digest-pinned bytes, never a login or a model call) and runs one stage. Two
// modes: `brokered`, where Sentinel runs the loop, one admitted turn at a time through the model broker; and
// `native`, where a CLI runs its own loop over a scratch tree holding only the stage's declared inputs. Brokered is
// pure delegation over the review session: `run()` calls `runSession` with the caller, checkpoints and reader its
// caller built, so the admitted path (dispatch → runner → session → providerCaller → broker → registry → the CLI
// wrapper → the sandboxed runner) is unchanged byte for byte. Both modes record the same provenance shape. The stage
// input and provenance use the pipeline contract's agent field names.
import type { Digest } from '../contracts/index.js';
import type { AgentMode } from '../contracts/pipeline.js';
import { canonicalDigest } from '../policy/digest.js';
import { fail } from './providers/errors.js';
import { providerKind } from './providers/registry.js';
import { runSession, type RunSessionOptions, type SessionResult, type SessionSpec } from './session.js';
import {
  COPILOT_AGENT_PROFILE,
  copilotProfileById,
  copilotRuntimeInstallation,
  probeCopilotCredentialPath,
  qualifyInstalledNativeCopilot,
  type CopilotCredentialPath,
} from './providers/cli-copilot-profile.js';
import { CLAUDE_NATIVE_PROFILE, qualifyInstalledNativeClaude } from './providers/cli-native-profile.js';
import { safeInputPath, type CopilotAgentResult } from './providers/cli-copilot-agent.js';
import type { ModelBroker, ModelEnvelope } from './providers/broker.js';
import type { ProviderBinding } from './providers/profile.js';
import { reviewFail } from './errors.js';
import { NATIVE_REVIEW_INSTRUCTIONS, nativeOutputSchema, nativeTask, parseFinalAnswer } from './native.js';

/** The runners an agent stage can name (the pipeline contract's ids). */
export type AgentRunnerId = 'copilot-cli' | 'claude-cli' | 'hosted-api';
export type { AgentMode };

/** The agent stage a runner receives (the `agent` kind of the pipeline's `StageDefinition`, same field names). */
export interface AgentStageInput {
  readonly id: string;
  readonly kind: 'agent';
  readonly mode: AgentMode;
  readonly runner: AgentRunnerId;
  readonly model: string;
  /** The prompt a brokered stage sends, by pack reference; absent means the bundled prompt. */
  readonly prompt?: string;
  /** The instructions a native stage's CLI reads, by pack reference. */
  readonly instructions?: string;
  /** Ordered skill pack references: the order is part of the instruction bytes. */
  readonly skills?: readonly string[];
  /** The declared outputs; a native stage's output is validated against its schema before publication. */
  readonly produces?: readonly (string | { readonly name: string; readonly schema: string })[];
  readonly budget?: Readonly<{ turns?: number; tokens?: number; seconds?: number; usd?: string }>;
}

/** One materialised input: bytes the coordinator resolved and the withholding fold already passed. */
export interface AgentInputFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** What a model stage cost: rates and confirmed usage, or unobserved with its reason. Never a zero amount. */
export type AgentCost =
  | Readonly<{ basis: 'rates'; amount: string; currency: string }>
  | Readonly<{ basis: 'unobserved'; reason: 'subscription' | 'usage-unknown' | 'no-rates' }>;

/** The agent half of a stage's provenance: the same fields for both modes and both CLIs. */
export interface AgentRunProvenance {
  readonly mode: AgentMode;
  readonly runner: AgentRunnerId;
  readonly runnerVersion: string | null;
  readonly profileId: string;
  readonly executableDigest: Digest | null;
  /**
   * The installation that ran: its category and the exact resolved executable path. Private to the owner's record;
   * `publicProvenance` redacts the path before anything leaves it.
   */
  readonly installation: Readonly<{ source: string; executablePath: string }> | null;
  readonly model: Readonly<{ requested: string; reported: string | null; identitySource: 'host-reported' }>;
  readonly promptDigest: Digest | null;
  readonly skillDigests: readonly Digest[];
  readonly turns: number;
  readonly tokens: Readonly<{ input: number | null; output: number | null; certainty: 'confirmed' | 'uncertain' }>;
  readonly cost: AgentCost;
  readonly deadline: Readonly<{ grantedMs: number; usedMs: number | null }>;
  readonly where: 'sandboxed-cli';
}

/** What a qualification established: installed bytes matched one pinned profile. Not a login, not inference. */
export interface AgentQualification {
  readonly runner: AgentRunnerId;
  readonly profileId: string;
  readonly version: string;
  readonly executableDigest: Digest;
  readonly profileDigest: Digest;
  readonly modes: readonly AgentMode[];
  /** Which installation matched the pin (`configured`, `path`, `homebrew-cask`, `known-location`). */
  readonly installation?: string;
  /** The exact resolved executable path: private to the owner's qualification record, never in a public artifact. */
  readonly executablePath?: string;
  /** The credential path as probed once here: whether this process (a CLI or a service child) can reach the login. */
  readonly credentialPath?: CopilotCredentialPath;
}

/** A brokered run's result is the review session's own record, observations and private artifacts. */
export interface BrokeredRunResult {
  readonly mode: 'brokered';
  readonly session: SessionResult;
}
export interface NativeRunResult {
  readonly mode: 'native';
  /** The validated output, under the stage's declared output name. */
  readonly output: Readonly<{ name: string; schema: string; value: unknown }>;
  /** The CLI's JSONL event stream: every tool call and read, as printed. */
  readonly transcript: Uint8Array;
  /** The CLI's own Markdown export of the session (`--share`). */
  readonly share: Uint8Array;
  /** Scratch-relative paths the read tools opened, in first-read order. */
  readonly filesRead: readonly string[];
  readonly tools: readonly Readonly<{ tool: string; path: string | null }>[];
  readonly instructions: Uint8Array;
  readonly task: string;
  readonly provenance: AgentRunProvenance;
}
export type AgentRunResult = BrokeredRunResult | NativeRunResult;

/** What a brokered run needs: the session its caller prepared over an admitted envelope. */
export interface BrokeredRunContext {
  readonly spec: SessionSpec;
  readonly options: RunSessionOptions;
}
/** What a native run needs from its caller: an admitted envelope, the current binding and a stable operation id. */
export interface NativeRunContext {
  readonly broker: ModelBroker;
  readonly envelope: ModelEnvelope;
  /** The current genuine binding; compared with the envelope's on dispatch. */
  readonly binding: ProviderBinding;
  readonly operationId: string;
  readonly signal?: AbortSignal;
  /** Promoted instruction bytes for this stage; absent means the bundled native review instructions. */
  readonly instructions?: Uint8Array;
}
export interface AgentRunContext {
  readonly brokered?: BrokeredRunContext;
  readonly native?: NativeRunContext;
}

export interface AgentRunner {
  readonly id: AgentRunnerId;
  /** The modes this runner has a qualified profile for on this platform. */
  readonly modes: readonly AgentMode[];
  qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification>;
  /**
   * Runs one stage. A `brokered` stage is a review session over the model broker (`review/dispatch.ts`), so a runner
   * refuses it here; `native` runs the CLI's own loop where this runner has a qualified native profile. The CLI's
   * scratch tree is materialised inside the sandboxed runner's owned root and removed with it.
   */
  run(stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext): Promise<AgentRunResult>;
}

const timingOf = (t?: { deadlineAt: number; signal?: AbortSignal }) => t ?? { deadlineAt: Date.now() + 5000 };

/** Copilot native mode: the stage's budget, inputs and output schema in; a validated output and provenance out. */
async function runCopilotNative(
  stage: AgentStageInput,
  inputs: readonly AgentInputFile[],
  context: NativeRunContext,
): Promise<NativeRunResult> {
  if (stage.runner !== 'copilot-cli') fail('sentinel.provider.invalidProfile', 'the stage names another runner');
  const turns = stage.budget?.turns,
    tokens = stage.budget?.tokens,
    seconds = stage.budget?.seconds;
  if (
    !Number.isSafeInteger(turns) ||
    !Number.isSafeInteger(tokens) ||
    !Number.isSafeInteger(seconds) ||
    turns! < 1 ||
    tokens! < 1 ||
    seconds! < 1 ||
    seconds! > 600
  )
    return reviewFail('sentinel.review.nativeBudget');
  const named = (stage.produces ?? []).filter((p): p is { name: string; schema: string } => typeof p === 'object');
  if (named.length !== 1) return reviewFail('sentinel.review.outputSchema', 'a native stage declares one named output');
  const schema = nativeOutputSchema(named[0]!.schema);
  if (stage.instructions !== undefined && context.instructions === undefined)
    fail('sentinel.provider.invalidProfile', 'promoted stage instructions are read from their stage pack');
  if (stage.skills?.length) fail('sentinel.provider.invalidProfile', 'skills are read from their promoted packs');
  const paths = inputs.map((f) => safeInputPath(f.relativePath));
  if (new Set(paths).size !== paths.length || !paths.length)
    fail('sentinel.provider.invalidProfile', 'a native stage reads distinct inputs');
  const instructions = context.instructions ?? new TextEncoder().encode(NATIVE_REVIEW_INSTRUCTIONS.text + '\n');
  const task = nativeTask(stage.id, paths, schema);
  const pinned = context.binding.copilotProfile ? copilotProfileById(context.binding.copilotProfile.id) : undefined;
  // The vendor's login must be reachable from this process (a foreground CLI or a service child in the owner's login
  // session); a locked or absent login refuses here, before any reservation or launch.
  const credential = await probeCopilotCredentialPath({
    deadlineAt: Date.now() + 5000,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (credential.selector !== 'selected' || credential.keychain !== 'reachable')
    fail(
      'sentinel.provider.credentialUnavailable',
      `the Copilot login is not reachable from this process (selector ${credential.selector}, keychain ${credential.keychain})`,
    );
  const started = Date.now(),
    grantedMs = seconds! * 1000;
  const provenanceOf = (
    result: CopilotAgentResult,
    installation: Readonly<{ source: string; executable: string }> | null,
  ): AgentRunProvenance =>
    Object.freeze({
      mode: 'native' as const,
      runner: 'copilot-cli' as const,
      runnerVersion: pinned?.version ?? null,
      profileId: pinned?.id ?? COPILOT_AGENT_PROFILE.id,
      executableDigest: (pinned?.executableDigest ?? null) as Digest | null,
      installation: installation
        ? Object.freeze({ source: installation.source, executablePath: installation.executable })
        : null,
      model: Object.freeze({
        requested: context.binding.model,
        reported: result.reportedModel,
        identitySource: 'host-reported' as const,
      }),
      promptDigest: canonicalDigest({ instructions: Buffer.from(instructions).toString('base64'), task }) as Digest,
      skillDigests: Object.freeze([]),
      turns: result.turns,
      tokens: Object.freeze({
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        certainty: 'confirmed' as const,
      }),
      cost: Object.freeze({ basis: 'unobserved' as const, reason: 'subscription' as const }),
      deadline: Object.freeze({ grantedMs, usedMs: Date.now() - started }),
      where: 'sandboxed-cli' as const,
    });
  // A run that completed and settled but is then refused (another model answered, the stage's token budget was
  // exceeded, the answer fails its schema) keeps its transcript and provenance in a private failed-attempt record;
  // no stage output is published from it.
  const failed = (
    error: { code: string },
    result: CopilotAgentResult,
    installation: Readonly<{ source: string; executable: string }> | null,
  ): never => {
    throw new NativeRunFailure(
      error.code,
      Object.freeze({
        disclosure: 'private-only' as const,
        withholding: 'accepted-secret-fold-before-read' as const,
        failure: error.code,
        finalAnswer: result.finalAnswer,
        filesRead: result.filesRead,
        tools: result.tools,
        transcript: result.events,
        share: result.share,
        instructions,
        task,
        provenance: provenanceOf(result, installation),
      }),
      error,
    );
  };
  let reply: Awaited<ReturnType<ModelBroker['runAgent']>>;
  try {
    reply = await context.broker.runAgent(context.envelope, context.binding, {
      operationId: context.operationId,
      files: inputs.map((f) => ({ relativePath: f.relativePath, bytes: f.bytes })),
      instructions,
      task,
      maxTurns: turns!,
      tokens: tokens!,
      deadlineAt: started + grantedMs,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } catch (e) {
    const settled = (e as { agentResult?: CopilotAgentResult }).agentResult;
    if (settled) return failed(e as { code: string }, settled, null);
    throw e;
  }
  let value: unknown;
  try {
    value = schema.validate(
      parseFinalAnswer(reply.result.finalAnswer),
      new Set(paths),
      new Set(reply.result.filesRead),
    );
  } catch (e) {
    return failed(e as { code: string }, reply.result, reply.installation);
  }
  const provenance = provenanceOf(reply.result, reply.installation);
  return Object.freeze({
    mode: 'native' as const,
    output: Object.freeze({ name: named[0]!.name, schema: named[0]!.schema, value }),
    transcript: reply.result.events,
    share: reply.result.share,
    filesRead: reply.result.filesRead,
    tools: reply.result.tools,
    instructions,
    task,
    provenance,
  });
}

/** A provenance record as it may leave the owner's private record: the executable path redacted, nothing else. */
export function publicProvenance(p: AgentRunProvenance): AgentRunProvenance {
  return Object.freeze({
    ...p,
    installation: p.installation
      ? Object.freeze({ source: p.installation.source, executablePath: '<redacted>' })
      : null,
  });
}

/** What a refused native run retains privately: its transcript and provenance, never a stage output. */
export interface NativeFailedAttempt {
  readonly disclosure: 'private-only';
  /** The accepted-secret withholding fold runs over this record before any owner read. */
  readonly withholding: 'accepted-secret-fold-before-read';
  readonly failure: string;
  readonly finalAnswer: string;
  readonly filesRead: readonly string[];
  readonly tools: readonly Readonly<{ tool: string; path: string | null }>[];
  readonly transcript: Uint8Array;
  readonly share: Uint8Array;
  readonly instructions: Uint8Array;
  readonly task: string;
  readonly provenance: AgentRunProvenance;
}
/** A native run that completed and was refused afterwards. Its `code` is the refusal's catalog key. */
export class NativeRunFailure extends Error {
  readonly code: string;
  readonly retained: NativeFailedAttempt;
  constructor(code: string, retained: NativeFailedAttempt, cause: unknown) {
    super((cause as Error)?.message ?? code);
    this.name = 'NativeRunFailure';
    this.code = code;
    this.retained = retained;
  }
}

/** Brokered: exactly the review session today's dispatch ran. Native: the runner's own native run, if it has one. */
async function delegate(
  runner: AgentRunner,
  stage: AgentStageInput,
  inputs: readonly AgentInputFile[],
  context: AgentRunContext,
  native?: (stage: AgentStageInput, inputs: readonly AgentInputFile[], c: NativeRunContext) => Promise<NativeRunResult>,
): Promise<AgentRunResult> {
  if (stage.kind !== 'agent' || stage.runner !== runner.id)
    fail('sentinel.provider.invalidProfile', 'the stage names another runner');
  if (!runner.modes.includes(stage.mode) || (stage.mode === 'native' && !native))
    return fail('sentinel.provider.capabilityUntested', 'no qualified native profile for this runner');
  if (stage.mode === 'native') {
    if (!context.native) return fail('sentinel.provider.invalidProfile', 'a native stage needs its admitted envelope');
    return native!(stage, inputs, context.native);
  }
  if (!context.brokered) return fail('sentinel.provider.invalidProfile', 'a brokered stage needs its prepared session');
  return Object.freeze({
    mode: 'brokered' as const,
    session: await runSession(context.brokered.spec, context.brokered.options),
  });
}

export const COPILOT_RUNNER: AgentRunner = Object.freeze({
  id: 'copilot-cli' as const,
  modes: Object.freeze(['brokered', 'native'] as const),
  async qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification> {
    const runtime = await qualifyInstalledNativeCopilot(timingOf(timing), COPILOT_AGENT_PROFILE);
    return Object.freeze({
      runner: 'copilot-cli' as const,
      profileId: runtime.profileId,
      version: COPILOT_AGENT_PROFILE.version,
      executableDigest: runtime.executableDigest as Digest,
      profileDigest: runtime.profileDigest as Digest,
      modes: COPILOT_RUNNER.modes,
      installation: copilotRuntimeInstallation(runtime).source,
      executablePath: copilotRuntimeInstallation(runtime).executable,
      credentialPath: await probeCopilotCredentialPath(timingOf(timing)),
    });
  },
  run: (stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(COPILOT_RUNNER, stage, inputs, context, runCopilotNative),
});

export const CLAUDE_RUNNER: AgentRunner = Object.freeze({
  id: 'claude-cli' as const,
  modes: Object.freeze(['brokered'] as const),
  async qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification> {
    const runtime = await qualifyInstalledNativeClaude(timingOf(timing));
    return Object.freeze({
      runner: 'claude-cli' as const,
      profileId: runtime.profileId,
      version: CLAUDE_NATIVE_PROFILE.version,
      executableDigest: runtime.executableDigest as Digest,
      profileDigest: runtime.profileDigest as Digest,
      modes: CLAUDE_RUNNER.modes,
    });
  },
  run: (stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(CLAUDE_RUNNER, stage, inputs, context),
});

/**
 * The HTTP model APIs (Ollama, OpenAI-compatible): brokered only, through the same session and broker. There is no
 * installed code to qualify; an HTTP provider is qualified by the owner's capability probe of its exact origin.
 */
export const HTTP_API_RUNNER: AgentRunner = Object.freeze({
  id: 'hosted-api' as const,
  modes: Object.freeze(['brokered'] as const),
  qualify: () =>
    Promise.resolve().then(() =>
      fail('sentinel.provider.capabilityUntested', 'an HTTP provider is qualified by its capability probe'),
    ),
  run: (stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(HTTP_API_RUNNER, stage, inputs, context),
});

const RUNNERS = new Map<string, AgentRunner>([
  [COPILOT_RUNNER.id, COPILOT_RUNNER],
  [CLAUDE_RUNNER.id, CLAUDE_RUNNER],
  [HTTP_API_RUNNER.id, HTTP_API_RUNNER],
]);
/** Every runner, in a fixed order. */
export const AGENT_RUNNERS: readonly AgentRunner[] = Object.freeze([COPILOT_RUNNER, CLAUDE_RUNNER, HTTP_API_RUNNER]);
/** The runner a stage names; an unknown runner is refused, never defaulted. */
export function agentRunner(id: string): AgentRunner {
  return RUNNERS.get(id) ?? fail('sentinel.provider.invalidProfile', 'unknown agent runner');
}
/** The runner a provider kind's turns run on, from the registry; an unregistered kind is refused. */
export const runnerForKind = (kind: string): AgentRunner => agentRunner(providerKind(kind).runner);
