// AgentRunner: one interface over what an `agent` stage can run on — Copilot CLI, Claude Code, and the HTTP model
// APIs (Ollama, an OpenAI-compatible endpoint) behind their own flag.
//
// A runner qualifies its installed code (digest-pinned bytes, never a login or a model call) and runs one stage. Two
// modes: `brokered`, where Sentinel runs the loop, one admitted turn at a time through the model broker; and
// `native`, where a CLI runs its own loop over a scratch tree holding only the stage's declared inputs. Brokered is
// pure delegation over the review session as it is today: `run()` calls `runSession` with the caller, checkpoints
// and reader its caller built, so the admitted path (dispatch → runner → session → providerCaller → broker →
// registry → the CLI wrapper → the sandboxed runner) is unchanged byte for byte. The stage input and provenance
// use the pipeline contract's agent field names; they are local types until that contract is imported here.
import type { Digest } from '../contracts/index.js';
import { fail } from './providers/errors.js';
import { providerKind } from './providers/registry.js';
import { runSession, type RunSessionOptions, type SessionResult, type SessionSpec } from './session.js';
import { COPILOT_NATIVE_PROFILE, qualifyInstalledNativeCopilot } from './providers/cli-copilot-profile.js';
import { CLAUDE_NATIVE_PROFILE, qualifyInstalledNativeClaude } from './providers/cli-native-profile.js';

/** The runners an agent stage can name (the pipeline contract's ids). */
export type AgentRunnerId = 'copilot-cli' | 'claude-cli' | 'hosted-api';
export type AgentMode = 'brokered' | 'native';

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
}

/** What a brokered run needs: the session its caller prepared over an admitted envelope. */
export interface BrokeredRunContext {
  readonly spec: SessionSpec;
  readonly options: RunSessionOptions;
}
export interface AgentRunContext {
  readonly brokered?: BrokeredRunContext;
}
/** A brokered run's result is the review session's own record, observations and private artifacts. */
export interface AgentRunResult {
  readonly mode: 'brokered';
  readonly session: SessionResult;
}

export interface AgentRunner {
  readonly id: AgentRunnerId;
  /** The modes this runner has a qualified profile for on this platform. */
  readonly modes: readonly AgentMode[];
  qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification>;
  /**
   * Runs one stage. `brokered` delegates to the review session its caller prepared; `native` runs the CLI's own
   * loop where this runner has a qualified native profile, and is refused where it has none.
   */
  run(stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext): Promise<AgentRunResult>;
}

const timingOf = (t?: { deadlineAt: number; signal?: AbortSignal }) => t ?? { deadlineAt: Date.now() + 5000 };

/** Brokered: exactly the review session today's dispatch ran. Native: refused until a native profile qualifies. */
async function delegate(
  runner: AgentRunner,
  stage: AgentStageInput,
  context: AgentRunContext,
): Promise<AgentRunResult> {
  if (stage.kind !== 'agent' || stage.runner !== runner.id)
    fail('sentinel.provider.invalidProfile', 'the stage names another runner');
  if (stage.mode !== 'brokered' || !runner.modes.includes(stage.mode))
    return fail('sentinel.provider.capabilityUntested', 'no qualified native profile for this runner');
  if (!context.brokered) return fail('sentinel.provider.invalidProfile', 'a brokered stage needs its prepared session');
  return Object.freeze({
    mode: 'brokered' as const,
    session: await runSession(context.brokered.spec, context.brokered.options),
  });
}

export const COPILOT_RUNNER: AgentRunner = Object.freeze({
  id: 'copilot-cli' as const,
  modes: Object.freeze(['brokered'] as const),
  async qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification> {
    const runtime = await qualifyInstalledNativeCopilot(timingOf(timing));
    return Object.freeze({
      runner: 'copilot-cli' as const,
      profileId: runtime.profileId,
      version: COPILOT_NATIVE_PROFILE.version,
      executableDigest: runtime.executableDigest as Digest,
      profileDigest: runtime.profileDigest as Digest,
      modes: COPILOT_RUNNER.modes,
    });
  },
  run: (stage: AgentStageInput, _inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(COPILOT_RUNNER, stage, context),
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
  run: (stage: AgentStageInput, _inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(CLAUDE_RUNNER, stage, context),
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
  run: (stage: AgentStageInput, _inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(HTTP_API_RUNNER, stage, context),
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
