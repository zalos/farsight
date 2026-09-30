#!/usr/bin/env node
// Doctor for Farsight's e2e suite. Run from the repo root:
//   node .claude/skills/e2e-playwright/scripts/check-e2e-setup.mjs
// Checks: Node 24+, the built CLI, @playwright/test + its chromium, the MCP SDK,
// ports 4510/4511 free (and 4477/4478 left alone), and whether the last report
// is stamped. Exits 1 on any red check.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const req = createRequire(join(root, 'package.json'));
let red = 0;
const say = (ok, label, hint = '') => {
  const mark = ok === true ? '\x1b[32m✓' : ok === 'warn' ? '\x1b[33m⚠' : '\x1b[31m✗';
  if (ok === false) red++;
  console.log(`${mark}\x1b[0m ${label}${hint ? ` — ${hint}` : ''}`);
};
const busy = (port) => new Promise((ok) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('error', () => ok(false));
});

const major = Number(process.versions.node.split('.')[0]);
say(major >= 24, `node ${process.versions.node}`, major >= 24 ? '' : 'needs 24+ (.nvmrc; see docs/AI-HANDOFF.md for the Codex runtime path)');
const built = existsSync(join(root, 'packages/cli/dist/cli.js'));
say(built, 'packages/cli/dist/cli.js', built ? '' : 'run `pnpm build`');
say(existsSync(join(root, 'e2e/playwright.config.ts')), 'e2e/playwright.config.ts');
try {
  const { chromium } = req('@playwright/test');
  const exe = chromium.executablePath();
  say(existsSync(exe), `@playwright/test ${req('@playwright/test/package.json').version} · chromium`, existsSync(exe) ? '' : 'run `npx playwright install chromium`');
} catch { say(false, '@playwright/test', 'run `pnpm install`'); }
try { req.resolve('@modelcontextprotocol/sdk/client/index.js'); say(true, '@modelcontextprotocol/sdk client'); }
catch { say(false, '@modelcontextprotocol/sdk', 'run `pnpm install`'); }
for (const port of [4510, 4511]) {
  const taken = await busy(port);
  say(!taken, `port ${port} free`, taken ? `something listens — \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, stop it by pid (never pkill -f "cli.js serve")` : '');
}
for (const port of [4477, 4478]) if (await busy(port)) say('warn', `port ${port} is a live lead server`, 'the suite never touches it');
const results = join(root, 'e2e/test-results/results.json');
if (!existsSync(results)) say('warn', 'no e2e/test-results/results.json yet', 'run `pnpm e2e`');
else {
  const doc = JSON.parse(readFileSync(results, 'utf8'));
  const s = doc.stats ?? {};
  say(doc.farsight?.sourceDigest ? true : 'warn', `last report ${s.startTime ?? '?'} · ${s.expected ?? 0} passed · ${s.unexpected ?? 0} failed · ${s.flaky ?? 0} flaky`,
    doc.farsight?.sourceDigest ? `stamped ${doc.farsight.sourceDigest}` : 'unstamped — freshness will read unknown; run through `pnpm e2e`');
}
process.exit(red ? 1 : 0);
