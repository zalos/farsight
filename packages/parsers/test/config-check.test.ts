// A guard that checks how the app was started — its settings — rather than a request is tagged `config-check`
// (swarm-fixes 2026-10-05, finding 4): the journeys list it apart from a screen's gates. Runs against the built
// package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo } from '../dist/index.js';

test('a @guard reading the environment with no request is a config check; one taking the request is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-config-check-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/env.ts'), [
    '/** @guard dev sign-in only outside production */',
    'export function resolveDevLogin(requested: string | undefined, env: Record<string, string | undefined>): boolean {',
    "  if (requested === 'true' && env['NODE_ENV'] === 'production') throw new Error('refused');",
    "  return env['NODE_ENV'] !== 'production';",
    '}',
    '/** @guard a signed-in user */',
    'export function requireSession(req: Request): string {',
    "  if (!process.env.SECRET) throw new Error('no secret');",
    "  return req.headers.get('cookie') ?? '';",
    '}',
  ].join('\n'));
  const g = await ingestRepo(dir, { repoName: 'cfg', openapi: false, design: false, tests: false });
  const by = new Map(g.nodes.map((n) => [n.name.split(':')[0], n]));
  assert.equal(by.get('resolveDevLogin')!.kind, 'guard');
  assert.ok(by.get('resolveDevLogin')!.tags.includes('config-check'));
  assert.equal(by.get('requireSession')!.kind, 'guard');
  assert.ok(!by.get('requireSession')!.tags.includes('config-check'));
});
