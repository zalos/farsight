# Sentinel v2 — the plan

> Status: proposal, 2026-10-23. Supersedes the direction of [the implementation plan](../farsight-sentinel/implementation-plan.md) and the
> [closeout](../../../SENTINEL-STATUS-2026-10-23.md) where they disagree; it does not touch the shipped release gates.
> Companion files: [tasks.md](tasks.md) (the work breakdown), [mocks/](mocks/) (the UX mocks, rendered as PNGs).

## 0. The verdict in one page

Sentinel was built in 30 PR packages over six days by one agent lineage with another reviewing. The kernel it produced is
real and worth keeping: a digest-chained plan, a DAG of work units with per-unit input fingerprints, append-only attempts
with retained invocation records, a content-addressed object store with verified publications, container isolation with
pinned image digests, a brokered review loop with retained prompts, wires and token usage, and a linked-rerun model. Nothing
in this plan throws that away.

Three things went wrong on top of it, and they are what the owner noticed.

1. **The product is bottom-up.** The owner UI is a separate server-rendered page in an iframe, organised around the
   coordinator's own objects (runs, attempts, revisions, receipts). Farsight's other surfaces go the other way: ALL →
   JOURNEY → SCREEN → ACTION → LINES, one chrome that holds still, a dock on the right. Sentinel needs the same ladder:
   **SCANS → PIPELINE → STAGE → ENTRY POINTS → PATH**. An entry point the parser found is a door into the whole code path
   under it, with the findings and the model's observations pinned to the hop they belong to.
2. **Nothing is configurable.** The pipeline is derived from promoted rules, not declared by the user. There is no stage
   kind for a host script, inputs are captured source files only, no stage can consume another stage's output, the two
   agentic stages are a closed enum, the prompt is bundled and skills are always `[]`, and one run gets exactly one
   model binding. The owner asked for the opposite: a pipeline of declared stages (script on the host, tool in a pinned
   container, agent through Claude CLI or Copilot CLI with custom instructions and skills), typed inputs and outputs that
   flow stage to stage, provider and model per stage, hosted APIs behind a flag, and every stage's provenance (what ran,
   which version, where, what it cost) one click away.
3. **The code is hard to change.** 52k lines in 340 files, written as one-statement-per-semicolon lines (several files
   average 200+ characters per line), the same adapter-id lists hard-coded in five layers, two driver interfaces, review
   units bolted onto a sealed plan, and service glue that re-derives the same registry in several places. There is no
   formatter, no linter and no hook, so none of this is caught.

The plan, in order: **format and lint the repo with no functional change (phase 0)**, then **carve the kernel behind
interfaces** (phase 1), then **declare the pipeline** (phase 2), then **build the top-down UI on the real data** (phase 3),
then **qualify the two agent CLIs and the host script runner** (phase 4), and only then revisit the deferred release.
Phases 1–3 each ship behind the existing flags and leave the qualified Copilot path intact until its replacement passes
the same checks.

## 1. What we keep, what we change, what we stop

| Keep as is | Change | Stop |
|---|---|---|
| `store/` (objects, ledger, migrations, owner lock) | `planner/`: stages become declared, rules become what a `tool` stage selects | Deriving the stage set from promoted rules alone |
| `execution/` coordinator, scheduler, supervisor, isolation, protocol, recovery | `contracts/`: widen `PlanWork`/`StageRef` to a stage id and four kinds; add `StageIO` and `Provenance` | The second `CheckDriver` interface and the `canonical.ts` bridge |
| `policy/` grants, three verdicts, receipts, adoption | `review/`: the brokered loop becomes one of two agent modes; prompts and skills become promoted, digest-pinned bytes | One model binding per run |
| `adapters/*` scanner kernels and normalisers; `frameworks/*`; `analysis/paths` | `service/`: one `SentinelService` facade; transports call it and nothing else | Transports reaching into store/execution internals |
| The qualified Copilot CLI profile, sandbox and proxy | `owner-ui/`: retired as a page; its session/authority code moves behind the facade; the viewer surface draws the ladder | The iframe companion as the product UI |
| Report folds, SARIF, offline HTML | `reports/`: fold by output type, not by adapter id; model observations projected (#194) | Hard-coded `SCANNER_ADAPTERS` lists |
| The 227 test files | Tests move to the seams they test; container-spawning tests tagged and selected by `ci-changes` | Tests that assert internal glue shapes |

## 2. Principles that carry over from Farsight

- **One graph, many lenses.** A finding, a gap, an observation and a stage are views over the same application graph.
  An entry point in Sentinel *is* the route or screen node Farsight already has; the path under it is `core/query.ts`'s
  execution walk, retained as captured bytes (PR 19a's walkthrough), never a second parser.
- **Code is the source of truth; the model proposes.** A scanner finding is evidence. A model observation is a cited
  claim and is always drawn as one. Neither changes the coverage word. A decision binds to evidence and reopens when the
  evidence changes.
- **Every number names its scope.** `12 findings · this scan`, `3 tests reach · this route`, `$0.09 · list price`.
  Every number is a `Counted`; every chip has a tip.
- **No silent fallback.** A stage declares where it runs. Hosted APIs are off unless the flag is on; a local model is
  refused where policy forbids it; an unqualified runner runs and the report says so.
- **Provenance on everything.** Every stage run records what ran (script digest, image digest, CLI executable digest),
  which version, where (host or container), what it read, what it wrote, how long, how many tokens, how much.

## 3. The product model

### 3.1 A pipeline of stages

A **pipeline** is a declared, digest-pinned list of **stages**. Four kinds:

| kind | runs where | implementation | provenance recorded |
|---|---|---|---|
| `builtin` | in-process or a bounded child from Sentinel's own code | `capture`, `parse`, `inventory`, `walkthrough`, `report`, `framework-controls`, `paths` | module digest, Sentinel version |
| `tool` | a pinned Linux container, never pulled during a scan, no host fallback | an adapter (`gitleaks`, `osv-scanner`, `semgrep`, `trivy`, `zizmor`) plus the rules it selects | adapter id and version, image reference and id, worker digest, rules and database snapshots |
| `script` | **host** (owner-promoted) or a pinned script-runner container | an entry file from a promoted stage pack (`node` or `sh`), version string | entry digest, interpreter name/version/digest, argv, environment variable names, image when containerised |
| `agent` | the host (the CLI) with network through Sentinel's child proxy | a runner (`claude-cli`, `copilot-cli`, `hosted-api` behind the flag), a model, a prompt, ordered skills, a mode | runner executable digest, requested and reported model, prompt and skill digests, every request wire, turns, tokens in/out, cost or `unobserved`, deadline used |

Every stage declares `needs` (typed inputs: `source`, `parse`, `inventory`, or `{stage, output}`), `produces` (typed
outputs: `findings`, `coverage`, `observations`, `walkthrough-md`, or `{schema}`), optional `after` (ordering only),
`fanOut` (`per-run`, `per-source`, `per-entry`, `per-check`), `required`, and a `budget`. The coordinator resolves
`{stage, output}` inputs when the producer publishes, runs every upstream artifact through the canonical secret-withholding
fold before an agent or a host script sees it, and refuses a cycle, a missing required input or an incompatible type
before anything runs. The existing check matrix stays the coverage engine: a `tool` stage *selects* from it, and only a
`tool` or `builtin` stage's `coverage` output can satisfy a required check. An `agent` stage can never make coverage.

### 3.2 Two agent modes

| mode | who runs the loop | what the model can touch | what is retained | use it for |
|---|---|---|---|---|
| `brokered` (today) | Sentinel: fixed JSON grammar, one CLI process per turn, the evidence broker serves cited slices | only what the broker serves | prompt, every wire, served citations, replies | review stages whose output must be citeable claim by claim |
| `native` (new) | the CLI: `claude -p … --output-format stream-json` / `copilot -p …` over a scratch working tree that holds only the stage's declared inputs | the inputs in the scratch tree, the CLI's own read tools, the skills Sentinel materialised | the CLI's full transcript (every tool call and read), prompt and skill bytes, the final output validated against the stage's output schema | custom stages written by the owner: triage, explain, cross-check, summarise |

`native` is what the owner means by "agentic with custom instructions". The transcript makes what the model inspected
observable; the output schema makes the result consumable by the next stage. Each runner is qualified separately on a
pinned version (today: Copilot 1.0.103 qualified; Claude CLI pinned to 2.1.282 with a sandbox profile but unqualified).
Both modes record the same `Provenance` shape, so the UI and the report draw them the same way.

### 3.3 The config file

One file per workspace, adopted by digest like settings and rule packs: `.farsight/sentinel/pipeline.json`
(`sentinel.config.json` is already taken by the repository *request* file). A stage with bytes (a script, a prompt, a
skill) references them from a promoted stage pack, so the pipeline's digest covers the bytes.

```jsonc
{
  "schema": "sentinel-pipeline/1",
  "id": "default", "revision": 8,
  "stages": [
    { "id": "capture",   "kind": "builtin", "operation": "capture" },
    { "id": "parse",     "kind": "builtin", "operation": "parse", "needs": ["capture"] },
    { "id": "secrets",   "kind": "tool", "adapter": "gitleaks", "rules": ["sentinel.secrets.current-tree"], "needs": ["capture"], "required": true },
    { "id": "patterns",  "kind": "tool", "adapter": "semgrep", "rules": "pack:builtin:pattern", "needs": ["capture", "parse"] },
    { "id": "walk",      "kind": "builtin", "operation": "walkthrough", "needs": ["parse"], "fanOut": "per-entry" },
    { "id": "review",    "kind": "agent", "mode": "brokered", "runner": "copilot-cli", "model": "gpt-6-luna",
      "prompt": "stages/review@3#prompt.md", "skills": ["skills/owasp-top10@2", "skills/express-auth@1"],
      "needs": [{ "stage": "walk", "output": "walkthrough" }, { "stage": "patterns", "output": "findings" }],
      "after": ["secrets"], "fanOut": "per-entry", "budget": { "turns": 3, "tokens": 20000, "seconds": 120 } },
    { "id": "triage",    "kind": "agent", "mode": "native", "runner": "claude-cli", "model": "claude-sonnet-5-5",
      "instructions": "stages/triage@1#triage.md", "skills": ["skills/farsight-journeys@1"],
      "needs": [{ "stage": "patterns", "output": "findings" }, { "stage": "review", "output": "observations" }, "farsight.journeys"],
      "produces": [{ "name": "triage", "schema": "sentinel.triage/v1" }],
      "budget": { "turns": 4, "tokens": 60000, "usd": 0.50, "seconds": 180 } },
    { "id": "report",    "kind": "builtin", "operation": "report", "needs": ["secrets", "patterns", "review", "triage", "walk"] }
  ],
  "flags": { "hostedApiReviewEnabled": false, "hostScripts": true }
}
```

Feature flags stay in adopted settings and are enforced at dispatch, not hidden in the UI: `hostedApiReviewEnabled`
(hosted HTTP providers), `nativeClaudeReviewEnabled` → generalised to a per-runner qualification record, and a new
`hostScripts` (a `script` stage with `runner: host`). A disabled choice is drawn greyed with its reason.

### 3.4 Admission and cost

Today a run is admitted with one intent and one model envelope. A declared pipeline needs a composite intent: one
`run.start` receipt whose digest covers the pipeline revision, every stage's effects (`tool-execution`,
`host-execution`, `paid-inference`, `source-disclosure`, `network`) and every provider binding, minted in one confirmed
CLI or browser action. Budgets are per stage and summed per provider; the budget ledger stays per envelope. Cost is
recorded as money only when a provider has rates; a subscription CLI records `unobserved`, and the UI prints
`$0.09 · list price, not billed` or `cost unobserved · subscription`, never `$0`.

### 3.5 What the user does

- `farsight-sentinel init` writes `pipeline.json` from a profile (`static`, `scanners`, `secrets`, `agentic`).
- `farsight-sentinel plan` validates the pipeline (types, cycles, availability, flags), previews which stages reuse a
  retained result and which will run, prints the effects and the cost ceiling, and writes a draft.
- `farsight-sentinel run --confirm` admits the draft and runs it; `--detach` returns the run id.
- `farsight-sentinel rerun <run> --stage triage [--runner claude-cli --model …]` previews the dependency consequences and
  creates a linked child run; the parent is immutable.
- `farsight-sentinel diff <a> <b>` compares two runs by fingerprint.
- `farsight-sentinel report <run> --html|--md|--json|--sarif`; `walk <run> <entry> --md` for one entry point.
- The viewer does all of the above through the facade; the browser's confirmation is the same receipt flow.

## 4. The UX

The Sentinel surface lives inside the Farsight viewer shell, reads the catalog, uses the HUD tokens, and shares the dock,
the chips, the tooltips and the register switch. The chrome holds still. Five stops on one level control:

| stop | what it shows | layouts | the dock |
|---|---|---|---|
| **SCANS** | every retained scan of this workspace: findings, observations, policy word, stages, agentic count, cost, duration | `list` · `compare` | the picked scan, or the A → B delta |
| **PIPELINE** | the stages top to bottom, parallel stages side by side; each card carries its kind, provenance line, status, duration, cost, inputs and outputs; `+ add a stage here` between rows | `ladder` · `lanes` · `table` | the picked stage: runner, model, prompt, skills, turns, tokens, cost, where it ran, flags, what it read and produced, rerun |
| **STAGE** | one stage's retained record: for an agent stage the prompt, the turns with tokens, the cited observations; for a tool stage the command, the image, the raw report; for a script the argv and the log | `prompt` · `turns` · `inputs` · `outputs` | rerun with another runner, the observation, the path |
| **ENTRY POINTS** | every entry the parser found, grouped by surface (routes by framework, screens, jobs, CI), with guards on the way, what it reaches, findings, review state, a risk bar | `by surface` · `by risk` · `table` | the picked entry: journey, screen, persona, who may, tests, what sits on its path |
| **PATH** | one entry's whole code path top to bottom: route → gate → handler → function → record → table → external, each hop folded to its signature or open to its body, gates marked with their tier, findings and observations pinned to their hop, boundaries the walk could not follow drawn dashed | `ladder` · `code` · `diff` | the picked finding: evidence, place, business sentence, decision, history |

Configure is the PIPELINE stop in edit mode: the same ladder, each stage card an editor, a new stage a drawer with kind,
runner, model, instructions, skills, wired inputs, outputs, budget and where it runs; the JSON it writes shown beneath;
`validate` → `preview the run` → confirm.

The mocks, rendered from the invoice-app example and Farsight's own design tokens:

| | |
|---|---|
| [01 · Pipeline](mocks/01-pipeline.png) | the ladder with a running custom stage and the stage dock |
| [02 · Stage](mocks/02-stage-agent.png) | an agent stage's turns, tokens and cited observation; rerun with another runner |
| [03 · Entry points](mocks/03-entry-points.png) | the attack surface grouped by framework surface |
| [04 · Path](mocks/04-path.png) | one entry point end to end with the finding and the observation pinned |
| [05 · Configure](mocks/05-configure.png) | adding an agentic triage stage wired to two upstream outputs |
| [06 · Scans](mocks/06-scans.png) | retained scans and the A → B compare |
| [before · owner panel](mocks/before-01-owner-top.png) · [before · process graph](mocks/before-02-process-expanded.png) | the shipped companion page, for contrast (real layout, synthetic values) |

Sources are in `mocks/pages/`; `node docs/proposals/sentinel-v2/mocks/build.mjs` re-renders them.

What the mocks fix against the current UI, each grounded in the audit (§5 below): the companion page and its JSON error
become a surface in the shell; "preparation" and "analysis" become stages on one ladder; provenance that is stored but
invisible (runner, model, prompt digest, tokens, image digest) is on every card; entry points become doors; the path
view replaces the live-disk code view with the retained walkthrough; cost and scope words are on every number.

## 5. What the audits found

Four read-only audits ran on `main` at `e85e2382` on 2026-10-23 (the UX audit also drove the live preview on :4520 and
the shipped owner-UI code against synthetic companion answers; nothing was paired, confirmed or started). The full
reports stay outside the repo; this is what they established.

### 5.1 The UX today

- `#/sentinel` is a 20-line surface that draws a heading, a *Reconnect* button and an iframe to a separately served
  companion page. The companion is five stacked form sections: run status and actions, scan configuration, recent
  retained runs, the recorded scan process, a shareable report. Every one of its 120 strings has identical text in both
  registers; it has its own stylesheet, no HUD fonts, chips, tooltips, scope words, addresses or lens.
- The process graph shows the coordinator's steps (capture, parse, inventory, check, review), not the application. A
  card expands into tables of hash handles. The panel says of itself: *"Entry names, endpoint methods and code locations
  are not supplied by this privacy-safe inspection."*
- Findings appear only as Markdown source in a `<pre>`, requested without Farsight context, so they lose the screen,
  journey and persona placement the report document already carries.
- Model details are a list below the graph: model names, prompt hashes, byte counts. No prompt text, no skills, no
  tokens, no cost. Scripted and tool steps show no engine, version, image, or container-versus-host.
- Configuration is a disabled one-option model select, a disabled *Save*, and a pointer to edit `settings.json` by hand.
  The stage set is fixed at six; per-work rerun is disabled in the browser.
- Nothing in Farsight links to Sentinel: the gate card, the Map and the code map have no Sentinel chip.
- The data for the mocks mostly exists already: findings carry node ids plus the screens, journeys and personas they
  touch; framework checks carry the route node for each entry; call paths carry steps and file locations; review
  records carry tokens, steps and tool calls; attempt records carry tokens, cost and currency; run records say whether a
  step ran in a container, a child process or in-process; plans pin image digests, databases and rules. None of it
  reaches the panel or MCP. Two gaps are real: cost is not recorded for a subscription CLI, and the CLI has no run list.

### 5.2 The CLI today

About 25 verbs, each with its own `--confirm`. A first scan is init → adopt → rules promote → assets adopt-tool → plan →
run `<id>` --confirm [--confirm-models] → report `<id>`, threading ids by hand and copying model digests into JSON.
`init` prints *"available with PR 06 … PR 09"* to the user; human-readable `capabilities` crashes after two rows
(`--json` works); `status` and `report` refuse with *"another Sentinel process owns this store"* while the service runs;
there is no `scan` command.

### 5.3 The execution model today

What runs is a *unit* (`PlanWork`, `WorkEnvelope`) in a DAG with per-unit input fingerprints; the stage is a closed enum
(`capture | parse | inventory | check | review-guided | review-general`). The graph is derived from promoted rules:
`planBootstrap` hard-codes capture → parse → inventory, `planAnalysis` turns rule × scope into checks batched per
adapter, `withReviewUnits` appends two review units to a sealed plan and recomputes its digest. Unit inputs are captured
source files only; no unit can consume another unit's output except one hard-coded case (the hosted-review secret gate
reads the gitleaks publication). Adapter kinds are `external` (pinned image, never pulled, no host fallback), `built-in`
(a child from a closed list of Sentinel's own code) and `operation` (in-process). There is no host-script kind and the
module headers forbid one. Provider kinds are `ollama`, `openai-compatible`, `claude-cli`, `copilot-cli`; there is no
Anthropic API kind. A Claude CLI adapter exists (`review/providers/cli-native-*.ts`, pinned to 2.1.282 and one model,
behind `nativeClaudeReviewEnabled`); both CLIs are driven as single-turn text engines with their own tools, skills and
instructions stripped, one process per turn, Sentinel running the loop over a JSON reply grammar. Copilot gets three
turns in 120 s under `sandbox-exec` with a CONNECT-allowlist proxy; usage comes from `--usage-output-file`. Money is
recorded only for owner-entered rates; a CLI records `null` on a subscription basis. Skills are modelled by the contract
and always passed as `[]`. One model binding per run. Settings live at `.farsight/sentinel/settings.json`, adopted by
digest; admission ANDs policy, capability and credential verdicts; receipts are single-use and issued only through the
owner CLI. Reports are recomputed from accepted publications and survive source removal; a rerun is a linked child that
selects unit ids and holds the rest.

The audit's judgement, not a measurement: roughly 35–40 % of the code is kernel worth keeping (store, planner,
coordinator and isolation, policy, contracts, the review broker and budget), about 30 % is product capability that
becomes stages (scanner adapters, frameworks, paths, findings, reports, imports), and 25–30 % is accidental (repeated
hard-coded adapter lists, two driver interfaces, review units bolted onto a sealed plan, hand-threaded service glue,
very dense one-line files).

### 5.4 The code today

- **No layering.** 18 of the 20 source folders form one dependency cycle; only `contracts/` and `imports/` stand outside
  it. Concrete wrong-way edges: the 1,624-line `store/ledger.ts` imports the evidence-import feature;
  `policy/admission.ts` imports owner-ui code; `execution/coordinator.ts` imports `review/dispatch.ts` and review imports
  execution back; reports, findings and frameworks import `service/`; `service/` and `transport/ipc.ts` import
  `cli/outcome.ts` and `cli/actor.ts`. `validate.ts` sits at the package root, is imported by 17 folders, and itself
  imports store and planner. The plan's single `service.ts` became a 33-file folder; `cli.ts` calls nine service modules
  directly; no use case (plan, run, report) is exported.
- **One concept, many places.** "Stage" has at least seven vocabularies and "capability" six; work states use different
  words in the contract and the scheduler; about 50 unrelated `Error` classes with no shared base. The sha256 helper is
  redefined in about 35 files; the ID regex is copied into 25 and the digest regex into 26; `canonicalJson`, the function
  behind every digest, has two implementations that differ on edge inputs; there are two frame codecs and three wrappers
  around the JS parser in the framework packs; `broker.ts` alone branches on provider kind 12 times (about 26 across the
  package); `superviseAttempt` branches on adapter kind nine times; each scanner has a test-only `run<Tool>Attempt` path
  in `src/` that production never uses.
- **Missing seams.** The Claude CLI and Copilot CLI adapters are near-copies, each with its own sandbox, proxy and process
  handling; execution site is decided by a kind switch, not a backend; there is no `StageRunner`, `ScannerPlugin`,
  `LedgerExtension`, `SentinelService` facade, `SentinelError` or feature-flag registry. Worth keeping as patterns: the
  store facade, the pure planner, the digest-bound registries, contracts with generated schemas, `CheckpointStore`, the
  `DockerRunner` seam.
- **Style.** Against `packages/core/src` without its string catalogs: lines over 160 characters 4.4 % vs 1.9 %; lines
  with two or more statements 6.0 % vs 2.9 %; minified-looking files 14.8 % vs 2.2 %. Density tracks write order: owner-ui
  77 %, evidence 37 %, findings 28 %, service 22 %; store, planner, adapters and frameworks near 0 %.
- **Tests.** 198 test files, about 1,581 cases; 193 of 243 test files import compiled internals (181 distinct modules, 16
  of them public); 64 spawn processes, 27 run the CLI end to end, 23 need real containers. Runtime was not measured.

## 6. The target architecture

Imports point down only, enforced by `eslint-plugin-boundaries` (or dependency-cruiser) from phase 1 on.

```text
L8  transport/   cli/ (command table → facade) · ipc/ (server op table → facade; client RemoteSentinelService)
                 mcp/ · http/ (the viewer's /api/sentinel routes; no owner-ui page)
                   only imports app/ and contracts/
L7  app/         SentinelService facade · LocalSentinelService (holds the store) · RemoteSentinelService (IPC)
                 Principal (OwnerPrincipal minted only by the CLI entry, ADR 37; AgentPrincipal per channel)
                 use cases: settings · rules · assets · pipeline · plan · run · inspect · reports · decisions · evidence
                 composition.ts: StageRegistry + ProviderRegistry from plugins; capabilities derived, not listed
L6  providers/   ModelProvider registry: http/ollama · http/openai-compatible · http/anthropic (flagged) · cli/claude · cli/copilot
                 AgentRunner (brokered | native) · SandboxedCliRunner (one sandbox, one proxy) · broker (admission, receipts, budget)
L5  stages/      StageRunner implementations: builtin/ (capture, parse, inventory, walkthrough, report)
                 tool/ (ScannerPlugin: pattern, gitleaks, osv, trivy, zizmor) · script/ (host, container) · agent/ (session, evidence, instructions)
L4  execution/   coordinator · scheduler · recovery · publication · coverage · protocol · supervisor (generic)
                 backends/{container, host-child, in-process, sandboxed-cli} : ExecutionBackend
L3  domain/      snapshot · rules · policy (settings, admission, receipts, features.ts) · planner (pure, consumes StageDefinition)
                 findings · reports (incl. assembly) · imports · evidence · analysis (pure parts) · frameworks/{shared, express, nest, next, spring}
L2  store/       facade · ledger (generic) · LedgerExtension ports · objects · migrations · gc · journal
L1  contracts/   envelopes · validate.ts · schemas.generated.ts
L0  kernel/      digest (one canonicalJson, one sha256) · freeze · ids · errors (SentinelError) · seal · framing · failpoints
```

The interfaces, each introduced first as pure delegation over today's code with one implementation per existing branch:

| interface | replaces | implementations |
|---|---|---|
| `SentinelService` | `service/*` called directly from `cli.ts`, `owner-service.ts`, `owner-ui/operations.ts` | `Local`, `Remote` (IPC); every method takes a `Principal` |
| `StageRunner { plan(def, ctx) → units; run(unit, inputs, backend) → outputs }` | `CheckDriver` (two copies), `coordinator.#operation`, `withReviewUnits`, `review/dispatch` | `builtin`, `tool`, `script`, `agent` |
| `ExecutionBackend { prepare, launch, observe, collect, cleanup }` | the nine `adapter.kind` branches in `superviseAttempt` | `container`, `host-child`, `in-process`, `sandboxed-cli` |
| `ScannerPlugin { id, kernel, normalize, assets, rules }` | `SCANNER_ADAPTERS`, `SHIPPED_CHECK_ADAPTERS`, `productionDrivers`, the packaging loops | one per tool |
| `ModelProvider { kind, bind, generate, price }` and `AgentRunner { qualify, run }` | the 26 provider-kind branches; the two near-copy CLI wrappers | `claude-cli`, `copilot-cli`, `openai-compatible`, `anthropic`, `ollama` |
| `LedgerExtension` + repositories | `store/ledger.ts` importing evidence; the budget ledger's private SQLite | `EvidenceRepository`, `BudgetRepository`, `DecisionJournal`, `PipelineRepository` |
| `FeatureFlags` (`policy/features.ts`) | `hostedApiReviewEnabled`, `nativeClaudeReviewEnabled` booleans read ad hoc | `review.hosted-api`, `runner.claude-cli`, `runner.copilot-cli`, `stage.host-scripts`; old names kept as aliases |
| `SentinelError { code, detail, spend }` | about 50 unrelated error classes and scattered `instanceof` outcome mapping | one `outcomeOf(error)` in `app/` |

Two ADRs land with the work: one for the facade and principal boundary, one for the pipeline and stage model. Moves
(the audit's M rows) ship with re-export shims so the 193 internal-importing test files keep compiling; the shims
re-export and never re-instantiate, because the `WeakSet` brands would otherwise split into two registries. Plan digests,
invocation records and work/attempt ids are checked byte-identical on the fixtures after every move, and the real-ingest
comparison `AGENTS.md` requires runs for anything core-adjacent.

<!-- SECTION:7 -->

