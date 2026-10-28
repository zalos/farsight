// Package-private fixed helper loader. No caller path, credential lookup override, shell, refresh or fallback.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNativeClaudeToken, type NativeClaudeToken } from './cli-native-auth.js';
import { fail, ProviderError, NativeCredentialError, parseNativeAuthDiagnostic } from './errors.js';
import { claimNativeLogin, assertNativeLoginActive, type NativeCallAuthority } from './authority.js';
import type { NativeTiming } from './cli-native-profile.js';

export const NATIVE_HELPER_SOURCE = 'sha256:6192b46a93c6352f7f7795543b51b6f75c2f75ee89e91fbcce523a9cf3a3d0cf';
export interface NativeHelper {
  readonly digest: string;
  readonly protocol: 'claude-keychain-token/1';
}
const helpers = new WeakMap<object, { path: string; digest: string }>();
async function helperDirectory(timing: NativeTiming): Promise<string> {
  const module = fileURLToPath(import.meta.url);
  let dist = dirname(module);
  // Only compiled dist ancestry, never an enclosing workspace's package. The own manifest is mandatory.
  for (let depth = 0; depth < 3 && basename(dist) !== 'dist'; depth++) dist = dirname(dist);
  if (basename(dist) !== 'dist')
    return fail('sentinel.provider.capabilityUntested', 'native helper compiled layout unavailable');
  const fd = await open(join(dirname(dist), 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let name: unknown;
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > 65536) throw new Error();
    name = JSON.parse(await fd.readFile('utf8')).name;
  } finally {
    await fd.close();
  }
  const member = relative(dist, module).split('\\').join('/');
  if (
    name === '@farsight/sentinel'
      ? member !== 'review/providers/cli-native-helper.js'
      : name !== 'farsight-sentinel' ||
        !/^(?:chunks\/chunk-[A-Z0-9]+|index|cli|review\/providers\/index)\.mjs$/.test(member)
  )
    return fail('sentinel.provider.capabilityUntested', 'native helper own package layout refused');
  boundary(timing);
  return join(dist, 'review/providers/native');
}
function boundary(t: NativeTiming) {
  if (t.signal?.aborted) fail('sentinel.provider.canceled', 'native helper canceled');
  if (!Number.isSafeInteger(t.deadlineAt) || Date.now() >= t.deadlineAt)
    fail('sentinel.provider.timeout', 'native helper original deadline elapsed');
}
async function hash(path: string, timing: NativeTiming) {
  boundary(timing);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size < 4096 || before.size > 1024 * 1024)
      return fail('sentinel.provider.capabilityUntested', 'fixed native helper bounds');
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat();
    boundary(timing);
    if (
      bytesRead !== bytes.length ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== 0x0100000c ||
      bytes.readUInt32LE(12) !== 2
    )
      return fail('sentinel.provider.capabilityUntested', 'fixed native helper identity');
    return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length };
  } finally {
    await fd.close();
  }
}
export async function qualifyNativeHelper(timing: NativeTiming): Promise<NativeHelper> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return fail('sentinel.provider.capabilityUntested', 'native helper platform unavailable');
  boundary(timing);
  try {
    const base = await helperDirectory(timing);
    const manifestPath = join(base, 'manifest.json');
    const mfd = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let manifest: any;
    try {
      const info = await mfd.stat();
      if (!info.isFile() || info.size > 2048) throw new Error();
      manifest = JSON.parse(await mfd.readFile('utf8'));
    } finally {
      await mfd.close();
    }
    if (
      Object.keys(manifest).sort().join() !==
        ['schema', 'platform', 'arch', 'protocol', 'sourceDigest', 'helperDigest', 'helperBytes', 'noUi', 'compiler']
          .sort()
          .join() ||
      manifest.schema !== 'sentinel-native-cli-helper/1' ||
      manifest.platform !== 'darwin' ||
      manifest.arch !== 'arm64' ||
      manifest.protocol !== 'claude-keychain-token/1' ||
      manifest.sourceDigest !== NATIVE_HELPER_SOURCE ||
      manifest.noUi !== true ||
      typeof manifest.compiler !== 'string' ||
      manifest.compiler.length > 500 ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.helperDigest)
    )
      throw new Error();
    const path = await realpath(join(base, 'claude-keychain-helper'));
    if (path !== join(base, 'claude-keychain-helper')) throw new Error();
    const observed = await hash(path, timing);
    if (observed.digest !== manifest.helperDigest || observed.bytes !== manifest.helperBytes) throw new Error();
    const result = Object.freeze({ digest: observed.digest, protocol: 'claude-keychain-token/1' as const });
    helpers.set(result, { path, digest: observed.digest });
    return result;
  } catch (error) {
    if (
      error instanceof ProviderError &&
      ['sentinel.provider.canceled', 'sentinel.provider.timeout'].includes(error.code)
    )
      throw error;
    return fail('sentinel.provider.capabilityUntested', 'fixed native helper missing or unqualified');
  }
}
/** Called only by the broker after a genuine envelope, consumed receipt and durable held reservation. */
export async function readNativeLogin(
  helper: NativeHelper,
  timing: NativeTiming,
  authority: NativeCallAuthority,
): Promise<NativeClaudeToken> {
  claimNativeLogin(authority, helper, timing);
  const held = helpers.get(helper);
  if (!held) return fail('sentinel.provider.notTrusted', 'native helper is not qualified');
  const observed = await hash(held.path, timing);
  if (observed.digest !== held.digest) return fail('sentinel.provider.capabilityUntested', 'native helper changed');
  boundary(timing);
  assertNativeLoginActive(authority);
  const deadlineAt = Math.min(timing.deadlineAt, Date.now() + 5000);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(held.path, [], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let total = 0,
      stderr = 0,
      failure: ProviderError | undefined;
    const chunks: Buffer[] = [],
      diagnostic: Buffer[] = [];
    const stop = (error: ProviderError) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new ProviderError('sentinel.provider.canceled', 'native helper canceled'));
    const timer = setTimeout(
      () => stop(new ProviderError('sentinel.provider.timeout', 'native helper deadline elapsed')),
      Math.max(1, deadlineAt - Date.now()),
    );
    timing.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      total += data.length;
      if (total > 65536)
        stop(new ProviderError('sentinel.provider.credentialUnavailable', 'native helper output bounds'));
      else chunks.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.length;
      if (stderr <= 256) diagnostic.push(data);
      if (stderr > 1024)
        stop(new ProviderError('sentinel.provider.credentialUnavailable', 'native helper stderr bounds'));
    });
    child.once('error', () => {
      failure ??= new ProviderError('sentinel.provider.credentialUnavailable', 'native helper could not start');
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      timing.signal?.removeEventListener('abort', abort);
      if (failure || code !== 0 || signal !== null || stderr !== 0) {
        for (const c of chunks) c.fill(0);
        const detail =
          stderr <= 256 && signal === null && [65, 69, 70, 74, 77].includes(code!)
            ? parseNativeAuthDiagnostic(Buffer.concat(diagnostic))
            : undefined;
        reject(
          failure ??
            (detail
              ? new NativeCredentialError(detail)
              : new ProviderError(
                  'sentinel.provider.credentialUnavailable',
                  'native login unavailable without interaction',
                )),
        );
      } else resolve(Buffer.concat(chunks));
    });
    if (timing.signal?.aborted) abort();
  });
  try {
    boundary(timing);
    return parseNativeClaudeToken(bytes, timing.deadlineAt, timing.signal);
  } finally {
    bytes.fill(0);
  }
}
