#!/usr/bin/env node
// Sentinel is a separate installable artifact (ADR 18); farsight-cli never bundles or imports it.
// Reads packages/sentinel/package.json: each `bin` and each JavaScript export, `dist/<x>.js`, is
// bundled from `src/<x>.ts` with Sentinel's workspace dependencies inlined, in one build whose shared
// modules land in `dist/chunks/` so every export subpath sees the same module instances. Third-party
// dependencies of that closure stay external and become the tarball's dependencies. The
// tarball carries Sentinel's own version, runtime floor and `private` flag, not the app's.
// Public types are required: every JavaScript export needs a `types` condition, and tsc's
// declarations ship beside the bundles. A declaration that imports a publishable workspace library
// (one with publishConfig, such as @farsight/graph or @farsight/code-parser) gets that library's
// declarations vendored under dist/vendor/ with the import rewritten, so its types arrive whole. Any
// other workspace package, or a module the tarball does not declare, is refused: it would not
// resolve for a consumer.
//
//   pnpm --filter @farsight/sentinel... build && node scripts/pack-sentinel.mjs
//   → build/sentinel/farsight-sentinel-<sentinel version>.tgz
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertTarball, buildClosure, missingBuildOutputs, npmPackEnv } from './pack-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'packages', 'sentinel');
const fail = (message, details = []) => {
  console.error('pack-sentinel: ' + message);
  for (const line of details) console.error('  ' + line);
  process.exit(1);
};
if (!existsSync(join(dir, 'package.json'))) fail('packages/sentinel/package.json is missing; there is no Sentinel package to pack.');
const sentinel = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Sentinel's own workspace closure must be built (its imports resolve through each `main`);
// checked before build/sentinel is touched.
const missing = missingBuildOutputs(root, sentinel.name);
if (missing.length) {
  fail('compiled packages are missing. Run `pnpm --filter @farsight/sentinel... build && node scripts/pack-sentinel.mjs`.',
    missing.map((path) => 'missing: ' + (isAbsolute(path) ? relative(root, path) : path)));
}

const target = (entry) => (typeof entry === 'string' ? entry : entry?.import ?? entry?.default);
const rel = (file) => String(file).replace(/^\.\//, '');
// subpath → its JavaScript target and declaration; non-JavaScript subpaths (schemas, package.json) are handled below
const declared = typeof sentinel.exports === 'string' || !sentinel.exports
  ? { '.': { types: sentinel.types, import: sentinel.exports ?? sentinel.main } } : sentinel.exports;
const jsExports = Object.entries(declared)
  .map(([subpath, entry]) => [subpath, target(entry), typeof entry === 'object' ? entry?.types : undefined])
  .filter(([, file]) => typeof file === 'string' && /\.js$/.test(file));
const untyped = jsExports.filter(([, , types]) => typeof types !== 'string' || !/^dist\/.+\.d\.ts$/.test(rel(types)));
if (untyped.length) fail('every JavaScript export needs a `types` condition under dist/ (public types are part of the package).', untyped.map(([subpath]) => `untyped: ${subpath}`));
const missingTypes = jsExports.map(([, , types]) => rel(types)).filter((types) => !existsSync(join(dir, types)));
if (missingTypes.length) fail('declarations are missing. Run `pnpm --filter @farsight/sentinel... build && node scripts/pack-sentinel.mjs`.', missingTypes.map((types) => `missing: packages/sentinel/${types}`));
const schemaDir = join(dir, 'schemas');
const schemaFiles = existsSync(schemaDir) ? readdirSync(schemaDir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')) : [];
if (declared['./schemas/*'] && !schemaFiles.length) fail('the manifest exports ./schemas/* but packages/sentinel/schemas has no JSON schema.');
// `dist/<x>.js` → `src/<x>.ts`; the published file is `dist/<x>.mjs`.
const entries = new Map();
const entryFor = (target) => {
  const file = rel(target);
  const m = /^dist\/(.+)\.js$/.exec(file);
  if (!m) fail(`cannot map ${file} to a source entry; expected dist/<name>.js.`);
  const source = join(dir, 'src', `${m[1]}.ts`);
  if (!existsSync(source)) fail(`packages/sentinel/src/${m[1]}.ts is missing for ${file}.`);
  entries.set(m[1], source); // dist/contracts/index.js → dist/contracts/index.mjs
  return `dist/${m[1]}.mjs`;
};
const bins = Object.fromEntries(Object.entries(typeof sentinel.bin === 'string' ? { 'farsight-sentinel': sentinel.bin } : sentinel.bin ?? {})
  .map(([name, target]) => [name, entryFor(target)]));
if (!Object.keys(bins).length || !jsExports.some(([subpath]) => subpath === '.')) {
  fail('the Sentinel manifest needs a `bin` and a root export (`exports["."]` or `main`).');
}
// Files started or hashed by path rather than imported ship as their own entries (not exports): the launch gate
// a built-in worker process runs first (src/execution/assets.ts finds it from the package root).
// It is required whenever the package can start a built-in worker (it has the supervisor).
const ASSETS = [['execution/launch-gate', 'execution/supervisor']];
for (const [asset, needs] of ASSETS) {
  const source = join(dir, 'src', `${asset}.ts`);
  if (!existsSync(join(dir, 'src', `${needs}.ts`))) continue;
  if (!existsSync(source)) fail(`packages/sentinel/src/${asset}.ts is missing; the launch gate must ship with the package.`);
  entries.set(asset, source);
}
// `types` first: TypeScript takes the first condition that matches.
const exportsMap = Object.fromEntries(jsExports.map(([subpath, file, types]) => [subpath, { types: `./${rel(types)}`, import: `./${entryFor(file)}` }]));
exportsMap['./package.json'] = './package.json';

// Third-party dependencies of the closure: kept external, declared once with one range.
const dependencies = {};
for (const member of buildClosure(root, sentinel.name).closure) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(member.manifest[field] ?? {})) {
      if (typeof spec !== 'string' || spec.startsWith('workspace:')) continue;
      if (dependencies[name] && dependencies[name] !== spec) fail(`${name} is required as both ${dependencies[name]} and ${spec}; align the ranges.`);
      dependencies[name] = spec;
    }
  }
}

// tsc's declarations, read and checked before anything is staged. They ship in their own layout:
// `./x.js` specifiers inside them resolve to `./x.d.ts`, so each relative target must exist too.
const packageOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
const closureByName = new Map(buildClosure(root, sentinel.name).closure.map((m) => [m.name, m]));
const vendorable = (name) => { const m = closureByName.get(name); return Boolean(m && m.manifest.publishConfig && !m.manifest.private); };
const declarations = new Map();
const specifiers = new Set();
const dist = join(dir, 'dist');
const brokenRelative = [];
const queue = [];
const queued = new Set();
const enqueueTree = (srcDist, prefix) => {
  for (const file of readdirSync(srcDist, { recursive: true }).map(String).filter((f) => f.endsWith('.d.ts'))) {
    const out = prefix ? `${prefix}/${file}` : file;
    if (!queued.has(out)) { queued.add(out); queue.push({ abs: join(srcDist, file), out }); }
  }
};
const vendoredRoots = new Set();
/** The vendored output path of a publishable library's declaration for `spec`, or null when it has none. */
const vendorTarget = (spec) => {
  const name = packageOf(spec);
  const member = closureByName.get(name);
  const sub = spec.slice(name.length);
  const entry = member.manifest.exports?.[`.${sub}`];
  const types = typeof entry === 'object' && entry ? entry.types : sub === '' ? member.manifest.types : undefined;
  if (typeof types !== 'string' || !/^(\.\/)?dist\/.+\.d\.ts$/.test(types)) return null;
  const short = name.split('/').pop();
  if (!vendoredRoots.has(name)) { vendoredRoots.add(name); enqueueTree(join(member.dir, 'dist'), `vendor/${short}`); }
  return `vendor/${short}/${rel(types).replace(/^dist\//, '')}`;
};
/**
 * `text` with every comment and every string's contents replaced by spaces (quotes kept, offsets unchanged), so neither a
 * comment nor a string literal such as `'from'` in `Pick<T, 'from' | 'to'>` reads as an import keyword.
 */
const maskComments = (text) => {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += c + ' '.repeat(Math.max(0, Math.min(j, text.length) - i - 1)) + (j < text.length ? c : ''); i = j + 1;
    } else if (c === '/' && text[i + 1] === '/' && !text.startsWith('///', i)) {
      const j = text.indexOf('\n', i); const end = j < 0 ? text.length : j;
      out += ' '.repeat(end - i); i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2); const end = j < 0 ? text.length : j + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' '); i = end;
    } else { out += c; i++; }
  }
  return out;
};
const KEYWORD = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\/\/\/\s*<reference\s+types=)["']/gm;
enqueueTree(dist, '');
for (let i = 0; i < queue.length; i++) {
  const { abs, out } = queue[i];
  let text = readFileSync(abs, 'utf8').replace(/^\/\/# sourceMappingURL=\S+$/m, '').trimEnd() + '\n';
  const masked = maskComments(text);
  const edits = [];
  for (const m of masked.matchAll(KEYWORD)) {
    // The keyword is real code; the specifier is read from the original text between its quotes.
    const quoteAt = m.index + m[0].length - 1;
    const end = text.indexOf(text[quoteAt], quoteAt + 1);
    if (end < 0) continue;
    edits.push({ at: m.index, whole: text.slice(m.index, end + 1), open: text.slice(m.index, quoteAt + 1), spec: text.slice(quoteAt + 1, end), close: text[end] });
  }
  const rewrite = ({ whole, open, spec, close }) => {
    if (spec.startsWith('.')) {
      const target = join(dirname(abs), spec).replace(/\.js$/, '.d.ts');
      if (!existsSync(target) && !existsSync(join(target.replace(/\.d\.ts$/, ''), 'index.d.ts'))) brokenRelative.push(`${out}: ${spec}`);
      return whole;
    }
    if (packageOf(spec).startsWith('@farsight/') && vendorable(packageOf(spec))) {
      const target = vendorTarget(spec);
      if (!target) { specifiers.add(spec); return whole; }
      let path = relative(dirname(out), target).split('\\').join('/').replace(/\.d\.ts$/, '.js');
      if (!path.startsWith('.')) path = `./${path}`;
      return `${open}${path}${close}`;
    }
    specifiers.add(spec);
    return whole;
  };
  for (const e of edits.reverse()) text = text.slice(0, e.at) + rewrite(e) + text.slice(e.at + e.whole.length);
  declarations.set(out, text);
}
if (brokenRelative.length) fail('a declaration imports a sibling declaration that is not built. Run `pnpm --filter @farsight/sentinel... build`.', brokenRelative.map((s) => `missing: ${s}`));
const unresolvable = [...specifiers].filter((s) => {
  const name = packageOf(s);
  if (s.startsWith('node:') || builtinModules.includes(name)) return !dependencies['@types/node'];
  return name.startsWith('@farsight/') || !dependencies[name];
});
if (unresolvable.length) {
  fail('a declaration imports a module a consumer could not resolve (a workspace package, or one the tarball does not declare; node: builtins need @types/node).', unresolvable.map((s) => `import: ${s}`));
}

// Everything is built in a staging directory; build/sentinel is replaced only after the bundle and
// the tarball succeed, and other packages' outputs in build/ are never touched.
const version = sentinel.version ?? pkg.version;
const buildDir = join(root, 'build');
mkdirSync(buildDir, { recursive: true });
const stage = mkdtempSync(join(buildDir, '.stage-sentinel-'));
const out = join(stage, 'package');
try {
  mkdirSync(join(out, 'dist'), { recursive: true });
  await build({
    logLevel: 'silent',
    entryPoints: Object.fromEntries([...entries].map(([name, source]) => [name, source])),
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    // One build with shared chunks: a module two entries import (the store, its error class) exists once, so
    // `root.X === subpath.X` and `instanceof` hold across subpaths. Separate bundles would each carry a copy.
    splitting: true, chunkNames: 'chunks/[name]-[hash]',
    outdir: join(out, 'dist'), outExtension: { '.js': '.mjs' },
    external: Object.keys(dependencies).flatMap((name) => [name, `${name}/*`]),
    // inlined CommonJS dependencies call require() for builtins; an ESM bundle has none
    banner: { js: "import { createRequire as __sentinelCreateRequire } from 'node:module';\nconst require = __sentinelCreateRequire(import.meta.url);" },
  });
  // esbuild keeps an entry's own shebang; a bin without one still has to run from npm's .bin link.
  for (const target of new Set(Object.values(bins))) {
    const path = join(out, target);
    const text = readFileSync(path, 'utf8');
    if (!text.startsWith('#!')) writeFileSync(path, '#!/usr/bin/env node\n' + text);
  }
  for (const [file, text] of declarations) {
    mkdirSync(dirname(join(out, 'dist', file)), { recursive: true });
    writeFileSync(join(out, 'dist', file), text);
  }

  const files = ['dist'];
  if (schemaFiles.length) {
    cpSync(schemaDir, join(out, 'schemas'), { recursive: true });
    files.push('schemas');
    exportsMap['./schemas/*'] = './schemas/*';
  }
  // The rule packs Sentinel ships (data only: a manifest, detector descriptions, fixtures), promoted by the owner.
  if (existsSync(join(dir, 'rules'))) { cpSync(join(dir, 'rules'), join(out, 'rules'), { recursive: true }); files.push('rules'); }
  // Provenance of the files the package starts by path rather than imports (the launch gate): where and which bytes.
  const assets = {};
  for (const [asset] of ASSETS) {
    const emitted = join(out, 'dist', `${asset}.mjs`);
    if (existsSync(emitted)) assets[asset] = { path: `dist/${asset}.mjs`, sha256: createHash('sha256').update(readFileSync(emitted)).digest('hex') };
  }
  // Non-code assets the package owns (in-container workers and their digest manifests), each staged by its own hook,
  // scripts/package-assets*.mjs, in name order.
  for (const hook of (existsSync(join(dir, 'scripts')) ? readdirSync(join(dir, 'scripts')) : []).filter((f) => /^package-assets.*\.mjs$/.test(f)).sort()) {
    const staged = await (await import(pathToFileURL(join(dir, 'scripts', hook)).href)).stageAssets(dir, out);
    for (const f of staged.files) if (!files.includes(f)) files.push(f);
    Object.assign(exportsMap, staged.exports);
  }
  for (const doc of ['README.md']) if (existsSync(join(dir, doc))) { cpSync(join(dir, doc), join(out, doc)); files.push(doc); }
  writeFileSync(join(out, 'package.json'), JSON.stringify({
    name: 'farsight-sentinel', version,
    ...(sentinel.private ? { private: true } : {}),
    description: sentinel.description ?? 'Optional Sentinel package for Farsight, installed and run separately from farsight-cli.',
    license: 'MIT', ...(pkg.repository ? { repository: pkg.repository } : {}), type: 'module',
    bin: bins, types: exportsMap['.'].types, exports: exportsMap, files,
    ...(Object.keys(assets).length ? { sentinel: { assets } } : {}),
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    engines: { node: sentinel.engines?.node ?? pkg.engines?.node ?? '>=24' },
  }, null, 2) + '\n');
  execFileSync('npm', ['pack', '--pack-destination', '..'], { cwd: out, stdio: 'inherit', env: npmPackEnv() });
  assertTarball(join(stage, `farsight-sentinel-${version}.tgz`)); // before build/sentinel is replaced
} catch (error) {
  rmSync(stage, { recursive: true, force: true });
  const detail = error?.errors?.length ? error.errors.map((e) => `${e.location?.file ?? ''} ${e.text}`.trim()) : [error?.message];
  fail('the bundle or the tarball failed; prior artifacts in build/ are unchanged.', detail);
}
const published = join(buildDir, 'sentinel');
rmSync(published, { recursive: true, force: true });
renameSync(stage, published);
console.log(`\npackaged: build/sentinel/farsight-sentinel-${version}.tgz`);
