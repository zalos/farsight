// Registered fixed code is available only with the exact owner-promoted structural pack. Importing this module
// performs no asset lookup; entry construction happens only in the owner's execution/planning registry.
import { dirname, join } from 'node:path';
import { assertCanonicalStorePath } from '../store/paths.js';
import { ensurePrivateDir } from '../policy/user-state.js';
import { ensureDurableDir } from './publish-once.js';
import { boundedPathsAdapter } from '../analysis/paths/driver.js';
import { PATHS_SUPPORTED_RULES } from '../analysis/paths/definitions.js';
import { PATHS_ADAPTER_ID } from '../analysis/paths/request.js';
import { readPackDirectory, validatePack, type ValidatedPack } from '../rules/index.js';
import type { RuleLockEnvelope } from '../contracts/rules.js';
import { builtinPackDir } from './package-paths.js';
export { PATHS_ADAPTER_ID };
const adapters = new Map<string, ReturnType<typeof boundedPathsAdapter>>();
export function pathAdapter(trustDir: string) {
  assertCanonicalStorePath(trustDir);
  const dir = join(trustDir, 'adapters', PATHS_ADAPTER_ID);
  ensureDurableDir(dir, dirname(trustDir));
  for (const p of [trustDir, join(trustDir, 'adapters'), dir]) ensurePrivateDir(p, 'sentinel.receipt.storeUnsafe');
  let adapter = adapters.get(dir);
  if (!adapter) {
    adapter = boundedPathsAdapter({ entryDir: dir });
    adapters.set(dir, adapter);
  }
  return adapter;
}
export function shippedPathPack(pack: ValidatedPack): boolean {
  return pack.entry.packDigest === validatePack(readPackDirectory(builtinPackDir('bounded-paths')!)).entry.packDigest;
}
export function pathsAvailable(lock: RuleLockEnvelope, packs: readonly ValidatedPack[]): boolean {
  const held = packs.find(shippedPathPack);
  return Boolean(
    held &&
    lock.packs.some((p) => p.packDigest === held.entry.packDigest) &&
    held.rules.length === PATHS_SUPPORTED_RULES.length &&
    held.rules.every(
      (r) =>
        PATHS_SUPPORTED_RULES.some(
          (s) => s.familyId === r.familyId && s.revision === r.revision && s.definitionDigest === r.definitionDigest,
        ) &&
        held.manifest.rules.find((d) => d.familyId === r.familyId && d.revision === r.revision)?.implementation
          .adapterId === PATHS_ADAPTER_ID,
    ),
  );
}
