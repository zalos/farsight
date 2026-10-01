# CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request. A newer push to the same ref
cancels the run in progress. The workflow has read-only repository access and no secrets.

## What runs

Two jobs on `ubuntu-latest` run **in parallel**, so a red e2e and a red unit test are separate signals. Both use
Node from `.nvmrc` (24) and pnpm from `packageManager` (9.0.0), with the pnpm store cached on the lockfile.

| job | steps | timeout |
|---|---|---|
| **validate** | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm typecheck` (every package, then `e2e/`) → `pnpm -r test` → `pnpm lint:strings` | 20 min |
| **e2e** | `pnpm install --frozen-lockfile` → `pnpm build` → chromium (cached in `~/.cache/ms-playwright`, keyed on the `@playwright/test` version) → `pnpm e2e` | 30 min |

On the first runs (2026-10-01), **validate** took 1–1¼ min and **e2e** about 1½ min, of which the 109-test
suite itself takes about 41 s on the runner (13 s on a warm Mac). The first run of a new `@playwright/test`
version also downloads chromium; after that the browser comes from the cache, and only its system libraries are
installed again.

The live tracker tests (`packages/work-jira`, `packages/work-azdo`, `test/live.test.ts`) skip unless
`FARSIGHT_LIVE=1`, which CI never sets. No test reads a keychain. Secret resolution is tested with an injected
runner.

## Run the same thing locally

Build before tests. The tests import `dist/`, and e2e drives `packages/cli/dist/cli.js`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm -r test
pnpm lint:strings
pnpm exec playwright install chromium   # once per @playwright/test version
pnpm e2e
```

`node .claude/skills/e2e-playwright/scripts/check-e2e-setup.mjs` checks the e2e prerequisites before a run.
Set `CI=1` to get the runner's Playwright behaviour: `test.only` fails the run, and a failed test is retried once.

## The three e2e env knobs

The suite owns its ports. `reuseExistingServer` is off, so an occupied port fails the run instead of quietly
testing someone else's server. Two lanes running at once each pick their own ports:

| variable | default | what listens there |
|---|---|---|
| `FARSIGHT_E2E_PORT` | 4510 | the viewer's `farsight serve` on the fixture workspace (`e2e/fixture/serve.mjs`) |
| `FARSIGHT_E2E_SYNC_PORT` | 4511 | the server the MCP spec starts to prove `/api/sync` |
| `FARSIGHT_E2E_SB_PORT` | 4539 | the stub Storybook the stories spec points the fixture source at |

## Artifacts

| artifact | when | contents |
|---|---|---|
| `e2e-results-json` | always | `e2e/test-results/results.json`, stamped (below) |
| `e2e-report` | e2e failed | `e2e/test-results/` (traces of retried tests, failure screenshots) and `e2e/.playwright-report/` (open `index.html`, or `pnpm exec playwright show-report e2e/.playwright-report`) |

Both are kept for 14 days. To read a failure, start with the job log. Playwright's `list` reporter names each
failed spec and line. Then open the report artifact for that test's trace and screenshot.

## How e2e results reach the dogfood graph

`pnpm e2e` (`scripts/e2e.mjs`) runs Playwright. Then it writes `farsight.sourceDigest`, `stampedAt`, `repo` and
`commit` into `e2e/test-results/results.json`. The digest is the checkout's content digest, from
`farsight digest --repo farsight`. `farsight.config.json → tests.e2e` reads that file at ingest. So the specs
appear in Farsight's own graph as e2e tests with their last run, and their freshness reads `unchanged` while the
digest matches the code. An unstamped report reads `unknown`.

CI does not change the dogfood graph. To bring a CI run in, download `e2e-results-json` into `e2e/test-results/`
and re-sync the workspace server (`curl -X POST localhost:4477/api/sync`). The digest says whether that run
matches your checkout. A runner checks out without `.farsight/settings.json`, so it computes its digest without
the workspace source excludes. If yours differs, the report reads as not matching rather than as fresh.
