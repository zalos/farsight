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
import type { AgentMode, AgentRunnerId as DeclaredRunnerId } from '../contracts/pipeline.js';
import { createHash } from 'node:crypto';
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
import {
  CLAUDE_AGENT_PROFILE,
  claudeProfileById,
  claudeRuntimeInstallation,
  nativeRuntimeHelper,
  qualifyInstalledNativeClaude,
} from './providers/cli-native-profile.js';
import { probeNativeLogin, type NativeLoginProbe } from './providers/cli-native-helper.js';
import { safeInputPath, type CopilotAgentPartial, type CopilotAgentResult } from './providers/cli-copilot-agent.js';
import type { ModelBroker, ModelEnvelope } from './providers/broker.js';
import type { ProviderBinding } from './providers/profile.js';
import { reviewFail } from './errors.js';
import {
  CLAUDE_TASK_LAYOUT,
  COPILOT_TASK_LAYOUT,
  NATIVE_REVIEW_INSTRUCTIONS,
  nativeOutputSchema,
  nativeTask,
  parseFinalAnswer,
  type NativeTaskLayout,
} from './native.js';
import { resolveStageInstructions, stagePackDigests, type ResolvedStageInstructions } from './packs.js';

/**
 * The runners Sentinel implements, each one of the pipeline contract's declarable runner ids, so a contract change to
 * one of them fails this build. A declarable id with no runner here (`ollama`) is not one.
 */
export type AgentRunnerId = Extract<DeclaredRunnerId, 'copilot-cli' | 'claude-cli' | 'hosted-api'>;
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
  readonly credentialPath?: CopilotCredentialPath | ClaudeCredentialPath;
}

/** Claude's two login paths, as classes: never an item, a token or a path. */
export interface ClaudeCredentialPath {
  /** The vendor login the brokered profile's fixed helper reads: `reachable`, or the helper's refusal class. */
  readonly vendorLogin: 'reachable' | Extract<NativeLoginProbe, { reachable: false }>['reason'];
  /** The native profile's credential: the owner's token under an adopted reference, read by the broker at admission. */
  readonly native: 'adopted-reference';
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
  /** Every pack reference the stage used and the pack digest it resolved to, as the pipeline digest covers them. */
  readonly packs: readonly Readonly<{ ref: string; digest: string }>[];
  /** The exact instruction record sealed before the broker call (owner-private). */
  readonly instructionRecord: NativeInstructionRecord;
  /** Other models the CLI reported usage for (a background model), apart from the answering one (owner-private). */
  readonly secondaryModels: readonly string[];
  /** The promoted skills, in order, with each file's digest: the exact bytes that were materialised. */
  readonly skills: readonly Readonly<{
    ref: string;
    digest: string;
    files: readonly Readonly<{ path: string; digest: string }>[];
  }>[];
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
  /**
   * The workspace trust folder that holds promoted stage packs. Required when the stage names instructions or
   * skills; every referenced byte is re-checked against the pack lock here, before anything is admitted or sent.
   */
  readonly trustDir?: string;
  /**
   * Seals the exact instruction record before anything is admitted or sent: the caller retains it owner-privately,
   * behind the accepted-secret withholding fold. A failure here dispatches nothing.
   */
  readonly retain?: (record: NativeInstructionRecord) => Promise<void>;
  /**
   * The pack binding an admitted spec sealed: when given, the packs resolved here must be exactly these (reference and
   * digest, in order), before the credential probe, any reservation or any launch.
   */
  readonly packs?: readonly Readonly<{ ref: string; digest: string }>[];
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

/** What differs between the two CLIs' native modes; the run itself is one function over these. */
interface NativeFlavor {
  readonly runner: 'copilot-cli' | 'claude-cli';
  /** The task's wording and where the scratch tree holds instructions and skills. */
  readonly layout: NativeTaskLayout;
  /** The adopted pin's profile, or undefined when the binding names none this runner knows. */
  pinned(binding: ProviderBinding): Readonly<{ id: string; version: string; executableDigest: string }> | undefined;
  readonly fallbackProfileId: string;
  /** Refuses with `credentialUnavailable`, before any reservation or launch, when the login cannot be reached. */
  probe(timing: { deadlineAt: number; signal?: AbortSignal }): Promise<void>;
  /** The CLI enforces the output schema and a dollar ceiling itself (`--json-schema`, `--max-budget-usd`). */
  readonly enforces: boolean;
}

const COPILOT_FLAVOR: NativeFlavor = Object.freeze({
  runner: 'copilot-cli' as const,
  layout: COPILOT_TASK_LAYOUT,
  pinned: (b: ProviderBinding) => (b.copilotProfile ? copilotProfileById(b.copilotProfile.id) : undefined),
  fallbackProfileId: COPILOT_AGENT_PROFILE.id,
  // The vendor's login must be reachable from this process (a foreground CLI or a service child in the owner's
  // login session); a locked or absent login refuses here, before any reservation or launch.
  async probe(timing: { deadlineAt: number; signal?: AbortSignal }) {
    const credential = await probeCopilotCredentialPath(timing);
    if (credential.selector !== 'selected' || credential.keychain !== 'reachable')
      fail(
        'sentinel.provider.credentialUnavailable',
        `the Copilot login is not reachable from this process (selector ${credential.selector}, keychain ${credential.keychain})`,
      );
  },
  enforces: false,
});

const CLAUDE_FLAVOR: NativeFlavor = Object.freeze({
  runner: 'claude-cli' as const,
  layout: CLAUDE_TASK_LAYOUT,
  pinned: (b: ProviderBinding) => (b.nativeProfile ? claudeProfileById(b.nativeProfile.id) : undefined),
  fallbackProfileId: CLAUDE_AGENT_PROFILE.id,
  // The owner's token was read by the broker from the adopted reference when the envelope was admitted; an
  // unreadable reference denied admission there. Nothing is read again here.
  probe: () => Promise.resolve(),
  enforces: true,
});

/** A native run: the stage's budget, inputs and output schema in; a validated output and provenance out. */
async function runNative(
  flavor: NativeFlavor,
  stage: AgentStageInput,
  inputs: readonly AgentInputFile[],
  context: NativeRunContext,
): Promise<NativeRunResult> {
  if (stage.runner !== flavor.runner) fail('sentinel.provider.invalidProfile', 'the stage names another runner');
  if (
    stage.budget?.usd !== undefined &&
    (!flavor.enforces || !/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/.test(stage.budget.usd))
  )
    return reviewFail('sentinel.review.nativeBudget');
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
  // Every supplied pack field is validated before dispatch: a native stage naming a `prompt` is refused, never run
  // with the bundled instructions instead.
  const packed = stage.instructions !== undefined || stage.prompt !== undefined || Boolean(stage.skills?.length);
  if (packed && context.trustDir === undefined)
    fail('sentinel.provider.invalidProfile', 'promoted instructions and skills are read from the trust folder');
  // Changed or unapproved pack bytes refuse here, before the credential probe, any reservation or any launch.
  const resolved: ResolvedStageInstructions = packed
    ? resolveStageInstructions(context.trustDir!, { ...stage, mode: 'native' })
    : Object.freeze({ text: null, skills: Object.freeze([]) });
  // A stage with packs runs only after its exact instruction record is sealed by the caller.
  if (packed && !context.retain) return reviewFail('sentinel.review.instructionsUnsealed');
  // An admitted spec's packs are its own: a trust folder that now resolves other bytes refuses here.
  if (context.packs && canonicalDigest(stagePackDigests(resolved)) !== canonicalDigest(context.packs))
    return reviewFail(
      'sentinel.review.packChanged',
      'the trust folder resolves other pack bytes than the admitted spec sealed',
    );
  const paths = inputs.map((f) => safeInputPath(f.relativePath));
  if (new Set(paths).size !== paths.length || !paths.length)
    fail('sentinel.provider.invalidProfile', 'a native stage reads distinct inputs');
  const instructions = resolved.text?.bytes ?? new TextEncoder().encode(NATIVE_REVIEW_INSTRUCTIONS.text + '\n');
  // The sealed digests are taken now, from the pack lock (skills, a promoted instructions file) or from the bytes as
  // first received (inputs, the bundled instructions); the request carries its own copies, so nothing a caller does
  // to the record can change what is written, and the scratch tree is verified against these strings.
  const skills = resolved.skills.map((k) =>
    Object.freeze({
      id: k.id,
      files: k.files.map((f) => Object.freeze({ path: f.path, bytes: Uint8Array.from(f.bytes), digest: f.digest })),
    }),
  );
  const inputDigests = Object.freeze(inputs.map((f) => 'sha256:' + createHash('sha256').update(f.bytes).digest('hex')));
  const instructionsDigest =
    resolved.text?.digest ?? 'sha256:' + createHash('sha256').update(instructions).digest('hex');
  const sendInputs = inputs.map((f) => ({ relativePath: f.relativePath, bytes: Uint8Array.from(f.bytes) }));
  const sendInstructions = Uint8Array.from(instructions);
  const task = nativeTask(
    stage.id,
    paths,
    schema,
    resolved.skills.map((k) => k.id),
    flavor.layout,
  );
  const pinned = flavor.pinned(context.binding);
  await flavor.probe({ deadlineAt: Date.now() + 5000, ...(context.signal ? { signal: context.signal } : {}) });
  const started = Date.now(),
    grantedMs = seconds! * 1000;
  type Installation = Readonly<{ source: string; executable: string }> | null;
  /** One shape for every run: a settled one (confirmed usage) or one that stopped before settling (uncertain). */
  const provenanceOf = (
    seen: Readonly<{ turns: number; reportedModel: string | null; usage: CopilotAgentResult['usage'] | null }>,
    installation: Installation,
  ): AgentRunProvenance =>
    Object.freeze({
      mode: 'native' as const,
      runner: flavor.runner,
      runnerVersion: pinned?.version ?? null,
      profileId: pinned?.id ?? flavor.fallbackProfileId,
      executableDigest: (pinned?.executableDigest ?? null) as Digest | null,
      installation: installation
        ? Object.freeze({ source: installation.source, executablePath: installation.executable })
        : null,
      model: Object.freeze({
        requested: context.binding.model,
        reported: seen.reportedModel,
        identitySource: 'host-reported' as const,
      }),
      promptDigest: canonicalDigest({ instructions: Buffer.from(instructions).toString('base64'), task }) as Digest,
      skillDigests: Object.freeze(resolved.skills.map((k) => k.digest as Digest)),
      turns: seen.turns,
      tokens: seen.usage
        ? Object.freeze({
            input: seen.usage.inputTokens,
            output: seen.usage.outputTokens,
            certainty: 'confirmed' as const,
          })
        : Object.freeze({ input: null, output: null, certainty: 'uncertain' as const }),
      cost: Object.freeze({
        basis: 'unobserved' as const,
        reason: seen.usage ? ('subscription' as const) : ('usage-unknown' as const),
      }),
      deadline: Object.freeze({ grantedMs, usedMs: Date.now() - started }),
      where: 'sandboxed-cli' as const,
    });
  // Every native run that is refused keeps its inspection ledger and provenance in a private failed-attempt record,
  // and publishes no stage output. A run that completed and settled (another model answered, the token budget was
  // exceeded, the answer fails its schema) keeps its whole stream and share transcript, with confirmed usage; a run
  // that stopped before completing (a denied tool, a malformed stream, the deadline) keeps the bounded partial stream
  // the monitor captured, with usage uncertain.
  const failed = (
    error: { code: string },
    seen: Readonly<{
      finalAnswer: string | null;
      reportedModel: string | null;
      turns: number;
      tools: CopilotAgentResult['tools'];
      filesRead: readonly string[];
      events: Uint8Array;
      share: Uint8Array;
      usage: CopilotAgentResult['usage'] | null;
    }>,
    installation: Installation,
  ): never => {
    throw new NativeRunFailure(
      error.code,
      Object.freeze({
        disclosure: 'private-only' as const,
        withholding: 'accepted-secret-fold-before-read' as const,
        failure: error.code,
        completed: seen.usage !== null,
        finalAnswer: seen.finalAnswer,
        filesRead: seen.filesRead,
        tools: seen.tools,
        transcript: seen.events,
        share: seen.share,
        instructions,
        task,
        provenance: provenanceOf(seen, installation),
        instructionRecord: record,
      }),
      error,
    );
  };
  const sha = (b: Uint8Array) => ('sha256:' + createHash('sha256').update(b).digest('hex')) as Digest;
  const record: NativeInstructionRecord = Object.freeze({
    schema: 'sentinel-native-instructions/draft-1' as const,
    disclosure: 'private-only' as const,
    withholding: 'accepted-secret-fold-before-read' as const,
    stage: stage.id,
    instructions: Object.freeze({
      ref: resolved.text?.ref ?? null,
      digest: instructionsDigest as Digest,
      bytes: Uint8Array.from(instructions),
    }),
    inputs: Object.freeze(
      inputs.map((f, i) => Object.freeze({ relativePath: f.relativePath, digest: inputDigests[i] as Digest })),
    ),
    task: Object.freeze({ digest: sha(Buffer.from(task)), text: task }),
    skills: Object.freeze(
      resolved.skills.map((k) =>
        Object.freeze({
          ref: k.ref,
          digest: k.digest,
          files: Object.freeze(
            k.files.map((f) =>
              Object.freeze({ path: f.path, digest: f.digest as Digest, bytes: Uint8Array.from(f.bytes) }),
            ),
          ),
        }),
      ),
    ),
    packs: stagePackDigests(resolved),
  });
  // Sealed before the broker call: the record exists (and the caller retained it) before any byte is sent.
  if (context.retain) await context.retain(record);
  let reply: Awaited<ReturnType<ModelBroker['runAgent']>>;
  try {
    reply = await context.broker.runAgent(context.envelope, context.binding, {
      operationId: context.operationId,
      files: sendInputs,
      instructions: sendInstructions,
      digests: Object.freeze({ instructions: instructionsDigest, files: inputDigests }),
      task,
      ...(skills.length ? { skills } : {}),
      maxTurns: turns!,
      tokens: tokens!,
      deadlineAt: started + grantedMs,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(flavor.enforces ? { jsonSchema: JSON.stringify(schema.jsonSchema) } : {}),
      ...(flavor.enforces && stage.budget?.usd !== undefined ? { maxUsd: stage.budget.usd } : {}),
    });
  } catch (e) {
    const refused = e as {
      code: string;
      agentResult?: CopilotAgentResult;
      agentPartial?: CopilotAgentPartial;
      agentInstallation?: Readonly<{ source: string; executable: string }>;
    };
    if (refused.agentResult) return failed(refused, refused.agentResult, refused.agentInstallation ?? null);
    if (refused.agentPartial)
      return failed(
        refused,
        {
          finalAnswer: null,
          reportedModel: null,
          turns: refused.agentPartial.turns,
          tools: refused.agentPartial.tools,
          filesRead: refused.agentPartial.filesRead,
          events: refused.agentPartial.stream,
          share: new Uint8Array(0),
          usage: null,
        },
        refused.agentInstallation ?? null,
      );
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
    return failed(e as { code: string }, { ...reply.result, events: reply.result.events }, reply.installation);
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
    packs: stagePackDigests(resolved),
    instructionRecord: record,
    secondaryModels: Object.freeze([...(reply.result.secondaryModels ?? [])]),
    skills: Object.freeze(
      resolved.skills.map((k) =>
        Object.freeze({
          ref: k.ref,
          digest: k.digest,
          files: Object.freeze(k.files.map((f) => Object.freeze({ path: f.path, digest: f.digest }))),
        }),
      ),
    ),
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

/**
 * The exact instructions a native stage sends, sealed before the broker call: the instructions file, the task, every
 * promoted skill file with its digest, and the pack references they resolved from. Owner-private; the accepted-secret
 * withholding fold runs over it before any read.
 */
export interface NativeInstructionRecord {
  readonly schema: 'sentinel-native-instructions/draft-1';
  readonly disclosure: 'private-only';
  readonly withholding: 'accepted-secret-fold-before-read';
  readonly stage: string;
  readonly instructions: Readonly<{ ref: string | null; digest: Digest; bytes: Uint8Array }>;
  /** Each input's digest as first received; the scratch tree is verified against these, never against buffers. */
  readonly inputs: readonly Readonly<{ relativePath: string; digest: Digest }>[];
  readonly task: Readonly<{ digest: Digest; text: string }>;
  readonly skills: readonly Readonly<{
    ref: string;
    digest: string;
    files: readonly Readonly<{ path: string; digest: Digest; bytes: Uint8Array }>[];
  }>[];
  readonly packs: readonly Readonly<{ ref: string; digest: string }>[];
}

/** What a refused native run retains privately: its transcript and provenance, never a stage output. */
export interface NativeFailedAttempt {
  readonly disclosure: 'private-only';
  /** The accepted-secret withholding fold runs over this record before any owner read. */
  readonly withholding: 'accepted-secret-fold-before-read';
  readonly failure: string;
  /** Whether the run completed and settled (confirmed usage) before it was refused, or stopped before that. */
  readonly completed: boolean;
  readonly finalAnswer: string | null;
  readonly filesRead: readonly string[];
  readonly tools: readonly Readonly<{ tool: string; path: string | null }>[];
  readonly transcript: Uint8Array;
  readonly share: Uint8Array;
  readonly instructions: Uint8Array;
  readonly task: string;
  readonly provenance: AgentRunProvenance;
  readonly instructionRecord: NativeInstructionRecord;
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
    delegate(COPILOT_RUNNER, stage, inputs, context, (st, i, c) => runNative(COPILOT_FLAVOR, st, i, c)),
});

export const CLAUDE_RUNNER: AgentRunner = Object.freeze({
  id: 'claude-cli' as const,
  modes: Object.freeze(['brokered', 'native'] as const),
  async qualify(timing?: { deadlineAt: number; signal?: AbortSignal }): Promise<AgentQualification> {
    const runtime = await qualifyInstalledNativeClaude(timingOf(timing), CLAUDE_AGENT_PROFILE);
    const installation = claudeRuntimeInstallation(runtime);
    // The class of each login path, read once: the vendor login through the fixed helper (what the brokered profile
    // uses), and the native profile's adopted token reference, which only the broker reads, at admission.
    const vendor = await probeNativeLogin(nativeRuntimeHelper(runtime), timingOf(timing));
    return Object.freeze({
      runner: 'claude-cli' as const,
      profileId: runtime.profileId,
      version: CLAUDE_AGENT_PROFILE.version,
      executableDigest: runtime.executableDigest as Digest,
      profileDigest: runtime.profileDigest as Digest,
      modes: CLAUDE_RUNNER.modes,
      installation: installation.source,
      executablePath: installation.executable,
      credentialPath: Object.freeze({
        vendorLogin: vendor.reachable ? ('reachable' as const) : vendor.reason,
        native: 'adopted-reference' as const,
      }),
    });
  },
  run: (stage: AgentStageInput, inputs: readonly AgentInputFile[], context: AgentRunContext) =>
    delegate(CLAUDE_RUNNER, stage, inputs, context, (st, i, c) => runNative(CLAUDE_FLAVOR, st, i, c)),
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
/** Whether an adopted pin runs its own loop: a native-mode profile runs native agent stages only. */
export const pinRunsNative = (binding: ProviderBinding): boolean =>
  providerKind(binding.kind).cli?.mode(binding) === 'native';
/** Every runner, in a fixed order. */
export const AGENT_RUNNERS: readonly AgentRunner[] = Object.freeze([COPILOT_RUNNER, CLAUDE_RUNNER, HTTP_API_RUNNER]);
/** The runner a stage names; an unknown runner is refused, never defaulted. */
export function agentRunner(id: string): AgentRunner {
  return RUNNERS.get(id) ?? fail('sentinel.provider.invalidProfile', 'unknown agent runner');
}
/** The runner a provider kind's turns run on, from the registry; an unregistered kind is refused. */
export const runnerForKind = (kind: string): AgentRunner => agentRunner(providerKind(kind).runner);
