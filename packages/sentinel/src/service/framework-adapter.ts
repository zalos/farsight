// The shipped inspection adapter is registered code; only an exact owner-promoted pack makes it available.
// Its generated entry lives in private owner state outside the pinned installation and every checkout.
import { dirname, join } from 'node:path';
import { assertCanonicalStorePath } from '../store/paths.js';
import { ensurePrivateDir } from '../policy/user-state.js';
import { ensureDurableDir } from './publish-once.js';
import { frameworkControlsAdapter, CONTROLS_SUPPORTED_RULES, type FrameworkControlsAdapter } from '../frameworks/controls/driver.js';
import { FRAMEWORK_CONTROLS_ADAPTER_ID } from '../frameworks/controls/definitions.js';
import { readPackDirectory, validatePack, type ValidatedPack } from '../rules/index.js';
import type { RuleLockEnvelope } from '../contracts/rules.js';
import { builtinPackDir } from './package-paths.js';

export { FRAMEWORK_CONTROLS_ADAPTER_ID };
const adapters = new Map<string, FrameworkControlsAdapter>();
const UNSAFE = 'sentinel.receipt.storeUnsafe' as const;

export function frameworkAdapter(trustDir: string): FrameworkControlsAdapter {
  assertCanonicalStorePath(trustDir);
  const dir = join(trustDir, 'adapters', FRAMEWORK_CONTROLS_ADAPTER_ID);
  ensureDurableDir(dir, dirname(trustDir));
  for (const p of [trustDir, join(trustDir, 'adapters'), dir]) ensurePrivateDir(p, UNSAFE);
  let adapter = adapters.get(dir);
  if (!adapter) { adapter = frameworkControlsAdapter({ entryDir: dir }); adapters.set(dir, adapter); }
  return adapter;
}

/** Exact shipped bytes, revalidated from the installation; a different pack cannot donate capabilities. */
export function shippedFrameworkPack(pack: ValidatedPack): boolean {
  return pack.entry.packDigest === validatePack(readPackDirectory(builtinPackDir('framework-controls')!)).entry.packDigest;
}

/** Lock and held files, never a repository request or an adapter name, establish owner promotion. */
export function frameworkAvailable(lock: RuleLockEnvelope, packs: readonly ValidatedPack[]): boolean {
  const shipped = validatePack(readPackDirectory(builtinPackDir('framework-controls')!));
  const held = packs.find(p => p.entry.packDigest === shipped.entry.packDigest);
  if (!held || !lock.packs.some(p => p.packDigest === held.entry.packDigest) || held.rules.length !== CONTROLS_SUPPORTED_RULES.length) return false;
  return held.rules.every(r => CONTROLS_SUPPORTED_RULES.some(s => s.familyId === r.familyId && s.revision === r.revision && s.definitionDigest === r.definitionDigest)
    && held.manifest.rules.find(d => d.familyId === r.familyId && d.revision === r.revision)?.implementation.adapterId === FRAMEWORK_CONTROLS_ADAPTER_ID);
}
