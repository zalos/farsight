# Sentinel v2 — the proposal, phase 0 and the thin slice

Archived from `docs/AI-HANDOFF.md` on 2026-10-28 (2026-10-23 → 10-28). Dated records, verbatim apart from
re-pointed relative links; read on demand, never loaded at session start. Index: [README.md](README.md).

## Sentinel v2 thin slice and the demo build — 2026-10-28

Merged today, in order: #227 put SCANS · PIPELINE · STAGE in the viewer; #237 gave one `scan` command the
`SentinelService` facade and a composite `run.start` receipt; #243 fixed the load-dependent preparation-clock test
at the boundary; #241 moved store, snapshot, rules and policy onto the kernel; #244 added [DEMO.md](../DEMO.md);
#238 made the CI selector load modules by literal paths. #245 re-landed the stage editor on `main`: #239 had been
squashed into #237's branch by mistake and reverted there.

#242 added migration 7 and the store side of private artifact retention for a failed attempt, with no coordinator
write yet. #246 retired the owner-ui companion page: the view is the owner surface, `farsight serve` prints
`127.0.0.1`, the companion lookup names the paired origin, and `owner-ui` waits up to 30 s for the service.

#249 added the walk-free, no-Docker `review` profile. After the owner's `paid.admit` receipt, it makes one Copilot
general review of captured source with `hostedReviewSecretScan: when-selected`; the README and `init` say plainly
that the source reaches the model without a secrets scan. `checkPipeline` refuses an input no planned unit produces
(`sentinel.pipeline.inputUnproduced`); bootstrap outputs resolve through reused work's ledger dependencies. The
preview names each declared stage's model or says *not configured*; only `scan --confirm` admits the model.

#250 added DEMO.md §4b and verified that profile live from a fresh clone: `scan` exited 4, `scan --confirm` exited 2
in about 35 s, and the report named `copilot-cli brokered · model gpt-6-luna · 3 turns · … · cost unobserved ·
subscription`. In #250's observed live demo runs, the review ended unfinished at the 3-turn cap with zero
observations; the report says so. The owner paused the Docker agentic route (V-3). The demo is the CLI and this
no-Docker review path on another Mac, following DEMO.md with Node 24, pnpm 9 or npm 10, git-lfs and a logged-in
Copilot CLI 1.0.105.

#251 made build and pack work with npm as well as pnpm: root `workspaces`, 37 internal dependencies on
npm-compatible ranges, `link-workspace-packages=true`, `scripts/workspace-run.mjs` and the `npm-build` CI job.
All 1,896 dist files were byte-identical under pnpm; Sentinel's npm source tests still hit #200.

Open after the demo: #248 (native observations and provenance in the report and the unfinished-review progress
line) and #252 (brokered cost basis, a private 0600 budget ledger, failed-native-attempt retention and the
missing-login cause) are in flight. PA's second PR is local and unopened: `run.rerun`, the option-A flip, explicit
`init` grant effects that re-record three golden digests, the local `ollama` runner and `adoptPipeline` refusing
non-CLI receipts. Still open are the capabilities PR (`capabilities --models` for 1.0.105 and Claude native), the
declared host-script stage through `scan` with `<output>.schema.json` in its pack, P-3b reuse of retained checks on
rerun, and a durable pre-attempt refusal reason using a closed structured set at the store boundary. The fixed
`preparation-admission` and `preparation-publication-crash` cases may stay in `serial-suite.txt`. Dependabot
#236/#195 (zod 3→4) awaits the owner's call.

Before every merge, check `gh pr view <n> --json baseRefName` is `main`: a stacked PR can squash into its parent.
Never run bare `pnpm install` in a worktree; use `--ignore-scripts` there, then run `pnpm install` in the primary
checkout after merge to restore the shared lefthook path. The preparation-clock race was load-dependent, not a code
regression.

## Phase 0 complete — 2026-10-27

#208 `cdf7ab9e`: formatted code-parser and mcp (37 JS/TS files); AST-identical, with identical real-ingest node and edge sets.
#209 `49951fc7`: cleared Sentinel's suppressions — 129 fixed, 17 reasoned disables.
#210 `00683efa`: cleared non-Sentinel suppressions — 142 fixed, 24 reasoned disables.
Seven suppressions remain in five sha256-pinned feasibility files; their measured bytes stay unchanged to preserve retained evidence.
`eslint-suppressions.json` now holds only those seven; #210's ingest delta is two unused viewer helpers, two call edges and 17 inferred coverage edges from an unused `preview` import (both builds agree on the same source).
Every eligible JS/TS area is formatted; permanent exclusions are listed in `.prettierignore`.
PR #121 must be reapplied onto the formatted main rather than merged, with `prettier --write` on its files.
Intermittent CI tests seen in phase 0:

- `sentinel-service`: snapshot-rollback clock test on main's `b32b70e5` run.
- `e2e`: Map lanes sizing with a NaN font / zoom ×0.97 on #208's first run.
- `e2e`: pinch zoom at `map-zoom.pw.spec.ts:149`; failed on main in all three isolated runs.
- `e2e`: owner-UI browser gate `/confirm` timed out after 30 s on #210's rebased run.
- `sentinel-isolation`: OOM witness (#184).
- MCP-controls package consumer: local timeout / `controlOutcomeUnknown` on #209; not reproduced.
- `validate`: `packages/sentinel/test/preparation-publication-crash.test.ts:57` service-readiness retry limit (`i < 200`) before the SIGKILL checkpoint, seen on #211's first run.

## Phase 0 hygiene landed — 2026-10-27

#199 tooling `b1bca9f9`, #202 gitleaks allowlist `136600b9` and #201 Sentinel formatting `b1439457` landed;
#204 scripts formatting `9d108e34`, #205 string lint `35c12add` and #206 packages formatting `b32b70e5` complete hygiene.
The style PRs proved unchanged JS/TS ASTs and comments: Sentinel 563 files, scripts 70, remaining packages 447.
Sentinel's five worker digests stayed identical; scripts retained all 240 evidence sha256 pins and the feasibility harness.
Sentinel source grew 51,875 → 87,305 lines; scripts 10,170 → 18,166; remaining eligible areas 122,057 → 175,473.
Build, types, unit tests, schemas, package checks, catalog lint and final CI passed; 319 ESLint suppressions remain frozen.
`lint` is the seventh required check. Linked worktrees share one hooks directory; keep the installed hook path lasting.
After pulling into an existing worktree, run `pnpm install --config.confirm-modules-purge=false` once.
A branch without `lefthook.yml` relies on CI's `commits` check until rebased; never commit on main from such a worktree.
`packages/code-parser` and `packages/mcp` stay unformatted until PR #121; its new test file needs `prettier --write` before `format:check`.
Open follow-ups: #200 fixes Sentinel's ESLint/uri-js closure refusal; #203 makes test-file import detection independent of layout.
The three style squash commits are in `.git-blame-ignore-revs`; hook installation sets `blame.ignoreRevsFile` when it exists.

## Sentinel v2 P0-1 tooling — 2026-10-26

Branch `build/prettier-eslint-lefthook` adds pinned Prettier/ESLint/lefthook, frozen lint suppressions, the CI lint
job, the proposal's unchanged AST checker and planted tests, hook migration and contributor guidance. No product
code or CI selector changed. `.npmrc` excludes only `uri-js` from shared pnpm hoisting: ESLint's Ajv retains its own
dependency, while fast-uri's unrelated benchmark import stays outside Sentinel's pinned runtime closure.
Node 24/pnpm 9 build and package typechecks (14 each), formatting/lint/catalog/actionlint, 244 script tests and 38
unchanged Sentinel closure/preparation cases passed. Workspace tests passed 3,380 cases with 161 gated skips and zero failures.
Shared LFS hook hashes are unchanged; branch commits pass and a bad subject was rejected after formatting/re-staging.
The lead owns making `lint` required after its first green CI run. Code formatting and frozen lint debt remain later work.
Review follow-up documents silent hook skips on older branches, the lasting-path install after merge and the one-time
pnpm purge flag for existing worktrees. Root formatting ignores are anchored; Claude scripts now have Node globals,
leaving 319 suppressions across 179 files. Formatting/lint and all 244 script tests passed again. The collector fix is
tracked in [#200](https://github.com/zalos/farsight/issues/200); npm with ESLint 8/9 remains an unverified case.

## Sentinel v2 proposal — 2026-10-23

The owner reviewed the closeout and the shipped Sentinel and found three problems: the UI is bottom-up (a companion
page in an iframe organised around coordinator objects), nothing is configurable (stages derived from promoted rules,
no host scripts, no typed stage-to-stage inputs, prompt bundled, one model binding per run), and the code is scattered
and dense (18 of 20 folders in one import cycle, 14.8 % of files minified-style, no formatter or linter). Four read-only
audits on `e85e2382` (architecture, UX, execution model, tooling) ground the new direction in
[docs/proposals/sentinel-v2/README.md](../proposals/sentinel-v2/README.md): a declared pipeline of `builtin · tool · script ·
agent` stages with typed inputs and outputs in `.farsight/sentinel/pipeline.json`, two agent modes (brokered, native)
over Claude CLI and Copilot CLI with hosted APIs behind a flag, a five-stop top-down surface (SCANS · PIPELINE · STAGE ·
ENTRY POINTS · PATH) in the viewer shell, and an eight-layer architecture behind a `SentinelService` facade. Six mocks
are in `proposals/sentinel-v2/mocks/` (rendered from the invoice-app example; `node docs/proposals/sentinel-v2/mocks/build.mjs`
re-renders them). The work breakdown is [tasks.md](../proposals/sentinel-v2/tasks.md): phase 0 formats and lints the repo
with no functional change (Prettier 3.9.10 at 120 columns, ESLint 10 flat config with frozen suppressions, lefthook 2.2.2
with no LFS hook names and `no_auto_install`, a CI `lint` job, an AST-equivalence proof in
[tooling.md](../proposals/sentinel-v2/tooling.md)), then the carve (phase 1), the declared pipeline (2), the surface (3),
the runners (4), the deferred release (5). Nine owner decisions are listed at the end of tasks.md; none of the phases
has started. Branch `docs/sentinel-v2-plan` in `../farsight-wt/sentinel-v2-plan`; documentation only, no build, test,
ingest or server change; the primary checkout is untouched.
