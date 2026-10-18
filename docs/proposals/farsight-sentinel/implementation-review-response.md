# Response to the Sentinel implementation review

**Status:** incorporated into the PR 00 review draft, 2026-10-17. No Sentinel implementation has started.
**Baseline:** application `4fce1c8`; proposal PR #117 merged at `04c3c63`.

The [implementation review](claude-review-implementation.md) identified four material gaps: placement in
Farsight's application view, model dependencies blocking the deterministic GUI, missing repository conventions,
and a SQL key that prevented child work revisions. All four are addressed in the revised
[architecture](implementation-plan.md), [PR backlog](implementation-prs.md) and
[examples](implementation-examples.md). Both Claude reviews are preserved unchanged.

## Disposition of every finding

Numbers refer to section 2 of Claude's review. “Incorporated” means the plan now specifies the work and
acceptance evidence; it does not mean the planned runtime behavior has been implemented or validated.

| Review | Disposition | Change and execution gate |
|---|---|---|
| 2.1 — no application place | Incorporated, with an additional source-binding requirement | PR 19 projects findings **and gaps** onto canonical nodes, screens, journeys and personas using existing core folds and both registers. A pinned application-context artifact/receipt prevents placement against unrelated current code. PR 23a adds conditional MCP read sections; PR 25 adds the shared gate-card/Map Gates & rules chip. Test known placement, artifact-only inputs, mismatches and duplicate screen counts. |
| 2.2 — deterministic GUI waits for models | Incorporated | Split 23 into deterministic MCP **23a** and external claims **23b**. GUI **25** depends on 23a/24; **25b** adds model panels. **26** gates the deterministic release independently. The wave table respects full predecessor sets; model E5/E8 do not block deterministic shipping. |
| 2.3 — settings and data paths | Incorporated | PR 03 ignores `.farsight/sentinel/*` with a narrow exception for the tracked `settings.example.json`. PR 06 names live `settings.json`, digest-bound adoption outside the checkout and a redacted effective-policy view. PR 21 uses keychain references and no raw settings/credentials in HTTP output. |
| 2.4 — public fixtures | Incorporated | Fixtures start under `packages/sentinel/test/fixtures/` in 01. Secret fixtures use inert values and exact line allowlists, never directory exemptions. Vulnerable manifests/locks have fixture-only filenames and become ecosystem filenames only in temporary test trees. PRs 11/12 add conformance tests and security notes. |
| 2.5 — default tests and CI | Incorporated | PR 02 adds path selection and an actual lightweight package smoke job. Fast tests run in `pnpm -r test`; container/full-kill tests opt in with reasons. PR 07 adds isolation CI; PR 08 adds a bounded kill subset to selected validate runs and a separate full E4 job. Dedicated selected jobs fail missing prerequisites. |
| 2.6 — existing three-verdict gate | Incorporated with a narrower reuse boundary | PR 06 extracts the existing **pure policy matcher** into core, preserving Work exports and regression behavior. Sentinel supplies its own capability and credential/authority verdicts, plus scoped human receipts. Work's tracker session is not a model credential. Sentinel reserves exit **4** for confirmation; existing Work exit 2 and Sentinel coverage exit 2 remain unchanged. |
| 2.7 — revision column is ineffective | Fixed and executed | `(id, revision)` is the primary key. Attempt, active-attempt and publication references bind both fields. The index is `work_by_run_revision`. The expanded SQL probe accepts two revisions/two publications and rejects duplicates and cross-revision references. PR 03 inherits those regression cases; publication admission checks still belong to 08. |
| 2.8 — scope and branches | Incorporated | PR 02 registers `sentinel` in the commit linter/tests. The working agreement uses `feat/`, `fix/`, `docs/`, `chore/`; PR 00 is on `docs/sentinel-implementation-plan`. Its title is `docs: prepare Sentinel implementation for execution`. |
| 2.9 — parser reads outside manifest | Incorporated with an explicit limitation | PR 05 verifies the materialized entry set/bytes and returned `analysis.inputs` using each input kind's codec. Existing reader bounds reject escapes/symlinks. There is no injected reader hook, and the plan does not claim syscall auditing of arbitrary native/custom adapters. |
| 2.10 — business vocabulary | Incorporated | Architecture section 11 gives code/business twins and definitions for SARIF, CWE, SCC, frontier, epoch, attempt, publication and evidence terms. Catalogs and lint precede PR 09's public commands; placement uses application sentences. |
| 2.11 — Unix socket limit | Incorporated and source-checked | PR 09 uses a short owner-only runtime directory and a byte-length check with terminator space. Long/multibyte paths, stale sockets, ownership and collisions are acceptance cases. Apple's source declares 104 bytes; it is linked in the architecture. |
| 2.12 — container prerequisite | Owner decision pending | External scanners require containers under the proposed policy; parsing/planning do not. PR 01 tests exact selected Linux/macOS runtimes and records installation, VM limits and terms. Docker Desktop subscription terms and Colima's project/license were checked; neither is claimed to be a validated Sentinel backend. The owner's answer is needed before external-scanner probes, not before reviewing PR 00. |
| 2.13 — identities, coverage and exit behavior | Preserved | Keep snapshot/run/attempt/report identities and explicit work revisions; applicability/execution/coverage/producer/outcome separation; final exit precedence 3 → 2 → 1 → 0; product-behavior acceptance cases. Confirmation exit 4 is pre-admission, not another completed-scan verdict. |

## Clarifications made while applying the review

**Placement needs an input, not only a fold.** The portable parser output has no journey enrichment. Calling
`flowWalks` on that artifact would not produce the promised screen/journey association. PR 19 therefore owns
capture and verification of application context, or bounded derivation from captured local design/config
inputs. A matching commit alone is insufficient: source identity, parser/config inputs and enrichment must
be bound. Missing or mismatched context gives an explicit unplaced result. Reachability remains navigation
evidence, not proof of a feasible exploit or successful authorization.

**The reusable gate is the policy matcher.** `packages/work/src/gate.ts` exports generic `decideGrants`, but
its `credentialVerdict` checks a tracker-specific session. Copying the whole gate or manufacturing a tracker
session would give Sentinel a misleading approval claim. Extract the generic matcher/types to core with an
ADR and compatibility re-export; retain separate provider capability and credential checks. A caller name,
`--confirm` token alone, or model output cannot establish human authority. The owner-control flow issues a
bounded receipt, and the coordinator rechecks/consumes it atomically.

**Parallel waves must preserve dependencies.** The new table permits framework lanes only after the common
contract/CLI slice, paths after the pattern/framework lanes, and reporting after the complete deterministic
set. PR 23a and the host bridge share an agreed schema and can proceed together. Model review remains a
separate continuation. Shared core/catalog/CI files have one integration owner rather than concurrent editors.

**Ignoring a directory cannot hide its example twin.** The planned ignore rule excludes its contents with
one exception, instead of ignoring the parent directory and then trying to re-include an unreachable file.
Fixture naming also has an explicit discovery check; a renamed JSON file is not assumed sufficient for every
ecosystem. These are implementation acceptance requirements, not configuration changes made by PR 00.

## Validation performed for this revision

The SQL example was executed under **Node 24.19.0 / SQLite 3.53.3**. Nine behavior checks passed: parent/child
work revisions coexist; each active attempt binds to its revision; cross-revision publication is rejected;
cross-revision active-attempt assignment fails at commit and rolls back; both revisions publish; a retry
cannot publish again; an identical duplicate is rejected; an attempt cannot reference an absent revision;
and a duplicate work revision is rejected. The final ledger has two work revisions and two publications,
with empty foreign-key diagnostics and `integrity_check = ok`.

The earlier probe covered duplicate publication and integrity only. It did not test a second work revision;
Claude's finding was correct. The handoff now makes that limitation and the expanded result explicit.
TypeScript examples are illustrative contracts/orchestration; syntax checking is not full typechecking or
runtime proof. The seven-file documentation check passed 50 local links (including three anchor targets),
one JSON block and 13 TypeScript blocks' syntax. Whitespace checks passed and both review SHA-256 hashes match
their pre-edit values. Mermaid blocks were counted, not rendered. No application build, scanner,
container, model, ingest or dogfood-server operation is needed for these ordinary Markdown edits.

## Next action

Review PR 00 and the [execution-readiness table](implementation-prs.md#4-execution-readiness-and-decision-record).
The three confirmed owner choices remain unchanged: local first with a hosted option, source-only first,
Ollama plus a configurable hosted endpoint. Record the container-prerequisite answer and agree the revised
plan before dispatching PR 01. PR 01 then produces the capability/decision manifest and measurements needed
to select exact engines, framework releases and thresholds. No planned support is advertised as shipped.
