// The framework inspection worker's identity is its whole import closure, not one file (ADR 44). The supervisor pins a
// built-in adapter by the digest of its module file; the worker imports the four framework libraries, the fact
// mapping and their packages, so a change to any of those would change what the adapter does without changing that
// pin. The registered module is therefore a generated entry that embeds the byte manifest of the closure: every
// Sentinel file the worker reaches through static or literal dynamic imports, and every package it or they import,
// whole (an installed package's directory; a workspace package's published files), with each package's own
// dependencies in turn. The entry's digest, which the supervisor pins and the plan records, covers every byte of the
// manifest, including how Node finds each package (every `node_modules` candidate it would try, and the real path the
// one it takes resolves to). At start, under the launch gate and before the worker is imported, the entry re-reads
// every listed file, package folder and resolution and exits, writing nothing, if any byte, link, folder listing,
// resolution or absence differs.
//
// What this guarantees: a changed build or installation after registration is refused, and any change to the
// closure is a different adapter identity. It is not a defence against a process that can write the installation
// between that check and the import, which could equally rewrite Node itself.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FRAMEWORK_CONTROLS_WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
/** The exit status of an entry whose closure differs from its manifest: no protocol byte is written. */
export const CLOSURE_REFUSED = 71;

/**
 * One listed path: its SHA-256 (`file`), the target of a link inside a package (`link`), that it must not exist
 * (`absent`), the SHA-256 of a package folder's sorted names (`dir`, so a file added inside a package is a change too),
 * the real path a logical path must still resolve to (`resolves`: a `node_modules` candidate Node takes, or a module
 * reached through a link), or that a `node_modules` candidate Node would try first holds no folder (`unresolved`, so a
 * nearer package cannot shadow the pinned one).
 */
export type ClosureEntry = readonly [path: string, kind: 'file' | 'link' | 'absent' | 'dir' | 'resolves' | 'unresolved', value: string];

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

/**
 * The worker's closure as it is on disk now; `extra` modules (the coordinator-side driver) are pinned with theirs.
 * Pure reads; nothing is imported or run.
 */
export function workerClosure(entry: string = FRAMEWORK_CONTROLS_WORKER, extra: readonly string[] = []): WorkerClosure {
  const out = new Map<string, ClosureEntry>();
  const portable = new Map<string, string>();
  const root = realpathSync(dirname(dirname(dirname(entry))));
  const add = (path: string, kind: ClosureEntry[1], value: string, name: string) => { out.set(`${path}\u0000${kind}`, [path, kind, value]); portable.set(name, `${kind}:${value}`); };
  const where = (p: string) => relative(root, p);
  // Node's package lookup from `from`, as it runs it: every `node_modules/<name>` from the importing folder up to the
  // root, the first that is a folder wins and is then used by its real path. Each candidate before it is bound as
  // holding no folder and the winner as resolving to exactly that real path, so neither a retargeted link nor a nearer
  // new package can change what loads. Returns the real folder, or null when no candidate is one.
  const resolutions = new Map<string, string | null>();
  const packageDir = (name: string, from: string): string | null => {
    const key = `${from}\u0000${name}`;
    if (resolutions.has(key)) return resolutions.get(key)!;
    let found: string | null = null;
    for (let d = from; ; d = dirname(d)) {
      const candidate = join(d, 'node_modules', name);
      let isDir = false;
      try { isDir = statSync(candidate).isDirectory(); } catch { isDir = false; }
      if (isDir) { found = realpathSync(candidate); add(candidate, 'resolves', found, `resolve:${where(from)}:${name}`); break; }
      add(candidate, 'unresolved', '', `candidate:${where(from)}:${where(candidate)}`);
      if (dirname(d) === d) break;
    }
    resolutions.set(key, found);
    return found;
  };
  const listPackage = (dir: string, name: string, pkg: any) => {
    const installed = dir.split(sep).includes('node_modules');
    // An installed package holds only what its publisher packed; a workspace package ships its `files`.
    const tops: string[] = !installed && Array.isArray(pkg.files) ? ['package.json', ...pkg.files] : readdirSync(dir).filter(n => n !== 'node_modules');
    const followed = new Set<string>();
    const walk = (abs: string) => {
      let st;
      try { st = lstatSync(abs); } catch { add(abs, 'absent', '', `${name}/${relative(dir, abs)}`); return; }
      if (st.isSymbolicLink()) {
        // Node loads through a link: bind the link, the real path it resolves to, and the target's own bytes or
        // folder, wherever it is. A dangling link stays bound to its text and its target's absence.
        const label = `${name}/${relative(dir, abs)}`;
        const text = readlinkSync(abs);
        add(abs, 'link', text, label);
        let real: string | null = null;
        try { real = realpathSync(abs); } catch { real = null; }
        if (real === null) { add(resolve(dirname(abs), text), 'absent', '', `${label}->absent`); return; }
        add(abs, 'resolves', real, `${label}->`);
        if (!followed.has(real)) { followed.add(real); walk(real); }
      }
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
    if (!dir) return;
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
    // Node loads a module by its real path and resolves its imports from there: a path through a link is bound to it.
    const real = realpathSync(abs);
    if (real !== abs) { add(abs, 'resolves', real, `module:${where(abs)}`); visitFile(real); return; }
    const bytes = readFileSync(abs);
    add(abs, 'file', sha(bytes), relative(root, abs));
    // Its own path must stay real: Node resolves its relative imports and its package lookups from there.
    add(abs, 'resolves', abs, `real:${where(abs)}`);
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
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
const CLOSURE = ${JSON.stringify(closure.entries)};
for (const [path, kind, value] of CLOSURE) {
  let st = null;
  try { st = lstatSync(path); } catch { st = null; }
  const ok = kind === 'absent' ? st === null
    : kind === 'link' ? st !== null && st.isSymbolicLink() && readlinkSync(path) === value
    : kind === 'dir' ? st !== null && st.isDirectory() && createHash('sha256').update(JSON.stringify(readdirSync(path).sort())).digest('hex') === value
    : kind === 'resolves' ? (() => { try { return realpathSync(path) === value; } catch { return false; } })()
    : kind === 'unresolved' ? (() => { try { return !statSync(path).isDirectory(); } catch { return true; } })()
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
