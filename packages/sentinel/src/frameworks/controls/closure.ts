// The framework inspection worker's identity is its whole import closure, not one file (ADR 44). The supervisor pins a
// built-in adapter by the digest of its module file; the worker imports the four framework libraries, the fact
// mapping and their packages, so a change to any of those would change what the adapter does without changing that
// pin. The registered module is therefore a generated entry that embeds the byte manifest of the closure: every
// Sentinel file the worker reaches through static or literal dynamic imports, and every package it or they import,
// whole (each resolved package's directory, including workspace packages), with each package's own
// dependencies in turn. The entry's digest, which the supervisor pins and the plan records, covers every byte of the
// manifest, including how Node finds each package (every `node_modules` candidate it would try, and the real path the
// one it takes resolves to). At start, under the launch gate and before the worker is imported, the entry re-reads
// every listed file, package folder and resolution and exits, writing nothing, if any byte, link, folder listing,
// resolution or absence differs.
//
// Packed execution pins the fixed shipped dist tree in full plus installed dependency metadata/actual lookups
// from every emitted module folder; generated require aliases are not a closure-completeness boundary.
//
// What this guarantees: a changed build or installation after registration is refused, and any change to the
// closure is a different adapter identity. It is not a defence against a process that can write the installation
// between that check and the import, which could equally rewrite Node itself.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinWorkerFiles } from '../../execution/assets.js';
import { sha256Hex as sha } from '../../kernel/digest.js';
import { builtinWorker, type BuiltinWorkerId } from '../../execution/builtin-workers.js';
import { publishOnce, readPublished } from '../../service/publish-once.js';

const MAX_CLOSURE_ENTRIES = 20_000;
const MAX_CLOSURE_FILES = 10_000;
const MAX_CLOSURE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
let parser: typeof import('oxc-parser') | undefined;
/** The exit status of an entry whose closure differs from its manifest: no protocol byte is written. */
export const CLOSURE_REFUSED = 71;

/**
 * One listed path: its SHA-256 (`file`), the target of a link inside a package (`link`), that it must not exist
 * (`absent`), the SHA-256 of a package folder's sorted names (`dir`, so a file added inside a package is a change too),
 * the real path a logical path must still resolve to (`resolves`: a `node_modules` candidate Node takes, or a module
 * reached through a link), or that a `node_modules` candidate Node would try first holds no folder (`unresolved`, so a
 * nearer package cannot shadow the pinned one).
 */
export type ClosureEntry = readonly [
  path: string,
  kind: 'file' | 'link' | 'absent' | 'dir' | 'resolves' | 'unresolved',
  value: string,
];

/**
 * A worker's byte closure: every file, link, folder and resolution its entry rechecks, and the digest over them all.
 */
export interface WorkerClosure {
  readonly entries: readonly ClosureEntry[];
  /** Relative labels still carry absolute resolution and target-path values. This digest is bound to the installation, not invariant under relocation. */
  readonly digest: string;
}

const packageName = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;

/** Literal module loads, including createRequire aliases. Only shipped dependency code is inspected here; computed
 * native loaders in the pinned dependencies are audited separately in ADR 44. This is not an arbitrary JS resolver. */
function literalLoads(path: string, bytes: Uint8Array): string[] {
  // Loading the native parser is registration work, never a side effect of importing the CLI or service.
  const parsed = (parser ??= createRequire(import.meta.url)('oxc-parser')).parseSync(
    path,
    Buffer.from(bytes).toString('utf8'),
  );
  const program = typeof parsed.program === 'string' ? JSON.parse(parsed.program) : parsed.program;
  // An invalid bundled fixture is still byte-pinned; Node cannot execute it as a module.
  if (parsed.errors.length) return [];
  const nodes: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.type === 'string') nodes.push(n);
    for (const v of Object.values(n))
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
  };
  walk(program);
  const factories = new Set(['createRequire']);
  const namespaces = new Set(['module']);
  for (const n of nodes)
    if (n.type === 'ImportDeclaration' && ['module', 'node:module'].includes(n.source?.value)) {
      for (const spec of n.specifiers) {
        if (spec.imported?.name === 'createRequire') factories.add(spec.local.name);
        if (['ImportNamespaceSpecifier', 'ImportDefaultSpecifier'].includes(spec.type)) namespaces.add(spec.local.name);
      }
    }
  const isFactory = (n: any) =>
    n?.type === 'Identifier'
      ? factories.has(n.name)
      : n?.type === 'MemberExpression' &&
        namespaces.has(n.object?.name) &&
        (n.property?.name ?? n.property?.value) === 'createRequire';
  const loaders = new Set(['require']);
  for (const n of nodes)
    if (
      n.type === 'VariableDeclarator' &&
      n.id?.type === 'Identifier' &&
      n.init?.type === 'CallExpression' &&
      isFactory(n.init.callee)
    )
      loaders.add(n.id.name);
  // Simple aliases are conservative name sets, not a claim to resolve arbitrary JavaScript data flow.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes)
      if (
        n.type === 'VariableDeclarator' &&
        n.id?.type === 'Identifier' &&
        n.init?.type === 'Identifier' &&
        loaders.has(n.init.name) &&
        !loaders.has(n.id.name)
      ) {
        loaders.add(n.id.name);
        grew = true;
      }
  }
  const isLoader = (n: any): boolean =>
    n?.type === 'Identifier'
      ? loaders.has(n.name)
      : n?.type === 'CallExpression'
        ? isFactory(n.callee)
        : n?.type === 'MemberExpression' &&
          ((n.object?.name === 'module' && (n.property?.name ?? n.property?.value) === 'require') ||
            (loaders.has(n.object?.name) && (n.property?.name ?? n.property?.value) === 'resolve'));
  const literals: string[] = [];
  for (const n of nodes) {
    const value = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(
      n.type,
    )
      ? n.source
      : n.type === 'CallExpression' && isLoader(n.callee)
        ? n.arguments[0]
        : null;
    if (typeof value?.value === 'string') literals.push(value.value);
    else if (value?.type === 'TemplateLiteral' && value.expressions.length === 0)
      literals.push(value.quasis[0].value.cooked);
  }
  return literals;
}

/**
 * The worker's closure as it is on disk now; `extra` modules (the coordinator-side driver) are pinned with theirs.
 * Reads the installed build as data with the pinned parser; nothing from the target is imported or run.
 */
function collectClosure(
  entry: string,
  extra: readonly string[],
  packed?: ReturnType<typeof builtinWorkerFiles>,
): WorkerClosure {
  const out = new Map<string, ClosureEntry>();
  const portable = new Map<string, string>();
  const modulePackages = new Set<string>();
  const root = realpathSync(dirname(dirname(dirname(entry))));
  const countedFiles = new Set<string>();
  let fileBytes = 0;
  const readPinned = (path: string) => {
    if (!countedFiles.has(path)) {
      const size = lstatSync(path).size;
      if (countedFiles.size >= MAX_CLOSURE_FILES || fileBytes + size > MAX_CLOSURE_BYTES)
        throw new Error('the framework closure exceeds its bounded file inventory');
      countedFiles.add(path);
      fileBytes += size;
    }
    return readFileSync(path);
  };
  const add = (path: string, kind: ClosureEntry[1], value: string, name: string) => {
    if (out.size >= MAX_CLOSURE_ENTRIES) throw new Error('the framework closure exceeds its bounded entry inventory');
    out.set(`${path}\u0000${kind}`, [path, kind, value]);
    portable.set(name, `${kind}:${value}`);
  };
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
      let isDir: boolean;
      try {
        isDir = statSync(candidate).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) {
        found = realpathSync(candidate);
        add(candidate, 'resolves', found, `resolve:${where(from)}:${name}`);
        break;
      }
      add(candidate, 'unresolved', '', `candidate:${where(from)}:${where(candidate)}`);
      if (dirname(d) === d) break;
    }
    resolutions.set(key, found);
    return found;
  };
  const listPackage = (dir: string, name: string, pkg: any) => {
    // A workspace's files list does not constrain Node's reads: its runtime may load an unlisted internal helper.
    // Bind the whole resolved folder for both installed and workspace packages, rather than trusting that list.
    const tops = readdirSync(dir).filter((n) => n !== 'node_modules');
    const followed = new Set<string>();
    const inside = (path: string) => path === dir || path.startsWith(dir + sep);
    const refuseEscape = (path: string) => {
      if (!inside(path) || relative(dir, path).split(sep).includes('node_modules'))
        throw new Error(
          'the worker package loads outside its pinned package root or through an unbound node_modules path',
        );
    };
    // A legacy package main can point outside its folder even without an inner link.
    if (typeof pkg.main === 'string') refuseEscape(resolve(dir, pkg.main));
    const walk = (abs: string) => {
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        add(abs, 'absent', '', `${name}/${relative(dir, abs)}`);
        return;
      }
      if (st.isSymbolicLink()) {
        // Node loads through a link: bind the link, the real path it resolves to, and the target's own bytes or
        // folder within this package. An escaped target is unsupported: binding one file would not bind its imports.
        // A dangling link stays bound to its text and its target's absence.
        const label = `${name}/${relative(dir, abs)}`;
        const text = readlinkSync(abs);
        refuseEscape(resolve(dirname(abs), text));
        add(abs, 'link', text, label);
        let real: string | null;
        try {
          real = realpathSync(abs);
        } catch {
          real = null;
        }
        if (real === null) {
          add(resolve(dirname(abs), text), 'absent', '', `${label}->absent`);
          return;
        }
        refuseEscape(real);
        add(abs, 'resolves', real, `${label}->`);
        if (!followed.has(real)) {
          followed.add(real);
          walk(real);
        }
      } else if (st.isDirectory()) {
        const names = readdirSync(abs).sort();
        add(abs, 'dir', sha(JSON.stringify(names)), `${name}/${relative(dir, abs)}/`);
        for (const n of names) if (n !== 'node_modules') walk(join(abs, n));
      } else if (st.isFile()) {
        const bytes = readPinned(abs);
        add(abs, 'file', sha(bytes), `${name}/${relative(dir, abs)}`);
        if (/\.[cm]?js$/.test(abs))
          for (const spec of literalLoads(abs, bytes)) {
            if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) {
              refuseEscape(spec.startsWith('file:') ? fileURLToPath(spec) : resolve(dirname(abs), spec));
            } else if (!isBuiltin(spec) && packageName(spec) !== pkg.name) {
              if (spec.startsWith('#')) throw new Error('the worker package uses an unsupported package import alias');
              // Record lookup at the actual module folder, including absent optional loads. Check after the metadata
              // closure is complete: unused fixture imports may name another package already fully pinned there.
              const actual = packageDir(packageName(spec), dirname(abs));
              if (actual !== null) modulePackages.add(actual);
            }
          }
      }
    };
    add(dir, 'dir', sha(JSON.stringify(readdirSync(dir).sort())), `${name}/`);
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
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }))
      visitPackage(dep, dir);
  };
  const files = new Set<string>();
  const visitFile = (abs: string) => {
    if (files.has(abs)) return;
    files.add(abs);
    if (!existsSync(abs)) {
      add(abs, 'absent', '', relative(root, abs));
      return;
    }
    // Node loads a module by its real path and resolves its imports from there: a path through a link is bound to it.
    const real = realpathSync(abs);
    if (real !== abs) {
      add(abs, 'resolves', real, `module:${where(abs)}`);
      visitFile(real);
      return;
    }
    const bytes = readPinned(abs);
    add(abs, 'file', sha(bytes), relative(root, abs));
    // Its own path must stay real: Node resolves its relative imports and its package lookups from there.
    add(abs, 'resolves', abs, `real:${where(abs)}`);
    if (!/\.[cm]?js$/.test(abs)) return;
    for (const spec of literalLoads(abs, bytes)) {
      if (spec.startsWith('node:') || isBuiltin(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:'))
        visitFile(spec.startsWith('file:') ? fileURLToPath(spec) : resolve(dirname(abs), spec));
      else visitPackage(packageName(spec), dirname(abs));
    }
  };
  if (packed) {
    const own = realpathSync(packed.layout.root);
    const dist = join(own, 'dist');
    if (
      realpathSync(dist) !== dist ||
      realpathSync(entry) !== join(dist, `${packed.descriptor.asset}.mjs`) ||
      extra.some((p) => !realpathSync(p).startsWith(dist + sep))
    )
      throw new Error('the framework worker is not in the fixed shipped dist tree');
    const manifest = join(own, 'package.json');
    add(manifest, 'file', sha(readPinned(manifest)), 'sentinel/package.json');
    const pkg = JSON.parse(readPinned(manifest).toString('utf8'));
    if (
      pkg.name !== 'farsight-sentinel' ||
      pkg.sentinel?.assets?.[packed.descriptor.asset]?.path !== `dist/${packed.descriptor.asset}.mjs` ||
      pkg.sentinel.assets[packed.descriptor.asset].sha256 !== sha(readPinned(entry))
    )
      throw new Error('the worker differs from its fixed shipped asset');
    const names = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    const folders = new Set<string>();
    const walkDist = (path: string) => {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error('the shipped dist tree contains a link');
      if (st.isDirectory()) {
        if (path !== dist && path.endsWith(sep + 'node_modules'))
          throw new Error('the shipped dist tree contains a dependency shadow');
        const children = readdirSync(path).sort();
        add(path, 'dir', sha(JSON.stringify(children)), `sentinel/${relative(own, path)}/`);
        for (const name of children) walkDist(join(path, name));
      } else if (st.isFile()) {
        add(path, 'file', sha(readPinned(path)), `sentinel/${relative(own, path)}`);
        if (/\.[cm]?js$/.test(path)) folders.add(dirname(path));
      } else throw new Error('the shipped dist tree contains a non-file');
    };
    walkDist(dist);
    // Generated require aliases are not a completeness boundary. Every emitted chunk is pinned, and every declared
    // external dependency is resolved from every emitted module folder (including absent optional candidates).
    for (const from of folders) for (const name of names) visitPackage(name, from);
  } else {
    visitFile(realpathSync(entry));
    for (const e of extra) visitFile(realpathSync(e));
  }
  for (const dir of modulePackages)
    if (!packages.has(dir))
      throw new Error('the worker package loads an unbound dependency outside its pinned package root');
  const entries = [...out.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const digest = `sha256:${sha(JSON.stringify([...portable].sort((a, b) => (a[0] < b[0] ? -1 : 1))))}`;
  return { entries, digest };
}

/** The entry module's source: the manifest, the check, then the worker. */
export function closureEntrySource(
  closure: WorkerClosure,
  worker: string,
  fixedExport: string = 'runFrameworkControlsWorker',
): string {
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
if (typeof worker[${JSON.stringify(fixedExport)}] !== 'function') process.exit(${CLOSURE_REFUSED});
await worker[${JSON.stringify(fixedExport)}]();
`;
}

/**
 * Writes the entry for the closure as it is now into `dir` (an owner-private folder) and returns its path and
 * closure digest, for the adapter definition's `module`. The file name carries the full entry-source SHA-256; an existing file
 * of that name is reused only when its bytes are identical.
 */
function publishEntry(dir: string, id: string, closure: WorkerClosure, worker: string, fixedExport: string) {
  const source = closureEntrySource(closure, worker, fixedExport);
  const name = `${id}-${sha(source)}.mjs`;
  const module = join(dir, name);
  const bytes = Buffer.from(source);
  if (bytes.length > MAX_ENTRY_BYTES) throw new Error('the generated framework entry exceeds its bound');
  publishOnce(dir, name, bytes);
  if (!readPublished(dir, name, MAX_ENTRY_BYTES)?.equals(bytes))
    throw new Error('the generated framework entry is not its exact published bytes');
  return { module, closureDigest: closure.digest, files: closure.entries.length };
}

/** The only production entry: a closed identity, its shipped worker and fixed driver, with no custom path/export. */
export function writeBuiltinClosureEntry(
  dir: string,
  id: BuiltinWorkerId,
): { module: string; closureDigest: string; files: number } {
  builtinWorker(id); // Reject inherited/non-string identities before any filesystem work.
  const files = builtinWorkerFiles(id);
  const closure = collectClosure(files.worker, [files.driver], files.layout.installed ? files : undefined);
  return publishEntry(dir, id, closure, files.worker, files.descriptor.export);
}

// Internal fixture helpers, imported only by tests, absent from the controls index and package exports. They never
// take the installed whole-dist branch and cannot be selected by registration or any production caller.
/** Test helper: the closure of `entry` (and `extra` roots) as the generated entry would list it. */
export function workerClosure(entry: string, extra: readonly string[] = []): WorkerClosure {
  return collectClosure(entry, extra);
}
/**
 * Test helper: publishes a generated closure entry for `worker` into `dir`, as registration does for the shipped
 * worker.
 */
export function writeClosureEntry(dir: string, worker: string, extra: readonly string[] = []) {
  return publishEntry(dir, 'framework-controls', collectClosure(worker, extra), worker, 'runFrameworkControlsWorker');
}
