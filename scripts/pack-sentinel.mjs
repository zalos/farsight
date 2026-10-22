#!/usr/bin/env node
// Sentinel is a separate installable artifact (ADR 18); farsight-cli never bundles or imports it.
// Reads packages/sentinel/package.json: each `bin` and the root export, `dist/<x>.js`, is
// bundled from `src/<x>.ts` with Sentinel's workspace dependencies inlined. Third-party
// dependencies of that closure stay external and become the tarball's dependencies.
//
//   pnpm --filter @farsight/sentinel... build && node scripts/pack-sentinel.mjs
//   → build/sentinel/farsight-sentinel-<version>.tgz
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosure, missingBuildOutputs } from './pack-preflight.mjs';

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

const rootExport = (exports) => {
  const dot = typeof exports === 'string' ? exports : exports?.['.'];
  return typeof dot === 'string' ? dot : dot?.import ?? dot?.default;
};
// `dist/<x>.js` → `src/<x>.ts`; the published file is `dist/<x>.mjs`.
const entries = new Map();
const entryFor = (target) => {
  const rel = String(target).replace(/^\.\//, '');
  const m = /^dist\/(.+)\.js$/.exec(rel);
  if (!m) fail(`cannot map ${rel} to a source entry; expected dist/<name>.js.`);
  const source = join(dir, 'src', `${m[1]}.ts`);
  if (!existsSync(source)) fail(`packages/sentinel/src/${m[1]}.ts is missing for ${rel}.`);
  entries.set(m[1], source);
  return `dist/${m[1]}.mjs`;
};
const bins = Object.fromEntries(Object.entries(typeof sentinel.bin === 'string' ? { 'farsight-sentinel': sentinel.bin } : sentinel.bin ?? {})
  .map(([name, target]) => [name, entryFor(target)]));
const main = rootExport(sentinel.exports) ?? sentinel.main;
if (!Object.keys(bins).length || !main) fail('the Sentinel manifest needs a `bin` and a root export (`exports["."]` or `main`).');
const exported = entryFor(main);

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

const base = join(root, 'build', 'sentinel');
const out = join(base, 'package');
rmSync(base, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
await build({
  entryPoints: Object.fromEntries([...entries].map(([name, source]) => [name, source])),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
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

const files = ['dist'];
const exportsMap = { '.': `./${exported}`, './package.json': './package.json' };
if (existsSync(join(dir, 'schemas'))) {
  cpSync(join(dir, 'schemas'), join(out, 'schemas'), { recursive: true });
  files.push('schemas');
  exportsMap['./schemas/*'] = './schemas/*';
}
for (const doc of ['README.md']) if (existsSync(join(dir, doc))) { cpSync(join(dir, doc), join(out, doc)); files.push(doc); }
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'farsight-sentinel', version: pkg.version,
  description: 'Optional security review companion for Farsight, installed and run separately from farsight-cli.',
  license: 'MIT', ...(pkg.repository ? { repository: pkg.repository } : {}), type: 'module',
  bin: bins, exports: exportsMap, files,
  ...(Object.keys(dependencies).length ? { dependencies } : {}),
  engines: { node: '>=24' },
}, null, 2) + '\n');
execFileSync('npm', ['pack', '--pack-destination', '..'], { cwd: out, stdio: 'inherit' });
console.log(`\npackaged: build/sentinel/farsight-sentinel-${pkg.version}.tgz`);
