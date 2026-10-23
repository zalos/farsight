# CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request. A newer push to the same ref
cancels the run in progress. `.github/workflows/commits.yml` checks PR titles and branch commits, including on
title edits; its separate concurrency group leaves running tests alone. Both workflows have read-only repository
access and no secrets beyond the run's own `GITHUB_TOKEN`.

The native scanner CLI gate also runs framework inspection privacy against genuine accepted Gitleaks publications,
then installs the tarball with npm alone and exercises framework report delivery, source-removed replay and an actual
mid-inspection service kill/resume. Both clean and secret-withheld delivered HTML reports are opened offline and
printed in the browser-provisioned job. A missing pinned image after native opt-in fails; the new native test file is
in the explicit zero-skip test list. Ordinary package acceptance runs the framework consumer without Docker.

## What runs

The six required check names are **affected checks · validate · e2e · echo-package · secrets · commits**.
Branch protection requires them from GitHub Actions, requires the branch to be up to date, and applies to admins.
A small `changes` job (displayed as **affected checks**) tests and runs
`scripts/ci-changes.mjs`, then the affected runtime jobs run in parallel on `ubuntu-latest`. No dependency install
or browser download is needed to select checks. The selection appears in the run summary. Build jobs use Node
from `.nvmrc` (24) and pnpm from `packageManager` (9.0.0), with the pnpm store cached on the lockfile.

| job | steps | timeout |
|---|---|---|
| **affected checks** | test `scripts/ci-changes.mjs` and select suites from the changed paths | 5 min |
| **validate** | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm -r typecheck` → `pnpm -r test` → `pnpm test:scripts` → `pnpm lint:strings`; includes Echo's unit tests | 20 min |
| **e2e** | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm e2e:typecheck` → chromium (cached in `~/.cache/ms-playwright`, keyed on the `@playwright/test` version) → `SENTINEL_REPORT_BROWSER=1` offline report delivery and print (exactly one case, zero skips) → `pnpm e2e` → `pnpm e2e:perf` on the small preset (`FARSIGHT_PERF_PRESET=small`; the table is the `e2e-perf-results` artifact) | 30 min |
| **secrets** | gitleaks over the pushed or PR commits (below) | 10 min |
| **commits** | pull requests only: `scripts/lint-commits.mjs --message "$PR_TITLE"` (the title becomes the squash commit on `main` — type and scope must be on the lists) and `--range base..head --any-scope` (every branch commit has the conventional shape) | 5 min |
| **parser-package (Linux/macOS)** (non-required) | parser package/workflow/dependency changes: actual tarballs installed outside the workspace, public types, native/WASM parsing, saved-graph query | 15 min |
| **echo-package** | when relevant, `pnpm install --frozen-lockfile` → `pnpm test:echo:package` | 15 min |
| **sentinel-isolation** (not yet required) | when relevant, `pnpm install --frozen-lockfile` → `docker pull` of the one pinned canary image by digest (provisioning; the code under test never pulls) → `pnpm --filter '@farsight/sentinel...' build` → `SENTINEL_ISOLATION=1` worker-protocol and real-container canaries (network, host-file, effective identity, memory, CPU, process, file-size and temporary-storage enforcement, malformed output, deadline, cancel, failed start, ambiguous-create reconciliation, cleanup ownership) and real-container crash recovery (a coordinator killed after a create whose reply is lost, before a create whose container appears late, while canceling, and within one epoch after a create without a confirmed answer), one repetition each as smoke; the pinned Gitleaks image (`docker pull` by digest) for its conformance suite and the public CLI's canonical secret scan (`test/gitleaks-cli.test.ts`), then the packed tarball installed by npm alone runs the same scan (`scripts/test-sentinel-secrets-consumer.mjs`). A missing or unqualified container runtime fails it, and so does any skipped test | 30 min |
| **sentinel-recovery** (not yet required) | when relevant, `pnpm install --frozen-lockfile` → `pnpm --filter '@farsight/sentinel...' build` → `SENTINEL_RECOVERY_SMOKE=1`: one real SIGKILL of a coordinator process at each boundary (before a worker is started, after it is started, after its attempt is recorded, before staging, after staging, after the objects, after publication) one orphaned worker and one worker whose coordinator died before its start (it must exit on its own at end of stdin, having written nothing), each recovered by a fresh process with every output accepted exactly once, plus the in-process coordinator suite. A missing prerequisite fails it, and so does any skipped test. The 20-repetition matrix is the separate **sentinel-recovery-full** workflow (`SENTINEL_RECOVERY_FULL=1`): every process boundary, then the four real-container crash cases 20 times each (with the pinned canary image and `SENTINEL_ISOLATION=1`), with no owned container left and two unrelated containers untouched; a release gate run by hand and on every push to `release/**` | 20 min |
| **sentinel-service** (not yet required) | when Sentinel is selected, `pnpm install --frozen-lockfile` → `pnpm --filter '@farsight/sentinel...' build` → the CLI, owner socket, detached service, kill-and-resume and rule-lock suites (`cli-prework`, `service-detached`, `service-policy`, `service-mcp-controls`, `service-planned-pause`, `cli-preview-e2e`, `cli-rules`, `preview-slice`, `trusted-profile`, `receipts-publish`) on native amd64 as the runner's non-root user under umask 022. Running as root, on another architecture, or any skipped test fails it | 20 min |
| **sentinel-package** (not yet required) | when relevant, `pnpm install --frozen-lockfile` → `pnpm pack:cli` (builds only the CLI's closure, so Sentinel stays unbuilt; the job fails if `packages/sentinel/dist` exists) → `scripts/test-farsight-package.mjs` → `pnpm test:cli:package:absent` → `pnpm test:sentinel:package` (below) | 15 min |

### Native installed scanner CLI acceptance

The separate `sentinel-scanner-cli` workflow runs on pull requests and pushes to `main`, with manual dispatch too.
Its inexpensive selection job reuses the union of `sentinel-package` and `sentinel-isolation` inputs from the existing
selector, including the manifest-derived dependency closures. Documentation-only changes skip the acceptance job;
mixed changes retain it, and an unavailable range, failed selector or missing output cannot silently skip it.

The selected `scanner-cli-linux-amd64` job requires a native non-root Ubuntu amd64 host, a Linux amd64 Docker daemon,
Node 24 and the exact measured adapter pins. An explicit provisioning step verifies each index's amd64 manifest and
pulls the four pinned Semgrep, OSV-Scanner, Trivy and zizmor images; another explicit step acquires the pinned Trivy
checks bundle through its bounded owner setup script. OSV tests use original synthetic offline archives; no live
advisory database, project package manager or host scanner runs. Runtime execution never pulls or acquires assets.

The job runs driver/binding/asset/admission tests and the real public four-engine CLI with test-file concurrency one.
The report authority regressions use genuine accepted publications, including malformed worker output, missing
accepted objects, exact check/source/scope bindings and bounded special-file refusals.
An empty suite, any skip, failure or cancellation fails acceptance. It then packs the npm artifact and runs
`test-sentinel-scanner-consumer.mjs` from a clean consumer: init, adopt settings, promote exact packs, missing-asset
refusal, owner-receipted tools/databases, plan, detach/join/wait, and report regeneration after service restart and
source removal; with the source and service gone it also writes the full report once as shareable and private HTML
and JSON, and a browser step opens both HTML files from disk with no network and JavaScript off, failing on any
request, page or console error, and prints them (only the shareable screenshots are retained). Required coverage
gaps stay exit 2. Tests stop only their own supervised resources; the final step
queries the daemon directly and fails if Sentinel containers remain. It never deletes an unowned container or hides
a failed daemon query. The tested commit/image/worker pins, TAP result, installed-consumer success log and daemon identity are retained as CI evidence.

This job is not yet a protected required check. Adding the workflow is not a measurement: native installed-command
acceptance is recorded only after the selected job actually passes on its exact commit. It covers the four-engine public dispatch path. Preview compatibility remains in the existing service checks;
Gitleaks and the remaining plan gates remain separate.

### Which changes select which checks

These are deliberately broad suite boundaries, not an inferred per-test dependency graph. Mixed changes take the
union of the matching checks. Secrets and PR commit conventions always run, including for documentation.

| changed paths | runtime checks |
|---|---|
| Root Markdown, Markdown under `docs/`, `.github/`, `.claude/`, `.agents/`, or `LICENSE` | none, except the packaged Echo docs below |
| `docs/ECHO.md`, `packages/echo/README.md`, Echo packaging scripts or example connection/settings | `echo-package` |
| `packages/sentinel/README.md`, `scripts/pack-sentinel.mjs`, `scripts/test-sentinel-package.mjs` | `sentinel-package` |
| `packages/sentinel/` outside `test/` | `validate` + `sentinel-package` + `sentinel-isolation` + `sentinel-recovery` + `e2e` (the e2e job also runs the offline report browser gate) |
| `packages/sentinel/test/` | `validate` + `sentinel-isolation` + `sentinel-recovery` + `e2e` (offline report browser gate) |
| `e2e/`, `scripts/e2e.mjs`, `scripts/e2e-perf.mjs`, `scripts/synth-graph.mjs` | `e2e` (including its typecheck and small perf suite) |
| Package `test/` folders, `scripts/test/`, changelog/release/hook-install/commit-lint scripts | `validate` |
| Package code/assets, `examples/`, `schemas/` | `validate` + `e2e`; graph, core and Echo changes also select `echo-package`; changes to a package in `farsight-cli`'s workspace dependency closure (cli, server, mcp, parsers, code-parser, core, graph, work and the work providers today, read from the manifests by `scripts/ci-changes.mjs`), Sentinel's own closure, or `examples/invoice-app/` also select `sentinel-package`; Sentinel's own closure (read from the manifests) also selects `sentinel-isolation` and `sentinel-recovery`; unreadable manifests select all |
| Everything else, including dependencies, build config, workflows, the selector itself and the shared packaging scripts (`pack.mjs`, `pack-preflight.mjs`, `npm-consumer.mjs`, `test-farsight-package.mjs`, `test-farsight-package-absent.mjs`) | all |

Markdown inside fixtures is test input, not automatically documentation. Graph and core are Echo build dependencies, so its
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

Echo's required package job follows the selection table above. An unrelated change skips the whole job, including
checkout and install. The required `validate` job retains all Echo unit tests, whose
runner gives each run a temporary `XDG_STATE_HOME` so tests never approve files in the developer's real trust state.

The package check builds Echo's separate tarball, installs it into a temporary directory without optional embedding dependencies,
downloads the checksum-pinned iii engine, and verifies synthetic save/recall, restart persistence, and separate stores.
It also installs all three workspace hook formats into a temporary fixture and invokes their exact commands against
the running memory bridge, including sharing one profile between two workspaces. It makes no model calls and uses
no real memories or host sessions. This check needs npm and GitHub release downloads; a failure is reported in
`echo-package` and blocks merging when that check runs. An unaffected package job is explicitly skipped.

Sentinel's package job (ADR 18) proves the boundary in both directions from clean `npm init -y` consumers,
outside the pnpm workspace. Clean means none of the caller's npm configuration: inherited `npm_config_*`
variables are dropped and npm's user and global config files, cache and XDG config/state are task-local
(`scripts/npm-consumer.mjs`; `HOME` is untouched, and `FARSIGHT_NPM_REGISTRY` names a mirror explicitly). The
scratch directory is removed on success and on any npm failure. First `pnpm pack:cli` builds only `@farsight/cli...` and packs `farsight-cli`; the
pack preflight (`scripts/pack-preflight.mjs`) requires only the CLI's `workspace:` dependency closure and refuses
before removing any prior artifact. `scripts/test-farsight-package.mjs` installs that tarball, checks that the
bundle names no Sentinel module, that no Sentinel package is installed and that the tarball's `engines.node` equals
the workspace's, prints `--version`, ingests the
invoice example and serves it read-only on a free port until `/api/version` answers, then stops its own server
by pid. `pnpm test:cli:package:absent` (`scripts/test-farsight-package-absent.mjs`) repeats that pack, install and
startup in a temporary copy of the workspace with `packages/sentinel/` removed (installed from the pnpm store, not a
Git checkout). Then `pnpm test:sentinel:package` builds `@farsight/sentinel...`, packs `farsight-sentinel` and installs
it: every bin answers `--help`; the root and each subpath export import and ship declarations; a strict TypeScript
consumer compiles against the installed types, naming every runtime export and each envelope's contract type; the
installed schemas are exactly the source set, byte for byte, one per envelope version and resolvable through the
exports map (zero schemas fails); the package's valid fixtures validate through the installed package and a changed
version is refused; `engines.node` is a floor this Node meets and no `workspace:` specifier leaks; and neither `farsight-cli` nor
any `@farsight/*` package is installed with it. The job fails, rather than skips, when the Sentinel manifest is
missing. No scanner, container, model or provider is started; npm fetches only declared third-party
dependencies. Both packers build in a staging directory under `build/` and replace only their own outputs
(`build/farsight-cli*`, `build/sentinel/`) after the bundle and the tarball succeed: a missing compiled module
anywhere in the closure fails the pack with every prior artifact, and other packages' outputs, left in place.
`node scripts/pack.mjs --check` runs the preflight and the full staged bundle and replaces nothing.
Sentinel's fast schema tests are its package `test` script, so they run in `validate` with every other package.
The package hook also runs the installed SDK control consumer: adopted grants, real owner CLI confirmation,
same-run pause/resume/cancel and lost accepted response followed by status without replay. The native service list
includes its genuine SDK control tests and retains the zero-skip guard.
Container and kill-matrix suites are explicit opt-ins with named skip reasons: without `SENTINEL_ISOLATION=1` only the
real-container cases skip, and the fake-worker protocol tests still run. The isolation qualification is exact host,
runtime and server triples (`ISOLATION_POLICY` in `packages/sentinel/src/execution/isolation.ts`): darwin-arm64 with
Docker Desktop and linux-x64 with Docker Engine are measured. The Linux qualification ran on Node 24.21.0,
Engine 28.0.4, Ubuntu 24.04.5 LTS and cgroup v2: [82 tests passed with zero skips](https://github.com/zalos/farsight/actions/runs/39728679640/job/119658477459). `sentinel-package` becomes a required
check once it has passed on `main` (an owner branch-protection change); until then it is reported but not required.

The **sentinel-iac-qualification** workflow (not required) qualifies the infrastructure and CI adapters on a native
Linux/amd64 runner (ADRs 33 and 34). It runs on a pull request that changes the Trivy or zizmor adapter, its fixtures, the execution service or the
workflow, and by hand. Its provisioning step pulls each pinned image index, checks its linux/amd64 manifest, and acquires
the pinned checks bundle with `packages/sentinel/scripts/acquire-trivy-checks.mjs` (the only network steps). The unit and
real-engine suites must pass with zero skips; the packed tarball's shipped workers must run; no container may be left.

The **secrets** job runs gitleaks over the pushed or PR commits with `.gitleaks.toml`. A finding fails the job and uploads a SARIF artifact; it posts no PR comment. What it checks, and
how to allowlist a value you have checked: [SECURITY.md](SECURITY.md#the-scan-in-ci).

## Run the same thing locally

Choose checks from the table above for local work too: ordinary Markdown edits do not need a build, unit tests or
e2e. For changes to CI selection, run `pnpm test:scripts` and `actionlint`; the workflow change itself selects all
checks on GitHub. Keep local validation focused on the affected behavior instead of rerunning unrelated suites.

The offline report browser test is explicitly selected with `SENTINEL_REPORT_BROWSER=1`; `CI=true` alone does not require a browser in the unit-test job. The e2e job runs it after provisioning Chromium whenever application e2e or Sentinel isolation checks are selected, and fails on a missing browser, failure, or skipped case.

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
pnpm test:cli:package                   # farsight-cli from its closure alone, in a clean npm consumer
pnpm test:cli:package:absent            # the same with packages/sentinel removed from a temporary workspace copy
pnpm test:sentinel:package              # farsight-sentinel, separately, in a clean npm consumer
docker pull node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9   # once: the canary image
(cd packages/sentinel && SENTINEL_ISOLATION=1 node --disable-warning=ExperimentalWarning --experimental-strip-types \
  --test test/execution-isolation.test.ts test/execution-protocol.test.ts test/execution-container-faults.test.ts test/execution-framing-budget.test.ts)   # real-container canaries
(cd packages/sentinel && SENTINEL_RECOVERY_SMOKE=1 node --disable-warning=ExperimentalWarning --experimental-strip-types \
  --test test/execution-recovery-kill.test.ts)   # one kill per boundary; SENTINEL_RECOVERY_FULL=1 for 20 each
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

## Opt-in: pattern adapter qualification on Linux/amd64

`.github/workflows/sentinel-pattern-qualification.yml` runs on a pull request that changes the pattern adapter, its
rules, the execution service or the workflow itself, and by hand (`gh workflow run sentinel-pattern-qualification.yml
--ref <branch>`, once it is on the default branch), on a native `ubuntu-24.04` amd64 runner. It is not a required check. Its one network step
provisions the pinned Semgrep index and checks that the index lists the linux/amd64 manifest the adapter records; the
scans then run through PR 07's isolation with `--pull never` and no network. It runs the pattern unit tests, the
real-engine conformance suite (original corpus, timeouts, output bounds, omissions, scrubbed diagnostics) with
`SENTINEL_PATTERN_QUALIFY=linux/amd64`, so results are accepted as candidate rather than refused, and the packed
tarball's shipped pattern assets; any skipped, failed or cancelled test fails it, and so does a container left behind or a
daemon that cannot be asked. A green run is the evidence for marking
linux/amd64 measured in `src/adapters/pattern/adapter.ts`; the workflow changes nothing itself.

## Qualification: OSV advisory adapter on Linux/amd64

`.github/workflows/sentinel-osv-qualification.yml` runs on a pull request that changes the OSV adapter, its fixtures, the
execution service, the packing scripts or the workflow itself, and by hand once it is on the default branch, on a native
`ubuntu-24.04` amd64 runner. It is not a required check. Its one network step provisions the pinned OSV-Scanner index and
checks the linux/amd64 manifest the adapter records; scans run through PR 07's isolation with `--pull never`, no network
and synthetic advisory snapshots built from the original fixtures. It runs the OSV unit and real-engine conformance
suites with `SENTINEL_OSV_QUALIFY=linux/amd64` (results accepted as candidate, not refused) and the packed tarball's
shipped worker; any skipped, failed or cancelled test, a container left behind or a daemon that cannot be asked fails it.
A green run is the evidence for marking linux/amd64 measured in `src/adapters/osv/adapter.ts` (ADR 29).

The individual Pattern, OSV and IaC qualification jobs select their own installed workers with
`SENTINEL_PACKAGE_ENGINE=pattern|osv|iac`; all four asset manifests and their exact bytes are still checked. A local package smoke
with `SENTINEL_ISOLATION=1` and no selector executes all four workers. Each native job must observe its own worker
success marker, so a missing or failed selected engine cannot pass as an asset-only check.

## Read-only MCP verification

The read-only MCP slice (ADR 48) runs its genuine owner-store/socket/budget controls in the service job's explicit
zero-skip list. Ordinary `test:sentinel:package` also installs the tarball with npm and drives the real SDK through
preview and framework reports, source-removed selected replay, reconnect and restart expiry. The native scanner
job additionally selects `service-readonly-native.test.ts` and the installed MCP consumer with native opt-in:
current/baseline/selected secret withholding uses the already provisioned pinned Gitleaks image. Native missing
assets fail; ordinary validation explicitly skips those two native controls. SARIF consumer rerendering from
canonical-key-sorted parsed JSON compares semantic values; exact delivered format hashes are always checked,
and the genuine same-evaluation held-service tests compare all four legacy rendering bytes exactly.

The read-only lifetime controls spawn a real detached owner with the production 15-second idle policy; private
test-process clocks advance over view/delivery absolute expiry without changing a production limit or adding a
public clock input. They prove retained buffers survive the idle cutoff, then expire and release the held store
even with an open idle MCP socket. The installed SDK consumer asserts exact SDK/zod versions, status-only request
shape and retryable inspection contention.

## Isolation failure observations

The ordinary `sentinel-isolation` job retains bounded optional observations alongside its unchanged seven-file
native command, default concurrency and strict assertions. Forwarding controls and an actual-runner journal-argv
preflight run first. `runner-provenance.json` records the commit, runner ImageOS/ImageVersion, kernel and Docker
client/server components (including containerd and runc). Missing provenance or an unsupported journal option
fails that preflight visibly. A red preflight is an observation-infrastructure failure, not a native isolation
result: preserve it and correct the probe in a reviewed new commit, never an unchanged failed-job retry.
The always-run artifact upload retains traces and both TAP files for three days;
upload failure is visible. No privileged monitor, new image or production termination inference is added.

Each trace covers only its exact owned container and bounded time window. It records command/attached-client
ordering, raw daemon inspection before any delayed-OOM mask, exact child cgroup identity/counters where readable,
and filtered unprivileged journal results. Journal `matched`, `no-match-visible` and `unavailable` are separate;
all remain limited by the runner account's visibility. Exact-ID filtering can omit relevant records. An increase
in a persistent daemon-parent cgroup counter cannot attribute a concurrent kill to the child. Dropped records,
expired windows and unavailable sensors remain explicit; without an exact child window, its cause stays unknown.
Traces are diagnostic evidence, not scanner results. The observer adds work and changes timing; its merge is
the comparison boundary, so observed pass/failure rates are not directly comparable with earlier runs.

On recurrence, preserve the original failing TAP and artifact before cleanup/expiry. Compare client kill requests
with actual client exit and daemon events, and exact child cgroup observations with terminal daemon state. A kill
request after reaping is not an actual signal. Exit 137, fixture wording, parent counters or no visible journal
matches never prove OOM. If child counters and daemon state disagree, record that discrepancy without changing the
production conservative result or native assertion. A passing run does not explain a historical failure. Do not
blindly rerun a failed gate or claim release clearance; retain the unresolved cause for an explicit owner decision.

## Owner report-import verification

The normal installed Sentinel package gate also runs `scripts/test-sentinel-evidence-consumer.mjs`. It snapshots
the input tarball, freshly compiles the private Sentinel modules, repacks and requires an identical artifact digest
before installing the original snapshot with npm. Provenance mismatch retains the private input for diagnosis.
Actual installed commands cover preview, stale confirmation, acceptance, source-removed read/list, Markdown,
busy-owner refusal and natural release, interrupted predecessor transfer and explicit abandonment.

The deterministic interruption is a separately identified matching built-private after-stage hold followed by a
real SIGKILL; it is not an installed CLI crash qualification. The public transfer/abandon actions still use the
unmodified installed package. The native scanner job additionally selects `evidence-privacy.test.ts` with zero
skips and requires the installed consumer's genuine current/baseline/selected secret-privacy result. Existing MCP,
framework, scanner, observer and full recovery gates remain selected.
