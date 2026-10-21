import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('api diff selective strict checks policy while JSON retains raw evidence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'api-policy-'));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  try {
    writeFileSync(join(cwd, 'graph.json'), JSON.stringify({ version: 1, nodes: [
      { id: 'app::route::GET /now', kind: 'route', name: 'GET /now', tags: [], loc: { repo: 'app', path: 'routes.ts', line: 1 } },
      { id: 'app::route::GET /private', kind: 'route', name: 'GET /private', tags: [], loc: { repo: 'app', path: 'routes.ts', line: 2 } },
    ], edges: [], meta: {} }));
    writeFileSync(join(cwd, 'api.json'), JSON.stringify({ openapi: '3.1.0', paths: {
      '/now': { get: { 'x-phase': 'preview' } }, '/later': { get: { 'x-phase': 'release' } },
    } }));
    writeFileSync(join(cwd, 'farsight.config.json'), JSON.stringify({ openapi: [{ path: 'api.json', phase: 'preview', phaseOrder: ['preview', 'release'] }], internalRoutes: ['GET /private'] }));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'api', 'diff', '--spec', 'api.json', '--repo', 'app', '--format', 'json', ...args], { cwd, encoding: 'utf8' });
    const clean = run('--strict=missing,undocumented');
    assert.equal(clean.status, 0, clean.stderr);
    const result = JSON.parse(clean.stdout);
    assert.equal(result.counts.drift, 2);
    assert.equal(result.policy.counts.planned, 1);
    assert.equal(result.policy.counts.internal, 1);
    assert.equal(run('--strict', '--phase', 'release').status, 1);
    assert.equal(run('--strict=notes', '--phase', 'release').status, 0);
    assert.notEqual(run('--strict=typo').status, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
