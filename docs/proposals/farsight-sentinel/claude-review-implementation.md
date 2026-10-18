# Farsight Sentinel implementation plan: independent review

Reviewer: Claude (Fable 5.1) · 2026-10-17 · branch `codex/sentinel-implementation-plan` (uncommitted) in its own
worktree, application baseline `4fce1c8` verified against the primary checkout. Files reviewed:
[implementation plan](implementation-plan.md), [PR build plan](implementation-prs.md),
[implementation examples](implementation-examples.md), the handoff paragraph and the proposal link on this branch.
The earlier [proposal review](claude-review.md) and [response](codex-response.md) were read for context and are
unchanged. Findings use [Conventional Comments](https://conventionalcomments.org/). **Verified** means read in the
code at `4fce1c8` or executed today; **inference** is my reading of what that implies.

What this review did: read all three documents in full; checked every import, option and export the examples
name against `packages/code-parser` and `packages/graph`; executed the SQL skeleton under Node 24.21.0 (SQLite
3.53.4) with probe inserts; read `scripts/lint-commits.mjs`, `scripts/ci-changes.mjs`, `.gitleaks.toml`,
`.gitignore`, `.farsight/settings.example.json`, `packages/server/src/guard.ts`, `packages/work/src/gate.ts`,
`packages/mcp/src/tiers.ts`. No scanner, container, model or build was run; the primary checkout and both
dogfood servers were not touched.

## 1. Verdict

The three documents are buildable and faithful to the proposal and to the review's dispositions. The four
identities (snapshot · run/plan revision · attempt · report revision), the five-way split of applicability,
execution, coverage, producer and outcome, the publication-uniqueness design and the refusal to let a model or
a repository config approve anything are exactly the shape the proposal needed. I would agree PR 00 with the
changes below, the first two before PR 01 is dispatched.

1. **Sentinel never meets Farsight's own lens.** Across the proposal, the plan, the PR plan and the examples the
   words *journey*, *screen* and *persona* do not appear once (§2.1). A finding on a route that is not placed on
   the screen and journey that reach it, with a sentence in the business register, fails principle 3 (two
   audiences, same nodes) and the bar the product is judged against. The fix is small because the plan already
   keys framework facts on canonical node ids; it has to be in PR 19's report fold and PR 25's scope.
2. **The deterministic product waits for the model lanes.** PR 23 (MCP) depends on PR 22 (agent review, with
   E5's 300 case evaluations), and PR 25 (GUI) depends on PR 23, so no reader sees a deterministic Sentinel
   result in the viewer until the model review is accepted (§2.2). Split PR 23 and the GUI lands three PRs
   earlier, which is also when the reviewer swarm can look at it.
3. **Six repository conventions are missed** (§2.3–2.8): the trusted settings file and its `.example` twin,
   the gitignore entry, the fixtures in a public and secret-scanned repository, test skipping under `pnpm -r
   test`, the `sentinel` commit scope and the branch prefix, and the three-verdict gate that already exists for
   agent writes.
4. **The SQL skeleton's `revision` column is dead** as written: `work_units.id` is the primary key, so a second
   revision of the same work id is rejected (§2.7, executed).

## 2. Findings, ranked

### 2.1 issue (blocking before PR 25): a finding has no place in the product

**Verified.** `grep -ci journey` over `farsight-sentinel.md`, `implementation-plan.md`, `implementation-prs.md`,
`implementation-examples.md`, `contracts.md`, `codex-response.md` returns 0 for every file; *screen* appears
once in the plan and once in the PR plan, both meaning a display. The GUI PR (25) lists overview, checks table,
execution timeline, finding evidence, decision proposal and comparison. Nothing names the screen, the journey or
the persona a finding reaches, and nothing names the business-register sentence for a check, a gap or a decision.

**Why it matters.** AGENTS.md's bar is *"a person who opens Farsight on a real application understands the app
before they understand the tool"*, and principle 3 says every feature works for developers and business users.
The outsider demo (handoff item 19) showed that the business register is where readers go wrong; a security
surface that speaks only in rules, engines and CWE ids repeats that. The data to place a finding exists: the
plan's framework facts and `SourceEvidence` carry `nodeId`, and core already folds a node to the journeys and
screens that reach it for `affected` and `impact`.

**Recommendation.**
- PR 19's report fold emits, per finding and per coverage gap, a `place`: the canonical node id, the screens
  and journeys that reach it (through the existing core folds, never a new scan), with `Counted`s over
  `count.scope.*` scopes listed in `docs/COUNTS.md`. A finding on a file with no application node has an
  empty place, said in words.
- PR 25 draws the place on every finding row and adds one Sentinel chip to the surfaces a reader already uses:
  the gate card and the Map property's *Gates & rules* tab, only when the bridge is configured, reading the
  pinned report, never computing. The business register says *check · gap · decision · evidence*; the code
  register keeps rule ids, engines and CWE.
- PR 23's MCP `describe_node` and `gate` answers gain a `## sentinel` section under the same condition.
- Add a sentence to §3 of the plan: *"A finding is a view over the one graph: it is placed on the screens and
  journeys that reach its node through core's existing folds."*

### 2.2 suggestion (non-blocking): split PR 23 so the deterministic GUI does not wait for model review

**Verified.** PR plan §2: PR 23 depends on 20 and 22; PR 25 depends on 23 and 24; PR 22 depends on 18–21 and
its gate is E5 (two models, 30 labeled cases, five trials). The milestone table puts the first usable release
at 23–26.

**Inference.** The critical path to a reader seeing a Sentinel result in the viewer runs through the model
lanes, although the plan's own summary says *"deliver a complete deterministic scan before adding framework
semantics and model review"*.

**Recommendation.** PR 23a: MCP read and mutation tools over deterministic runs (depends on 20). PR 23b: fenced
external review claims (depends on 22). PR 25 depends on 23a and 24; model-review views are added additively
by PR 22 or a 25b. Name a shippable checkpoint after PR 25 (*deterministic release*) distinct from the first
release that includes optional model review. Also add a wave table, because this repository implements in
parallel worktrees (AGENTS.md § Dispatching subagents): 01 → 02 → {03 ‖ 07} → 04 → 05 → 06 → 08 → 09 →
{10 ‖ 11 ‖ 12 ‖ 13 ‖ 14 ‖ 15 ‖ 16 ‖ 17 ‖ 21} → {18 ‖ 19 ‖ 24} → {20 ‖ 23a} → {22 ‖ 25} → {23b, 26}. The
file-ownership columns already make this safe; say which contract files are frozen at 02 and 07 so adapter
lanes do not edit them.

### 2.3 issue (non-blocking, required in PR 03 and PR 21): local config and data paths follow the repository's rules

**Verified.** `.gitignore` ignores `.farsight/cache/`, `.farsight/farsight.db*`, `.farsight/work.db*`,
`.farsight/graph@sync-*.json` and `.farsight/settings.json`; nothing covers `.farsight/sentinel/`. The plan
names no settings file for the trusted policy, provider endpoints or credential references. Echo's precedent is
`.echo/settings.example.json` and `.echo/connection.example.json` beside the untracked files. AGENTS.md: *"Local
config is never tracked; each file has a scrubbed `.example` twin … a new local config gets its twin in the same
change"*, secrets are `keychain:farsight/<provider>-<instance>` references read in-process, and `GET
/api/settings` serves the settings file back wholesale, so a value there would leak.

**Recommendation.** PR 03 adds `.farsight/sentinel/` to `.gitignore`. PR 06 (policy) names the trusted settings
file, say `.farsight/sentinel/settings.json`, ships its `.example` twin, and states that the viewer's settings
route never serves it. PR 21 uses the keychain reference form for every provider credential and the Echo
`secrets.ts` pattern for reading it, and says so in `docs/SECURITY.md`'s secrets section.

### 2.4 issue (non-blocking, required in PRs 01, 11, 12): fixtures in a public, scanned repository

**Verified.** CI's required `secrets` job runs gitleaks 8.30.1 over every commit with `.gitleaks.toml`, whose
allowlist is by line with a stated reason per entry. The dogfood workspace excludes `examples/**`
(`.farsight/settings.example.json`), so fixture code under `examples/sentinel/` will not enter Farsight's own
graph. There is no `.github/dependabot.yml`; GitHub still raised three alerts on example manifests, cleared in
PR #30 (handoff item 9).

**Inference.** PR 11's synthetic secrets will fail the `secrets` check unless they use formats gitleaks' default
rules already allowlist or get line entries with reasons. PR 12's known-vulnerable lockfile will raise Dependabot
alerts on the repository. Vulnerable-by-design TS and Java under `examples/` is also what GitHub code scanning
and any future Sentinel dogfood run will flag on Farsight itself.

**Recommendation.** Fixture secrets use documented dummy formats (the AWS `…EXAMPLE` key, a gitleaks test value)
and each gets a `.gitleaks.toml` line entry with its reason. Fixture manifests and lockfiles carry a
non-manifest name (`package-lock.fixture.json`) and are renamed into the materialized tree by the test. A
paragraph in `docs/SECURITY.md` says why vulnerable fixtures exist and where. Prefer `packages/sentinel/test/
fixtures/` over `examples/` for anything that is not a walkthrough a reader opens.

### 2.5 issue (non-blocking, required from PR 03): tests that need SQLite, a container runtime or a kill harness

**Verified.** `scripts/ci-changes.mjs` maps `packages/<anything>/` to validate and e2e, so Sentinel's unit tests
run under `pnpm -r test` in the required `validate` job from PR 02 on; `scripts/sentinel-feasibility.mjs` falls
to the *unknown path → all checks* branch. The plan defers dedicated Sentinel CI selection to PR 26. The live
tracker tests are the precedent for opt-in tests: they skip with a reason unless `FARSIGHT_LIVE=1`.

**Recommendation.** From PR 03, every test that needs a container runtime, a real kill or more than a few
seconds skips with a printed reason unless an opt-in variable (`SENTINEL_ISOLATION=1`) is set; E4's twenty kills
per boundary are an opt-in gate with a CI-sized subset (one kill per boundary) in `validate`. Register the
selector rule and the `sentinel-package` job (the `echo-package` shape) in PR 02, not PR 26, so a tarball check
exists before the adapters land, and update `docs/CI.md`'s table in the same PR.

### 2.6 suggestion (non-blocking): reuse the three-verdict gate for approvals and paid admission

**Verified.** `packages/work/src/gate.ts` exports `decideGrants()` (line 73), `GrantDecision { verdict, grant,
requiresConfirmation }`, `evaluatePolicy()` and `credentialVerdict()`; `farsight affected --post` and every
tracker write print the three verdicts (policy · tracker · credential), exit 2 while waiting for `--confirm`,
and agents confirm through a person. The plan's §11 invents *"a trusted local owner action"* for disposition
approval, rule promotion and tool acquisition, and §10 a separate admission check for paid model calls.

**Recommendation.** Express owner approvals and cost-bearing admission as `decideGrants` decisions with the same
three verdicts and the same `--confirm` flow, so MCP agents, the CLI and the GUI's future owner-control flow share
one vocabulary and one test suite. Note the exit-code collision: `farsight work …` exits 2 for *waiting for
confirmation*, Sentinel exits 2 for *required coverage incomplete*. If `farsight sentinel …` aliases the CLI,
either document the two meanings beside each other or renumber Sentinel's codes before PR 09.

### 2.7 issue (non-blocking, fix in the examples now): the SQL skeleton cannot hold a second work revision

**Verified by execution** (Node 24.21.0, SQLite 3.53.4, `PRAGMA foreign_keys = ON`, the skeleton as written):

| probe | result |
|---|---|
| insert `work_units ('w1', run, revision 2)` after revision 1 | `UNIQUE constraint failed: work_units.id` |
| two attempts on `w1` revision 1 | accepted |
| publish attempt 1 | accepted |
| publish attempt 2 for the same work revision | `UNIQUE constraint failed: publications.work_id, publications.work_revision` |

The publication constraint does what the examples claim. The revision column does not: with `id TEXT PRIMARY
KEY`, `UNIQUE (id, revision)` is implied and a work unit can never have a second revision, so *"a rule/model/
policy change … creates a child run"* with the same work id and a new revision is impossible in this schema.

**Recommendation.** Either `PRIMARY KEY (id, revision)` on `work_units` with every foreign key already composite
as written, or drop `revision` from the skeleton and say a child run allocates new work ids. The index
`ready_work_by_run (run_id, id)` names a readiness the skeleton has no column for; name it for what it indexes or
add the `state` column. The handoff's *"the SQL skeleton executed with duplicate-publication rejection"* is true
and should also say the revision case was not probed.

### 2.8 suggestion (non-blocking): commit scope and branch names

**Verified.** `scripts/lint-commits.mjs` `SCOPES` has no `sentinel` (nor `graph` or `code-parser`, which PR
#115 did not add). AGENTS.md names branches `feat/…`, `fix/…`, `docs/…`, `chore/…`; the PR plan says *"branches
use `codex/`"*. The suggested titles are scopeless, which lints, but the changelog groups by scope.

**Recommendation.** PR 02 adds `sentinel` to `SCOPES` and its test; titles from PR 03 on read
`feat(sentinel): …`. Branch names follow AGENTS.md whichever provider implements; `codex/` is a worktree habit,
not the repository's rule.

### 2.9 suggestion (non-blocking): say how a parser read outside the manifest is detected

**Verified.** `ParseRepositoryOptions` at `4fce1c8` is `root, sourceId, signal, limits, inputs` plus the adapter
options; there is no reader or filesystem hook. `EdgeOccurrence.span` is documented as UTF-16 code units, end
exclusive (`packages/graph/src/graph.ts:1060`), which the examples' conversion note already assumes. The
subpath exports `@farsight/code-parser/adapters/tsjs` and `/adapters/java`, `createParser({ adapters })`,
`testFiles`, the five `ParserLimits` fields and `canonicalJson` from `@farsight/graph` all exist as written.

**Recommendation.** Plan §6 should say the mechanism: the parser only sees a private materialized tree, so the
integrity check is that every `analysis.inputs` fingerprint matches a captured object and that the materialized
tree's entry set equals the manifest; the walker's own skips (dot-directories, `node_modules`, `dist`,
`build`, `target`, `coverage`) are then the parser's completeness boundary, which the independent inventory
already covers. Praise: the UTF-16 → byte-offset conversion rule and *"reject an unconvertible citation"* are
right and rarely stated.

### 2.10 nitpick (non-blocking): the business register needs its words before PR 09

The catalog's RULE 5 bans developer units from the business register and `pnpm lint:strings` enforces it.
*SARIF*, *CWE-89*, *SCC*, *frontier*, *epoch*, *attempt* and *publication* will each need a business twin or a
fold into a plainer sentence. Add a small glossary table to the plan (code word → business word) and ship it as
`strings-sentinel.ts` in PR 09 so the GUI and reports never invent words later. `docs/COUNTS.md` is already named
for the new scopes; good.

### 2.11 nitpick (non-blocking): the Unix socket path

**Inference.** macOS limits a Unix socket path to 104 bytes. A worktree path of the depth this repository uses
plus `.farsight/sentinel/<name>.sock` can exceed it. Put the socket under a short runtime directory (`$TMPDIR` or
`XDG_RUNTIME_DIR`) named by a hash of the store path, record it in the ledger, and test the long-path case on
both hosts in PR 09.

### 2.12 question (non-blocking): is a container runtime an acceptable prerequisite for every scan?

The plan makes Linux containers mandatory for every external scanner, with no host-execution fallback, on macOS
and Linux. On macOS that means Docker Desktop, Colima, Podman or OrbStack, and a Linux VM whose memory bounds
E8's limits. Docker Desktop's commercial terms require a paid subscription above a company-size threshold (known;
not re-read today). The consequence is that a secrets scan of a small TypeScript repository needs a container
runtime installed. I agree with the rule; the owner should answer it knowingly in PR 01, and the setup guidance
should name the tested runtimes and their terms rather than *"Docker-compatible"*.

### 2.13 praise

The four identities in §5 and the applicability · execution · coverage · producer · outcome separation in §6 are
the clearest statement of *what a green cell means* in any Farsight document so far, and they match the
product's own *verified vs seen by a coverage run* rule. Precedence 3 → 2 → 1 → 0 on exit codes with every fact
kept in JSON is right. The acceptance cases in examples §11 are product behaviors, not implementation details,
and read as the test names they should become.

## 3. Verified facts, by location

| claim in the documents | where checked | result |
|---|---|---|
| imports and options in examples §1 | `packages/code-parser/package.json` exports; `src/types.ts`; `src/index.ts:22` | all exist as written at `4fce1c8` |
| `canonicalJson` from `@farsight/graph` | `packages/graph/src/portable.ts:13`, re-exported by `index.ts` | exists |
| spans need UTF-16 → byte conversion | `packages/graph/src/graph.ts:1060` | span is UTF-16 code units, end exclusive |
| SQL skeleton rejects a duplicate publication | executed under Node 24.21.0 / SQLite 3.53.4 | rejected; second work revision also rejected (§2.7) |
| core's SQLite driver | `packages/core/src/snapshots.ts:21` | built-in `node:sqlite`, consistent with the plan |
| `isWriteRoute` is an explicit list | `packages/server/src/guard.ts:87–93` | `/api/sentinel` writes must be added (PR 24 lists `guard.ts`) |
| MCP tiers | `packages/mcp/src/tiers.ts` | `core` / `all`; Sentinel tools outside core is consistent |
| `sentinel` commit scope | `scripts/lint-commits.mjs:19–22` | absent |
| CI selection for a new package | `scripts/ci-changes.mjs:8–33` | `packages/*` → validate + e2e; unknown scripts → all |
| secret scan | `.github/workflows/ci.yml:45–63`, `.gitleaks.toml` | gitleaks 8.30.1 on every commit, line allowlist |
| dogfood excludes examples | `.farsight/settings.example.json:10` | `examples/**`, `prototypes/**` excluded |
| `.farsight/sentinel/` ignored | `.gitignore` | not ignored |
| no journey, screen or persona in Sentinel docs | `grep -ci` over all ten files | 0 journeys everywhere; *screen* 2 hits, both meaning a display |
| no client name, home path or address in the three new files | grep | clean |
| the handoff's *twelve TypeScript examples* | counted fenced `ts` blocks | 12 |

## 4. Proposed edits, by file

- `implementation-plan.md` §3: add the one-graph sentence (§2.1); §6: the integrity mechanism (§2.9); §11:
  `decideGrants` and the exit-code note (§2.6); §12: the opt-in test rule (§2.5); a glossary table (§2.10);
  §1 table: name the tested container runtimes (§2.12).
- `implementation-prs.md`: split PR 23 into 23a/23b, re-point PR 25, add the wave table and the deterministic
  checkpoint (§2.2); PR 02 adds the `sentinel` scope, the selector rule and the package check (§2.5, §2.8);
  PR 03 adds the gitignore entry (§2.3); PR 06 names the settings file and twin (§2.3); PRs 11–12 the fixture
  rules (§2.4); PR 19 the `place` (§2.1); PR 25 the chip on the gate card and the Map property (§2.1); §4
  working agreement: branch names per AGENTS.md (§2.8).
- `implementation-examples.md` §5: fix the primary key or drop `revision`; rename the index (§2.7). §2: add
  `place` to the report-side type or note it is a fold, not a stored field (§2.1).
- `docs/AI-HANDOFF.md` paragraph: say the SQL probe covered duplicate publication only (§2.7).

## 5. What this review did not do

No scanner, container runtime, model or Sentinel code was run or exists. The container-licensing and socket-path
points are from memory and marked inference. The business-register and journey-placement finding is a product
judgement against AGENTS.md's principles, not a measurement; the outsider demo (handoff item 19) is the nearest
evidence for why it matters.
