#!/usr/bin/env node
// Libraries release together, independently of the application's root version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { nextVersion } from './release.mjs';

export function libraryVersion(root, version, { dryRun = false } = {}) {
  const files = ['graph', 'code-parser'].map((name) => join(root, 'packages', name, 'package.json'));
  const packages = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  if (packages[0].version !== packages[1].version) throw new Error('Library versions must match');
  const stamp = join(root, 'packages/code-parser/src/version.ts');
  const source = readFileSync(stamp, 'utf8');
  if (!source.includes(`export const PARSER_VERSION = '${packages[0].version}';`))
    throw new Error('Parser version stamp is out of date');
  if (!version) return packages[0].version;
  nextVersion(packages[0].version, { version }); // shared semver validation
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Library releases currently use stable X.Y.Z versions');
  const old = packages[0].version.split('.').map(Number),
    next = version.split('.').map(Number);
  const first = next.findIndex((n, i) => n !== old[i]);
  if (first < 0 || next[first] < old[first]) throw new Error('The library version must increase');
  if (!dryRun) {
    packages[1].dependencies = { ...packages[1].dependencies, '@farsight/graph': `^${version}` };
    packages.forEach((pkg, i) => writeFileSync(files[i], JSON.stringify({ ...pkg, version }, null, 2) + '\n'));
    writeFileSync(stamp, source.replace(`'${packages[0].version}'`, `'${version}'`));
  }
  return version;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const args = process.argv.slice(2);
  const version = args.find((arg) => !arg.startsWith('--'));
  if (!version && !args.includes('--check'))
    throw new Error('Usage: node scripts/library-version.mjs X.Y.Z [--dry-run] | --check');
  console.log(`Parser libraries: ${libraryVersion(root, version, { dryRun: args.includes('--dry-run') })}`);
}
