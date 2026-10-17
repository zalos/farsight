#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryVersion } from './library-version.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = libraryVersion(root);
if (process.env.LIBRARY_VERSION !== version) throw new Error('Requested release does not match both reviewed package versions');
const dryRun = process.env.DRY_RUN !== 'false';
if (!dryRun && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main')) throw new Error('Publication requires the main-branch trusted workflow');
for (const name of ['graph', 'code-parser']) {
  const artifact = join(root, 'build/parser', `farsight-${name}-${version}.tgz`);
  if (dryRun) {
    execFileSync('npm', ['publish', artifact, '--access', 'public', '--dry-run'], { stdio: 'inherit' });
    continue;
  }
  // A partial paired publish can be retried only with the exact same bytes.
  let published;
  try {
    published = JSON.parse(execFileSync('npm', ['view', `@farsight/${name}@${version}`, 'dist.integrity', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    let detail;
    try { detail = JSON.parse(String(error.stdout)); } catch { throw error; }
    if (detail?.error?.code !== 'E404') throw error;
  }
  if (published) {
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(artifact)).digest('base64');
    if (published !== integrity) throw new Error(`Published @farsight/${name}@${version} differs from this artifact`);
    console.log(`@farsight/${name}@${version} already has these exact bytes`);
  } else execFileSync('npm', ['publish', artifact, '--access', 'public', '--provenance'], { stdio: 'inherit' });
}
