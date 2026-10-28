// One admitted native-mode Claude Code run: `claude -p` runs its own loop over a scratch tree holding only the stage's
// inputs and promoted skills, with `Read` and `Glob` the only tools. The owner's long-lived token, read in-process by
// the broker from the adopted keychain reference, crosses only an anonymous descriptor. Same shared sandboxed runner
// as every CLI turn; the stream-json output is the transcript and is retained, bounded. The broker alone admits,
// reserves and settles; this module supplies confinement and decoding.
import type { Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeClaudeAgentSetup, cleanupNativeClaudeSetup, CLAUDE_AGENT_PROFILE } from './cli-native-profile.js';
import { openNativeClaudeProxy } from './cli-native-proxy.js';
import { discardNativeClaudeToken, sendNativeClaudeToken, type NativeClaudeToken } from './cli-native-auth.js';
import { beginClaudeAgentCall, finishClaudeAgentCall, type ClaudeAgentAuthority } from './authority.js';
import { freshSandboxedState, superviseSandboxedCli, TranscriptCapture } from './sandboxed-cli.js';
import { fail, ProviderError } from './errors.js';
import {
  safeInputPath,
  verifyMaterialised,
  type CopilotAgentPartial,
  type CopilotAgentRequest,
  type CopilotAgentResult,
} from './cli-copilot-agent.js';

/** The two read tools the model may use, as Claude Code names them. */
export const CLAUDE_READ_TOOLS = Object.freeze(CLAUDE_AGENT_PROFILE.tools.split(','));
/** Built-in tools refused outright, beside the allow list: nothing that runs, writes, fetches or delegates. */
export const CLAUDE_DENIED_TOOLS = Object.freeze([
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
]);

/**
 * Where promoted skills live in the scratch tree: one session-only plugin (`--plugin-dir`) inside the working
 * directory, so the CLI lists them and `Read` can open them. On 2.1.282 `--restricted` ignores project skills under
 * `.claude/skills/` (measured), while a session plugin still loads; no input may sit under `.claude/`.
 */
export const CLAUDE_STAGE_PLUGIN = '.claude/sentinel-stage';
/** The plugin manifest Sentinel writes beside the skills: fixed bytes, a name and nothing else the CLI would load. */
export const CLAUDE_STAGE_PLUGIN_MANIFEST =
  JSON.stringify({ name: 'sentinel-stage', version: '1.0.0', description: 'Promoted Sentinel stage skills' }) + '\n';

/** The fixed native-mode argv after the executable. The task is piped on stdin; the token is on descriptor 3. */
export function claudeAgentArguments(l: {
  systemPromptPath: string;
  workDir: string;
  model: string;
  maxTurns: number;
  maxUsd?: string;
  jsonSchema: string;
  /** The stage plugin's folder, when the stage has promoted skills. */
  pluginDir?: string;
}): readonly string[] {
  return Object.freeze([
    '--print',
    '--verbose',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--model',
    l.model,
    '--system-prompt-file',
    l.systemPromptPath,
    '--add-dir',
    l.workDir,
    '--tools',
    CLAUDE_READ_TOOLS.join(','),
    '--disallowedTools',
    CLAUDE_DENIED_TOOLS.join(','),
    '--restricted',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{"disableAllHooks":true}',
    // `--restricted` ignores every settings file; promoted skills arrive as the one session plugin, and no input may
    // carry a name the CLI reads as its own instructions or configuration (`safeInputPath`).
    ...(l.pluginDir ? ['--plugin-dir', l.pluginDir] : []),
    '--no-session-persistence',
    '--max-turns',
    String(l.maxTurns),
    ...(l.maxUsd ? ['--max-budget-usd', l.maxUsd] : []),
    '--json-schema',
    l.jsonSchema,
  ]);
}

/** A Copilot-shaped native request, plus the output schema `--json-schema` enforces and the CLI's own dollar cap. */
export type ClaudeAgentRequest = CopilotAgentRequest &
  Readonly<{
    /** The stage output's JSON Schema, enforced by the CLI on its final answer (validated again by the runner). */
    jsonSchema: string;
    /** `--max-budget-usd`: the CLI's own list-price ceiling, a decimal string. */
    maxUsd?: string;
  }>;

const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 50000;
const MAX_ANSWER = 262144;
const obj = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A Claude native run's failure: a closed reason, plus the partial ledger once the process had started. */
export class ClaudeAgentError extends ProviderError {
  partial?: CopilotAgentPartial;
  constructor(
    code: ProviderError['code'],
    readonly reason: 'stream' | 'disallowed-tool' | 'turns' | 'result' | 'identity' | 'usage' | 'exit',
    spend: 'none' | 'possible' = 'possible',
  ) {
    super(code, `Claude native ${reason}`, spend);
  }
}

/**
 * The tool `--json-schema` adds: the model hands its final answer to it, and the CLI validates that answer against
 * the schema before it ends the run (the 2.1.282 binary names it `StructuredOutput`). It reads and runs nothing.
 */
export const CLAUDE_OUTPUT_TOOL = 'StructuredOutput';

/**
 * The stream-json transcript, decoded as it arrives: strict UTF-8, one JSON object per line, bounded. Each assistant
 * message (one model request) counts against the turn budget; any tool other than `Read {file_path, offset?,
 * limit?}`, `Glob {pattern, path?}` and the output tool, or any path outside the scratch tree, stops the run at once.
 * The `result` event carries the answer (`structured_output`, which the CLI validated against the schema) and the
 * usage.
 */
export class ClaudeAgentDecoder {
  #pending = Buffer.alloc(0);
  #bytes = 0;
  #events = 0;
  readonly #messages = new Set<string>();
  readonly #tools: { tool: string; path: string | null }[] = [];
  #model: string | undefined;
  #result: Record<string, any> | undefined;
  constructor(
    readonly workDir: string,
    readonly maxTurns: number,
  ) {}
  #bad(reason: ClaudeAgentError['reason'], code: ProviderError['code'] = 'sentinel.provider.malformedResponse'): never {
    throw new ClaudeAgentError(code, reason);
  }
  get bytes() {
    return this.#bytes;
  }
  get events() {
    return this.#events;
  }
  push(chunk: Uint8Array): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_EVENTS_BYTES) this.#bad('stream', 'sentinel.provider.responseTooLarge');
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (let nl = this.#pending.indexOf(10); nl >= 0; nl = this.#pending.indexOf(10)) {
      this.#line(this.#pending.subarray(0, nl));
      this.#pending = this.#pending.subarray(nl + 1);
    }
    if (this.#pending.length > MAX_LINE_BYTES) this.#bad('stream', 'sentinel.provider.responseTooLarge');
  }
  #line(bytes: Buffer): void {
    if (!bytes.length) return;
    let e: Record<string, any> | undefined;
    try {
      e = obj(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
    } catch {
      this.#bad('stream');
    }
    if (!e || typeof e.type !== 'string') return this.#bad('stream');
    if (++this.#events > MAX_EVENTS) this.#bad('stream', 'sentinel.provider.responseTooLarge');
    if (this.#result) return this.#bad('result');
    if (e.type === 'system' && e.subtype === 'init') {
      if (this.#model !== undefined || typeof e.model !== 'string' || e.model.length > 200)
        return this.#bad('identity', 'sentinel.provider.identityMalformed');
      this.#model = e.model;
      return;
    }
    if (e.type === 'assistant') {
      const message = obj(e.message);
      if (typeof message?.id === 'string' && !this.#messages.has(message.id)) {
        this.#messages.add(message.id);
        if (this.#messages.size > this.maxTurns) this.#bad('turns', 'sentinel.provider.budgetExhausted');
      }
      for (const block of Array.isArray(message?.content) ? message!.content : []) {
        if (obj(block)?.type !== 'tool_use') continue;
        if (block.name === CLAUDE_OUTPUT_TOOL) {
          if (!obj(block.input)) this.#bad('disallowed-tool');
          this.#tools.push(Object.freeze({ tool: CLAUDE_OUTPUT_TOOL, path: null }));
          continue;
        }
        this.#tools.push(Object.freeze({ tool: block.name, path: this.#toolPath(block.name, obj(block.input)) }));
      }
      return;
    }
    if (e.type === 'result') this.#result = e;
  }
  #inside(path: unknown): string | null {
    if (typeof path !== 'string' || path.length > 4096) return null;
    const root = this.workDir.endsWith('/') ? this.workDir : this.workDir + '/';
    if (path === this.workDir) return '.';
    if (path.startsWith('/') && !path.startsWith(root)) return null;
    const rel = posix.normalize(path.startsWith('/') ? path.slice(root.length) : path);
    return rel === '..' || rel.startsWith('../') || rel.startsWith('/') ? null : rel;
  }
  #toolPath(tool: unknown, input: Record<string, any> | undefined): string | null {
    const shapes: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
      Read: { required: ['file_path'], optional: ['offset', 'limit'] },
      Glob: { required: ['pattern'], optional: ['path'] },
    };
    const shape = typeof tool === 'string' && CLAUDE_READ_TOOLS.includes(tool) ? shapes[tool] : undefined;
    if (!shape || !input) return this.#bad('disallowed-tool');
    const keys = Object.keys(input);
    if (
      shape.required.some((k) => !keys.includes(k)) ||
      keys.some((k) => !shape.required.includes(k) && !shape.optional.includes(k))
    )
      return this.#bad('disallowed-tool');
    for (const k of ['offset', 'limit'])
      if (input[k] !== undefined && !Number.isSafeInteger(input[k])) return this.#bad('disallowed-tool');
    if (tool === 'Glob') {
      const p = input.pattern;
      if (
        typeof p !== 'string' ||
        p.length > 1024 ||
        p.startsWith('/') ||
        p.startsWith('~') ||
        p.split(/[\\/]/).includes('..')
      )
        return this.#bad('disallowed-tool');
      if (input.path === undefined) return null;
      return this.#inside(input.path) ?? this.#bad('disallowed-tool');
    }
    return this.#inside(input.file_path) ?? this.#bad('disallowed-tool');
  }
  partial(): CopilotAgentPartial {
    const filesRead: string[] = [];
    for (const t of this.#tools)
      if (t.path !== null && t.path !== '.' && !filesRead.includes(t.path)) filesRead.push(t.path);
    return Object.freeze({
      turns: this.#messages.size,
      tools: Object.freeze([...this.#tools]),
      filesRead: Object.freeze(filesRead),
      events: this.#events,
      stream: new Uint8Array(0),
    });
  }
  finish(): Omit<CopilotAgentResult, 'events' | 'share'> {
    if (this.#pending.length) this.#line(this.#pending);
    this.#pending = Buffer.alloc(0);
    const r = this.#result;
    if (!r || r.subtype !== 'success' || r.is_error !== false) return this.#bad('result');
    const usage = obj(r.usage),
      models = obj(r.modelUsage);
    const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
    if (!usage || fields.some((k) => !count(usage[k]))) return this.#bad('usage');
    if (!this.#model || !models || !Object.hasOwn(models, this.#model))
      return this.#bad('identity', 'sentinel.provider.identityMismatch');
    // The schema-checked answer only: a run that ended without one (text alone) did not answer in its schema.
    if (obj(r.structured_output) === undefined) return this.#bad('result');
    const answer = JSON.stringify(r.structured_output);
    if (!answer.trim() || answer.length > MAX_ANSWER) return this.#bad('result');
    // Every model the run used counts against the stage, a small background model included: the larger of the
    // main loop's usage and the per-model sum.
    let input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
      output = usage.output_tokens as number;
    let modelIn = 0,
      modelOut = 0;
    for (const m of Object.values(models)) {
      const u = obj(m);
      const parts = ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens'];
      if (!u || parts.some((k) => u[k] !== undefined && !count(u[k]))) return this.#bad('usage');
      modelIn += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      modelOut += u.outputTokens ?? 0;
    }
    if (modelIn + modelOut > input + output) [input, output] = [modelIn, modelOut];
    const filesRead = this.partial().filesRead;
    return Object.freeze({
      finalAnswer: answer,
      reportedModel: this.#model,
      turns: count(r.num_turns) ? r.num_turns : this.#messages.size,
      tools: Object.freeze([...this.#tools]),
      filesRead,
      usage: Object.freeze({ inputTokens: input, outputTokens: output, requests: this.#messages.size }),
    });
  }
}

const CLAUDE_AGENT_WORDS = Object.freeze({
  canceled: 'Claude native run canceled',
  timeout: 'original Claude native deadline elapsed',
  stream: 'Claude native stream refused',
  stderr: 'Claude native stderr bound',
  stdin: 'Claude native input delivery failed',
  unavailable: 'Claude native process unavailable',
});
const sha = (b: Uint8Array) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const sealed = (bytes: Uint8Array, digest: string) => {
  if (sha(bytes) !== digest)
    throw new ProviderError('sentinel.provider.scratchChanged', 'a buffer differs from its digest');
  return bytes;
};

export async function nativeClaudeAgentCall(authority: ClaudeAgentAuthority): Promise<CopilotAgentResult> {
  const { runtime, request, limits, token } = beginClaudeAgentCall(authority);
  let proxy: Awaited<ReturnType<typeof openNativeClaudeProxy>> | undefined;
  let setup: Awaited<ReturnType<typeof nativeClaudeAgentSetup>> | undefined;
  let decoder: ClaudeAgentDecoder | undefined;
  let handle: NativeClaudeToken | undefined = token;
  const state = freshSandboxedState();
  const transcript = new TranscriptCapture(MAX_EVENTS_BYTES);
  try {
    // One fixed destination, a few sequential connections (the loop's turns), each one checked and bounded.
    proxy = await openNativeClaudeProxy({
      ...limits,
      maxUpstreamBytes: 4 * 1024 * 1024,
      maxDownstreamBytes: 4 * 1024 * 1024,
      // The startup alone opens about a dozen in turn to the one authority (measured against a refusing listener).
      maxConnections: 16,
    });
    setup = await nativeClaudeAgentSetup(runtime, proxy.port, limits);
    const current = setup,
      work = current.ownedRoot + '/work',
      prompt = current.ownedRoot + '/system.txt';
    if (request.digests.files.length !== request.files.length)
      fail('sentinel.provider.invalidProfile', 'every native input has its sealed digest');
    await writeFile(prompt, sealed(request.instructions, request.digests.instructions), { flag: 'wx', mode: 0o400 });
    for (const [i, f] of request.files.entries()) {
      const rel = safeInputPath(f.relativePath);
      await mkdir(dirname(join(work, rel)), { recursive: true, mode: 0o700 });
      await writeFile(join(work, rel), sealed(f.bytes, request.digests.files[i]!), { flag: 'wx', mode: 0o400 });
    }
    const plugin = join(work, CLAUDE_STAGE_PLUGIN),
      manifest = join(plugin, '.claude-plugin/plugin.json'),
      skills = request.skills ?? [];
    if (skills.length) {
      await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
      await writeFile(manifest, Buffer.from(CLAUDE_STAGE_PLUGIN_MANIFEST), { flag: 'wx', mode: 0o400 });
    }
    for (const skill of skills) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.id))
        fail('sentinel.provider.invalidProfile', 'a skill id is a pack id');
      for (const f of skill.files) {
        const target = join(plugin, 'skills', skill.id, safeInputPath(f.path));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, sealed(f.bytes, f.digest), { flag: 'wx', mode: 0o400 });
      }
    }
    await verifyMaterialised([
      { path: prompt, digest: request.digests.instructions },
      ...(skills.length ? [{ path: manifest, digest: sha(Buffer.from(CLAUDE_STAGE_PLUGIN_MANIFEST)) }] : []),
      ...skills.flatMap((k) => k.files.map((f) => ({ path: join(plugin, 'skills', k.id, f.path), digest: f.digest }))),
      ...request.files.map((f, i) => ({ path: join(work, f.relativePath), digest: request.digests.files[i]! })),
    ]);
    decoder = new ClaudeAgentDecoder(work, request.maxTurns);
    const stream = decoder;
    let delivered = false;
    await superviseSandboxedCli(
      {
        label: 'sentinel-claude-agent',
        policy: current.policy,
        executable: current.executable,
        args: claudeAgentArguments({
          systemPromptPath: prompt,
          workDir: work,
          model: request.model,
          maxTurns: request.maxTurns,
          ...(request.maxUsd ? { maxUsd: request.maxUsd } : {}),
          jsonSchema: request.jsonSchema,
          ...(skills.length ? { pluginDir: plugin } : {}),
        }),
        cwd: work,
        env: current.env,
        extraPipes: 1,
        timing: limits,
        stderrLimit: 4096,
        words: CLAUDE_AGENT_WORDS,
        transcript,
        onStdout: (b) => stream.push(b),
        deliver: (child, control) => {
          const once = handle;
          handle = undefined;
          if (!once) return control.stop(new ProviderError('sentinel.provider.credentialUnavailable', 'no token'));
          void sendNativeClaudeToken(once, child.stdio[3] as Writable, limits.deadlineAt, limits.signal)
            .then(() => {
              if (control.failed()) return;
              delivered = true;
              child.stdin!.end(request.task);
            })
            .catch((e) =>
              control.stop(
                new ProviderError(
                  e instanceof ProviderError ? e.code : 'sentinel.provider.credentialUnavailable',
                  'native descriptor delivery refused',
                  'possible',
                ),
              ),
            );
        },
      },
      state,
    );
    if (state.code !== 0 || state.signal !== null || !delivered)
      throw new ClaudeAgentError('sentinel.provider.malformedResponse', 'exit');
    const decoded = stream.finish();
    return Object.freeze({
      ...decoded,
      events: new Uint8Array(transcript.content()),
      share: new Uint8Array(0),
    });
  } catch (e) {
    const failure =
      e instanceof ClaudeAgentError
        ? e
        : Object.assign(
            new ClaudeAgentError(
              e instanceof ProviderError ? e.code : 'sentinel.provider.malformedResponse',
              'stream',
              state.pid !== undefined ? 'possible' : e instanceof ProviderError ? e.spend : 'none',
            ),
          );
    // The bounded partial ledger, privately, before cleanup removes the owned root. Usage stays uncertain.
    if (decoder)
      failure.partial = Object.freeze({ ...decoder.partial(), stream: new Uint8Array(transcript.content()) });
    throw failure;
  } finally {
    finishClaudeAgentCall(authority);
    if (handle) discardNativeClaudeToken(handle);
    await proxy?.close();
    if (setup) await cleanupNativeClaudeSetup(setup);
  }
}
