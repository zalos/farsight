#!/usr/bin/env node
// `pnpm e2e [playwright args]` — run the e2e suite, then stamp its report so
// Farsight can say whether the run still matches the code.
//
// Playwright's json reporter has no hook for a source digest, so this is the
// moment of record (the same one `farsight tests import --stamp` uses): the
// content digest of this checkout, computed the way ingest computes it for the
// `farsight` source (workspace excludes included), is written into
// e2e/test-results/results.json as `farsight.sourceDigest`. The dogfood graph's
// `tests.e2e` block reads that file; a matching digest reads `unchanged`, an
// unstamped one `unknown` — never fresh by assumption.
//
// Needs `pnpm build` first: the webServer and the MCP spec run packages/cli/dist.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli', 'dist', 'cli.js');
if (!existsSync(cli)) {
  console.error('packages/cli/dist is missing — run `pnpm build` first (the e2e suite drives the built CLI).');
  process.exit(2);
}

const playwright = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
const run = spawnSync(process.execPath, [playwright, 'test', '-c', join(root, 'e2e', 'playwright.config.ts'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit',
});

const results = join(root, 'e2e', 'test-results', 'results.json');
if (existsSync(results)) {
  const digest = spawnSync(process.execPath, [cli, 'digest', '--repo', 'farsight', root], { cwd: root, encoding: 'utf8' });
  const sourceDigest = digest.stdout.trim();
  if (digest.status === 0 && /^[0-9a-f]{6,}$/.test(sourceDigest)) {
    const doc = JSON.parse(readFileSync(results, 'utf8'));
    // the commit beside the digest: a later mismatch on the same commit is the working tree, not a new commit
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const commit = head.status === 0 ? head.stdout.trim() : '';
    doc.farsight = { sourceDigest, stampedAt: new Date().toISOString(), repo: 'farsight', ...(commit ? { commit } : {}) };
    writeFileSync(results, JSON.stringify(doc, null, 2));
    console.log(`e2e report stamped with content digest ${sourceDigest} → ${results}`);
  } else {
    console.error(`could not compute the content digest — the report stays unstamped (freshness: unknown)\n${digest.stderr}`);
  }
}
process.exit(run.status ?? 1);
