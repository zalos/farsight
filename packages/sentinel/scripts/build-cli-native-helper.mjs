// Build-time only. No runtime compiler, credential query, network or downloaded dependency.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, chmod, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = resolve(root, 'packages/sentinel/src/review/providers/native/claude-keychain-helper.m');
const output = resolve(root, 'build/sentinel-cli-native/darwin-arm64');
const local = resolve(root, 'packages/sentinel/dist/review/providers/native');
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native CLI helper build requires macOS arm64; no fallback or acquisition.');
const bytes = await readFile(source);
const { stdout: compiler } = await exec('/usr/bin/clang', ['--version'], { timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } });
const compilerLine = compiler.split('\n')[0];
if (!compilerLine || Buffer.byteLength(compilerLine) > 500) throw new Error('Compiler provenance unavailable.');
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, '.build-'));
try {
  const binary = join(scratch, 'claude-keychain-helper');
  await exec('/usr/bin/clang', ['-arch', 'arm64', '-mmacosx-version-min=13.0', '-fobjc-arc', '-O2', '-fstack-protector-strong',
    '-framework', 'Foundation', '-framework', 'Security', '-framework', 'LocalAuthentication', source, '-o', binary],
  { timeout: 30000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin' } });
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', binary], { timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } });
  const helper = await readFile(binary);
  if (helper.length > 262144 || helper.length < 32 || helper.readUInt32LE(0) !== 0xfeedfacf || helper.readUInt32LE(4) !== 0x0100000c || helper.readUInt32LE(12) !== 2) throw new Error('Helper is not a bounded Mach-O arm64 executable.');
  const { stdout } = await exec(binary, ['--self-test'], { timeout: 5000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } });
  const self = JSON.parse(stdout);
  if (self.protocol !== 'claude-keychain-token/1' || self.noUi !== true || self.coreDisabled !== true) throw new Error('Native no-UI self-test failed.');
  if (hash(await readFile(source)) !== hash(bytes)) throw new Error('Helper source changed during build.');
  const manifest = { schema: 'sentinel-native-cli-helper/1', platform: 'darwin', arch: 'arm64', protocol: 'claude-keychain-token/1',
    sourceDigest: hash(bytes), helperDigest: hash(helper), helperBytes: helper.length, noUi: true, compiler: compilerLine };
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const directory of [output, local]) {
    await mkdir(directory, { recursive: true });
    const next = join(directory, `.helper-${process.pid}`);
    await copyFile(binary, next); await chmod(next, 0o555);
    await rename(next, join(directory, 'claude-keychain-helper'));
    const metadata = join(directory, `.manifest-${process.pid}`);
    await copyFile(join(scratch, 'manifest.json'), metadata); await rename(metadata, join(directory, 'manifest.json'));
  }
  console.log(JSON.stringify(manifest));
} finally { await rm(scratch, { recursive: true, force: true }); }
