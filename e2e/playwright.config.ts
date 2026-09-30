import { defineConfig, devices } from '@playwright/test';

/**
 * Farsight's own e2e suite (ADR 8 in docs/ARCHITECTURE.md: no MSW).
 *
 * - `viewer` drives the real viewer served by the real `farsight serve`, which
 *   `e2e/fixture/serve.mjs` boots against a temp copy of `examples/invoice-app`
 *   ingested with an explicit `--out` — never the dogfood graph.json. Faults
 *   (500s, a newer build on disk) are injected per test with `page.route`.
 * - `mcp` runs no browser: it spawns `farsight mcp` over stdio with the MCP SDK
 *   client and proves data flows and updates (refresh_graph, /api/sync).
 *
 * The json report at `e2e/test-results/results.json` is what the dogfood
 * `farsight.config.json → tests.e2e` reads, so these specs appear in Farsight
 * as e2e tests with their last run; `pnpm e2e` stamps the content digest into it
 * so freshness can say `unchanged`. The html report lives in a dot-directory
 * because the source walk skips those — its trace viewer ships JavaScript that
 * would otherwise be ingested as Farsight's own functions.
 *
 * Port 4510 is this suite's alone (the lead's servers are 4477 / 4478);
 * reuseExistingServer is off, so an occupied port fails the run instead of
 * silently testing someone else's server. Two lanes running the suite at once
 * each pick their own: `FARSIGHT_E2E_PORT` (viewer) and
 * `FARSIGHT_E2E_SYNC_PORT` (the MCP spec's server, default 4511).
 */
export const E2E_PORT = Number(process.env['FARSIGHT_E2E_PORT'] || 4510);

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.pw\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: 'test-results/artifacts',
  reporter: [
    ['list'],
    ['html', { outputFolder: '.playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'viewer',
      testIgnore: /mcp.*\.pw\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${E2E_PORT}`,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mcp',
      testMatch: /mcp.*\.pw\.spec\.ts/,
      timeout: 60_000,
    },
  ],
  webServer: {
    command: `node fixture/serve.mjs ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/api/version`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
