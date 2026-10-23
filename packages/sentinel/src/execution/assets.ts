// Package-owned files started by path: resolve lazily from this package's own manifest, independently of cwd or the
// packer's shared chunk layout. Installed workers and the launch gate have exact manifest paths and byte pins.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshot } from '../policy/immutable.js';
import { ExecutionError } from './errors.js';
import { builtinWorker, type BuiltinWorkerId } from './builtin-workers.js';

const invalid = (reason: string): never => { throw new ExecutionError('sentinel.execution.adapterInvalid', { reason }); };
const plain = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
interface PackageLayout { readonly root: string; readonly installed: boolean; readonly extension: '.mjs' | '.js'; readonly assets: Readonly<Record<string, any>> }
let layout: PackageLayout | undefined;

/** Internal installation layout; no file is discovered or read merely by importing this module. */
export function packageLayout(): PackageLayout {
  if (layout) return layout;
  const start = dirname(fileURLToPath(import.meta.url));
  let dist = start;
  for (let i = 0; basename(dist) !== 'dist' && i < 16 && dirname(dist) !== dist; i++) dist = dirname(dist);
  if (basename(dist) !== 'dist') return invalid('the Sentinel module is outside its compiled dist tree');
  const ownRoot = dirname(dist);
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    let st;
    try { st = lstatSync(manifest); } catch (error) {
      // Only an actually absent boundary permits looking above dist. Existing but unreadable, malformed or foreign
      // manifests must never turn an installed copy into an enclosing workspace's unpinned .js layout.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return invalid('the Sentinel package manifest is unreadable');
      if (dir === ownRoot) return invalid('the Sentinel package manifest is missing');
      continue;
    }
    if (dir !== ownRoot) return invalid('an unexpected package boundary is inside the shipped dist tree');
    if (!st.isFile() || st.isSymbolicLink()) return invalid('the Sentinel package manifest is unsafe');
    let pkg: any;
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return invalid('the Sentinel package manifest is unreadable or malformed'); }
    if (!plain(pkg) || (pkg.name !== '@farsight/sentinel' && pkg.name !== 'farsight-sentinel')) return invalid('the nearest package is not Sentinel');
    const installed = pkg.name === 'farsight-sentinel';
    if (installed && (!plain(pkg.sentinel) || !Object.hasOwn(pkg.sentinel, 'assets') || !plain(pkg.sentinel.assets))) invalid('the shipped asset manifest is unavailable');
    return (layout = Object.freeze({ root: dir, installed, extension: installed ? '.mjs' : '.js', assets: installed ? snapshot(pkg.sentinel.assets) : Object.freeze({}) }));
  }
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

/** The two fixed in-process model operations share this exact package-owned implementation entry. */
export function reviewOperationPath():string{return fixedDistFile(packageLayout(),'review/dispatch',false)}
