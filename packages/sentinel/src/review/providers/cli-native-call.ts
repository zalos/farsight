// One-shot fixed native invocation. The broker alone supplies admission/reservation; this module supplies confinement.
import type { Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { nativeClaudeSetup, cleanupNativeClaudeSetup, nativeRuntimeHelper } from './cli-native-profile.js';
import { openNativeClaudeProxy } from './cli-native-proxy.js';
import { readNativeLogin } from './cli-native-helper.js';
import { discardNativeClaudeToken, sendNativeClaudeToken } from './cli-native-auth.js';
import { NativeClaudeDecoder } from './cli-native-wire.js';
import type { ParsedReply } from './kinds.js';
import { beginNativeCall, finishNativeCall, assertNativeLoginActive, type NativeCallAuthority } from './authority.js';
import { freshSandboxedState, superviseSandboxedCli } from './sandboxed-cli.js';
import { fail, ProviderError } from './errors.js';

/** The fixed single-turn print-mode argv after the executable: no tools, no MCP, no settings, no slash commands. */
export function claudeInvocationArguments(systemPromptPath: string, model: string): readonly string[] {
  return Object.freeze([
    '--print',
    '--verbose',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--model',
    model,
    '--system-prompt-file',
    systemPromptPath,
    '--restricted',
    '--safe-mode',
    '--tools',
    '',
    '--disallowedTools',
    '*',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns',
    '1',
    '--settings',
    '{"disableAllHooks":true}',
  ]);
}
const CLAUDE_WORDS = Object.freeze({
  canceled: 'native call canceled',
  timeout: 'original native call deadline elapsed',
  stream: 'native stream refused',
  stderr: 'native stderr bound',
  stdin: 'native input delivery failed',
  unavailable: 'fixed native process unavailable',
});

export async function nativeClaudeCall(authority: NativeCallAuthority): Promise<ParsedReply> {
  const { runtime, wire, limits } = beginNativeCall(authority);
  const boundary = () => {
    if (limits.signal?.aborted) fail('sentinel.provider.canceled', 'native call canceled');
    if (Date.now() >= limits.deadlineAt) fail('sentinel.provider.timeout', 'original native call deadline elapsed');
  };
  boundary();
  const helper = nativeRuntimeHelper(runtime);
  const proxy = await openNativeClaudeProxy({
    ...limits,
    maxUpstreamBytes: 4 * 1024 * 1024,
    maxDownstreamBytes: 4 * 1024 * 1024,
  });
  let setup: Awaited<ReturnType<typeof nativeClaudeSetup>> | undefined;
  let token: Awaited<ReturnType<typeof readNativeLogin>> | undefined;
  try {
    setup = await nativeClaudeSetup(runtime, proxy.port, limits);
    const prompt = `${setup.ownedRoot}/system.txt`;
    await writeFile(prompt, wire.system, { flag: 'wx', mode: 0o400 });
    boundary();
    // Whole native login JSON remains only in the fixed no-UI helper. Only its access token crosses an anonymous FD.
    token = await readNativeLogin(helper, limits, authority);
    boundary();
    assertNativeLoginActive(authority);
    const currentSetup = setup,
      currentToken = token;
    const decoder = new NativeClaudeDecoder(limits.maxResponseBytes);
    const state = freshSandboxedState();
    let delivered = false;
    // The native process cannot execute the shell or any other executable under the deny-default policy.
    await superviseSandboxedCli(
      {
        label: 'sentinel-native-cli',
        policy: currentSetup.policy,
        executable: currentSetup.executable,
        args: claudeInvocationArguments(prompt, wire.requestedModel),
        cwd: currentSetup.ownedRoot,
        env: { ...currentSetup.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(limits.maxOutputTokens) },
        extraPipes: 1,
        timing: limits,
        stderrLimit: 4096,
        words: CLAUDE_WORDS,
        onStdout: (bytes) => decoder.push(bytes),
        deliver: (child, control) => {
          void sendNativeClaudeToken(currentToken, child.stdio[3] as Writable, limits.deadlineAt, limits.signal)
            .then(() => {
              if (control.failed() || limits.signal?.aborted || Date.now() >= limits.deadlineAt) {
                if (!control.failed()) {
                  if (limits.signal?.aborted) control.cancel();
                  else
                    control.stop(
                      new ProviderError('sentinel.provider.timeout', 'original native deadline elapsed', 'possible'),
                    );
                }
                return;
              }
              try {
                assertNativeLoginActive(authority);
              } catch {
                control.stop(
                  new ProviderError('sentinel.provider.notAdmitted', 'native reservation authority ended', 'possible'),
                );
                return;
              }
              delivered = true;
              child.stdin!.end(wire.stdin);
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
      throw new ProviderError(
        'sentinel.provider.malformedResponse',
        'native process exited without accepted completion',
        'possible',
      );
    const reply = decoder.finish();
    boundary();
    return reply;
  } finally {
    finishNativeCall(authority);
    if (token) discardNativeClaudeToken(token);
    await proxy.close();
    if (setup) await cleanupNativeClaudeSetup(setup);
  }
}
