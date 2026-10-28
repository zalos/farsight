// AgentRunner: one interface over the CLIs an `agent` stage can run on (Copilot CLI, Claude Code).
//
// A runner qualifies its installed code (digest-pinned bytes, never a login or a model call) and runs one stage. Two
// modes: `brokered`, where Sentinel runs the loop, one admitted CLI turn at a time through the model broker and the
// review session (`session.ts`, `providers/broker.ts`); and `native`, where the CLI runs its own loop over a scratch
// tree holding only the stage's declared inputs. Both modes record the same provenance shape, so a report and the
// viewer draw them alike. The stage input and the provenance use the pipeline contract's agent field names
// (`AgentStageDefinition`, `AgentProvenance`); they are local types until that contract is imported here.
import type { Digest } from '../contracts/index.js';
import { fail } from './providers/errors.js';
import { COPILOT_NATIVE_PROFILE, qualifyInstalledNativeCopilot } from './providers/cli-copilot-profile.js';
import { CLAUDE_NATIVE_PROFILE, qualifyInstalledNativeClaude } from './providers/cli-native-profile.js';

export type AgentRunnerId = 'copilot-cli' | 'claude-cli';
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

export interface AgentRunResult {
  readonly output: unknown;
  readonly transcript: Uint8Array;
  readonly provenance: AgentRunProvenance;
}

export interface AgentRunner {
  readonly id: AgentRunnerId;
  /** The modes this runner has a qualified profile for on this platform. */
  readonly modes: readonly AgentMode[];
  qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification>;
  /**
   * Runs one stage. A `brokered` stage is a review session over the model broker (`review/dispatch.ts`), so a runner
   * refuses it here; `native` runs the CLI's own loop where this runner has a qualified native profile.
   */
  run(stage: AgentStageInput, inputs: readonly AgentInputFile[], scratch: string): Promise<AgentRunResult>;
}

const timingOf = (t?: { deadlineAt: number; signal?: AbortSignal }) => t ?? { deadlineAt: Date.now() + 5000 };

/** The refusal shared by every mode a runner does not run itself. */
function unsupported(stage: AgentStageInput, runner: AgentRunner): never {
  if (stage.runner !== runner.id) fail('sentinel.provider.invalidProfile', 'the stage names another runner');
  if (stage.mode === 'brokered')
    fail('sentinel.provider.invalidProfile', 'a brokered stage runs as a review session through the model broker');
  return fail('sentinel.provider.capabilityUntested', 'no qualified native profile for this runner');
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
  run(stage: AgentStageInput) {
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
