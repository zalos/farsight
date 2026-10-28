// One admitted native-mode Copilot run: the CLI runs its own loop over a scratch tree that holds only the stage's
// declared inputs and instructions, with only the read tools available. Same sandbox, child proxy, account
// projection and owned-file reads as the brokered turn (`cli-copilot-call.ts`); the difference is what the model may
// do inside it and what is retained: the JSONL event stream and the `--share` Markdown transcript, both bounded.
// The broker alone admits, reserves and settles; this module supplies confinement and decoding.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import {
  nativeCopilotSetup,
  cleanupNativeCopilotSetup,
  verifyNativeCopilotSetup,
  readNativeCopilotSelector,
  copilotBoundary,
  COPILOT_AGENT_PROFILE,
} from './cli-copilot-profile.js';
import { openNativeCopilotProxy } from './cli-copilot-proxy.js';
import { copilotPrivateState } from './cli-copilot-call.js';
import { beginCopilotAgentCall, finishCopilotAgentCall, type CopilotAgentAuthority } from './authority.js';
import { freshSandboxedState, readOwnedFile, superviseSandboxedCli, TranscriptCapture } from './sandboxed-cli.js';
import { NativeCopilotError, ProviderError, fail, type NativeCopilotDiagnostic } from './errors.js';

/** The read-only tools the model may see, as the 1.0.105 CLI names them (recorded from the one debug dry run). */
export const COPILOT_READ_TOOLS = Object.freeze(COPILOT_AGENT_PROFILE.readTools.split(','));

/** What a native run needs from its stage: the files, the instructions file, the task text and the bounds. */
export interface CopilotAgentRequest {
  readonly model: string;
  /** Relative paths and bytes the coordinator resolved; the withholding fold already ran over them. */
  readonly files: readonly Readonly<{ relativePath: string; bytes: Uint8Array }>[];
  /** Written to `.github/copilot-instructions.md` in the scratch tree. */
  readonly instructions: Uint8Array;
  /**
   * The digests each written file must hash to, sealed before dispatch and never derived from the buffers above:
   * the instructions file's (from its pack's manifest, or of the bundled text) and each input's.
   */
  readonly digests: Readonly<{ instructions: string; files: readonly string[] }>;
  /** Piped on stdin as the one prompt-mode user message. */
  readonly task: string;
  /** Model requests (turns) allowed; one more stops the process and fails the run. */
  readonly maxTurns: number;
  /**
   * Promoted skills, in order: written to `.github/skills/<id>/` in the scratch tree, which `--add-dir` loads as the
   * session's only trusted skills. Their bytes were checked against the pack lock before this request was made.
   */
  readonly skills?: readonly Readonly<{
    id: string;
    /** Each file with the digest its promoted pack's manifest pins (checked against the pack lock). */
    files: readonly Readonly<{ path: string; bytes: Uint8Array; digest: string }>[];
  }>[];
}

/** A tool the model ran, with the scratch-relative path it named when it named one. */
export interface CopilotToolUse {
  readonly tool: string;
  readonly path: string | null;
}

export interface CopilotAgentResult {
  readonly finalAnswer: string;
  readonly reportedModel: string;
  readonly turns: number;
  readonly tools: readonly CopilotToolUse[];
  /** Scratch-relative paths the read tools named, in first-read order, deduplicated. */
  readonly filesRead: readonly string[];
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number; requests: number }>;
  /** The JSONL event stream as the CLI printed it (bounded). */
  readonly events: Uint8Array;
  /** The `--share` Markdown transcript (bounded). */
  readonly share: Uint8Array;
}

/** The partial inspection ledger of a native run that failed before completion. Private; usage uncertain. */
export interface CopilotAgentPartial {
  readonly turns: number;
  readonly tools: readonly CopilotToolUse[];
  readonly filesRead: readonly string[];
  readonly events: number;
  /** The JSONL stream as captured up to the failure (bounded). */
  readonly stream: Uint8Array;
}
/** A native run's failure: the closed diagnostic, plus the partial ledger when the process had started. */
export class NativeAgentError extends NativeCopilotError {
  partial?: CopilotAgentPartial;
}

/** The fixed native-mode argv after the executable. The prompt is piped on stdin, never argv. */
export function copilotAgentArguments(l: {
  usagePath: string;
  sharePath: string;
  workDir: string;
  model: string;
  /** The stage has promoted skills under `<workDir>/.github/skills/`: load that tree's skills as trusted. */
  skills?: boolean;
}): readonly string[] {
  return Object.freeze([
    '--no-auto-update',
    '--model',
    l.model,
    '--context',
    'default',
    '--output-format',
    'json',
    '--share',
    l.sharePath,
    '--usage-output-file',
    l.usagePath,
    '-C',
    l.workDir,
    '--trust-folder',
    ...(l.skills ? ['--add-dir', l.workDir] : []),
    '--available-tools',
    ...COPILOT_READ_TOOLS,
    '--excluded-tools',
    'mcp:*',
    'custom:*',
    '--deny-tool',
    'shell',
    '--deny-tool',
    'write',
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--disable-client-telemetry',
    '--sync-session=off',
    '--no-experimental',
    '--no-bash-env',
    '--disallow-temp-dir',
    '--log-level',
    'none',
    '--no-color',
    '--max-ai-credits',
    '30',
  ]);
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 50000;
const MAX_SHARE_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_BYTES = 262144;
const MAX_ANSWER = 262144;

const obj = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function diagnostic(
  reason: NativeCopilotDiagnostic['reason'],
  phase: NativeCopilotDiagnostic['phase'],
  frames: number,
  bytes: number,
): NativeCopilotDiagnostic {
  return {
    schema: 'sentinel-copilot-failure/1',
    phase,
    reason,
    exitCode: null,
    signal: null,
    eventClass: frames ? 'lifecycle' : 'none',
    frames,
    stdoutBytes: bytes,
    stderrBytes: 0,
    connections: 0,
    upstreamBytes: 0,
    downstreamBytes: 0,
    proxyEnded: 'open',
  };
}

/**
 * The JSONL event stream, decoded as it arrives: strict UTF-8, one JSON object per line, bounded. It counts model
 * requests against the turn budget, refuses any tool outside the read set the moment it starts, and keeps the last
 * final answer. Nothing the model writes becomes authority; the answer is validated by the stage afterwards.
 */
export class CopilotAgentDecoder {
  #pending = Buffer.alloc(0);
  #bytes = 0;
  #events = 0;
  #turns = 0;
  #final: string | undefined;
  #model: string | undefined;
  #result: number | undefined;
  readonly #tools: CopilotToolUse[] = [];
  constructor(
    readonly workDir: string,
    readonly maxTurns: number,
    readonly allowed: readonly string[] = COPILOT_READ_TOOLS,
  ) {}
  #bad(
    reason: NativeCopilotDiagnostic['reason'],
    code: ProviderError['code'] = 'sentinel.provider.malformedResponse',
  ): never {
    throw new NativeCopilotError(code, 'possible', diagnostic(reason, 'stream', this.#events, this.#bytes));
  }
  get bytes() {
    return this.#bytes;
  }
  get events() {
    return this.#events;
  }
  push(chunk: Uint8Array): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_EVENTS_BYTES) this.#bad('response-bound', 'sentinel.provider.responseTooLarge');
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (let nl = this.#pending.indexOf(10); nl >= 0; nl = this.#pending.indexOf(10)) {
      this.#line(this.#pending.subarray(0, nl));
      this.#pending = this.#pending.subarray(nl + 1);
    }
    if (this.#pending.length > MAX_LINE_BYTES) this.#bad('response-bound', 'sentinel.provider.responseTooLarge');
  }
  #line(bytes: Buffer): void {
    if (bytes.length === 0) return;
    let event: Record<string, any> | undefined;
    try {
      event = obj(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
    } catch {
      this.#bad('invalid-json');
    }
    if (!event || typeof event.type !== 'string') return this.#bad('invalid-event');
    if (++this.#events > MAX_EVENTS) this.#bad('response-bound', 'sentinel.provider.responseTooLarge');
    const data = obj(event.data) ?? {};
    switch (event.type) {
      case 'model.call_start':
        if (++this.#turns > this.maxTurns) this.#bad('disallowed-event', 'sentinel.provider.budgetExhausted');
        return;
      case 'tool.execution_start': {
        const tool = data.toolName;
        if (typeof tool !== 'string' || !this.allowed.includes(tool)) return this.#bad('disallowed-event');
        // The CLI's own path manager keeps its read tools inside the working directory. The seatbelt still lets the
        // process read its owned state and the keychain files, so the monitor fails closed: a call whose argument
        // shape is not one this profile knows, or that names any path outside the scratch tree, stops the run here,
        // before the model's next request can carry what it read.
        const path = this.#toolPath(tool, obj(data.arguments));
        this.#tools.push(Object.freeze({ tool, path }));
        return;
      }
      case 'assistant.message': {
        if (typeof data.model === 'string' && data.model.length <= 200) this.#model = data.model;
        if (data.phase === 'final_answer') {
          if (typeof data.content !== 'string' || data.content.length > MAX_ANSWER) return this.#bad('visible-message');
          this.#final = data.content;
        }
        return;
      }
      case 'result':
        if (!count(event.exitCode)) return this.#bad('result');
        this.#result = event.exitCode;
        return;
      default:
        return;
    }
  }
  /**
   * The scratch-relative path a known read tool names, refusing every other argument shape: `view {path,
   * view_range?}` and `glob {pattern, path?}`. A glob pattern may not be absolute or step outside the tree.
   */
  #toolPath(tool: string, args: Record<string, any> | undefined): string | null {
    const shapes: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
      view: { required: ['path'], optional: ['view_range'] },
      glob: { required: ['pattern'], optional: ['path'] },
    };
    const shape = shapes[tool];
    if (!shape || !args) return this.#bad('disallowed-event');
    const keys = Object.keys(args);
    if (
      shape.required.some((k) => !keys.includes(k)) ||
      keys.some((k) => !shape.required.includes(k) && !shape.optional.includes(k))
    )
      return this.#bad('disallowed-event');
    if (args.view_range !== undefined) {
      const r = args.view_range;
      if (!Array.isArray(r) || r.length > 2 || r.some((n) => !Number.isSafeInteger(n)))
        return this.#bad('disallowed-event');
    }
    if (tool === 'glob') {
      const pattern = args.pattern;
      if (
        typeof pattern !== 'string' ||
        pattern.length > 1024 ||
        pattern.startsWith('/') ||
        pattern.startsWith('~') ||
        pattern.split(/[\\/]/).includes('..')
      )
        return this.#bad('disallowed-event');
      if (args.path === undefined) return null;
    }
    const path = this.#relative(args.path);
    if (path === null) return this.#bad('disallowed-event');
    return path;
  }
  /** A path the tool named, made relative to the scratch tree; null for a path outside it or not a path. */
  #relative(path: unknown): string | null {
    if (typeof path !== 'string' || path.length > 4096) return null;
    const root = this.workDir.endsWith('/') ? this.workDir : this.workDir + '/';
    if (path === this.workDir) return '.';
    if (path.startsWith('/') && !path.startsWith(root)) return null;
    const rel = posix.normalize(path.startsWith('/') ? path.slice(root.length) : path);
    return rel === '..' || rel.startsWith('../') || rel.startsWith('/') ? null : rel;
  }
  /** What the stream showed so far: the private partial ledger a failed run keeps. */
  partial(): Readonly<{
    turns: number;
    tools: readonly CopilotToolUse[];
    filesRead: readonly string[];
    events: number;
  }> {
    const filesRead: string[] = [];
    for (const t of this.#tools)
      if (t.path !== null && t.path !== '.' && !filesRead.includes(t.path)) filesRead.push(t.path);
    return Object.freeze({
      turns: this.#turns,
      tools: Object.freeze([...this.#tools]),
      filesRead: Object.freeze(filesRead),
      events: this.#events,
    });
  }
  finish(): Readonly<{
    finalAnswer: string;
    reportedModel: string;
    turns: number;
    tools: readonly CopilotToolUse[];
    filesRead: readonly string[];
  }> {
    if (this.#pending.length) this.#line(this.#pending);
    this.#pending = Buffer.alloc(0);
    if (this.#result !== 0) this.#bad('result');
    if (this.#final === undefined || !this.#final.trim()) this.#bad('visible-message');
    if (this.#model === undefined) this.#bad('session-identity', 'sentinel.provider.identityMalformed');
    const filesRead: string[] = [];
    for (const t of this.#tools)
      if (t.path !== null && t.path !== '.' && !filesRead.includes(t.path)) filesRead.push(t.path);
    return Object.freeze({
      finalAnswer: this.#final!,
      reportedModel: this.#model!,
      turns: this.#turns,
      tools: Object.freeze([...this.#tools]),
      filesRead: Object.freeze(filesRead),
    });
  }
}

/** The owned usage file of one native run: exactly the requested model, one user request, confirmed token counts. */
export function decodeCopilotAgentUsage(
  bytes: Uint8Array,
  model: string,
): Readonly<{ inputTokens: number; outputTokens: number; requests: number }> {
  const bad = (reason: NativeCopilotDiagnostic['reason'], code: ProviderError['code']) =>
    new NativeCopilotError(code, 'possible', diagnostic(reason, 'usage', 0, 0));
  let metrics: Record<string, any> | undefined;
  try {
    metrics = obj(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
  } catch {
    throw bad('usage-shape', 'sentinel.provider.malformedResponse');
  }
  const models = obj(metrics?.modelMetrics),
    names = models ? Object.keys(models) : [];
  if (
    names.length !== 1 ||
    names[0] !== model ||
    (metrics?.currentModel !== undefined && metrics.currentModel !== model) ||
    metrics?.totalUserRequests !== 1
  )
    throw bad('usage-model', 'sentinel.provider.identityMismatch');
  const m = obj(models![model]),
    requests = obj(m?.requests),
    u = obj(m?.usage);
  if (
    !requests ||
    !count(requests.count) ||
    requests.count < 1 ||
    !u ||
    !count(u.inputTokens) ||
    !count(u.outputTokens)
  )
    throw bad('usage-count', 'sentinel.provider.malformedResponse');
  return Object.freeze({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, requests: requests.count });
}

/** A scratch-relative input path: no absolute path, no parent step, no hidden configuration directory. */
export function safeInputPath(path: string): string {
  const norm = posix.normalize(path);
  if (
    !path ||
    path.length > 1024 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    norm !== path ||
    norm.split('/').some((p) => p === '..' || p === '' || p === '.') ||
    norm.startsWith('.github/') ||
    norm.startsWith('.copilot/') ||
    norm.startsWith('.claude/') ||
    norm.startsWith('.agents/')
  )
    return fail('sentinel.provider.invalidProfile', 'a native input path is not a plain relative path');
  return norm;
}

/** Each written file is still one regular, single-link file holding exactly its bytes; otherwise scratchChanged. */
export async function verifyMaterialised(expected: readonly Readonly<{ path: string; digest: string }>[]) {
  for (const e of expected) {
    let now: Buffer | undefined;
    try {
      const st = await lstat(e.path);
      now = st.isFile() && !st.isSymbolicLink() && st.nlink === 1 ? await readFile(e.path) : undefined;
    } catch {
      now = undefined;
    }
    if (!now || 'sha256:' + sha256(now) !== e.digest)
      throw new ProviderError('sentinel.provider.scratchChanged', 'a materialised file changed before launch');
  }
}
/** A buffer about to be written must already hash to its sealed digest; a changed buffer is never written. */
const sealed = (bytes: Uint8Array, digest: string) => {
  if ('sha256:' + sha256(bytes) !== digest)
    throw new ProviderError('sentinel.provider.scratchChanged', 'a buffer differs from its sealed digest');
  return bytes;
};
const SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV']);
const AGENT_WORDS = Object.freeze({
  canceled: 'Copilot native run canceled',
  timeout: 'original Copilot native deadline elapsed',
  stream: 'Copilot native stream refused',
  stderr: 'Copilot native stderr bound',
  stdin: 'Copilot native input delivery failed',
  unavailable: 'Copilot native process unavailable',
});

export async function nativeCopilotAgentCall(authority: CopilotAgentAuthority): Promise<CopilotAgentResult> {
  const { runtime, request, limits } = beginCopilotAgentCall(authority);
  copilotBoundary(limits);
  const proxy = await openNativeCopilotProxy({ ...limits, maxUpstreamBytes: 4194304, maxDownstreamBytes: 4194304 });
  let setup: Awaited<ReturnType<typeof nativeCopilotSetup>> | undefined,
    phase: NativeCopilotDiagnostic['phase'] = 'setup',
    reason: NativeCopilotDiagnostic['reason'] = 'output-unavailable';
  let decoder: CopilotAgentDecoder | undefined;
  const state = freshSandboxedState();
  const transcript = new TranscriptCapture(MAX_EVENTS_BYTES);
  let stderr = Buffer.alloc(0);
  try {
    const selector = await readNativeCopilotSelector(limits);
    setup = await nativeCopilotSetup(runtime, proxy.port, limits);
    const current = setup,
      work = current.ownedRoot + '/work',
      usagePath = current.ownedRoot + '/state/usage.json',
      sharePath = current.ownedRoot + '/state/transcript.md',
      files = copilotPrivateState(selector, { stageSkills: Boolean(request.skills?.length) });
    await writeFile(current.ownedRoot + '/state/config.json', files.config, { flag: 'wx', mode: 0o600 });
    await writeFile(current.ownedRoot + '/state/settings.json', files.settings, { flag: 'wx', mode: 0o600 });
    // The scratch tree: only the declared inputs and the instructions, read-only to the sandboxed process.
    await mkdir(join(work, '.github'), { recursive: true, mode: 0o700 });
    if (request.digests.files.length !== request.files.length)
      fail('sentinel.provider.invalidProfile', 'every native input has its sealed digest');
    await writeFile(
      join(work, '.github/copilot-instructions.md'),
      sealed(request.instructions, request.digests.instructions),
      { flag: 'wx', mode: 0o400 },
    );
    for (const [i, f] of request.files.entries()) {
      const rel = safeInputPath(f.relativePath);
      await mkdir(dirname(join(work, rel)), { recursive: true, mode: 0o700 });
      await writeFile(join(work, rel), sealed(f.bytes, request.digests.files[i]!), { flag: 'wx', mode: 0o400 });
    }
    for (const skill of request.skills ?? []) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.id))
        fail('sentinel.provider.invalidProfile', 'a skill id is a plain pack id');
      for (const f of skill.files) {
        const rel = safeInputPath(f.path);
        const target = join(work, '.github/skills', skill.id, rel);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, sealed(f.bytes, f.digest), { flag: 'wx', mode: 0o400 });
      }
    }
    copilotBoundary(limits);
    await verifyNativeCopilotSetup(current, limits);
    // Immediately before the process starts: every materialised file is re-read and must hash to the bytes the
    // request carries (the instructions, each skill file, each input). A changed byte refuses before any launch.
    await verifyMaterialised([
      { path: join(work, '.github/copilot-instructions.md'), digest: request.digests.instructions },
      ...(request.skills ?? []).flatMap((k) =>
        k.files.map((f) => ({ path: join(work, '.github/skills', k.id, f.path), digest: f.digest })),
      ),
      ...request.files.map((f, i) => ({ path: join(work, f.relativePath), digest: request.digests.files[i]! })),
    ]);
    copilotBoundary(limits);
    decoder = new CopilotAgentDecoder(work, request.maxTurns);
    const stream = decoder;
    const shareNotice = Buffer.from(`Session exported to: ${sharePath}\n`);
    phase = 'spawn';
    try {
      await superviseSandboxedCli(
        {
          label: 'sentinel-copilot-agent',
          policy: current.policy,
          executable: current.executable,
          args: copilotAgentArguments({
            usagePath,
            sharePath,
            workDir: work,
            model: request.model,
            skills: Boolean(request.skills?.length),
          }),
          cwd: work,
          env: current.env,
          timing: limits,
          stderrLimit: 4096,
          words: AGENT_WORDS,
          transcript,
          onStdout: (b) => stream.push(b),
          onStderr: (b) => {
            stderr = Buffer.concat([stderr, b]).subarray(0, 4097);
          },
          onSpawned: () => {
            phase = 'stream';
          },
          deliver: (child) => child.stdin!.end(request.task),
        },
        state,
      );
    } catch (e) {
      if (state.reason) reason = state.reason;
      throw e;
    }
    // Exit zero, no signal, and stderr empty or exactly the --share notice; anything else is not a completion.
    if (
      state.code !== 0 ||
      state.signal !== null ||
      !state.spawned ||
      (stderr.length !== 0 && !stderr.equals(shareNotice))
    ) {
      phase = 'exit';
      reason = 'process-exit';
      throw new ProviderError('sentinel.provider.malformedResponse', 'Copilot exited without a completion', 'possible');
    }
    const decoded = stream.finish();
    copilotBoundary(limits);
    phase = 'usage-read';
    reason = 'usage-file';
    const words = { bound: 'Copilot native output bound', changed: 'Copilot native output identity changed' };
    const usageBytes = await readOwnedFile(usagePath, MAX_USAGE_BYTES, () => copilotBoundary(limits), words);
    const share = await readOwnedFile(sharePath, MAX_SHARE_BYTES, () => copilotBoundary(limits), words);
    phase = 'usage';
    reason = 'usage-shape';
    const usage = decodeCopilotAgentUsage(usageBytes, request.model);
    if (usage.requests !== decoded.turns)
      throw new NativeCopilotError(
        'sentinel.provider.malformedResponse',
        'possible',
        diagnostic('usage-count', 'usage', stream.events, stream.bytes),
      );
    return Object.freeze({
      ...decoded,
      usage,
      events: new Uint8Array(transcript.content()),
      share: new Uint8Array(share),
    });
  } catch (e) {
    const possibleSpend = state.pid !== undefined;
    const error =
      e instanceof ProviderError
        ? e
        : new ProviderError(
            'sentinel.provider.malformedResponse',
            'Copilot native output unavailable',
            possibleSpend ? 'possible' : 'none',
          );
    const prior = e instanceof NativeCopilotError ? e.nativeCopilot : undefined,
      p = proxy.observation();
    const failure = new NativeAgentError(error.code, possibleSpend ? 'possible' : error.spend, {
      schema: 'sentinel-copilot-failure/1',
      phase: prior?.phase ?? phase,
      reason:
        prior?.reason ??
        (error.code === 'sentinel.provider.credentialUnavailable'
          ? 'native-selector-unavailable'
          : error.code === 'sentinel.provider.timeout'
            ? 'deadline'
            : error.code === 'sentinel.provider.canceled'
              ? 'canceled'
              : error.code === 'sentinel.provider.responseTooLarge'
                ? 'response-bound'
                : reason),
      exitCode: state.code,
      signal:
        state.signal === null
          ? null
          : SIGNALS.has(state.signal)
            ? (state.signal as NativeCopilotDiagnostic['signal'])
            : 'other',
      eventClass: decoder?.events ? 'lifecycle' : 'none',
      frames: decoder?.events ?? 0,
      stdoutBytes: decoder?.bytes ?? 0,
      stderrBytes: state.stderrBytes,
      connections: p.connections,
      upstreamBytes: p.upstreamWireBytes,
      downstreamBytes: p.downstreamWireBytes,
      proxyEnded: p.endedBy,
    });
    // The bounded partial ledger is kept, privately, before cleanup removes the owned root: what the stream showed
    // (every tool call and path) and its raw JSONL as captured. Usage stays uncertain; no output is ever published.
    if (decoder)
      failure.partial = Object.freeze({ ...decoder.partial(), stream: new Uint8Array(transcript.content()) });
    throw failure;
  } finally {
    finishCopilotAgentCall(authority);
    await proxy.close();
    if (setup) await cleanupNativeCopilotSetup(setup);
  }
}
