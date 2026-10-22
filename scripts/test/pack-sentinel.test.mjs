// scripts/pack-sentinel.mjs and scripts/test-sentinel-package.mjs against a throwaway
// workspace with a stand-in Sentinel manifest; the real package's contracts are its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const node = (root, script, ...args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'farsight-pack-sentinel-'));
  for (const file of ['pack-sentinel.mjs', 'pack-preflight.mjs', 'npm-consumer.mjs', 'test-sentinel-package.mjs']) {
    write(root, `scripts/${file}`, readFileSync(resolve('scripts', file), 'utf8'));
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  write(root, 'package.json', JSON.stringify({ version: '0.0.0-test', type: 'module' }));
  write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js' }));
  // the sibling package's manifest shape: own draft version, private, typed conditional exports, a subpath
  write(root, 'packages/sentinel/package.json', JSON.stringify({
    name: '@farsight/sentinel', version: '0.0.0-draft.1', private: true, description: 'draft contracts only',
    engines: { node: '>=24' }, main: './dist/index.js', bin: { 'farsight-sentinel': './dist/cli.js' },
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './contracts': { types: './dist/contracts/index.d.ts', import: './dist/contracts/index.js' },
      './schemas/*': './schemas/*', './package.json': './package.json',
    },
    dependencies: { '@farsight/core': 'workspace:*' },
  }));
  write(root, 'packages/sentinel/src/contracts/index.ts', "export const reportKind: string = 'sentinel-report/draft';\n");
  write(root, 'packages/sentinel/src/index.ts', "export const contractVersion: string = 'draft';\n");
  write(root, 'packages/sentinel/src/cli.ts', "import { contractVersion } from './index.ts';\nconsole.log(`farsight-sentinel (${contractVersion}): no scanner is available yet`);\n");
  write(root, 'packages/sentinel/schemas/example.schema.json', JSON.stringify({ $id: 'example', type: 'object' }));
  write(root, 'build/sentinel/keep.txt', 'prior artifact');
  return root;
}

test('pack-sentinel refuses an unbuilt Sentinel closure before touching build/sentinel', () => {
  const root = workspace();
  try {
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

test('a packed Sentinel installs into a clean npm consumer: bin help, import, schemas, no farsight-cli', () => {
  const root = workspace();
  try {
    write(root, 'packages/core/dist/index.js', '');
    write(root, 'packages/sentinel/dist/index.js', '');
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(root, 'build/sentinel/farsight-sentinel-0.0.0-draft.1.tgz');
    assert.ok(existsSync(tarball));
    const manifest = JSON.parse(readFileSync(join(root, 'build/sentinel/package/package.json'), 'utf8'));
    assert.deepEqual(manifest.bin, { 'farsight-sentinel': 'dist/cli.mjs' });
    assert.deepEqual(manifest.exports, { '.': './dist/index.mjs', './contracts': './dist/contracts/index.mjs',
      './package.json': './package.json', './schemas/*': './schemas/*' });
    assert.equal(manifest.version, '0.0.0-draft.1', "Sentinel's own version, not the app's");
    assert.equal(manifest.private, true);
    assert.equal(manifest.description, 'draft contracts only');
    assert.equal(manifest.engines.node, '>=24');
    assert.deepEqual(manifest.files, ['dist', 'schemas']);
    assert.equal(manifest.dependencies, undefined, 'workspace dependencies are inlined, never declared');
    assert.match(readFileSync(join(root, 'build/sentinel/package/dist/cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);

    const smoke = node(root, 'test-sentinel-package.mjs');
    assert.equal(smoke.status, 0, smoke.stderr + smoke.stdout);
    assert.match(smoke.stdout, /sentinel package ok: farsight-sentinel --help, import \(1 exports, 1 subpaths\), 1 schemas, npm consumer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("third-party dependencies of Sentinel's closure stay external and are declared once", () => {
  const root = workspace();
  try {
    write(root, 'packages/core/dist/index.js', '');
    write(root, 'packages/sentinel/dist/index.js', '');
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js', dependencies: { yaml: '^2.0.0' } }));
    write(root, 'packages/sentinel/package.json', JSON.stringify({
      name: '@farsight/sentinel', version: '0.0.0-draft.1', main: './dist/index.js', bin: { 'farsight-sentinel': './dist/cli.js' },
      dependencies: { '@farsight/core': 'workspace:*', ajv: '8.20.0' },
    }));
    write(root, 'packages/sentinel/src/index.ts', "import Ajv from 'ajv';\nexport const contractVersion = 'draft';\nexport const validator = () => new Ajv();\n");
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    const manifest = JSON.parse(readFileSync(join(root, 'build/sentinel/package/package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { ajv: '8.20.0', yaml: '^2.0.0' });
    assert.match(readFileSync(join(root, 'build/sentinel/package/dist/index.mjs'), 'utf8'), /from "ajv"/);
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js', dependencies: { ajv: '^8.0.0' } }));
    const conflict = node(root, 'pack-sentinel.mjs');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /ajv is required as both/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
