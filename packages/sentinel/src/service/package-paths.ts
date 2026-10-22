// This package's own files: its executable (which also becomes the built-in preview worker when the coordinator gives
// it the detector's identity) and the rule packs it ships. Found from this module's folder upward, so they are right
// both in the workspace build and in the published bundle, whose shared code lives in chunk files.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This package's own executable: the manifest's `bin`, found from this module's folder upward.
 */
export function ownExecutable(): string {
  const { root, bin } = ownPackage();
  return join(root, bin);
}

/** This package's own folder (the one whose manifest names the `farsight-sentinel` executable) and that executable. */
export function ownPackage(): { root: string; bin: string } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; bin?: Record<string, string> };
      const bin = pkg.bin?.['farsight-sentinel'];
      if ((pkg.name === '@farsight/sentinel' || pkg.name === 'farsight-sentinel') && bin) return { root: dir, bin };
    }
    dir = dirname(dir);
  }
  throw new Error('sentinel.execution.adapterInvalid: the package executable could not be found');
}

/** Rule packs this package ships, by name: `builtin:<name>` on the command line. */
export const BUILTIN_PACKS = ['foundation-preview', 'pattern', 'advisories', 'infrastructure', 'ci', 'secrets', 'framework-controls'] as const;

/** The folder of a pack this package ships, or undefined for any other name. */
export function builtinPackDir(name: string): string | undefined {
  return (BUILTIN_PACKS as readonly string[]).includes(name) ? join(ownPackage().root, 'rules', name) : undefined;
}
