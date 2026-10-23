// Package-owned files started by path: resolve lazily from this package's own manifest, independently of cwd or the
// packer's shared chunk layout. Installed workers and the launch gate have exact manifest paths and byte pins.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExecutionError } from './errors.js';
import { builtinWorker, type BuiltinWorkerId } from './builtin-workers.js';

const invalid = (reason: string): never => { throw new ExecutionError('sentinel.execution.adapterInvalid', { reason }); };
const plain = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
interface PackageLayout { readonly root: string; readonly installed: boolean; readonly extension: '.mjs' | '.js'; readonly assets: Readonly<Record<string, any>> }
let layout: PackageLayout | undefined;

/** Internal installation layout; no file is discovered or read merely by importing this module. */
export function packageLayout(): PackageLayout {
  if (layout) return layout;
  for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 16; dir = dirname(dir), i++) {
    let pkg: any;
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* not here */ }
    if (pkg?.name === '@farsight/sentinel' || pkg?.name === 'farsight-sentinel') {
      const installed = pkg.name === 'farsight-sentinel';
      if (installed && (!plain(pkg.sentinel) || !Object.hasOwn(pkg.sentinel, 'assets') || !plain(pkg.sentinel.assets))) invalid('the shipped asset manifest is unavailable');
      return (layout = Object.freeze({ root: dir, installed, extension: installed ? '.mjs' : '.js', assets: installed ? pkg.sentinel.assets : Object.freeze({}) }));
    }
    if (dirname(dir) === dir) break;
  }
  return invalid('the Sentinel package root was not found');
}

export function packageRoot(): string { return packageLayout().root; }

function fixedDistFile(own: PackageLayout, stem: string, asset: boolean): string {
  const rel = `dist/${stem}${own.extension}`, path = join(own.root, rel);
  try {
    if (realpathSync(own.root) !== own.root) return invalid('the shipped package path is linked');
    let parent = own.root;
    for (const part of relative(own.root, path).split(sep)) {
      parent = join(parent, part);
      const st = lstatSync(parent);
      if (st.isSymbolicLink() || (parent === path ? !st.isFile() : !st.isDirectory())) return invalid('a shipped file is missing, linked or unsafe');
    }
    if (asset && own.installed) {
      const pin = Object.hasOwn(own.assets, stem) ? own.assets[stem] : undefined;
      if (!plain(pin) || pin.path !== rel || typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)
        || createHash('sha256').update(readFileSync(path)).digest('hex') !== pin.sha256) return invalid('the shipped file differs from its asset manifest');
    }
    return path;
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    return invalid('a required file is not shipped with the package');
  }
}

/** The driver is a fixed dist member pinned by the whole closure; it needs no separate asset-manifest entry. */
export function builtinWorkerFiles(id: BuiltinWorkerId) {
  const descriptor = builtinWorker(id), own = packageLayout();
  return { descriptor, layout: own, worker: fixedDistFile(own, descriptor.asset, true), driver: fixedDistFile(own, descriptor.driver, false) };
}

/** Rechecked at use: an installed .js sibling never substitutes for a missing or changed .mjs launch gate. */
export function launchGateUrl(): string { return pathToFileURL(fixedDistFile(packageLayout(), 'execution/launch-gate', true)).href; }
