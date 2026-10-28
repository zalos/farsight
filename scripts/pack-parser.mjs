#!/usr/bin/env node
// The libraries already declare ordinary published dependency ranges, so either manager can pack them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'build/parser');
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [join(root, 'scripts/library-version.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'scripts/graph-schema.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
for (const name of ['graph', 'code-parser']) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
  if (pkg.private) throw new Error(`${pkg.name} is private`);
  execFileSync('npm', ['pack', '--pack-destination', out], { cwd: join(root, 'packages', name), stdio: 'inherit' });
}
