// scripts/pack-sentinel.mjs and scripts/test-sentinel-package.mjs against a throwaway workspace
// with a stand-in Sentinel package in the real package's manifest shape (one envelope kind,
// compiled by tsc). The real package's contracts are its own; CI smokes the real tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const node = (root, script, ...args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 180_000 });
const tsc = (root) => spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'packages/sentinel/tsconfig.json')], { encoding: 'utf8' });
const json = (value) => JSON.stringify(value, null, 2);

const MANIFEST = {
  name: '@farsight/sentinel', version: '0.0.0-draft.1', private: true, description: 'draft contracts only',
  type: 'module', engines: { node: '>=24' }, main: './dist/index.js', types: './dist/index.d.ts',
  bin: { 'farsight-sentinel': './dist/cli.js' },
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './contracts': { types: './dist/contracts/index.d.ts', import: './dist/contracts/index.js' },
    './schemas/*': './schemas/*', './package.json': './package.json',
  },
  dependencies: { '@farsight/core': 'workspace:*' },
};

function workspace({ build = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'farsight-pack-sentinel-'));
  for (const file of ['pack-sentinel.mjs', 'pack-preflight.mjs', 'npm-consumer.mjs', 'test-sentinel-package.mjs']) {
    write(root, `scripts/${file}`, readFileSync(resolve('scripts', file), 'utf8'));
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  write(root, 'package.json', JSON.stringify({ version: '0.0.0-test', type: 'module', engines: { node: '>=24' } }));
  write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js' }));
  write(root, 'packages/core/dist/index.js', '');
  write(root, 'packages/sentinel/package.json', json(MANIFEST));
  write(root, 'packages/sentinel/tsconfig.json', json({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, declaration: true,
    sourceMap: true, declarationMap: true, rootDir: 'src', outDir: 'dist', types: [],
  }, include: ['src'] }));
  write(root, 'packages/sentinel/src/contracts/index.ts', [
    "export interface ReportEnvelope { schema: 'sentinel-report/draft-1'; id: string }",
    "export const ENVELOPES = { report: { schema: 'sentinel-report/draft-1', type: 'ReportEnvelope' } } as const;",
    'export type EnvelopeKind = keyof typeof ENVELOPES;', '',
  ].join('\n'));
  write(root, 'packages/sentinel/src/index.ts', [
    "import { ENVELOPES, type EnvelopeKind, type ReportEnvelope } from './contracts/index.js';",
    "export * from './contracts/index.js';",
    'export interface EnvelopeTypes { report: ReportEnvelope }',
    'export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: { code: string; path: string }[] };',
    'export function validateEnvelope<K extends EnvelopeKind>(kind: K, value: unknown): ValidationResult<EnvelopeTypes[K]> {',
    '  const v = value as { schema?: unknown; id?: unknown };',
    "  if (v?.schema !== ENVELOPES[kind].schema) return { ok: false, errors: [{ code: 'unsupportedVersion', path: '/schema' }] };",
    "  if (typeof v.id !== 'string') return { ok: false, errors: [{ code: 'invalid', path: '/id' }] };",
    '  return { ok: true, value: value as EnvelopeTypes[K] };',
    '}', '',
  ].join('\n'));
  write(root, 'packages/sentinel/src/cli.ts', "console.log('farsight-sentinel (draft): no scanner is available yet');\nexport {};\n");
  write(root, 'packages/sentinel/schemas/sentinel-report.draft-1.schema.json', JSON.stringify({ $id: 'sentinel-report/draft-1', type: 'object' }));
  write(root, 'packages/sentinel/test/contracts/valid/report.json', JSON.stringify({ schema: 'sentinel-report/draft-1', id: 'r1' }));
  write(root, 'build/sentinel/keep.txt', 'prior artifact');
  if (build) { const built = tsc(root); assert.equal(built.status, 0, built.stdout); }
  return root;
}
const tarball = (root) => join(root, 'build/sentinel/farsight-sentinel-0.0.0-draft.1.tgz');
const packedManifest = (root) => JSON.parse(readFileSync(join(root, 'build/sentinel/package/package.json'), 'utf8'));

test('pack-sentinel refuses an unbuilt or absent Sentinel before touching build/sentinel', () => {
  const root = workspace({ build: false });
  try {
    rmSync(join(root, 'packages/core/dist'), { recursive: true });
    const run = node(root, 'pack-sentinel.mjs');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pnpm --filter @farsight\/sentinel\.\.\. build/);
    assert.match(run.stderr, /missing: packages\/core\/dist\/index\.js/);
    assert.match(run.stderr, /missing: packages\/sentinel\/dist\/index\.js/);
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), true);
    rmSync(join(root, 'packages/sentinel'), { recursive: true });
    assert.match(node(root, 'pack-sentinel.mjs').stderr, /no Sentinel package to pack/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the tarball carries typed exports, declarations, its own metadata and the schemas', () => {
  const root = workspace();
  try {
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    assert.ok(existsSync(tarball(root)));
    const manifest = packedManifest(root);
    assert.deepEqual(manifest.exports, {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
      './contracts': { types: './dist/contracts/index.d.ts', import: './dist/contracts/index.mjs' },
      './package.json': './package.json', './schemas/*': './schemas/*',
    });
    assert.equal(manifest.types, './dist/index.d.ts');
    assert.equal(manifest.version, '0.0.0-draft.1', "Sentinel's own version, not the app's");
    assert.equal(manifest.private, true);
    assert.equal(manifest.description, 'draft contracts only');
    assert.equal(manifest.engines.node, '>=24');
    assert.deepEqual(manifest.files, ['dist', 'schemas']);
    assert.equal(manifest.dependencies, undefined, 'workspace dependencies are inlined, never declared');
    const out = join(root, 'build/sentinel/package/dist');
    assert.match(readFileSync(join(out, 'cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
    assert.doesNotMatch(readFileSync(join(out, 'index.d.ts'), 'utf8'), /sourceMappingURL/);
    assert.ok(existsSync(join(out, 'contracts/index.d.ts')));
    assert.ok(!existsSync(join(out, 'index.js.map')) && !existsSync(join(out, 'index.d.ts.map')), 'no maps into absent sources');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean npm consumer imports, type-checks and validates through the installed package', () => {
  const root = workspace();
  try {
    assert.equal(node(root, 'pack-sentinel.mjs').status, 0);
    const smoke = node(root, 'test-sentinel-package.mjs');
    assert.equal(smoke.status, 0, smoke.stderr + smoke.stdout);
    assert.match(smoke.stdout, /sentinel package ok: farsight-sentinel --help, 2 typed exports \(1 contract types compiled\), 1 schemas, 1 fixtures, npm consumer/);
    // the installed schema set must be the source set
    write(root, 'packages/sentinel/schemas/sentinel-extra.draft-1.schema.json', '{}');
    const stale = node(root, 'test-sentinel-package.mjs');
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /the installed schema set is the source set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the smoke fails when a contract type is missing, and the pack when the schemas are', () => {
  const root = workspace();
  try {
    write(root, 'packages/sentinel/src/contracts/index.ts', readFileSync(join(root, 'packages/sentinel/src/contracts/index.ts'), 'utf8')
      .replace("type: 'ReportEnvelope'", "type: 'MissingEnvelope'"));
    assert.equal(tsc(root).status, 0);
    assert.equal(node(root, 'pack-sentinel.mjs').status, 0);
    const untypedContract = node(root, 'test-sentinel-package.mjs');
    assert.equal(untypedContract.status, 1);
    assert.match(untypedContract.stderr, /the installed types do not compile[\s\S]*MissingEnvelope/);

    rmSync(join(root, 'packages/sentinel/schemas'), { recursive: true });
    const run = node(root, 'pack-sentinel.mjs');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /exports \.\/schemas\/\* but packages\/sentinel\/schemas has no JSON schema/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an untyped export or a declaration a consumer cannot resolve is refused', () => {
  const root = workspace();
  try {
    write(root, 'packages/sentinel/package.json', json({ ...MANIFEST, exports: { ...MANIFEST.exports, './contracts': './dist/contracts/index.js' } }));
    const untyped = node(root, 'pack-sentinel.mjs');
    assert.equal(untyped.status, 1);
    assert.match(untyped.stderr, /untyped: \.\/contracts/);

    write(root, 'packages/sentinel/package.json', json(MANIFEST));
    write(root, 'packages/sentinel/dist/index.d.ts', readFileSync(join(root, 'packages/sentinel/dist/index.d.ts'), 'utf8') +
      "\nexport type { Counted } from '@farsight/core';\nexport type { Stats } from 'node:fs';\n");
    const leaky = node(root, 'pack-sentinel.mjs');
    assert.equal(leaky.status, 1);
    assert.match(leaky.stderr, /import: @farsight\/core/);
    assert.match(leaky.stderr, /import: node:fs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("third-party dependencies of Sentinel's closure stay external and are declared once", () => {
  const root = workspace();
  try {
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js', dependencies: { yaml: '^2.0.0' } }));
    write(root, 'packages/sentinel/package.json', json({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, ajv: '8.20.0' } }));
    write(root, 'packages/sentinel/src/index.ts', readFileSync(join(root, 'packages/sentinel/src/index.ts'), 'utf8') +
      "// @ts-ignore the stand-in has no ajv installed; esbuild keeps it external\nimport Ajv from 'ajv';\nexport const validator = () => new Ajv();\n");
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    assert.deepEqual(packedManifest(root).dependencies, { ajv: '8.20.0', yaml: '^2.0.0' });
    assert.match(readFileSync(join(root, 'build/sentinel/package/dist/index.mjs'), 'utf8'), /from "ajv"/);
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js', dependencies: { ajv: '^8.0.0' } }));
    const conflict = node(root, 'pack-sentinel.mjs');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /ajv is required as both/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing transitive compiled module or sibling declaration fails before build/sentinel is replaced', () => {
  const root = workspace();
  try {
    write(root, 'build/sentinel/farsight-sentinel-prior.tgz', 'prior');
    // core's main exists, but re-exports a module that was never compiled: only a real bundle sees it
    write(root, 'packages/core/dist/index.js', "export * from './counts.js';\n");
    write(root, 'packages/sentinel/src/index.ts', readFileSync(join(root, 'packages/sentinel/src/index.ts'), 'utf8') +
      "export * as core from '../../core/dist/index.js';\n");
    const bundle = node(root, 'pack-sentinel.mjs');
    assert.equal(bundle.status, 1);
    assert.match(bundle.stderr, /prior artifacts in build\/ are unchanged[\s\S]*counts\.js/);
    assert.equal(existsSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz')), true);
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), true);

    write(root, 'packages/core/dist/index.js', '');
    write(root, 'packages/sentinel/dist/index.d.ts', readFileSync(join(root, 'packages/sentinel/dist/index.d.ts'), 'utf8') +
      "\nexport type { Gone } from './gone.js';\n");
    const decl = node(root, 'pack-sentinel.mjs');
    assert.equal(decl.status, 1);
    assert.match(decl.stderr, /sibling declaration that is not built[\s\S]*index\.d\.ts: \.\/gone\.js/);
    assert.equal(existsSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz')), true);
    assert.deepEqual(readdirSync(join(root, 'build')).filter((n) => n.startsWith('.stage-')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a successful Sentinel pack replaces build/sentinel only', () => {
  const root = workspace();
  try {
    write(root, 'build/farsight-cli-0.0.0.tgz', 'cli');
    write(root, 'build/echo/farsight-echo-0.0.0.tgz', 'echo');
    const run = node(root, 'pack-sentinel.mjs');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(tarball(root)), true);
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), false, 'its own prior output is replaced');
    assert.equal(existsSync(join(root, 'build/farsight-cli-0.0.0.tgz')), true);
    assert.equal(existsSync(join(root, 'build/echo/farsight-echo-0.0.0.tgz')), true);
    assert.deepEqual(readdirSync(join(root, 'build')).filter((n) => n.startsWith('.stage-')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm pack exiting 0 without a tarball keeps build/sentinel; an inherited dry run is switched off', () => {
  const root = workspace();
  try {
    write(root, 'build/sentinel/farsight-sentinel-prior.tgz', 'prior');
    write(root, 'fake-bin/npm', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'fake-bin/npm'), 0o755);
    const env = (extra) => ({ cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...extra } });
    const silent = spawnSync(process.execPath, [join(root, 'scripts/pack-sentinel.mjs')], env({ PATH: `${join(root, 'fake-bin')}:${process.env.PATH}` }));
    assert.equal(silent.status, 1);
    assert.match(silent.stderr, /prior artifacts in build\/ are unchanged[\s\S]*wrote no farsight-sentinel-0\.0\.0-draft\.1\.tgz/);
    assert.equal(readFileSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz'), 'utf8'), 'prior');
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), true);
    assert.deepEqual(readdirSync(join(root, 'build')).filter((n) => n.startsWith('.stage-')), []);

    const dry = spawnSync(process.execPath, [join(root, 'scripts/pack-sentinel.mjs')], env({ npm_config_dry_run: 'true' }));
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(existsSync(tarball(root)));
    assert.equal(existsSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz')), false, 'replaced by the real output');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
