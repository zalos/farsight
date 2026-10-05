import { defineConfig, devices } from '@playwright/test';

/**
 * The browser-side performance suite (docs/proposals/round-2026-10-05.md §4) — not part of `pnpm e2e`.
 *
 * `e2e/perf/serve.mjs` writes the synthetic workspace (`scripts/synth-graph.mjs`, the preset from
 * `FARSIGHT_PERF_PRESET`: `full` = 1,000 projects · ≈250k nodes, `small` = ≈50 projects · ≈20k nodes) into a
 * temp directory and runs the real `farsight serve` on it. `surfaces.perf.pw.spec.ts` measures every surface
 * (first draw, one interaction, long tasks, JS heap) and prints one table — markdown on stdout and
 * `e2e/perf/results.json`. Budgets apply on the full preset; CI runs the small one as a smoke.
 *
 * `pnpm e2e:perf` runs the full preset; `FARSIGHT_PERF_PRESET=small pnpm e2e:perf` the CI one. The port
 * is 4535 (`FARSIGHT_PERF_PORT`) — never the lead's 4477 / 4478. One worker: each surface is measured on
 * an otherwise idle server and browser.
 */
export const PERF_PORT = Number(process.env['FARSIGHT_PERF_PORT'] || 4535);
export const PERF_PRESET = process.env['FARSIGHT_PERF_PRESET'] || 'full';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.perf\.pw\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  outputDir: 'test-results',
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PERF_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node serve.mjs ${PERF_PORT} ${PERF_PRESET}`,
    url: `http://localhost:${PERF_PORT}/api/version`,
    reuseExistingServer: false,
    timeout: 5 * 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
