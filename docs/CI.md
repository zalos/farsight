# CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request. A newer push to the same ref
cancels the run in progress. `.github/workflows/commits.yml` checks PR titles and branch commits, including on
title edits; its separate concurrency group leaves running tests alone. Both workflows have read-only repository
access and no secrets beyond the run's own `GITHUB_TOKEN`.

## What runs

The four required check names remain **validate · e2e · secrets · commits**. A small `changes` job tests and runs
`scripts/ci-changes.mjs`, then the affected runtime jobs run in parallel on `ubuntu-latest`. No dependency install
or browser download is needed to select checks. The selection appears in the run summary. Build jobs use Node
from `.nvmrc` (24) and pnpm from `packageManager` (9.0.0), with the pnpm store cached on the lockfile.

| job | steps | timeout |
|---|---|---|
| **validate** | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm -r typecheck` → `pnpm -r test` → `pnpm test:scripts` → `pnpm lint:strings`; includes Echo's unit tests | 20 min |
| **e2e** | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm e2e:typecheck` → chromium (cached in `~/.cache/ms-playwright`, keyed on the `@playwright/test` version) → `pnpm e2e` → `pnpm e2e:perf` on the small preset (`FARSIGHT_PERF_PRESET=small`; the table is the `e2e-perf-results` artifact) | 30 min |
| **secrets** | gitleaks over the pushed or PR commits (below) | 10 min |
| **commits** | pull requests only: `scripts/lint-commits.mjs --message "$PR_TITLE"` (the title becomes the squash commit on `main` — type and scope must be on the lists) and `--range base..head --any-scope` (every branch commit has the conventional shape) | 5 min |
| **echo-package** (non-required) | when relevant, `pnpm install --frozen-lockfile` → `pnpm test:echo:package` | 15 min |

### Which changes select which checks

These are deliberately broad suite boundaries, not an inferred per-test dependency graph. Mixed changes take the
union of the matching checks. Secrets and PR commit conventions always run, including for documentation.

| changed paths | runtime checks |
|---|---|
| Root Markdown, Markdown under `docs/`, `.github/`, `.claude/`, `.agents/`, or `LICENSE` | none, except the packaged Echo docs below |
| `docs/ECHO.md`, `packages/echo/README.md`, Echo packaging scripts or example connection/settings | `echo-package` |
| `e2e/`, `scripts/e2e.mjs`, `scripts/e2e-perf.mjs`, `scripts/synth-graph.mjs` | `e2e` (including its typecheck and small perf suite) |
| Package `test/` folders, `scripts/test/`, changelog/release/hook-install/commit-lint scripts | `validate` |
| Package code/assets, `examples/`, `schemas/` | `validate` + `e2e`; core and Echo changes also select `echo-package` |
| Everything else, including dependencies, build config, workflows and the selector itself | all |

Markdown inside fixtures is test input, not automatically documentation. Core is an Echo build dependency, so its
whole package is watched, not just a few currently imported helpers. PRs compare merge-base → head, excluding
unrelated changes on the base branch; pushes compare before → after across every pushed commit. Deleted paths and
both sides of renames count. An unavailable range or failed selector runs all checks.

The workflow itself is never path-filtered. Unaffected jobs are explicitly skipped, which satisfies GitHub's
required checks without leaving a docs PR pending. Missing selector outputs run the checks, so a detector failure
cannot silently bypass them. See [GitHub's required-check guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Release creation and publication retain their full validation. The publish workflow's detection job, which runs
on every push to `main`, reads history and `package.json` without fetching LFS assets; the actual publish job still
fetches them.

On the first runs (2026-10-01), **validate** took 1–1¼ min and **e2e** about 1½ min, of which the 109-test
suite itself takes about 41 s on the runner (13 s on a warm Mac). The first run of a new `@playwright/test`
version also downloads chromium; after that the browser comes from the cache, and only its system libraries are
installed again.

The live tracker tests (`packages/work-jira`, `packages/work-azdo`, `test/live.test.ts`) skip unless
`FARSIGHT_LIVE=1`, which CI never sets. No test reads a keychain. Secret resolution is tested with an injected
runner.

Workspace installs allow dependency build scripts only for `esbuild` (`pnpm.onlyBuiltDependencies` in
`package.json`). Echo remains part of the workspace dependency resolution; the allowlist prevents its other
transitive dependencies from running install scripts. The explicit engine installation is tested separately.

Echo's optional package job follows the selection table above. An unrelated change skips the whole job, including
checkout and install. The required `validate` job retains all Echo unit tests, whose
runner gives each run a temporary `XDG_STATE_HOME` so tests never approve files in the developer's real trust state.

The package check builds Echo's separate tarball, installs it into a temporary directory without optional embedding dependencies,
downloads the checksum-pinned iii engine, and verifies synthetic save/recall, restart persistence, and separate stores.
It also installs all three workspace hook formats into a temporary fixture and invokes their exact commands against
the running memory bridge, including sharing one profile between two workspaces. It makes no model calls and uses
no real memories or host sessions. This check needs npm and GitHub release downloads; a failure is reported in
`echo-package` rather than blocking the four required checks.

The **secrets** job runs gitleaks over the pushed or PR commits with `.gitleaks.toml`. A finding fails the job and uploads a SARIF artifact; it posts no PR comment. What it checks, and
how to allowlist a value you have checked: [SECURITY.md](SECURITY.md#the-scan-in-ci).

## Run the same thing locally

Choose checks from the table above for local work too: ordinary Markdown edits do not need a build, unit tests or
e2e. For changes to CI selection, run `pnpm test:scripts` and `actionlint`; the workflow change itself selects all
checks on GitHub. Keep local validation focused on the affected behavior instead of rerunning unrelated suites.

When runtime checks are needed, build before tests. The tests import `dist/`, and e2e drives
`packages/cli/dist/cli.js`. The full set is:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm -r test
pnpm test:scripts
pnpm lint:strings
pnpm test:echo:package                  # optional network integration check for Echo changes
pnpm exec playwright install chromium   # once per @playwright/test version
pnpm e2e
```

`pnpm lint:commits --message 'fix(cli): …'` tries a PR title against the `commits` job's rule; the `commit-msg` hook
that `pnpm install` installs (`scripts/install-hooks.mjs`) runs the same check on every local commit.

`node .claude/skills/e2e-playwright/scripts/check-e2e-setup.mjs` checks the e2e prerequisites before a run.
Set `CI=1` to get the runner's Playwright behaviour: `test.only` fails the run, and a failed test is retried once.

## The perf suite

`pnpm e2e:perf` (`scripts/e2e-perf.mjs`, `e2e/perf/`) serves a synthetic workspace (`scripts/synth-graph.mjs`)
with the real `farsight serve` on port 4535 (`FARSIGHT_PERF_PORT`) and measures every surface: first draw, one
interaction, long tasks and the JS heap, printed as one markdown table and written to `e2e/perf/results.json`.
The full preset (1,000 projects · ≈250k nodes, the default) holds each row to the budgets of
`docs/proposals/round-2026-10-05.md` §4 and takes ~10 minutes; CI runs `FARSIGHT_PERF_PRESET=small`, where every
surface must draw with no page error and no budget applies. It is not part of `pnpm e2e`.

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
| `e2e-results-json` | whenever the e2e job runs | `e2e/test-results/results.json`, stamped (below) |
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
