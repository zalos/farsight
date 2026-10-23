// Stage only the fixed, source-bound macOS helper produced by this release's build job.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const read = (path, limit) => {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > limit) throw new Error('Native helper artifact must be a bounded regular file.');
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw new Error('Native helper artifact exceeds its bound.');
  return bytes;
};
export function stageNativeCliHelper(root, out, required = false) {
  const source = join(root, 'packages/sentinel/src/review/providers/native/claude-keychain-helper.m');
  const artifact = join(root, 'build/sentinel-cli-native/darwin-arm64');
  const manifestFile = join(artifact, 'manifest.json');
  if (!existsSync(manifestFile)) {
    if (required) throw new Error('The release requires the macOS arm64 CLI helper artifact from the same source revision.');
    return false;
  }
  const manifestBytes = read(manifestFile, 4096);
  const m = JSON.parse(manifestBytes);
  const keys = ['schema','platform','arch','protocol','sourceDigest','helperDigest','helperBytes','noUi','compiler'];
  if (!m || Object.keys(m).sort().join() !== keys.sort().join() || m.schema !== 'sentinel-native-cli-helper/1' ||
      m.platform !== 'darwin' || m.arch !== 'arm64' || m.protocol !== 'claude-keychain-token/1' || m.noUi !== true ||
      typeof m.compiler !== 'string' || !m.compiler || Buffer.byteLength(m.compiler) > 500 ||
      !Number.isInteger(m.helperBytes) || m.helperBytes < 32 || m.helperBytes > 262144 ||
      !/^sha256:[a-f0-9]{64}$/.test(m.helperDigest) || !/^sha256:[a-f0-9]{64}$/.test(m.sourceDigest)) {
    throw new Error('The native CLI helper manifest is invalid.');
  }
  const bytes = read(join(artifact, 'claude-keychain-helper'), 262144);
  if (digest(read(source, 262144)) !== m.sourceDigest || bytes.length !== m.helperBytes || digest(bytes) !== m.helperDigest ||
      bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 2) {
    throw new Error('The native CLI helper does not match this source revision and macOS arm64 executable manifest.');
  }
  const target = join(out, 'dist/review/providers/native');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'claude-keychain-helper'), bytes, { mode: 0o555 });
  chmodSync(join(target, 'claude-keychain-helper'), 0o555);
  writeFileSync(join(target, 'manifest.json'), manifestBytes);
  return true;
}
