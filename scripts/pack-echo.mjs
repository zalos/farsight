#!/usr/bin/env node
// Echo is a separate installable artifact; no reverse dependency enters farsight-cli.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'echo', 'package');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const echo = JSON.parse(readFileSync(join(root, 'packages/echo/package.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
await build({
  entryPoints: [join(root, 'packages/echo/src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: join(out, 'dist', 'echo.mjs'),
  external: ['@agentmemory/agentmemory', '@agentmemory/agentmemory/*'],
});
cpSync(join(root, 'packages/echo/public'), join(out, 'public'), { recursive: true });
cpSync(join(root, 'packages/echo/README.md'), join(out, 'README.md'));
writeFileSync(
  join(out, 'README.md'),
  readFileSync(join(out, 'README.md'), 'utf8').replace('../../docs/ECHO.md', 'ECHO.md'),
);
writeFileSync(
  join(out, 'ECHO.md'),
  readFileSync(join(root, 'docs/ECHO.md'), 'utf8').replaceAll('../packages/echo/README.md', 'README.md'),
);
cpSync(join(root, '.echo/settings.example.json'), join(out, 'settings.example.json'));
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'farsight-echo',
      version: pkg.version,
      description: 'Optional local memory companion for Farsight: isolated profiles, settings and agentmemory setup.',
      license: 'MIT',
      repository: pkg.repository,
      type: 'module',
      bin: { 'farsight-echo': 'dist/echo.mjs' },
      files: ['dist', 'public', 'README.md', 'ECHO.md', 'settings.example.json'],
      dependencies: { '@agentmemory/agentmemory': echo.dependencies['@agentmemory/agentmemory'] },
      engines: { node: '>=24' },
    },
    null,
    2,
  ) + '\n',
);
execFileSync('npm', ['pack', '--pack-destination', '..'], { cwd: out, stdio: 'inherit' });
