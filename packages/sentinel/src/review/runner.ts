// AgentRunner: one interface over the CLIs an `agent` stage can run on (Copilot CLI, Claude Code).
//
// A runner qualifies its installed code (digest-pinned bytes, never a login or a model call) and runs one stage. Two
// modes: `brokered`, where Sentinel runs the loop, one admitted CLI turn at a time through the model broker and the
// review session (`session.ts`, `providers/broker.ts`); and `native`, where the CLI runs its own loop over a scratch
// tree holding only the stage's declared inputs. Both modes record the same provenance shape, so a report and the
// viewer draw them alike. The stage input and the provenance use the pipeline contract's agent field names
// (`AgentStageDefinition`, `AgentProvenance`); they are local types until that contract is imported here.
import type { Digest } from '../contracts/index.js';
import type { AgentMode } from '../contracts/pipeline.js';
import { canonicalDigest } from '../policy/digest.js';
import { fail } from './providers/errors.js';
import {
  COPILOT_AGENT_PROFILE,
  copilotProfileById,
  copilotRuntimeInstallation,
  probeCopilotCredentialPath,
  qualifyInstalledNativeCopilot,
  type CopilotCredentialPath,
} from './providers/cli-copilot-profile.js';
import { CLAUDE_NATIVE_PROFILE, qualifyInstalledNativeClaude } from './providers/cli-native-profile.js';
import { safeInputPath } from './providers/cli-copilot-agent.js';
import type { ModelBroker, ModelEnvelope } from './providers/broker.js';
import type { ProviderBinding } from './providers/profile.js';
import { reviewFail } from './errors.js';
import { NATIVE_REVIEW_INSTRUCTIONS, nativeOutputSchema, nativeTask, parseFinalAnswer } from './native.js';

/** The CLI runners an agent stage can name here; `hosted-api` stays behind its flag and has no runner yet. */
export type AgentRunnerId = 'copilot-cli' | 'claude-cli';
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
  /** The credential path as probed once here: whether this process (a CLI or a service child) can reach the login. */
  readonly credentialPath?: CopilotCredentialPath;
}

export interface AgentRunResult {
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

/** What a native run needs from its caller: an admitted envelope, the current binding and a stable operation id. */
export interface AgentRunContext {
  readonly broker: ModelBroker;
  readonly envelope: ModelEnvelope;
  /** The current genuine binding; compared with the envelope's on dispatch. */
  readonly binding: ProviderBinding;
  readonly operationId: string;
  readonly signal?: AbortSignal;
  /** Promoted instruction bytes for this stage; absent means the bundled native review instructions. */
  readonly instructions?: Uint8Array;
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

/** The refusal shared by every mode a runner does not run itself. */
function unsupported(stage: AgentStageInput, runner: AgentRunner): never {
  if (stage.runner !== runner.id) fail('sentinel.provider.invalidProfile', 'the stage names another runner');
  if (stage.mode === 'brokered')
    fail('sentinel.provider.invalidProfile', 'a brokered stage runs as a review session through the model broker');
  return fail('sentinel.provider.capabilityUntested', 'no qualified native profile for this runner');
}

/** Copilot native mode: the stage's budget, inputs and output schema in; a validated output and provenance out. */
async function runCopilotNative(
  stage: AgentStageInput,
  inputs: readonly AgentInputFile[],
  context: AgentRunContext,
): Promise<AgentRunResult> {
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
  const reply = await context.broker.runAgent(context.envelope, context.binding, {
    operationId: context.operationId,
    files: inputs.map((f) => ({ relativePath: f.relativePath, bytes: f.bytes })),
    instructions,
    task,
    maxTurns: turns!,
    tokens: tokens!,
    deadlineAt: started + grantedMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const usedMs = Date.now() - started;
  const value = schema.validate(
    parseFinalAnswer(reply.result.finalAnswer),
    new Set(paths),
    new Set(reply.result.filesRead),
  );
  const provenance: AgentRunProvenance = Object.freeze({
    mode: 'native' as const,
    runner: 'copilot-cli' as const,
    runnerVersion: pinned?.version ?? null,
    profileId: pinned?.id ?? COPILOT_AGENT_PROFILE.id,
    executableDigest: (pinned?.executableDigest ?? null) as Digest | null,
    model: Object.freeze({
      requested: reply.identity.requestedModel,
      reported: reply.identity.returnedModel,
      identitySource: 'host-reported' as const,
    }),
    promptDigest: canonicalDigest({ instructions: Buffer.from(instructions).toString('base64'), task }) as Digest,
    skillDigests: Object.freeze([]),
    turns: reply.result.turns,
    tokens: Object.freeze({
      input: reply.usage.inputTokens,
      output: reply.usage.outputTokens,
      certainty: 'confirmed' as const,
    }),
    cost: Object.freeze({ basis: 'unobserved' as const, reason: 'subscription' as const }),
    deadline: Object.freeze({ grantedMs, usedMs }),
    where: 'sandboxed-cli' as const,
  });
  return Object.freeze({
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
      credentialPath: await probeCopilotCredentialPath(timingOf(timing)),
    });
  },
  run(stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext) {
    if (stage.mode === 'native') return runCopilotNative(stage, inputs, context);
    return Promise.resolve().then(() => unsupported(stage, COPILOT_RUNNER));
  },
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
  run(stage: AgentStageInput) {
    return Promise.resolve().then(() => unsupported(stage, CLAUDE_RUNNER));
  },
});

const RUNNERS = new Map<string, AgentRunner>([
  [COPILOT_RUNNER.id, COPILOT_RUNNER],
  [CLAUDE_RUNNER.id, CLAUDE_RUNNER],
]);
/** Every runner, in a fixed order. */
export const AGENT_RUNNERS: readonly AgentRunner[] = Object.freeze([COPILOT_RUNNER, CLAUDE_RUNNER]);
/** The runner a stage names; an unknown runner is refused, never defaulted. */
export function agentRunner(id: string): AgentRunner {
  return RUNNERS.get(id) ?? fail('sentinel.provider.invalidProfile', 'unknown agent runner');
}
