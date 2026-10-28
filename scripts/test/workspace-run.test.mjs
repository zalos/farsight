import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceOrder, runWorkspace, runRoot } from '../workspace-run.mjs';

const graph = () =>
  new Map([
    [
      '@farsight/app',
      { manifest: { dependencies: { '@farsight/core': '*' }, devDependencies: { '@farsight/types': '*' } } },
    ],
    ['@farsight/core', { manifest: { dependencies: { '@farsight/graph': '^0.3.1' } } }],
    ['@farsight/graph', { manifest: {} }],
    ['@farsight/types', { manifest: {} }],
    ['@farsight/other', { manifest: {} }],
  ]);
test('npm order includes transitive runtime and development dependencies, before their consumers', () => {
  assert.deepEqual(
    workspaceOrder(graph(), '@farsight/app').map((p) => p.name),
    ['@farsight/graph', '@farsight/core', '@farsight/types', '@farsight/app'],
  );
  assert.equal(workspaceOrder(graph()).length, 5);
});
test('cycles and missing internal packages fail before any script can run', () => {
  const packages = graph();
  packages.get('@farsight/graph').manifest.dependencies = { '@farsight/app': '*' };
  assert.throws(() => workspaceOrder(packages), /cycle/);
  assert.throws(() => workspaceOrder(graph(), '@farsight/missing'), /Missing workspace/);
  packages.delete('@farsight/core');
  assert.throws(() => workspaceOrder(packages), /Missing workspace/);
});
test('pnpm keeps its exact recursive and filtered commands; npm propagates the first failing script', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-run-'));
  try {
    for (const name of ['app', 'core']) {
      const dir = join(root, 'packages', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: `@farsight/${name}`,
          dependencies: name === 'app' ? { '@farsight/core': '*' } : {},
          scripts: { build: 'tsc', test: 'node test.mjs' },
        }),
      );
    }
    const calls = [];
    const run = (bin, args) => {
      calls.push([bin, args]);
      return { status: 0 };
    };
    const env = { npm_execpath: '/manager/pnpm.cjs', npm_config_user_agent: 'pnpm/9.0.0' };
    assert.equal(runWorkspace('build', undefined, { root, env, run }), 0);
    assert.deepEqual(calls.pop(), [process.execPath, [env.npm_execpath, '-r', 'build']]);
    runWorkspace('build', '@farsight/app', { root, env, run });
    assert.deepEqual(calls.pop(), [process.execPath, [env.npm_execpath, '--filter', '@farsight/app...', 'build']]);
    runRoot('pack:cli', { root, env, run });
    assert.deepEqual(calls.pop(), [process.execPath, [env.npm_execpath, 'run', 'pack:cli']]);
    const npm = { npm_execpath: '/manager/npm-cli.js', npm_config_user_agent: 'npm/10.9.4' };
    assert.equal(
      runWorkspace('build', undefined, {
        root,
        env: npm,
        run: (bin, args) => {
          calls.push([bin, args]);
          return { status: 7 };
        },
      }),
      7,
    );
    assert.deepEqual(calls, [[process.execPath, [npm.npm_execpath, 'run', 'build', '--workspace', '@farsight/core']]]);
    assert.throws(() => runWorkspace('install', undefined, { root, run }), /Usage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
