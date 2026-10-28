# Sentinel v2 — the plan

> Status: proposal, 2026-10-23; reworked 2026-10-27 after phase 0 landed. Supersedes the direction of
> [the implementation plan](../farsight-sentinel/implementation-plan.md) and the
> [closeout](../../../SENTINEL-STATUS-2026-10-23.md) where they disagree; it does not touch the shipped release gates.
> Companion files: [tasks.md](tasks.md) (the lanes and the work breakdown), [tooling.md](tooling.md) (phase 0's configs),
> [mocks/](mocks/) (the UX mocks, rendered as PNGs).
>
> **2026-10-27.** Phase 0 is done (PRs #199 to #210). The owner chose a thin vertical slice over the eleven-task
> phase-1 carve, accepted the three open decisions as written, and added a CI phase before everything else. The
> slice runs as parallel lanes with explicit file ownership (§9); the phase 1 to 4 tables in tasks.md stay as the
> task definitions the lanes draw from.

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

The plan, in order: **format and lint the repo with no functional change (phase 0, done)**, then **make CI fast enough to
run on every lane PR (phase 0b, §8)**, then **the thin slice in parallel lanes (§9)**: add a repository from the GUI, press
Scan, watch a declared pipeline run with a Copilot CLI agent stage, open the stage's record, change its runner, prompt or
skills, rerun it, read the report. The kernel is carved only where a lane's files need the seam; the rest of the phase 1 to 4
tasks map onto the lanes or a follow-ups table (tasks.md). Every lane ships behind the existing flags and leaves the
qualified Copilot path intact until its replacement passes the same checks.

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
| `builtin` | in-process or a bounded child from Sentinel's own code | `capture`, `parse`, `inventory`, `paths` (the bounded call paths of `analysis/paths/` and `service/path-report.ts`, what this plan calls the walkthrough; there is no module named `walkthrough` today), `report`, `framework-controls` | module digest, Sentinel version |
| `tool` | a pinned Linux container, never pulled during a scan, no host fallback | an adapter (`gitleaks`, `osv-scanner`, `semgrep`, `trivy`, `zizmor`) plus the rules it selects | adapter id and version, image reference and id, worker digest, rules and database snapshots |
| `script` | **host** (owner-promoted) or a pinned script-runner container | an entry file from a promoted stage pack (`node` or `sh`), version string | entry digest, interpreter name/version/digest, argv, environment variable names, image when containerised |
| `agent` | the host (the CLI) with network through Sentinel's child proxy | a runner (`claude-cli`, `copilot-cli`, `hosted-api` behind the flag), a model, a prompt, ordered skills, a mode | runner executable digest, requested and reported model, prompt and skill digests, every request wire, turns, tokens in/out, cost or `unobserved`, deadline used |

The contract today has `StageKind = 'coded' | 'agentic' | 'external-tool'` (`contracts/work.ts`) and two closed stage
enums, `PlanStage = 'capture' | 'parse' | 'inventory' | 'check'` and `ReviewPlanStage` (`contracts/plan.ts`). The four
kinds above map onto it additively: `builtin` is `coded`, `tool` is `external-tool`, `agent` is `agentic`, and `script` is
the one new value; the stage enums widen to a stage id with the five built-in ids kept, so every retained envelope still
validates.

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

Installed on the development machine on 2026-10-27: Copilot CLI **1.0.105** and Claude CLI **2.1.282**. The qualified
Copilot profile pins 1.0.103 and that version's package cache path (`review/providers/cli-copilot-profile.ts`), so the
installed binary is refused as `capabilityUntested` until it is re-qualified. Re-qualification means: run the isolation
(seatbelt deny-default), zero-contact (only the child proxy's allowlist is reachable) and replay controls against the
1.0.105 bytes, record a new profile id (`copilot-1.0.105-darwin-arm64-seatbelt-v6`, and a `native-v1` profile for the
native mode's read-tool allowances), keep 1.0.103's record, and re-record the retained wire if the JSONL changed. A profile
id is the CLI version, the platform and the sandbox profile revision.

The flags the native mode uses, read from each CLI's `--help` on 2026-10-27 (no live call):

| purpose | Copilot CLI 1.0.105 | Claude CLI 2.1.282 |
|---|---|---|
| one prompt, non-interactive | `-p <text>` (or the prompt on stdin, as the brokered adapter does today; the two are exclusive) | `-p` / `--print` with the task as the argument, `--system-prompt-file <prompt>` |
| model | `--model <id>`, `--reasoning-effort <level>` | `--model <id>`, `--effort <level>` |
| machine output | `--output-format json` (JSONL, one object per line), `-s` | `--output-format stream-json --verbose` (every tool call and read) |
| the transcript to retain | `--share <path>` writes the session as Markdown after completion; the JSONL stream beside it | the stream-json output is the transcript |
| the output against the stage's schema | validated by Sentinel after exit | `--json-schema <schema>` at the CLI, validated again by Sentinel |
| usage | `--usage-output-file <path>` (what the brokered adapter reads today) | the `result` event's usage in the stream |
| tools | `--available-tools <names>` (only these exist for the model), `--deny-tool shell --deny-tool write`, `--excluded-tools mcp:* custom:*`, `--disable-builtin-mcps`; the exact read-tool names are recorded from the first dry run | `--tools "Read,Grep,Glob"`, `--disallowedTools "Bash,Edit,Write,WebFetch,WebSearch"`, `--restricted`, `--permission-mode dontAsk --permission-prompts none` |
| the scratch tree | `-C <scratch>`, `--trust-folder` (one session, nothing saved), `--disallow-temp-dir` | `--add-dir <scratch>` |
| skills | materialised as `<scratch>/.github/skills/<id>/SKILL.md`; `--add-dir <scratch>` loads them as trusted (`copilot skill --help` also lists `.agents/skills/` and `.claude/skills/`) | materialised as `<scratch>/.claude/skills/<id>/SKILL.md`, loaded with `--setting-sources project`; today's adapter passes `--setting-sources ''` and `--disable-slash-commands`, which native mode drops |
| instructions | `.github/copilot-instructions.md` in the scratch tree, or `--agent <name>` for `.github/agents/<name>.md`; today's `--no-custom-instructions` is dropped | the system prompt file; `CLAUDE.md` in the scratch tree |
| MCP, hooks, network | `--disable-builtin-mcps`, `--deny-url`/`--allow-url`, `--secret-env-vars`, the child proxy as today | `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--settings '{"disableAllHooks":true}'`, the sandbox profile and the child proxy as today |
| budget | `--max-ai-credits <n>` and the stage deadline | `--max-turns <n>`, `--max-budget-usd <x>` and the stage deadline |
| hygiene | `--no-auto-update --disable-client-telemetry --sync-session=off --log-level none --no-color --no-ask-user --no-experimental --no-bash-env` (today's list) | `--no-session-persistence`; never `--bare` (it skips the keychain, so the subscription login is not found) |

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

## 7. Hygiene first: formatter, linter, hooks, CI

Nothing in phases 1–4 is reviewable on code written as one-statement-per-semicolon lines, so the first PR adds the tools
and changes no product code; the reformat lands one area per `style:` PR, each proven to change no program. The exact
files are in [tooling.md](tooling.md); the tested prototype of the proof is [tooling/ast-equivalence.mjs](tooling/ast-equivalence.mjs).

| choice | decision | why |
|---|---|---|
| Prettier 3.9.10 | `printWidth: 120`, `singleQuote`, `trailingComma: 'all'`, `quoteProps: 'preserve'`, `embeddedLanguageFormatting: 'off'`, JS/TS only in this phase | 120 is what the clean packages already write (p90 ≈ 121); single quotes because seven tests match source text; `preserve` and `off` keep every formatting PR AST-identical and never touch the worker sources that live in template literals and are sha256-pinned |
| ESLint 10.13.0 + typescript-eslint 8.72.0 (flat config, no type information yet) | `recommended` plus `no-var`, `eqeqeq`, `prefer-const`, `no-unused-vars` with `_` as errors; `complexity`, `max-depth`, `max-params`, `max-lines`, `max-lines-per-function`, `no-nested-ternary` as warnings to ratchet; existing violations frozen in `eslint-suppressions.json` | correctness on all code from day one with zero code edits; structure rules become errors package by package during phase 1; type-aware rules wait for test tsconfigs |
| no import sorting | `eslint-plugin-import-x` left out | reordering ESM imports moves side effects; not behaviour-neutral |
| lefthook 2.2.2 | `pre-commit`: the main-branch guard, `prettier --write` on staged files, `eslint --quiet`; `commit-msg`: the existing `lint-commits.mjs`; `no_auto_install: true`; **no LFS hook names** | 37 worktrees share one hooks directory: auto-install would rewrite hooks on every branch switch, and a lefthook-owned LFS hook would skip `git lfs` in any worktree on an older branch |
| CI `lint` job | `format:check`, `lint`, and for a PR titled `style…` the AST-equivalence check against the merge base; required after its first run; about two runner-minutes | the selector needs no change: docs-only pushes skip it, everything else runs it |
| blame | `.git-blame-ignore-revs` with each style squash SHA, set by `install-hooks.mjs` | squash-merging means a style PR cannot know its own SHA; the next PR records it |

What a naive reformat would break, all verified: two generated schema files are byte-compared in CI; `examples/`,
`prototypes/`, `**/fixtures/` and `packages/sentinel/rules/` are inputs whose lines and digests tests assert; the PR 01
feasibility harness under `scripts/` is sha256-pinned by 240 retained evidence records; seven tests match source text
with single quotes; the string lint's first rule works line by line; `.claude/worktrees/` is excluded only through
`.git/info/exclude`; the root `package.json` is not ESM, so configs are `.mjs`. Each is in the ignore lists or the
checklist. The string catalogs (`core/src/strings*.ts`, one entry per line by design) stay unformatted unless the owner
wants the extra 7–10k lines.

Measured churn at 120 columns: at least 34.8k lines rewritten across the repo, 20.2k of them in Sentinel (58 %;
13,351 Sentinel lines are over 120 characters today), 2.6k in `scripts/`, 12k in the other packages. Neither open PR
touches Sentinel source, so the Sentinel reformat lands first with no conflict; the remaining packages wait for #121.

The proof: `ast-equivalence.mjs` parses both revisions of every changed JS/TS file with the repo's TypeScript and
compares a trivia-free token stream (node kinds, identifiers, cooked strings, raw template text, numbers, regexes,
`let`/`const`, optional-chain extent), unwrapping parentheses and ignoring trailing commas and stray semicolons.
Re-printing 617 real files gave zero differences; every planted semantic edit (`==` → `===`, `let` → `const`, a changed
template, `'a':` → `a:`, an ASI hazard, moved braces) was caught.


## 8. Phase 0b: CI speed and affected checks

Every lane PR waits for the required checks, so CI's wall time is the pace of the whole slice. Measured on `main` at
`5aad3a6b` (run 40611895128, 2026-10-28T00:55Z) and the four runs before it, with `gh run view --json jobs` and the job
logs' timestamps:

| job | wall | where the time goes |
|---|---|---|
| validate | 586 s (586 to 983 s over five runs) | install 4, build 17, `pnpm -r typecheck` 14, **`pnpm -r test` 500**, `test:scripts` 30. Inside the test step, Sentinel's 198 files run **456 s** (00:57:06 to 01:04:42); echo 64 s, server 20 s, cli 18 s, parsers 10 s, core 4 s, the rest under 3 s, several in parallel |
| sentinel-package | 680 s (443 to 680 s) | the two CLI pack checks 56, pack Sentinel 18, **the eight consumer scripts in one serial chain 449**, the npm acceptance of both tarballs 130 |
| e2e | 367 s (321 to 374 s) | build 29, browsers from cache 14, the four Sentinel browser steps and their two packs 50, **`pnpm e2e` 221**, the small perf preset 28 |
| sentinel-service | 195 s (195 to 296 s) | 31 process-spawning test files, 165 s; these same files also run inside validate's Sentinel step |
| sentinel-isolation | 122 s | two image pulls 12, build 12, canaries 38, the installed secret scan 30 |
| sentinel-recovery · lint · echo-package · affected checks · secrets | 57 · 64 · 55 · 12 · 10 s | |
| sentinel-scanner-cli (its own workflow, not required) | 860 to 1,202 s | provisions four images and the checks bundle, runs the drivers and the installed four-engine consumer; selected by the union of the package and isolation inputs, so any Sentinel source change runs it |

A phase-0 PR's run took 14 to 16 minutes end to end. The pnpm store and the Playwright browser caches hit on every run
(install 2 to 5 s, browser restore 14 s); build sharing was measured and dropped: a build is 17 to 29 s per job, and an
artifact round trip of `dist/` costs about the same.

What the selector does today: a `packages/sentinel/src` change selects validate, e2e, sentinel-package, sentinel-isolation and
sentinel-recovery; any package change runs **every** package's tests in validate; the scanner CLI workflow runs for any
Sentinel source. The tactics, each with the file it touches, in the order of return:

| id | tactic | files | saves |
|---|---|---|---|
| C-1 | **test the packages a change reaches, not all of them.** The selector emits the merge base; validate runs `pnpm -r --filter "...[<merge-base>]" test`, pnpm's changed-since filter with dependents, read from the manifests. A root file, the lockfile, `scripts/`, `schemas/` or `examples/` still runs everything; a missing output still runs everything; the required check names do not change | `scripts/ci-changes.mjs`, `scripts/test/ci-changes.test.mjs`, `.github/workflows/ci.yml` (validate), `docs/CI.md` | a viewer or server PR no longer runs Sentinel's 456 s; a Sentinel PR no longer runs echo's 64 s |
| C-2 | **split Sentinel's unit suite from its process suite.** One list file names the 31 process-spawning files `sentinel-service` already runs; `pnpm --filter @farsight/sentinel test:unit` runs the rest with `--test-concurrency` at the core count, `test:process` runs the list, and `ci.yml`'s service job reads the same list. The 22 Docker-gated files keep skipping without `SENTINEL_ISOLATION` | `packages/sentinel/package.json`, `packages/sentinel/test/process-suite.txt`, `scripts/sentinel-tests.mjs`, `.github/workflows/ci.yml` (sentinel-service) | validate's Sentinel step 456 s to under 200 s; the 31 files run once, not twice |
| C-3 | **run the eight package consumers in parallel.** After one pack, `scripts/test-sentinel-consumers.mjs` runs the consumer scripts three at a time, each in its own scratch prefix, logs prefixed per consumer; `test:sentinel:package` calls it; the npm acceptance runs beside them | `scripts/test-sentinel-consumers.mjs`, `package.json`, `.github/workflows/ci.yml` (sentinel-package) | 449 s to about 180 s; the job under 6 min |
| C-4 | **the Sentinel browser steps only when Sentinel is selected.** The four steps and the two packs in `e2e` get `if: needs.changes.outputs.sentinel != 'false'` | `.github/workflows/ci.yml` (e2e) | 70 s on a viewer PR |
| C-5 | **drop the duplicate typecheck.** `tsc -p` already type-checks what it emits; `pnpm -r typecheck` after `pnpm build` repeats it. `e2e:typecheck` stays (e2e is not built) | `.github/workflows/ci.yml` (validate) | 14 s |
| C-6 | **select the scanner CLI workflow by the scanner closure**, not by any Sentinel source: `adapters/`, `execution/`, `rules/`, `assets/`, `service/scanner-*.ts`, `service/trusted-profile.ts`, `scripts/test-sentinel-scanner-consumer.mjs`, `scripts/npm-consumer.mjs`, the workflow itself. It stays non-required | `scripts/ci-changes.mjs` (a `scannerCli` output), `.github/workflows/sentinel-scanner-cli.yml`, `docs/CI.md` | 14 to 20 runner-minutes on every UX, review, report or cleanup PR |
| C-7 | **a minutes budget on every job**: `timeout-minutes` at 1.5× the target, a table in `docs/CI.md` with the measured and the budget per job, re-measured when a job crosses it | `.github/workflows/ci.yml`, `docs/CI.md` | nothing directly; a regression is a red check, not a slow one |
| C-8 (later) | tsc incremental output cached on a source hash; measured at under 20 s per job today, so after C-1 to C-7 | `tsconfig.base.json`, `.github/workflows/ci.yml` | under 20 s per job |

Targets, wall time of the required set on a PR:

| change | today | target |
|---|---|---|
| documentation only | 0 runtime jobs (affected checks 12 s, secrets, commits) | unchanged |
| viewer or server only | validate 10 to 16 min beside e2e 6 min | validate under 3 min, e2e under 5 min: **under 5 min** |
| Sentinel source only | validate 10 to 16, sentinel-package 7 to 11, e2e 6, service 3 to 5 min; the scanner CLI 14 to 20 min beside | **under 8 min**; the scanner CLI only for the scanner closure |
| core, graph or a dependency | everything, 16 min | under 10 min |

Invariants that do not move: a missing or failed selector output runs everything; every required check reports on every
PR (skipped explicitly, never pending); `commits` and `secrets` stay as they are; `cancel-in-progress` stays. The phase is
one Opus lane (L-CI) and lands before the other lanes' first PRs need it; it is reviewed like any other lane.

## 9. Sequencing: the thin slice in lanes

The slice, in the owner's words: run Farsight, add a repository from the GUI and load it, press **Scan**, watch the pipeline
run, configure it before or after, re-run parts, generate a report, and see every stage's steps and change them: the agent,
its skills, its prompt, a different coded step. Adding a source and syncing it already exists (`shell.js` `addSource` and
`syncNow` over `PUT /api/settings` and `POST /api/sync`); the slice starts at the Scan button.

The slice done, on the invoice-app example: the SENTINEL tab's SCANS stop says *no scan yet* and offers **Scan**; one
confirmation in the browser; the PIPELINE stop draws the ladder as it runs: capture, parse, inventory, secrets (a `tool`
stage, from a recorded fixture when Docker is off), review (an `agent` stage, Copilot CLI in native mode with the built-in
prompt and one skill), report; the STAGE stop shows the review stage's prompt, turns, tokens, cost `unobserved` and the
transcript; Configure changes the review stage's runner to Claude CLI, edits the prompt, adds a skill, changes the model;
*rerun this stage* creates a linked child run; Report downloads HTML and Markdown; a `script` stage on the host runs a coded
step behind `hostScripts`. Everything else (ENTRY POINTS, PATH, compare, hosted APIs, per-entry fan-out, the move-only
reshuffle) is a follow-up in tasks.md.

Seven lanes, each one Opus implementer in its own worktree under `../farsight-wt/<lane>/`, one PR per task, Sol reviewing
every PR over the bridge before the lead merges. Owned paths never overlap; a lane that needs a line in another lane's file
asks for it in its PR description and the owning lane makes the edit.

| lane | owns | first PR | starts |
|---|---|---|---|
| **L-CI** | `.github/workflows/`, `scripts/ci-changes.mjs` and its test, `scripts/sentinel-tests.mjs`, `scripts/test-sentinel-consumers.mjs`, `packages/sentinel/package.json` scripts, `docs/CI.md` | `ci: test only the packages a change reaches` | now |
| **L-PIPELINE** | `packages/sentinel/src/contracts/`, `schemas.generated.ts`, `planner/`, `execution/`, `cli.ts`, `cli/`, `capabilities.ts`, `index.ts`, `policy/features.ts` (new), `service/{local,canonical,launch,owner-service,controls,scanner-assets,scanner-profile,trusted-profile}.ts`, new `app/`, the matching tests and `strings-sentinel-{cli,plan,service,execution,policy}.ts` | `feat(sentinel): the pipeline and stage contracts and the flag registry` | now, as two workers (PA: contracts, facade, CLI; PB: planner, execution, report; the split is in tasks.md); P-1 lands first, the other lanes rebase onto it |
| **L-ADAPTER** | `packages/sentinel/src/review/` (all of it), `service/review-adapter.ts`, the review, providers, cli-copilot, cli-native, model and agentic-only tests and fixtures, `strings-sentinel-{providers,review,instructions}.ts` | `refactor(sentinel): one AgentRunner over the two CLI adapters` | now, against today's contracts; rebases when P-1 lands |
| **L-UX** | `packages/server/public/app/surfaces/sentinel.js`, new `lib/sentinel-*.js`, the `/api/sentinel/companion` block of `packages/server/src/index.ts`, `packages/core/src/sentinel-companion.ts`, `strings-sentinel-owner-ui.ts`, new `strings-sentinel-viewer.ts`, `packages/sentinel/src/owner-ui/`, new `packages/sentinel/src/transport/http/`, the owner-ui tests, `scripts/test-sentinel-owner-ui-consumer.mjs`, new `e2e/tests/sentinel-*.pw.spec.ts`, the Sentinel sections of `docs/COUNTS.md` and `docs/MAP-VIEWER.md` | `feat(sentinel): the read model for the viewer` | now, on today's runs and units; the configure step waits for P-2 and P-3 |
| **L-CLEAN-A** | new `packages/sentinel/src/kernel/`, `store/`, `snapshot/`, `adapters/`, `frameworks/`, `rules/`, `policy/` (except `features.ts`), `validate.ts` (as a shim), `eslint.config.mjs` (the boundaries rule), the matching tests and catalogs; JSDoc on `contracts/` after P-1 lands | `refactor(sentinel): kernel` | now; K-1 lands first, small |
| **L-CLEAN-B** | `findings/`, `evidence/`, `imports/`, `analysis/`, `reports/`, `transport/ipc.ts` and `transport/index.ts`, `service/{preparation-*,path-*,full-report,inspection-report,report-key,publish-once,readonly,rule-locks,run-failure,scratch-lease,framework-adapter,mcp,package-paths,preview-driver}.ts`, the matching tests and catalogs | `docs(sentinel): JSDoc on reports, findings and the report service` | B-1 now (comments only); B-2 after K-1 lands |
| **L-VERIFY** | nothing in the source; writes `docs/proposals/sentinel-v2/verify-2026-10-27.md` | (a report, not a PR series; its findings become issues or lane items) | V-1 now; V-2 after P-4, A-2 (L-ADAPTER) and U-2 merge; V-3 (Docker) last |

How the lanes meet: L-PIPELINE's P-1 defines `StageDefinition`, `Provenance` and `StageRun`; L-ADAPTER's runner takes a
`StageDefinition`-shaped input and L-UX's read model emits `Provenance`, both coded against §3 until P-1 lands and then
imported. The coordinator keeps calling `review/dispatch.ts` (L-ADAPTER's file) for an agent unit, so the native mode needs
no coordinator edit; the planner (L-PIPELINE) decides which units exist. Farsight's server imports no Sentinel code (ADR 18),
so the read model is served by Sentinel's own loopback host, the origin the companion uses today, and the viewer fetches it
cross-origin as it does the companion. The cleanup lanes finish their JSDoc PRs on `reports/` and `service/full-report.ts`
first, because L-PIPELINE's last PR takes those files over for the report fold.

Review and merge: Sol reads each PR's diff against its done-when and the owned-paths list and answers *may merge* or *not
yet* with findings at file:line; blocking findings go back to the lane; the lead merges with `gh pr merge --squash` after the
required checks are green, in the order lanes finish, and tells the running lanes to merge `main`. Docker runs only in
L-VERIFY's last step; every other lane exercises tool stages on the recorded fixtures with `SENTINEL_ISOLATION` unset. Live
model calls are allowed for L-ADAPTER's one acceptance per CLI under the stage budget; every other test replays recorded
wires.

## 10. The scan process today, against the owner's flow

Read on `main` at `5aad3a6b` on 2026-10-27 (`cli.ts`, `cli/`, the 33 files of `service/`, `planner/`, `execution/coordinator.ts`
and `supervisor.ts`, `review/dispatch.ts`, `review/providers/broker.ts`, `cli-copilot-call.ts`, `cli-native-call.ts`,
`owner-ui/operations.ts` and `server.ts`). This is L-VERIFY's checklist; each row is a place its V-1 run must reach.

| the owner's flow needs | today | where |
|---|---|---|
| add a repository from the GUI and load it | exists: Settings adds a source, *Sync* ingests it | `packages/server/public/app/shell.js` `addSource`, `syncNow`; `packages/server/src/index.ts` `PUT /api/settings`, `POST /api/sync` |
| press Scan | no button. The SENTINEL tab iframes a companion page at another origin; a run starts from the CLI or the companion's paired confirm | `surfaces/sentinel.js` (155 lines), `owner-ui/server.ts`, `index.ts` `/api/sentinel/companion` |
| one `scan` verb | none. A first scan is init, settings adopt, rules promote, plan, run `<id>` --confirm [--confirm-models], report, ids retyped; the profiles are `static`, `scanners`, `secrets`; `bundle` answers *PR 26* | `cli/args.ts` `COMMANDS`, `cli/init.ts` `PROFILES`, `cli.ts` the `plan`, `run` and `report` branches |
| read while a run is live | `plan`, `paths`, `run`, `retry`, `rerun`, `report --full`, `compare` and `report --instructions` refuse with `ownerServiceRunning`; `status` and the preview report go through the service | `cli.ts` the `live &&` branches and `fullReportCommand` |
| a declared pipeline | the stage set is derived: bootstrap capture, parse, inventory; then checks from rule × scope batched per adapter; then two review units appended to the sealed plan and its digest recomputed | `contracts/plan.ts` `PlanStage`, `ReviewPlanStage`; `planner/planner.ts` `planBootstrap`, `planAnalysis`; `review/plan.ts` `withReviewUnits` |
| a stage consumes another stage's output | one hard-coded case: the hosted review reads the Gitleaks publication | `review/dispatch.ts` `reviewSecretsKnown`, `requireHostedSecretCoverage` |
| rerun one stage | `rerun <run> --stage` takes unit ids, not stage ids | `service/local.ts` `followWorkspaceRun`; `cli.ts` the `retry`/`rerun` branch |
| choose the agent per stage | one provider binding per run from settings; the stage or segment choice is audit data and never admits a call | `review/providers/broker.ts` `openEnvelope`; `review/providers/selection.ts` `isApiKind` |
| the agent runs its own loop with skills | both CLIs are single-turn text engines: tools excluded, custom instructions off, Claude at `--max-turns 1`; skills are modelled (16 per stage) and always passed as `[]` | `review/providers/cli-copilot-call.ts` `copilotInvocationArguments`; `cli-native-call.ts` the argv block; `service/review-adapter.ts` `skills: []`; `review/instructions.ts` `INSTRUCTION_LIMITS` |
| edit the prompt | the prompt is the bundled manifest's bytes; no verb promotes a stage pack | `review/plan.ts` `readReviewSpec` |
| a coded step on the host | no kind: `operation` runs in-process, `external` in a container, `built-in` as a child from a closed list; the supervisor branches on the kind nine times | `execution/supervisor.ts`; `contracts/work.ts` `StageKind` |
| every stage's provenance one click away | stored (tokens, cost, image and prompt digests, container or child) but not folded for a reader; the companion lists hashes; the service's op table has no scans list and no stage read | `owner-ui/process.ts`; `service/owner-service.ts` the op switch |
| the qualified Copilot on this machine | the profile pins 1.0.103 and its package cache path; 1.0.105 is installed, so the call is `capabilityUntested` until re-qualified | `review/providers/cli-copilot-profile.ts` |
| capabilities for a human | the human output crashes after two rows; `--json` works | `capabilities.ts` |
| cost | a subscription CLI records `null`; nothing prints `unobserved` | `review/providers/broker.ts` settlement; `providers/budget.ts` |
| the read model without Farsight importing Sentinel | ADR 18 holds: the companion's loopback host is the only place to serve it | `packages/core/src/sentinel-companion.ts`; `owner-ui/host.ts` |

Five of these decide the slice: no `scan` verb and no run list; reads refused while the service holds the store; the stage
set derived, closed and sealed; both CLIs stripped to single-turn text engines with skills `[]`; the UI an iframe to the
coordinator's objects with no door from a source. The rest are what the lanes close on the way.

## 11. The phases as reference

The phase order below was the plan of 2026-10-23. Since 2026-10-27 the lanes in §9 are the order; every task in tasks.md's
phase tables is mapped to a lane or to the follow-ups table there, so the definitions stay and nothing is lost.

| phase | what lands | why in this order | done when |
|---|---|---|---|
| 0 · hygiene | Prettier, ESLint, lefthook, the CI `lint` check, one reformat PR with a blame-ignore rev | a refactor of unformatted, unlinted code cannot be reviewed; every later PR is readable | `pnpm lint` and `pnpm format:check` pass on `main` and are required checks; the reformat changed no compiled output |
| 1 · carve | kernel, guardrails, moves with shims, the four interfaces, the facade, the ledger ports, the flag registry | the pipeline model needs seams to plug into; the UI needs one facade to read through | no transport imports internals; digests on the fixtures byte-identical; the qualified Copilot path passes its workflows unchanged |
| 2 · declare | `pipeline.json`, stage contracts, typed inputs, stage packs, composite admission, host scripts, reports by output type, stage rerun and compare, one `scan` command | this is the product the owner asked for; it is built on phase 1's seams | the default pipeline plans to today's units; a custom agentic stage runs on the fixture and feeds the report |
| 3 · surface | the read model, the five stops, configure in place, compare, the gate-card chip, the companion retired | the data exists after phase 2; the UI only draws it | the six mocks drawn from the fixture with zero page errors; business register clean; outsiders explain a finding from the PATH stop |
| 4 · runners | `AgentRunner` native mode, Claude CLI qualified, Copilot native mode, custom prompts and skills, hosted API behind the flag, cost on every stage, per-entry fan-out | qualification is paid and slow; it runs beside phase 3, not before it | both CLIs pass the isolation, zero-contact and replay controls on macOS arm64 and Linux amd64 |
| 5 · release | Farsight 0.4.0 and Sentinel 0.1.0 through the release PR flow; the deferred gates | unchanged from the closeout | published URLs install in clean npm-only prefixes |


**The bar, in Farsight's own words:** a person who opens Sentinel on a real application understands what was checked,
by what, where it ran and what it cost, before they understand the tool; and from any entry point they can read the
whole path under it and see what sits on it.
