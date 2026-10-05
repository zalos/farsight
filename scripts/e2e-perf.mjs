#!/usr/bin/env node
// `pnpm e2e:perf [playwright args]` — the browser-side performance suite on the synthetic workspace
// (e2e/perf/, docs/proposals/round-2026-10-05.md §4). The full preset by default; CI sets
// FARSIGHT_PERF_PRESET=small. Needs `pnpm build` first: the webServer runs packages/cli/dist.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'packages', 'cli', 'dist', 'cli.js'))) {
  console.error('packages/cli/dist is missing — run `pnpm build` first (the perf suite drives the built CLI).');
  process.exit(2);
}
const playwright = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
const run = spawnSync(process.execPath, [playwright, 'test', '-c', join(root, 'e2e', 'perf', 'playwright.perf.config.ts'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { FARSIGHT_PERF_PRESET: 'full', ...process.env },
});
process.exit(run.status ?? 1);
