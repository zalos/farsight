// The framework inspection worker's identity is its whole import closure, not one file (ADR 44). The supervisor pins a
// built-in adapter by the digest of its module file; the worker imports the four framework libraries, the fact
// mapping and their packages, so a change to any of those would change what the adapter does without changing that
// pin. The registered module is therefore a generated entry that embeds the byte manifest of the closure: every
// Sentinel file the worker reaches through static or literal dynamic imports, and every package it or they import,
// whole (an installed package's directory; a workspace package's published files), with each package's own
// dependencies in turn. The entry's digest, which the supervisor pins and the plan records, covers every byte of the
// manifest. At start, under the launch gate and before the worker is imported, the entry re-reads every listed file
// and package folder and exits, writing nothing, if any byte, link, folder listing or absence differs.
//
// What this guarantees: a changed build or installation after registration is refused, and any change to the
// closure is a different adapter identity. It is not a defence against a process that can write the installation
// between that check and the import, which could equally rewrite Node itself.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FRAMEWORK_CONTROLS_WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
/** The exit status of an entry whose closure differs from its manifest: no protocol byte is written. */
export const CLOSURE_REFUSED = 71;

/**
 * One listed path: its SHA-256, the target of a link, that it must not exist, or (a package's folders) the SHA-256 of
 * its sorted names, so a file added inside a package is a change too.
 */
export type ClosureEntry = readonly [path: string, kind: 'file' | 'link' | 'absent' | 'dir', value: string];

export interface WorkerClosure {
  readonly entries: readonly ClosureEntry[];
  /** Over the entries with paths relative to the closure's own roots, so the same bytes installed elsewhere agree. */
  readonly digest: string;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const SPECIFIERS = [
  /(?:^|[\s;}])(?:import|export)\s[^'";]*?\sfrom\s*(['"])([^'"\n]+)\1/g,
  /(?:^|[\s;}])import\s*(['"])([^'"\n]+)\1/g,
  /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];
const packageName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

/** The package folder a bare name resolves to from `from`, by Node's node_modules walk, as a real path; or null. */
function packageDir(name: string, from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(d) === d) return null;
  }
}

/**
 * The worker's closure as it is on disk now; `extra` modules (the coordinator-side driver) are pinned with theirs.
 * Pure reads; nothing is imported or run.
 */
export function workerClosure(entry: string = FRAMEWORK_CONTROLS_WORKER, extra: readonly string[] = []): WorkerClosure {
  const out = new Map<string, ClosureEntry>();
  const portable = new Map<string, string>();
  const root = realpathSync(dirname(dirname(dirname(entry))));
  const add = (path: string, kind: ClosureEntry[1], value: string, name: string) => { out.set(path, [path, kind, value]); portable.set(name, `${kind}:${value}`); };
  const listPackage = (dir: string, name: string, pkg: any) => {
    const installed = dir.split(sep).includes('node_modules');
    // An installed package holds only what its publisher packed; a workspace package ships its `files`.
    const tops: string[] = !installed && Array.isArray(pkg.files) ? ['package.json', ...pkg.files] : readdirSync(dir).filter(n => n !== 'node_modules');
    const walk = (abs: string) => {
      let st;
      try { st = lstatSync(abs); } catch { add(abs, 'absent', '', `${name}/${relative(dir, abs)}`); return; }
      if (st.isSymbolicLink()) add(abs, 'link', readlinkSync(abs), `${name}/${relative(dir, abs)}`);
      else if (st.isDirectory()) {
        const names = readdirSync(abs).sort();
        add(abs, 'dir', sha(JSON.stringify(names)), `${name}/${relative(dir, abs)}/`);
        for (const n of names) if (n !== 'node_modules') walk(join(abs, n));
      }
      else if (st.isFile()) add(abs, 'file', sha(readFileSync(abs)), `${name}/${relative(dir, abs)}`);
    };
    if (installed || !Array.isArray(pkg.files)) add(dir, 'dir', sha(JSON.stringify(readdirSync(dir).sort())), `${name}/`);
    for (const t of [...new Set(tops)].sort()) walk(join(dir, t));
  };
  const packages = new Set<string>();
  const visitPackage = (name: string, from: string) => {
    const dir = packageDir(name, from);
    if (!dir) { add(join(from, 'node_modules', name), 'absent', '', `pkg:${name}@absent`); return; }
    if (packages.has(dir)) return;
    packages.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    listPackage(dir, `pkg:${name}@${pkg.version ?? ''}`, pkg);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visitPackage(dep, dir);
  };
  const files = new Set<string>();
  const visitFile = (abs: string) => {
    if (files.has(abs)) return;
    files.add(abs);
    if (!existsSync(abs)) { add(abs, 'absent', '', relative(root, abs)); return; }
    const bytes = readFileSync(abs);
    add(abs, 'file', sha(bytes), relative(root, abs));
    if (!/\.[cm]?js$/.test(abs)) return;
    const text = bytes.toString('utf8');
    for (const re of SPECIFIERS) for (const m of text.matchAll(re)) {
      const spec = m[2]!;
      if (spec.startsWith('node:') || isBuiltin(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) visitFile(resolve(dirname(abs), spec));
      else visitPackage(packageName(spec), dirname(abs));
    }
  };
  visitFile(realpathSync(entry));
  for (const e of extra) visitFile(realpathSync(e));
  const entries = [...out.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const digest = `sha256:${sha(JSON.stringify([...portable].sort((a, b) => (a[0] < b[0] ? -1 : 1))))}`;
  return { entries, digest };
}

/** The entry module's source: the manifest, the check, then the worker. */
export function closureEntrySource(closure: WorkerClosure, worker: string = FRAMEWORK_CONTROLS_WORKER): string {
  return `// Generated: the framework inspection worker behind its byte closure (closure ${closure.digest}).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
const CLOSURE = ${JSON.stringify(closure.entries)};
for (const [path, kind, value] of CLOSURE) {
  let st = null;
  try { st = lstatSync(path); } catch { st = null; }
  const ok = kind === 'absent' ? st === null
    : kind === 'link' ? st !== null && st.isSymbolicLink() && readlinkSync(path) === value
    : kind === 'dir' ? st !== null && st.isDirectory() && createHash('sha256').update(JSON.stringify(readdirSync(path).sort())).digest('hex') === value
    : st !== null && st.isFile() && createHash('sha256').update(readFileSync(path)).digest('hex') === value;
  if (!ok) process.exit(${CLOSURE_REFUSED});
}
const worker = await import(${JSON.stringify(pathToFileURL(realpathSync(worker)).href)});
await worker.runFrameworkControlsWorker();
`;
}

/**
 * Writes the entry for the closure as it is now into `dir` (an owner-private folder) and returns its path and
 * closure digest, for the adapter definition's `module`. The file name carries the closure digest; an existing file
 * of that name is reused only when its bytes are identical.
 */
export function writeClosureEntry(dir: string, worker: string = FRAMEWORK_CONTROLS_WORKER, extra: readonly string[] = []): { module: string; closureDigest: string; files: number } {
  const closure = workerClosure(worker, extra);
  const source = closureEntrySource(closure, worker);
  const module = join(dir, `framework-controls-${closure.digest.slice(7, 23)}.mjs`);
  try { writeFileSync(module, source, { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(module, 'utf8') !== source) throw e;
  }
  return { module, closureDigest: closure.digest, files: closure.entries.length };
}
