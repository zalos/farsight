// One-shot fixed native invocation. The broker alone supplies admission/reservation; this module supplies confinement.
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { nativeClaudeSetup, cleanupNativeClaudeSetup, nativeRuntimeHelper, type NativeClaudeRuntime, type NativeTiming } from './cli-native-profile.js';
import { openNativeClaudeProxy } from './cli-native-proxy.js';
import { readNativeLogin } from './cli-native-helper.js';
import { discardNativeClaudeToken, sendNativeClaudeToken } from './cli-native-auth.js';
import { NativeClaudeDecoder, type NativeReviewWire } from './cli-native-wire.js';
import type { ParsedReply } from './kinds.js';
import { fail, ProviderError } from './errors.js';

export async function nativeClaudeCall(runtime: NativeClaudeRuntime, wire: NativeReviewWire,
  limits: NativeTiming & { maxResponseBytes: number; maxOutputTokens: number }): Promise<ParsedReply> {
  const boundary = () => {
    if (limits.signal?.aborted) fail('sentinel.provider.canceled', 'native call canceled');
    if (Date.now() >= limits.deadlineAt) fail('sentinel.provider.timeout', 'original native call deadline elapsed');
  };
  boundary();
  const helper = nativeRuntimeHelper(runtime);
  const proxy = await openNativeClaudeProxy({ ...limits, maxUpstreamBytes: 4 * 1024 * 1024, maxDownstreamBytes: 4 * 1024 * 1024 });
  let setup: Awaited<ReturnType<typeof nativeClaudeSetup>> | undefined;
  let token: Awaited<ReturnType<typeof readNativeLogin>> | undefined;
  try {
    setup = await nativeClaudeSetup(runtime, proxy.port, limits);
    const prompt = `${setup.ownedRoot}/system.txt`;
    await writeFile(prompt, wire.system, { flag: 'wx', mode: 0o400 }); boundary();
    // Whole native login JSON remains only in the fixed no-UI helper. Only its access token crosses an anonymous FD.
    token = await readNativeLogin(helper, limits); boundary();
    const currentSetup = setup, currentToken = token;
    const reply = await new Promise<ParsedReply>((resolve, reject) => {
      // Fixed shell text only lowers the core limit and execs sandbox-exec; caller bytes are separate argv.
      // The native process cannot execute this shell or any other executable under the deny-default policy.
      const command = 'ulimit -H -c 0 && ulimit -S -c 0 && exec /usr/bin/sandbox-exec "$@"';
      const args = ['-c', command, 'sentinel-native-cli', '-p', currentSetup.policy, currentSetup.executable,
        '--print', '--verbose', '--input-format', 'text', '--output-format', 'stream-json', '--model', wire.requestedModel,
        '--system-prompt-file', prompt, '--restricted', '--safe-mode', '--tools', '', '--disallowedTools', '*',
        '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1',
        '--settings', '{"disableAllHooks":true}'];
      const child = spawn('/bin/sh', args, { cwd: currentSetup.ownedRoot, detached: true,
        env: { ...currentSetup.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(limits.maxOutputTokens) }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      const decoder = new NativeClaudeDecoder(limits.maxResponseBytes);
      let failure: ProviderError | undefined, stderr = 0, delivered = false;
      const stop = (e: ProviderError) => {
        failure ??= e;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* this exact owned group may already have exited */ } }
      };
      const cancel = () => stop(new ProviderError('sentinel.provider.canceled', 'native call canceled', 'possible'));
      const timer = setTimeout(() => stop(new ProviderError('sentinel.provider.timeout', 'original native call deadline elapsed', 'possible')), Math.max(1, limits.deadlineAt - Date.now()));
      limits.signal?.addEventListener('abort', cancel, { once: true });
      child.stdout!.on('data', (bytes: Buffer) => { if (!failure) { try { decoder.push(bytes); } catch (e) { stop(e instanceof ProviderError ? e : new ProviderError('sentinel.provider.malformedResponse', 'native stream refused', 'possible')); } } });
      child.stderr!.on('data', (bytes: Buffer) => { stderr += bytes.length; if (stderr > 4096) stop(new ProviderError('sentinel.provider.responseTooLarge', 'native stderr bound', 'possible')); });
      child.stdin!.on('error', () => stop(new ProviderError('sentinel.provider.unreachable', 'native input delivery failed', 'possible')));
      child.once('error', () => { failure ??= new ProviderError('sentinel.provider.unreachable', 'fixed native process unavailable'); });
      child.once('spawn', () => {
        if (limits.signal?.aborted || Date.now() >= limits.deadlineAt) { limits.signal?.aborted ? cancel() : stop(new ProviderError('sentinel.provider.timeout', 'original native deadline elapsed', 'possible')); return; }
        void sendNativeClaudeToken(currentToken, child.stdio[3] as Writable, limits.deadlineAt, limits.signal).then(() => {
          if (failure || limits.signal?.aborted || Date.now() >= limits.deadlineAt) { if (!failure) cancel(); return; }
          delivered = true; child.stdin!.end(wire.stdin);
        }).catch(e => stop(new ProviderError(e instanceof ProviderError ? e.code : 'sentinel.provider.credentialUnavailable', 'native descriptor delivery refused', 'possible')));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer); limits.signal?.removeEventListener('abort', cancel);
        if (limits.signal?.aborted) failure = new ProviderError('sentinel.provider.canceled', 'native call canceled', 'possible');
        else if (Date.now() >= limits.deadlineAt) failure = new ProviderError('sentinel.provider.timeout', 'original native deadline elapsed', 'possible');
        if (failure) { reject(failure); return; }
        if (code !== 0 || signal !== null || !delivered) { reject(new ProviderError('sentinel.provider.malformedResponse', 'native process exited without accepted completion', 'possible')); return; }
        try { resolve(decoder.finish()); } catch (e) { reject(e); }
      });
      if (limits.signal?.aborted) cancel();
    });
    boundary(); return reply;
  } finally {
    if (token) discardNativeClaudeToken(token);
    await proxy.close();
    if (setup) await cleanupNativeClaudeSetup(setup);
  }
}
