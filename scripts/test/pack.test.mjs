import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildClosure, missingBuildOutputs } from '../pack-preflight.mjs';

// A throwaway workspace: the pack scripts, the real node_modules, a prior artifact in build/.
function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'scripts'));
  for (const file of ['pack.mjs', 'pack-preflight.mjs']) copyFileSync(resolve('scripts', file), join(root, 'scripts', file));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.0', type: 'module' }));
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'keep.txt'), 'prior artifact');
  return root;
}
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const manifest = (root, dir, body) => write(root, `packages/${dir}/package.json`, JSON.stringify(body));
const pack = (root, ...args) => spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), ...args], { cwd: root, encoding: 'utf8' });

// The CLI's real shape in miniature: cli → core → graph, built.
function builtCli(root) {
  manifest(root, 'cli', { name: '@farsight/cli', dependencies: { '@farsight/core': 'workspace:*' }, devDependencies: { '@farsight/graph': 'workspace:*' } });
  manifest(root, 'core', { name: '@farsight/core', main: 'dist/index.js', dependencies: { '@farsight/graph': 'workspace:*' } });
  manifest(root, 'graph', { name: '@farsight/graph', main: './dist/index.js' });
  write(root, 'packages/core/dist/index.js', '');
  write(root, 'packages/core/dist/version.js', 'export const gitIdentity = () => ({});');
  write(root, 'packages/graph/dist/index.js', '');
}

test('pack without compiled packages explains the build prerequisite before changing build artifacts', () => {
  const root = workspace('farsight-pack-test-');
  try {
    const run = pack(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pnpm build && node scripts\/pack\.mjs/);
    assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.equal(existsSync(join(root, 'build', 'keep.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pack with only core built refuses a missing entry in the CLI closure before deleting prior artifacts', () => {
  const root = workspace('farsight-pack-partial-');
  try {
    builtCli(root);
    manifest(root, 'parsers', { name: '@farsight/parsers', main: 'dist/index.js' });
    manifest(root, 'cli', { name: '@farsight/cli', dependencies: { '@farsight/core': 'workspace:*', '@farsight/parsers': 'workspace:*' } });
    const run = pack(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pnpm build && node scripts\/pack\.mjs/);
    assert.match(run.stderr, /missing: packages\/parsers\/dist\/index\.js/);
    assert.equal(existsSync(join(root, 'build/keep.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Farsight packs with Sentinel present but unbuilt (and Echo unbuilt) beside the CLI closure', () => {
  const root = workspace('farsight-pack-unbuilt-');
  try {
    builtCli(root);
    // Sentinel and Echo depend on core; nothing in the CLI closure depends on them, and neither has a dist/.
    manifest(root, 'sentinel', { name: '@farsight/sentinel', main: './dist/index.js', types: './dist/index.d.ts', bin: { 'farsight-sentinel': './dist/cli.js' }, dependencies: { '@farsight/core': 'workspace:*', ajv: '8.20.0' } });
    write(root, 'packages/sentinel/src/index.ts', 'export {};');
    manifest(root, 'echo', { name: '@farsight/echo', main: 'dist/index.js', dependencies: { '@farsight/core': 'workspace:*' } });
    const run = pack(root, '--check');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /build prerequisites present/);
    assert.equal(existsSync(join(root, 'packages/sentinel/dist')), false);
    assert.equal(existsSync(join(root, 'build/keep.txt')), true, '--check changes no artifact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Farsight packs with no Sentinel package in the workspace at all', () => {
  const root = workspace('farsight-pack-absent-');
  try {
    builtCli(root);
    assert.equal(existsSync(join(root, 'packages/sentinel')), false);
    const run = pack(root, '--check');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(root, 'build/keep.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a CLI closure that did depend on an unbuilt Sentinel would be refused, not skipped', () => {
  const root = workspace('farsight-pack-dependent-');
  try {
    builtCli(root);
    manifest(root, 'sentinel', { name: '@farsight/sentinel', main: './dist/index.js' });
    manifest(root, 'cli', { name: '@farsight/cli', dependencies: { '@farsight/core': 'workspace:*', '@farsight/sentinel': 'workspace:*' } });
    const run = pack(root, '--check');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /missing: packages\/sentinel\/dist\/index\.js/);
    assert.equal(existsSync(join(root, 'build/keep.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the closure follows workspace specifiers transitively, and a workspace name with no manifest fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-pack-closure-'));
  try {
    builtCli(root);
    manifest(root, 'sentinel', { name: '@farsight/sentinel', main: 'dist/index.js', dependencies: { '@farsight/core': 'workspace:*' } });
    assert.deepEqual(buildClosure(root, '@farsight/cli').closure.map((p) => p.name), ['@farsight/cli', '@farsight/core', '@farsight/graph']);
    assert.deepEqual(buildClosure(root, '@farsight/sentinel').closure.map((p) => p.name), ['@farsight/sentinel', '@farsight/core', '@farsight/graph']);
    assert.deepEqual(missingBuildOutputs(root, '@farsight/cli'), []);
    assert.deepEqual(missingBuildOutputs(root, '@farsight/sentinel'), [join(root, 'packages/sentinel/dist/index.js')]);
    manifest(root, 'core', { name: '@farsight/core', main: 'dist/index.js', dependencies: { '@farsight/gone': 'workspace:*', zod: '^3' } });
    assert.deepEqual(missingBuildOutputs(root, '@farsight/cli'), ['@farsight/gone (no workspace manifest)']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the real CLI closure excludes the optional packages', () => {
  const names = buildClosure(resolve('.'), '@farsight/cli').closure.map((p) => p.name);
  assert.ok(names.includes('@farsight/core') && names.includes('@farsight/graph'), names.join(', '));
  for (const optional of ['@farsight/sentinel', '@farsight/echo', '@farsight/app']) assert.ok(!names.includes(optional), optional);
});
