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

The seven required check names are **affected checks · lint · validate · e2e · echo-package · secrets · commits**.
Branch protection requires them from GitHub Actions, requires the branch to be up to date, and applies to admins.
A small `changes` job (displayed as **affected checks**) tests and runs
`scripts/ci-changes.mjs`, then the affected runtime jobs run in parallel on `ubuntu-latest`. No dependency install
or browser download is needed to select checks. The selection appears in the run summary. Build jobs use Node
from `.nvmrc` (24) and pnpm from `packageManager` (9.0.0), with the pnpm store cached on the lockfile.

| job | steps | timeout |
|---|---|---|
| **affected checks** | test `scripts/ci-changes.mjs` and select suites from the changed paths | 2 min |
| **lint** | `pnpm install --frozen-lockfile` → `pnpm format:check` → `pnpm lint`; a PR whose title starts with `style` also compares JS/TS ASTs against its merge base | 3 min |
| **validate** | `pnpm install --frozen-lockfile` → `pnpm build` (`tsc -p` type-checks each package with the config `typecheck` uses, so there is no separate typecheck step) → the graph contract check → the unit tests of the packages the change reaches (below; every package when the selector says so), Sentinel's unit suite only (`SENTINEL_TEST_SUITE=unit`, its no-skip files with zero skips and the launch rule, `SENTINEL_TEST_LAUNCHES=1`; its process suite is sentinel-service's) → `pnpm test:scripts` → `pnpm lint:strings`; includes Echo's unit tests when Echo is reached | 9 min |
| **e2e** | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm e2e:typecheck` → chromium (cached in `~/.cache/ms-playwright`, keyed on the `@playwright/test` version) → the Sentinel browser steps (the paired owner UI journey, the installed owner browser workflow, offline report and retained structural HTML delivery and print, each exactly one case with zero skips) when sentinel-package runs or validate tests Sentinel, else skipped → `pnpm e2e` → `pnpm e2e:perf` on the small preset (`FARSIGHT_PERF_PRESET=small`; the table is the `e2e-perf-results` artifact) | 11 min |
| **secrets** | gitleaks over the pushed or PR commits (below) | 10 min |
| **commits** | pull requests only: `scripts/lint-commits.mjs --message "$PR_TITLE"` (the title becomes the squash commit on `main` — type and scope must be on the lists) and `--range base..head --any-scope` (every branch commit has the conventional shape) | 5 min |
| **parser-package (Linux/macOS)** (non-required) | parser package/workflow/dependency changes: actual tarballs installed outside the workspace, public types, native/WASM parsing, saved-graph query | 15 min |
| **echo-package** | when relevant, `pnpm install --frozen-lockfile` → `pnpm test:echo:package` | 5 min |
| **sentinel-isolation** (not yet required) | when relevant, `pnpm install --frozen-lockfile` → `docker pull` of the one pinned canary image by digest (provisioning; the code under test never pulls) → `pnpm --filter '@farsight/sentinel...' build` → `SENTINEL_ISOLATION=1` worker-protocol and real-container canaries (network, host-file, effective identity, memory, CPU, process, file-size and temporary-storage enforcement, malformed output, deadline, cancel, failed start, ambiguous-create reconciliation, cleanup ownership) and real-container crash recovery (a coordinator killed after a create whose reply is lost, before a create whose container appears late, while canceling, and within one epoch after a create without a confirmed answer), one repetition each as smoke; the pinned Gitleaks image (`docker pull` by digest) for its conformance suite and the public CLI's canonical secret scan (`test/gitleaks-cli.test.ts`), then the packed tarball installed by npm alone runs the same scan (`scripts/test-sentinel-secrets-consumer.mjs`). A missing or unqualified container runtime fails it, and so does any skipped test | 5 min |
| **sentinel-recovery** (not yet required) | when relevant, `pnpm install --frozen-lockfile` → `pnpm --filter '@farsight/sentinel...' build` → `SENTINEL_RECOVERY_SMOKE=1`: one real SIGKILL of a coordinator process at each boundary (before a worker is started, after it is started, after its attempt is recorded, before staging, after staging, after the objects, after publication) one orphaned worker and one worker whose coordinator died before its start (it must exit on its own at end of stdin, having written nothing), each recovered by a fresh process with every output accepted exactly once, plus the in-process coordinator suite. A missing prerequisite fails it, and so does any skipped test. The 20-repetition matrix is the separate **sentinel-recovery-full** workflow (`SENTINEL_RECOVERY_FULL=1`): every process boundary, then the four real-container crash cases 20 times each (with the pinned canary image and `SENTINEL_ISOLATION=1`), with no owned container left and two unrelated containers untouched; a release gate run by hand and on every push to `release/**` | 3 min |
| **sentinel-service** (not yet required) | whenever validate tests Sentinel (the selector's `service` output), `pnpm install --frozen-lockfile` → `pnpm --filter '@farsight/sentinel...' build` → Sentinel's process suite, the test files that start a Node.js process or a package manager (the CLI, the detached owner service, workers, scripts, a packed tarball) listed in `packages/sentinel/test/process-suite.txt` (`scripts/sentinel-tests.mjs --suite process`, its serial files first at concurrency 1, zero skips over the summed summary), on native amd64 as the runner's non-root user under umask 022. Running as root, on another architecture, or any skipped test fails it | 18 min |
| **sentinel-package** (not yet required) | when relevant, `pnpm install --frozen-lockfile` → `pnpm pack:cli` (builds only the CLI's closure, so Sentinel stays unbuilt; the job fails if `packages/sentinel/dist` exists) → `scripts/test-farsight-package.mjs` → `pnpm test:cli:package:absent` → `pnpm pack:sentinel` → `scripts/test-sentinel-consumers.mjs --jobs 3 --acceptance`: Sentinel's eight clean npm-only consumers (below) three at a time, each installing a private copy of the tarball, and beside them the npm-only acceptance of both tarballs (`scripts/npm-acceptance.mjs`, six clean consumers); every line is prefixed with its consumer and a per-consumer time summary ends the step | 9 min |

### Job budgets

Every job has a time budget: a target, and a `timeout-minutes` of 1.5 × the target, rounded up, so a regression turns
the check red instead of slowing every PR. `scripts/test/ci-budgets.test.mjs` fails if a job's timeout and its row
here disagree, or if a row's timeout is not 1.5 × its target. When a job's measured time crosses its target,
re-measure it and either fix the cause or move the budget in the same PR, with the run ids that measured it.
Measured times are the job's own run time, not queueing; the run ids are GitHub Actions runs of `zalos/farsight`
(main 40628220866–40649483163 are the five pushes 40628220866, 40629680573, 40635638060, 40639064981 and 40649483163).

| job | measured | target (min) | timeout (min) |
|---|---|---:|---:|
| affected checks | 9 to 24 s (main 40628220866, 40629680573, 40635638060, 40639064981, 40649483163) | 1 | 2 |
| secrets | 9 to 13 s (main 40628220866–40649483163); its job is left as it was by ruling, budget unchanged | — | 10 |
| lint | 64 to 96 s (main 40628220866–40649483163) | 2 | 3 |
| validate | 265 to 292 s testing every package after the process split (#225: 40635438642, 40649566118); 632 to 974 s before it (main 40628220866–40649483163) | 6 | 9 |
| echo-package | 46 to 60 s (main 40628220866–40649483163); it downloads the iii engine, so the target leaves room | 3 | 5 |
| sentinel-package | 432 to 680 s with the consumers in one chain (main 40628220866–40649483163); this budget assumes them three at a time | 6 | 9 |
| sentinel-isolation | 105 to 137 s (main 40628220866–40649483163) | 3 | 5 |
| sentinel-recovery | 45 to 77 s (main 40628220866–40649483163) | 2 | 3 |
| sentinel-service | 249 to 313 s with 32 files (main 40628220866–40649483163); 436 s with 83 (40635438642); **824 s with 86 and the serial files (40649566118), over its target**: the serial group alone took 114 s, and L-CLEAN-B's deterministic-checkpoint fix returns those files to the parallel run | 12 | 18 |
| e2e | 291 to 418 s (main 40628220866–40649483163) | 7 | 11 |
| scanner CLI affected checks | 9 to 14 s (40649966640, 40649979787, 40650194599, 40651233871, 40651344718) | 1 | 2 |
| scanner-cli-linux-amd64 | 1,011 to 1,252 s (40649966640–40651344718) | 20 | 30 |

### Native installed scanner CLI acceptance

The separate `sentinel-scanner-cli` workflow runs on pull requests and pushes to `main`, with manual dispatch too.
Its inexpensive selection job runs the selector's `scannerCli` output, the scanner closure, derived from what the
workflow's steps execute rather than listed (`scannerCliClosure()` in `scripts/ci-changes.mjs`). Its entries are the
files the steps name: the test files the native job runs, the scripts (the consumers, the browser check, the Trivy
checks acquisition), the packer behind `pnpm pack:sentinel`, and the package's command, which the installed consumers
run. From those it follows every import, export, dynamic import, `require` and `import.meta` file reference,
workspace packages and the published `farsight-sentinel` name through their `exports`, and compiled `dist/` paths
named as strings (the workers, launch gate and drivers), each mapped to its source: about 580 files today. A change
reaches the workflow when it is one of those files or lies in a folder a reached test reads whole (the example
application the full-report tests ingest, the advisory and IaC fixtures); when it is test data a reached test or script
names; when it is another build input of a package the build step builds (its manifest or tsconfig, Sentinel's rules,
assets and scripts); or when it is a source path that no longer exists, deleted or renamed away, which the closure of
the tree as it is now cannot rule out. Agent review's dispatch, the review adapter and the owner UI operations are in
the closure: the scanner tests read the review adapters through `review/dispatch`, and the installed consumer starts
the owner service, which builds the owner UI operations. What no step runs or imports stays out: agent review's
evaluation and owner provider, test files the workflow does not run and the fixtures only they read, another package's
tests, the viewer, server, CLI, Echo and work. Documentation-only changes skip the acceptance job; every path that
selects every check selects it; an unavailable range, unreadable workflow, failed selector or missing output cannot
silently skip it. The closure is wider than the five folders the plan named (and reaches `examples/invoice-app`)
because this workflow is the only place the native secret-privacy tests of reports, findings, evidence, decisions,
paths, preparation and frameworks run.

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

`lint` runs whenever validate, e2e, Echo packaging, Sentinel packaging or isolation is selected (missing outputs run
it too); a documentation-only change skips it. Prettier checks JS/TS only, with existing areas temporarily listed in
`.prettierignore`. ESLint freezes existing error counts per file and rule in `eslint-suppressions.json`; it rejects
new errors, while `pnpm lint:report` also shows structure warnings. After deliberately fixing old errors, run
`pnpm lint --prune-suppressions`. Sentinel's layer rule (`boundaries/dependencies`, imports point down only) is one
of those errors: its known upward imports are frozen there too, so `pnpm lint:boundaries` prints them without the
suppressions, and `packages/sentinel/test/import-matrix.test.ts` holds their exact set. A formatting-only PR uses `pnpm verify:format -- <merge-base> <head>` and the
per-PR checklist in [CONTRIBUTING.md](../CONTRIBUTING.md).

These are deliberately broad suite boundaries, not an inferred per-test dependency graph. Mixed changes take the
union of the matching checks. Secrets and PR commit conventions always run, including for documentation.

| changed paths | runtime checks |
|---|---|
| Root Markdown, Markdown under `docs/`, `.github/`, `.claude/` or `.agents/` (outside `skills/`), or `LICENSE` | none, except the packaged Echo docs below |
| `.claude/skills/` or `.agents/skills/` (the two trees must be identical) | `validate` — `scripts/check-skills-mirror.mjs` through `pnpm test:scripts` |
| `docs/ECHO.md`, `packages/echo/README.md`, Echo packaging scripts or example connection/settings | `echo-package` |
| `packages/sentinel/README.md`, `scripts/test-sentinel-package.mjs` | `sentinel-package` |
| `scripts/pack-sentinel.mjs` | `sentinel-package` + `validate` (Sentinel's review-package unit test packs the tarball) |
| `scripts/npm-acceptance.mjs` | `validate` (script tests) + `sentinel-package` (packed tarball acceptance) |
| `packages/sentinel/` outside `test/` | `validate` + `sentinel-package` + `sentinel-service` + `sentinel-isolation` + `sentinel-recovery` + `e2e` (the e2e job also runs the offline report browser gate) |
| `packages/sentinel/test/` | `validate` + `sentinel-service` + `sentinel-isolation` + `sentinel-recovery` + `e2e` (offline report browser gate) |
| `e2e/`, `scripts/e2e.mjs`, `scripts/e2e-perf.mjs` | `e2e` (including its typecheck and small perf suite) |
| `scripts/synth-graph.mjs` | `e2e` + `validate` (the server's search and fold tests import the synthetic workspace) |
| Package `test/` folders, `scripts/test/`, changelog/release/release-manifest/verify-release/hook-install/commit-lint scripts | `validate` |
| Package code/assets, `examples/`, `schemas/` | `validate` + `e2e`; graph, core and Echo changes also select `echo-package`; changes to a package in `farsight-cli`'s workspace dependency closure (cli, server, mcp, parsers, code-parser, core, graph, work and the work providers today, read from the manifests by `scripts/ci-changes.mjs`), Sentinel's own closure, or `examples/invoice-app/` also select `sentinel-package`; Sentinel's own closure (read from the manifests) also selects `sentinel-isolation` and `sentinel-recovery`; unreadable manifests select all |
| Everything else, including dependencies, build config, workflows, the selector itself and the shared packaging scripts (`pack.mjs`, `pack-preflight.mjs`, `npm-consumer.mjs`, `test-farsight-package.mjs`, `test-farsight-package-absent.mjs`) | all |

### Which packages validate tests

`validate` runs the unit tests of the packages the change reaches, not of every package. The selector works the set
out and emits it as `testScope=packages` and `testPackages` (space-separated names); validate's test step,
`node scripts/ci-changes.mjs --run-tests`, runs `pnpm -r --filter <name> … test` with one `--filter` per name. The set
is every package with a changed path, every package that depends on one (read from the manifests, all four
dependency fields) and the packages whose tests read one of those without depending on it. A viewer change tests
the server, the CLI and the MCP server; a Sentinel change tests Sentinel alone; a core change tests core and the
eleven packages built on it.

The selector is the only place the set is worked out, so it is read from the same `--no-renames` diff as the check
selection: a file moved out of a package counts on both sides and still tests that package. (pnpm's own
`--filter "...[<commit>]"` diffs with git's rename detection, sees only the destination, and is not used.)

pnpm cannot see a test that reads another package's files without depending on it: core's ask corpus and
Sentinel's report tests ingest through `packages/parsers/dist`, and the MCP and server tests spawn the CLI. The
selector reads every package's `test/` folder for such references (`packages/<dir>/dist`, `../../<dir>/dist`,
`join(here, '..', '..', '<dir>', 'dist')`, for `dist`, `src`, `test`, `public` and `bin`; whole-line comments do not
count) and adds the readers of a selected package alone, because their own code did not change. A reference that
runs only outside validate is listed in `OUTSIDE_VALIDATE` in `scripts/ci-changes.mjs` with the gate that keeps it
out (the owner UI browser journey reads the CLI only under `SENTINEL_OWNER_UI_BROWSER=1`, which the e2e job sets);
the selector test fails if the file loses that gate. The run summary names the set, and the test step prints the
exact pnpm command.

Every package is tested (`testScope=all`) when a path that selects validate lies outside a workspace package (root
files, the lockfile, `scripts/`, `schemas/`, `examples/`, workflows and the selector itself), when a path is under
`packages/` without a manifest, and when the manifests or a test folder cannot be read. The test step also tests
every package when `testScope` is missing or unknown, or is `packages` with a missing or empty `testPackages`. The
skills trees, which only the script tests read, select no package: the selector says so explicitly with
`testScope=none`, the step runs no package's tests and `pnpm test:scripts` still runs. The required check names do
not change.

The outputs carry only strict values: each check `true` or `false`, a scope from `all`, `packages` and `none`, and
names of the shape `@farsight/<lowercase-name>`. A workspace package named otherwise selects every check, and an
output that fails these rules is written as every check and every package, so no value can add an output record.
The test step refuses a name that is not a workspace package rather than pass pnpm a filter that matches nothing.

`sentinel-service` runs exactly when validate tests Sentinel, because it runs the part of Sentinel's tests validate
leaves out: when every package is tested (`scripts/`, `schemas/`, `examples/` and every path that runs every check),
and for Sentinel's own paths, its workspace closure (code-parser, core, graph) and the parsers, whose dist its report
tests ingest. It does not run for a viewer, server, CLI, Echo or work change, nor for Sentinel's packaging files
alone.

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
Sentinel's tests are two suites (`scripts/sentinel-tests.mjs`). The process suite is the files
`packages/sentinel/test/process-suite.txt` lists: every test file that starts a Node.js process or a package
manager, from the test or from the code under test (the CLI, the detached owner service, workers, scripts, a packed
tarball); `sentinel-service` runs it with zero skips. The unit suite is every other `test/*.test.ts`, which validate
runs: files that run in one process or start only git and other system tools, the 22 Docker-gated files (their
container cases skip without `SENTINEL_ISOLATION=1`), and the files `packages/sentinel/test/unit-launchers.txt` names:
six that start Node.js processes but have cases that skip on CI by design, which the zero-skip service job cannot hold. Both suites run at
`--test-concurrency` equal to the machine's available parallelism. A listed file that does not exist, a duplicate or
a malformed line fails both suites before anything runs.

Inside the unit suite, the files `packages/sentinel/test/no-skip-suite.txt` lists must not skip either: the twelve
in-process files that were in sentinel-service's zero-skip list before the process suite was measured (the owner UI
session, host, descriptor, model-start and process files, the preparation admission, receipt admission, journal and
profile files, service policy, store read budget and the trusted profile). `--suite unit` runs them first as their
own group with a TAP report beside the spec output and fails if its summary shows a skipped or todo test, the same
check the service job makes with `grep -qx '# skipped 0'`; then it runs the rest, where Docker, browser and opt-in
skips are normal. `--suite no-skip` runs that group alone. A file cannot be on both lists.

Within every group, the files `packages/sentinel/test/serial-suite.txt` lists run first, one at a time
(`--test-concurrency=1`), then the rest at the configured concurrency; they keep their group's skip rule. Their cases
race the wall clock or a SIGKILL checkpoint (the ORIGINAL-clock crossing in preparation admission, the publication
crash checkpoints, owner deaths in public preparation, an actual wall expiry in capture, the detached service's kill
and resume), and core-count concurrency made those races fail on CI. A deterministic-checkpoint fix is queued (lane
L-CLEAN-B); files leave the list as it lands. Each run writes TAP beside the spec output, a run without a TAP summary
fails, and `--summary <file>` writes the summed `# tests`, `# pass`, `# fail`, `# cancelled`, `# skipped` and `# todo`
lines of every run: sentinel-service checks `# skipped 0`, `# fail 0` and `# cancelled 0` there, so the serial run and
the parallel run are both counted.

The list is measured and enforced: `--launches` (`SENTINEL_TEST_LAUNCHES=1` in validate, `--launches` in
sentinel-service) runs a suite with a preload that records every child process each test file's process starts, from
the test or the code under test, and prints the report. After a run that passed, it fails when a unit file started a
Node.js process or a package manager without being named in `unit-launchers.txt`, or a process-suite file started
none, so a new test that starts processes fails validate until it is listed in `process-suite.txt` (or, when its
launching cases skip on CI, in `unit-launchers.txt`). git and other system tools do not count.

Locally, `pnpm --filter @farsight/sentinel test` (and so `pnpm -r test`) runs both suites in one run; `test:unit`
and `test:process` run one each.
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

To run the unit tests validate would run for your branch's commits, with the same fallbacks (every package for a
`scripts/`-only change, nothing when validate is not selected):

```sh
BASE_SHA=$(git merge-base origin/main HEAD) HEAD_SHA=$(git rev-parse HEAD) GITHUB_EVENT_NAME=push \
  node scripts/ci-changes.mjs --run-tests
```

It prints the set and the pnpm command before running it, and counts committed changes only.

The offline report browser test is explicitly selected with `SENTINEL_REPORT_BROWSER=1`; `CI=true` alone does not require a browser in the unit-test job. The e2e job runs it after provisioning Chromium when the job runs and sentinel-package runs or validate tests Sentinel (the selector's `sentinel` or `service` output), as it does the other three Sentinel browser steps; an application e2e change alone, outside both, skips them. It fails on a missing browser, failure, or skipped case.

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

`node .claude/skills/e2e-playwright/scripts/check-e2e-setup.mjs` checks the e2e prerequisites before a run.
Set `CI=1` to get the runner's Playwright behaviour: `test.only` fails the run, and a failed test is retried once.

## Git hooks and existing installs

`pnpm lint:commits --message 'fix(cli): …'` tries a PR title against the `commits` job's rule. On branches with
`lefthook.yml`, `pnpm install` installs pre-commit's main-branch guard, formatting and lint, plus the commit-msg lint
(`scripts/install-hooks.mjs`). A branch without `lefthook.yml` silently skips these checks: lefthook exits 0 without
a warning. Such a branch relies on CI's `commits` check until it rebases. Never commit on main from a worktree whose
branch predates lefthook.

`scripts/install-hooks.mjs` sets `blame.ignoreRevsFile` to `.git-blame-ignore-revs` when that file exists.

Linked worktrees share one hooks directory. Installing from a worktree embeds that worktree's absolute lefthook
binary path in the shared hooks; removing the worktree breaks those hooks. After this PR merges, run `pnpm install`
once in the primary checkout so the hooks point at a lasting path. Keep `no_auto_install: true` so commits cannot
rewrite shared hooks. Never name Git LFS hooks (`pre-push`, `post-checkout`, `post-commit`, `post-merge`) in
`lefthook.yml`, and never pop a `lefthook auto backup` stash entry.

After pulling this change into an existing worktree, run `pnpm install --config.confirm-modules-purge=false` once.
The changed `.npmrc` hoist settings make pnpm 9 ask to purge `node_modules`; without a terminal, it can silently exit
0 without installing. The flag allows the purge and completes installation. CI's fresh install is unaffected.

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

## Retained structural-path verification

Ordinary installed package checks include `scripts/test-sentinel-paths-consumer.mjs`: actual owner preparation,
separate run confirmation, retained source-removed reports, selected rerun, required security gaps and strict
installed worker assets. The native scanner job also runs this consumer and selects `path-report-secrets.test.ts`
for real current/baseline/request-ancestor privacy with zero skips. The browser-provisioned e2e job explicitly runs
the one `path-report-browser.test.ts` case, requiring one pass and zero failures/skips, and retains its TAP report.
It reads and prints clean/withheld HTML offline with JavaScript disabled after the source/store are removed.
Neither structural completion nor its test count supplies security coverage or independently re-proves no path.


Owner decisions add `owner-decision-privacy.test.ts` to the native scanner job's explicit zero-skip list.
The ordinary package and native scanner jobs both run the npm-only `test-sentinel-decisions-consumer.mjs`;
the native job additionally requires its `nativePrivacy:true` outcome. The installed workflow covers actual
proposal/confirmation/read/list, source-removed all-format reports, supersession/expiry and natural owner-service
release. Native opt-in adds genuine current/baseline/selected Gitleaks privacy. Unit/native subprocess checks
cover separate crash boundaries; the installed workflow does not claim those timing windows.
