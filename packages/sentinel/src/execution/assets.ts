// Files the package ships beside its code and starts or hashes by path: the launch gate a built-in worker process
// runs first. Code may be moved by the packer (pack-sentinel bundles it into dist/*.mjs and dist/chunks/), so a
// sibling URL of the importing file is not stable. The package root is found instead, by walking up from this file
// to the nearest package.json naming the Sentinel package, and the asset is looked up there in its known places.
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExecutionError } from './errors.js';

const NAMES = new Set(['@farsight/sentinel', 'farsight-sentinel']);
let root: string | undefined;

/** The installed or workspace Sentinel package folder. */
export function packageRoot(): string {
  if (root) return root;
  for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 16; dir = dirname(dir), i++) {
    try {
      if (NAMES.has(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name)) return (root = dir);
    } catch { /* not here */ }
    if (dirname(dir) === dir) break;
  }
  throw new ExecutionError('sentinel.execution.adapterInvalid', { reason: 'the Sentinel package root was not found' });
}

let gate: string | undefined;

/** The launch gate's file URL: dist/execution/launch-gate.js in the workspace, .mjs in the packed tarball. */
export function launchGateUrl(): string {
  if (gate) return gate;
  for (const rel of ['dist/execution/launch-gate.mjs', 'dist/execution/launch-gate.js']) {
    const path = join(packageRoot(), rel);
    try { if (lstatSync(path).isFile()) return (gate = pathToFileURL(path).href); } catch { /* next */ }
  }
  throw new ExecutionError('sentinel.execution.adapterInvalid', { reason: 'the launch gate is not shipped with the package' });
}


/** Framework worker is a shipped asset, never relative to a bundled shared chunk. */
export function frameworkWorkerPath(): string {
  for (const rel of ['dist/frameworks/controls/worker.mjs', 'dist/frameworks/controls/worker.js']) {
    const path = join(packageRoot(), rel);
    try { if (lstatSync(path).isFile()) return path; } catch { /* try the source-layout build */ }
  }
  throw new ExecutionError('sentinel.execution.adapterInvalid', { reason: 'the framework worker is not shipped with the package' });
}
