#!/usr/bin/env node
// Sentinel is a separate installable artifact (ADR 18); farsight-cli never bundles or imports it.
// Reads packages/sentinel/package.json: each `bin` and each JavaScript export, `dist/<x>.js`, is
// bundled from `src/<x>.ts` with Sentinel's workspace dependencies inlined, in one build whose shared
// modules land in `dist/chunks/` so every export subpath sees the same module instances. Third-party
// dependencies of that closure stay external and become the tarball's dependencies. The
// tarball carries Sentinel's own version, runtime floor and `private` flag, not the app's.
// Public types are required: every JavaScript export needs a `types` condition, and tsc's
// declarations ship beside the bundles. A declaration that imports a workspace package, or
// a module the tarball does not declare, is refused — it would not resolve for a consumer.
//
//   pnpm --filter @farsight/sentinel... build && node scripts/pack-sentinel.mjs
//   → build/sentinel/farsight-sentinel-<sentinel version>.tgz
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const declarations = new Map();
const specifiers = new Set();
const dist = join(dir, 'dist');
const brokenRelative = [];
for (const file of readdirSync(dist, { recursive: true }).map(String).filter((f) => f.endsWith('.d.ts'))) {
  const text = readFileSync(join(dist, file), 'utf8').replace(/^\/\/# sourceMappingURL=\S+$/m, '').trimEnd() + '\n';
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\/\/\/\s*<reference\s+types=)["']([^"']+)["']/gm)) {
    if (!m[1].startsWith('.')) { specifiers.add(m[1]); continue; }
    const target = join(dirname(join(dist, file)), m[1]).replace(/\.js$/, '.d.ts');
    if (!existsSync(target) && !existsSync(join(target.replace(/\.d\.ts$/, ''), 'index.d.ts'))) brokenRelative.push(`${file}: ${m[1]}`);
  }
  declarations.set(file, text);
}
if (brokenRelative.length) fail('a declaration imports a sibling declaration that is not built. Run `pnpm --filter @farsight/sentinel... build`.', brokenRelative.map((s) => `missing: ${s}`));
const packageOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
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
  for (const doc of ['README.md']) if (existsSync(join(dir, doc))) { cpSync(join(dir, doc), join(out, doc)); files.push(doc); }
  writeFileSync(join(out, 'package.json'), JSON.stringify({
    name: 'farsight-sentinel', version,
    ...(sentinel.private ? { private: true } : {}),
    description: sentinel.description ?? 'Optional Sentinel package for Farsight, installed and run separately from farsight-cli.',
    license: 'MIT', ...(pkg.repository ? { repository: pkg.repository } : {}), type: 'module',
    bin: bins, types: exportsMap['.'].types, exports: exportsMap, files,
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
