// One admitted Copilot invocation. Native supported keychain authentication remains inside the pinned vendor process.
import { writeFile } from 'node:fs/promises';
import {
  nativeCopilotSetup,
  cleanupNativeCopilotSetup,
  verifyNativeCopilotSetup,
  readNativeCopilotSelector,
  copilotBoundary,
  type NativeCopilotSelector,
} from './cli-copilot-profile.js';
import { openNativeCopilotProxy } from './cli-copilot-proxy.js';
import { NativeCopilotDecoder, NativeCopilotStderrClassifier } from './cli-copilot-wire.js';
import { beginCopilotCall, finishCopilotCall, type CopilotCallAuthority } from './authority.js';
import { freshSandboxedState, readOwnedFile, superviseSandboxedCli } from './sandboxed-cli.js';
import { NativeCopilotError, type NativeCopilotDiagnostic, ProviderError, type Spend } from './errors.js';
import type { ParsedReply } from './kinds.js';
export function copilotInvocationArguments(usagePath: string, model: string): readonly string[] {
  return Object.freeze([
    '--no-auto-update',
    '--model',
    model,
    '--context',
    'default',
    '-s',
    '--usage-output-file',
    usagePath,
    '--excluded-tools',
    'builtin:*',
    'mcp:*',
    'custom:*',
    '--deny-tool',
    'shell',
    '--deny-tool',
    'write',
    '--disable-builtin-mcps',
    '--no-custom-instructions',
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
/** Data-only completion check; this cannot create native call authority. */
export function cleanCopilotExit(
  code: number | null,
  signal: string | null,
  spawned: boolean,
  stderrBytes: number,
): boolean {
  return code === 0 && signal === null && spawned === true && stderrBytes === 0;
}
/** An exact pinned CLI login refusal. No proxy connection proves no request was sent; otherwise spend stays uncertain. */
export function classifyCopilotLoginRefusal(
  state: Readonly<{
    code: number | null;
    signal: string | null;
    spawned: boolean;
    stdoutBytes: number;
    frames: number;
    connections: number;
    upstreamBytes: number;
  }>,
  stderr: NativeCopilotStderrClassifier,
): Spend | null {
  if (
    state.code !== 1 ||
    state.signal !== null ||
    !state.spawned ||
    state.stdoutBytes !== 0 ||
    state.frames !== 0 ||
    !stderr.noAuthenticationInformation
  )
    return null;
  return state.connections === 0 && state.upstreamBytes === 0 ? 'none' : 'possible';
}
/** The owner-created fixed private state: only the validated selected-account pair is projected; nothing else. */
export function copilotPrivateState(
  selector: Readonly<NativeCopilotSelector>,
  options: Readonly<{ stageSkills?: boolean }> = {},
): Readonly<{
  config: string;
  settings: string;
}> {
  return Object.freeze({
    config: JSON.stringify({ lastLoggedInUser: selector, loggedInUsers: [selector] }),
    // No other account state or vendor discovery: hooks, memory, extensions and every skill are off.
    settings: JSON.stringify({
      disableAllHooks: true,
      memory: false,
      continueOnAutoMode: false,
      storeTokenPlaintext: false,
      extensions: { mode: 'disabled' },
      // A native stage with promoted skills loads only those, from its scratch tree; every other skill stays off and
      // the vendor's bundled skills stay unreadable under the seatbelt.
      skills: { disabled: options.stageSkills ? [] : ['*'] },
    }),
  });
}
const COPILOT_WORDS = Object.freeze({
  canceled: 'Copilot invocation canceled',
  timeout: 'original Copilot deadline elapsed',
  stream: 'Copilot stream refused',
  stderr: 'Copilot stderr bound',
  stdin: 'Copilot input delivery failed',
  unavailable: 'Copilot native process unavailable',
});
const SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV']);
export async function nativeCopilotCall(authority: CopilotCallAuthority): Promise<ParsedReply> {
  const { runtime, wire, limits } = beginCopilotCall(authority);
  copilotBoundary(limits);
  const proxy = await openNativeCopilotProxy({ ...limits, maxUpstreamBytes: 4194304, maxDownstreamBytes: 4194304 });
  let setup: Awaited<ReturnType<typeof nativeCopilotSetup>> | undefined,
    phase: NativeCopilotDiagnostic['phase'] = 'setup',
    reason: NativeCopilotDiagnostic['reason'] = 'output-unavailable',
    loginRefusal: Spend | null = null;
  let decoder: NativeCopilotDecoder | undefined;
  const state = freshSandboxedState();
  const stderrClassifier = new NativeCopilotStderrClassifier();
  try {
    const selector = await readNativeCopilotSelector(limits);
    setup = await nativeCopilotSetup(runtime, proxy.port, limits);
    const current = setup,
      usagePath = current.ownedRoot + '/state/usage.json',
      files = copilotPrivateState(selector);
    await writeFile(current.ownedRoot + '/state/config.json', files.config, { flag: 'wx', mode: 0o600 });
    await writeFile(current.ownedRoot + '/state/settings.json', files.settings, { flag: 'wx', mode: 0o600 });
    copilotBoundary(limits);
    await verifyNativeCopilotSetup(current, limits);
    decoder = new NativeCopilotDecoder(limits.maxResponseBytes, wire.requestedModel);
    const stream = decoder;
    phase = 'spawn';
    try {
      // Piped stdin is the supported programmatic prompt path. Supplying -p would cause Copilot to ignore stdin.
      await superviseSandboxedCli(
        {
          label: 'sentinel-copilot',
          policy: current.policy,
          executable: current.executable,
          args: copilotInvocationArguments(usagePath, wire.requestedModel),
          cwd: current.ownedRoot + '/home',
          env: current.env,
          timing: limits,
          stderrLimit: 4096,
          words: COPILOT_WORDS,
          onStdout: (b) => stream.push(b),
          onStderr: (b) => stderrClassifier.push(b),
          onSpawned: () => {
            phase = 'stream';
          },
          deliver: (child) => child.stdin!.end(wire.stdin),
        },
        state,
      );
    } catch (e) {
      if (state.reason) reason = state.reason;
      throw e;
    }
    if (!cleanCopilotExit(state.code, state.signal, state.spawned, state.stderrBytes)) {
      phase = 'exit';
      const p = proxy.observation();
      loginRefusal = classifyCopilotLoginRefusal(
        {
          code: state.code,
          signal: state.signal,
          spawned: state.spawned,
          stdoutBytes: stream.bytes,
          frames: stream.observation().frames,
          connections: p.connections,
          upstreamBytes: p.upstreamWireBytes,
        },
        stderrClassifier,
      );
      reason = loginRefusal ? 'native-auth-unavailable' : 'process-exit';
      throw new ProviderError(
        loginRefusal ? 'sentinel.provider.credentialUnavailable' : 'sentinel.provider.malformedResponse',
        loginRefusal ? 'Copilot login is unavailable' : 'Copilot exited without accepted completion',
        loginRefusal ?? 'possible',
      );
    }
    copilotBoundary(limits);
    phase = 'usage-read';
    reason = 'usage-file';
    const bytes = await readOwnedFile(
      usagePath,
      limits.maxResponseBytes - decoder.bytes,
      () => copilotBoundary(limits),
      { bound: 'Copilot usage file bound', changed: 'Copilot usage identity changed' },
    );
    phase = 'usage';
    reason = 'usage-shape';
    return decoder.finish(bytes);
  } catch (e) {
    const possibleSpend = state.pid !== undefined;
    const error =
      e instanceof ProviderError
        ? e
        : new ProviderError(
            'sentinel.provider.malformedResponse',
            'Copilot output unavailable',
            possibleSpend ? 'possible' : 'none',
          );
    const prior = e instanceof NativeCopilotError ? e.nativeCopilot : undefined,
      stream = decoder?.observation(),
      p = proxy.observation();
    // The exact pinned login refusal with no proxy connection proves no model call was sent.
    throw new NativeCopilotError(
      error.code,
      loginRefusal === 'none' ? 'none' : possibleSpend ? 'possible' : error.spend,
      {
        schema: 'sentinel-copilot-failure/1',
        phase: prior?.phase ?? phase,
        reason:
          prior?.reason ??
          (loginRefusal
            ? 'native-auth-unavailable'
            : error.code === 'sentinel.provider.credentialUnavailable'
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
        eventClass: stream?.eventClass ?? 'none',
        frames: stream?.frames ?? 0,
        stdoutBytes: stream?.bytes ?? 0,
        stderrBytes: state.stderrBytes,
        connections: p.connections,
        upstreamBytes: p.upstreamWireBytes,
        downstreamBytes: p.downstreamWireBytes,
        proxyEnded: p.endedBy,
      },
    );
  } finally {
    finishCopilotCall(authority);
    await proxy.close();
    if (setup) await cleanupNativeCopilotSetup(setup);
  }
}
