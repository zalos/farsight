# Sentinel v2 — work breakdown

Companion to [the plan](README.md). Every task is one PR unless marked otherwise, titled as a Conventional Commit, built
in its own worktree, validated with the affected checks from `docs/CI.md`. Sizes: **S** under a day, **M** one to three
days, **L** a week for one implementer. "Done when" is the acceptance the lead checks before merging; a green CI run is
not that evidence on its own. Phases are ordered; tasks inside a phase run in parallel unless `after` says otherwise.

Roles stay as the ledger has them: implementers in their own worktrees, an independent reviewer per PR, the lead owns
integration and the definition of done. Phase 0 is the exception: the lead runs it alone, because a reformat PR cannot
coexist with open feature branches.

## Phase 0 — hygiene, no functional change

<!-- PHASE0 -->

## Phase 1 — carve the kernel behind interfaces

Every phase-1 PR is a no-behaviour-change refactor: plan digests, invocation records and work/attempt ids on the fixtures
are byte-identical before and after, the real-ingest comparison against `main` is in the PR body, and the existing 227
test files pass unchanged apart from import paths that a re-export shim keeps working.

| id | task | size | after | done when |
|---|---|---|---|---|
| P1-1 | `chore(sentinel): dependency guardrails` — `eslint-plugin-boundaries` with the eight-layer map in report-only mode; the import matrix snapshotted as a test so a new upward edge fails | S | P0 | the current 18-folder cycle is listed as known debt; a new upward import fails the lint |
| P1-2 | `refactor(sentinel): kernel` — one `canonicalJson`, one sha256, one id and digest pattern, `deepFreeze`, `SentinelError`, framing codecs, under `kernel/`; the ~35 local sha helpers and 51 regex copies replaced by imports; the two `canonicalJson`s proven byte-identical on every fixture before one is deleted | M | P1-1 | zero local digest helpers left (lint rule); every retained artifact digest on the fixtures unchanged |
| P1-3 | `refactor(sentinel): contracts own validation` — `validate.ts` and `schemas.generated.ts` move under `contracts/`; its store and planner imports go to `kernel/` | S | P1-2 | the root ↔ everything cycle is gone from the matrix |
| P1-4 | `refactor(sentinel): move-only reshuffle` — the audit's M rows: `cli/outcome.ts` and `actor.ts` → `app/`; `service/mcp.ts` → `transport/mcp/`; `owner-ui/authority.ts`, `receipts.ts`, `descriptor.ts` → `policy/owner-ui/` and `store/`; `service/full-report.ts`, `inspection-report.ts`, `path-report.ts` → `reports/assemble/`; `publish-once.ts` → `store/journal/`; `adapters/*` → `stages/tool/*` with the test-only `run<Tool>Attempt` paths under `test/helpers/`; `review/*` → `stages/agent/`; `review/providers/*` → `providers/`; `analysis/paths/{driver,worker}` and `frameworks/controls/{driver,worker}` → `stages/script/`; re-export shims at every old path | L | P1-3 | `docs/MAP-PACKAGES.md` updated; no shim re-instantiates a registry; all tests pass; the matrix has no new upward edge |
| P1-5 | `refactor(sentinel): ExecutionBackend` — `superviseAttempt` delegates to `backends/{container, host-child, in-process, sandboxed-cli}`; isolation, processes, cgroup memory and the launch gate move behind them; no kind switch left in the supervisor | M | P1-4 | the native isolation and twenty-repetition recovery workflows pass unchanged; each backend has its own conformance test |
| P1-6 | `refactor(sentinel): StageRunner and ScannerPlugin` — one `StageRunner` contract replaces the two `CheckDriver` interfaces and the `canonical.ts` bridge; `builtin`, `tool`, `script`, `agent` runners wrap today's code; `ScannerPlugin` makes `productionDrivers`, `scanner-assets.ts`, `full-report.ts` and packaging iterate one list | L | P1-5 | `SCANNER_ADAPTERS`, `SHIPPED_CHECK_ADAPTERS` and the `'secrets-gitleaks'` literals are gone from service and report code; the installed five-scanner workflow passes |
| P1-7 | `refactor(sentinel): ModelProvider, AgentRunner and one sandboxed CLI runner` — the Claude and Copilot wrappers share `SandboxedCliRunner` (sandbox profile, proxy, process, usage file); the broker keeps admission, receipts, reservation and settlement; provider-kind switches collapse into the registry | M | P1-4 | the qualified Copilot profile's wire, sandbox profile and usage capture are byte-identical (the retained-wire test); the Claude adapter builds on the shared runner |
| P1-8 | `refactor(sentinel): SentinelService facade and Principal` — `LocalSentinelService` and `RemoteSentinelService`; `owner-service.ts` becomes an IPC op table; `cli.ts` becomes a command table; `owner-ui/operations.ts` and `process.ts` call the facade; ADR for the facade and the principal boundary | L | P1-6, P1-7 | no transport imports store or execution; an IPC caller cannot construct an `OwnerPrincipal` (test); the MCP controls consumer passes unchanged |
| P1-9 | `refactor(sentinel): LedgerExtension` — evidence, budget and decision repositories over generic ledger ports; migrations 1–6 byte-identical | M | P1-4 | `store/` imports no feature folder; the budget ledger reads through its repository |
| P1-10 | `refactor(sentinel): feature-flag registry and one state vocabulary` — `policy/features.ts`; work and attempt states use one closed set in the contract and the scheduler; the old booleans read as aliases | S | P1-8 | every flag read goes through the registry (lint); the enum pin tests list the states |
| P1-11 | `refactor(sentinel): capabilities derived from the registries` — `capabilities.ts` computed from `StageRegistry` and `ProviderRegistry`; the human `capabilities` output no longer crashes | S | P1-8 | the capability tests pin the same words; `capabilities` prints every row |


## Phase 2 — the declared pipeline

| id | task | size | after | done when |
|---|---|---|---|---|
| P2-1 | `feat(sentinel): add the pipeline and stage contracts` — `PipelineDefinition`, `StageDefinition` (four kinds), `StageInputDecl`/`StageOutputDecl`, `StageIO`, `Provenance`, `StageRun`; generated schemas; `PlanWork.stage` widened from the enum to a stage id with the old values kept as built-in ids | M | P1 | contracts compile, schemas regenerate without drift, every existing fixture still validates, the enum pin tests list the built-in ids explicitly |
| P2-2 | `feat(sentinel): read, validate and adopt pipeline.json` — the file, its schema, cycle and type checks, flag checks, availability checks (runner qualified, image present, adapter promoted), digest over referenced pack bytes, `settings adopt`-style adoption | M | P2-1 | `farsight-sentinel plan` refuses a cycle, a missing required input, an incompatible type, a disabled flag and an unknown pack, each with a catalog code; adopting pins the digest |
| P2-3 | `feat(sentinel): plan declared stages over the check matrix` — the planner builds the unit DAG from the pipeline; a `tool` stage selects its checks from the matrix; `builtin` stages keep today's bootstrap; `agent` stages generalise `withReviewUnits` with `fanOut`; `after` is ordering-only | L | P2-1 | the default pipeline plans to the same unit set and digests as today's rule-derived plan on the fixture (a golden test); review units are no longer appended to a sealed plan |
| P2-4 | `feat(sentinel): typed stage inputs resolved at publish` — `{stage, output}` inputs resolve to artifact ids when the producer publishes; the coordinator seals them into the attempt binding; the secret-withholding fold runs over every upstream artifact before an agent or host script reads it | L | P2-3 | a stage that needs `patterns.findings` blocks until patterns publishes, binds the exact artifact ids, and receives withheld findings when the run has accepted secret evidence (the existing privacy tests extended) |
| P2-5 | `feat(sentinel): stage packs and promotion` — a promoted pack holds scripts, prompts and skills by digest (`stage.promote`, mirrored on `rule.promote` and the rule lock book) | M | P2-1 | a changed prompt byte changes the pipeline digest and requires re-adoption; the report names the pack and digest |
| P2-6 | `feat(sentinel): composite run intent and per-stage budgets` — one `run.start` receipt covers the pipeline revision, every stage's effects and every provider binding; budgets per stage summed per provider; `paid.admit` accepts several bindings minted in one confirmed action | M | P2-3 | a two-provider pipeline is admitted with one confirmation; changing any stage after preview invalidates the receipt; the ledger shows per-stage spend |
| P2-7 | `feat(sentinel): host script stage` — `script` kind with `runner: host`: child process, empty environment, digest-checked entry, declared inputs materialised in a scratch directory, stdout captured and validated against the output schema; `runner: container` through the existing backend with a pinned script-runner image; the `hostScripts` flag; the report marks host execution as weaker isolation | L | P2-4 | the walkthrough stage runs as a host script in the fixture; a tampered entry file refuses at start; the provenance records interpreter digest, argv and env names |
| P2-8 | `feat(sentinel): fold reports by output type` — `full-report.ts` folds `findings`, `coverage`, `observations` and `{schema}` outputs by type; model observations project into ordinary JSON/Markdown/HTML/SARIF as a separate, cited class (#194) | M | P2-4 | the observation from the qualified Copilot run appears in the full report with its citation and model identity; counts separate observations from findings; source-removed regeneration still works |
| P2-9 | `feat(sentinel): stage-level rerun and compare` — `rerun <run> --stage <id>` expands to unit ids over the existing `RerunSelection`, previews downstream consequences, creates the linked child; `diff` compares by fingerprint and lists stage deltas (added, removed, changed revision, changed runner or model) | M | P2-3 | rerunning `triage` with another model reuses stages 1–5 as retained, creates one child, and `diff` prints the three stage rows the mock shows |
| P2-10 | `feat(sentinel): init profiles write pipeline.json` — `static`, `scanners`, `secrets`, `agentic`; `init` is idempotent and never overwrites | S | P2-2 | a clean npm-only consumer runs init → plan → run on the fixture with the `scanners` profile |
| P2-11 | `feat(sentinel): one scan command` — `farsight-sentinel scan [--confirm] [--detach]` = plan + preview + run, printing the exact confirm line; `scans` lists retained runs; `status`/`report` read through the running service instead of refusing; `capabilities` human output fixed; no internal PR numbers in any user-facing string | M | P2-2 | a first scan on the fixture is init → scan → scan --confirm → report, with ids printed and never retyped; the catalog lint finds no `PR 0` string |

## Phase 3 — the top-down surface

| id | task | size | after | done when |
|---|---|---|---|---|
| P3-1 | `feat(sentinel): read model for the viewer` — one `GET /api/sentinel/scans`, `/scans/:id` (pipeline with stage runs and provenance), `/scans/:id/stages/:stage` (retained record), `/scans/:id/entries`, `/scans/:id/entries/:entry/path`, `/scans/:id/findings/:id`, `/diff?a&b`, all read-only through the facade, every number a `Counted` with scope; the companion's session/authority code behind the facade | L | P1, P2-3 | every mock field has a source in one of these answers; `docs/COUNTS.md` lists each number; read-only servers refuse writes |
| P3-2 | `feat(viewer): Sentinel ladder — SCANS and PIPELINE stops` — `surfaces/sentinel.js` draws the chrome (five stops, LAYOUT, crumb, verdict chips) and the ladder with parallel rows; the stage dock; `lib/sentinel-model.js` pure folds unit-tested; catalog `strings-sentinel-*.ts` for both registers | L | P3-1 | the fixture's run draws as mock 01 with zero page errors at 1440 and 1280; business register shows no identifier tokens; e2e spec |
| P3-3 | `feat(viewer): STAGE stop` — prompt, turns, inputs, outputs, attempts for agent stages; command, image, raw report for tools; argv and log for scripts | M | P3-2 | the qualified Copilot run's retained record draws as mock 02; withheld content shows its reason |
| P3-4 | `feat(viewer): ENTRY POINTS stop` — grouped by surface with guards, reach, findings, review state, risk; the entry dock | M | P3-2 | mock 03 on the fixture; the risk tip explains the count; a door from the Map's property head to the entry |
| P3-5 | `feat(viewer): PATH stop` — the retained walkthrough rendered as hops (fold to signature, open to body), gates with tier, findings and observations pinned, boundaries dashed; the finding dock with decision and history; `read as markdown`, `see it on the map`, `open in the editor` | L | P3-2, walkthrough stage | mock 04 on the fixture; the same path reads identically from the Markdown export; a changed live file shows the retained bytes with a note |
| P3-6 | `feat(viewer): configure in place` — the PIPELINE stop in edit mode: stage editor drawer, kind/runner/model/instructions/skills/inputs/outputs/budget/where; validate and preview through the facade; confirm through the same receipt flow as the CLI | L | P3-2, P2-2, P2-6 | mock 05: adding the triage stage from the browser produces the same `pipeline.json` as the CLI, previews reuse vs rerun, and confirms once |
| P3-7 | `feat(viewer): compare two scans` — the SCANS stop's compare layout and delta list; A → B PDF export with the provenance footer | M | P3-2, P2-9 | mock 06 on two fixture runs; `diff --json` and the panel agree |
| P3-8 | `feat(viewer): Sentinel chip on the gate card and Map property` — the one shared door from a gate or screen to its findings and path | S | P3-5 | a gate with a finding on its path shows the chip in both places; read-only and stale states honest |
| P3-9 | `chore(sentinel): retire the owner-ui companion page` — remove the iframe surface and server-rendered HTML once P3-1…P3-6 pass; keep pairing and receipts behind the facade | M | P3-6 | no route serves the old page; the e2e suite's companion specs replaced by surface specs |

## Phase 4 — runners and qualification

| id | task | size | after | done when |
|---|---|---|---|---|
| P4-1 | `feat(sentinel): AgentRunner interface and the native mode` — `AgentRunner { id, qualify(), run(stage, inputs, scratch) → transcript + output }`; the native mode materialises inputs and skills into a scratch tree, runs the CLI's own loop, captures and validates the output, retains the transcript as the inspection ledger | L | P1, P2-4 | the brokered loop and the native mode record the same `Provenance`; a stage output that fails its schema is a failed attempt, never a partial publication |
| P4-2 | `feat(sentinel): qualify Claude CLI` — refresh the executable pin, unpin the single model, `claude -p --output-format stream-json` under the existing sandbox and child proxy, skills materialised as the CLI's skill directories, the isolation qualification the Copilot profile passed, a per-runner qualification record replacing `nativeClaudeReviewEnabled` | L | P4-1 | the Claude runner passes the same isolation, zero-contact and replay controls as Copilot on macOS arm64 and Linux amd64; the triage stage runs natively on the fixture with a retained transcript |
| P4-3 | `feat(sentinel): Copilot CLI native mode` — the same for `copilot -p` with its own loop; keep the brokered profile qualified | M | P4-1 | both modes qualified for Copilot 1.0.103; the report names the mode |
| P4-4 | `feat(sentinel): custom prompts and skills per stage` (#187) — promoted bytes, stage-versus-segment precedence, refusal for changed or unapproved bytes, raw display under the privacy rules | M | P2-5, P4-1 | a genuine public run uses one original skill; the retained instruction record lists exact bytes and digests before dispatch |
| P4-5 | `feat(sentinel): hosted API runner behind the flag` — the retained OpenAI-compatible transport plus an Anthropic Messages adapter, both refused at dispatch unless `hostedApiReviewEnabled`; cost from rates | M | P4-1 | with the flag off the UI greys the choice with its reason and dispatch refuses; with it on and a spend cap, one live acceptance per provider (owner-triggered, paid) |
| P4-6 | `feat(sentinel): cost and usage on every stage` — tokens in/out, calls, money when rates exist, `unobserved` otherwise, summed per run and per provider; the budget ledger surfaced | S | P2-6 | the pipeline card totals match the ledger; `$0` is never printed for a subscription runner |
| P4-7 | `feat(sentinel): per-entry fan-out for agent stages` — `fanOut: per-entry` runs one unit per walked entry under one envelope with a shared budget; the STAGE stop lists entries | M | P4-1, P2-3 | 18 entries review as 18 units with one confirmation and one budget; cancellation stops the rest |

## Phase 5 — the deferred release and the follow-ups that still stand

| id | task | size | after | done when |
|---|---|---|---|---|
| P5-1 | `chore(release): Farsight 0.4.0 and Sentinel 0.1.0` through the release PR flow; clean npm-only consumers against the published URLs | M | P3, P4-2 | the closeout's steps 3–5, unchanged |
| P5-2 | Java/Spring sample and managed runtime (#176), replay bundles and pruning (#175), differential selection (plan PR 27/28) | L each | P5-1 | per their existing gates |
| P5-3 | The outsider demo re-run on Sentinel: three outsiders asked to explain a finding's business consequence from the PATH stop alone | M | P3-5 | zero wrong answers on who may and what the finding reaches |

## Decisions the owner is asked to confirm

1. **Host scripts are allowed** behind `hostScripts`, as a weaker isolation class named in the report. The alternative is
   script stages only in a pinned runner container, which keeps the current invariant and needs Docker for every script.
2. **Native agent mode is the default for custom stages; brokered stays the default for the built-in review stage.**
   The alternative is brokered everywhere, which keeps every claim citeable but makes "custom instructions and skills"
   a rendered-text approximation.
3. **The owner-ui companion is retired**, its pairing and receipts kept behind the facade. The alternative is to keep it
   as a fallback page, which means maintaining two UIs.
4. **Phase 0 reformats the whole repository in one PR** with a blame-ignore rev, after the two open PRs (#121, #195)
   are merged or rebased. The alternative is Sentinel first, then the rest, which spreads the conflict over weeks.
5. **Prettier at 120 columns, ESLint flat config with type-aware rules only on `packages/*/src`**, lefthook replacing
   `scripts/install-hooks.mjs` while keeping the LFS hooks. Details in phase 0 once measured.
