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
  write(root, 'packages/sentinel/package.json', JSON.stringify({
    name: '@farsight/sentinel', main: 'dist/index.js', bin: { 'farsight-sentinel': 'dist/cli.js' },
    dependencies: { '@farsight/core': 'workspace:*' },
  }));
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
    const tarball = join(root, 'build/sentinel/farsight-sentinel-0.0.0-test.tgz');
    assert.ok(existsSync(tarball));
    const manifest = JSON.parse(readFileSync(join(root, 'build/sentinel/package/package.json'), 'utf8'));
    assert.deepEqual(manifest.bin, { 'farsight-sentinel': 'dist/cli.mjs' });
    assert.equal(manifest.exports['.'], './dist/index.mjs');
    assert.deepEqual(manifest.files, ['dist', 'schemas']);
    assert.equal(manifest.dependencies, undefined, 'workspace dependencies are inlined, never declared');
    assert.match(readFileSync(join(root, 'build/sentinel/package/dist/cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);

    const smoke = node(root, 'test-sentinel-package.mjs', tarball);
    assert.equal(smoke.status, 0, smoke.stderr + smoke.stdout);
    assert.match(smoke.stdout, /sentinel package ok: farsight-sentinel --help, import \(1 exports\), 1 schemas, npm consumer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
