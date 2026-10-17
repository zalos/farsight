# Farsight Sentinel proposal: independent review

Reviewer: Claude (Fable 5.1) · 2026-10-17 · branch `codex/farsight-sentinel-proposal` at `2ca7f2b`, with the proposal
files uncommitted in the worktree. This review is research and design only. No scanner was installed or run, no model
was called, nothing was built, and the primary checkout and the dogfood servers were not touched. Every web source
below was read on 2026-10-17; every code citation names the revision it was read at.

Files reviewed: [the proposal](../farsight-sentinel.md), [contracts](contracts.md), [scanner research](research-scanners.md),
[workflow research](research-workflows.md), [repository fit](repository-fit.md), the handoff addition on this branch,
and the companion [analysis-core research](../../research/analysis-core-options-2026-10-17.md).

Three labels are used throughout. **Verified** is something I read in the code at a named revision or on a primary
source page on the access date. **Inference** is my reading of what that implies. **Recommendation** is what I would
change. Findings use [Conventional Comments](https://conventionalcomments.org/).

## 1. Verdict

The proposal's spine is right and should stand: one application graph with a separate execution ledger, content-addressed
immutable artifacts, a frozen check plan whose coverage is reported beside findings, observations kept apart from
dispositions, deterministic validation of everything a model says, and model providers off by default. The research
appendices are unusually careful about what documentation does and does not establish. I would proceed to increment A.

Four things have to change before increment B starts, in this order:

1. **The reviewed base is stale.** PR #115 (the parser-library extraction) merged into `main` at `4fce1c8` on
   2026-10-17 at 18:37 UTC, after the proposal pinned `2ca7f2b`. It changes four rows of the fit table and two of the
   proposal's Phase 1 requirements, mostly for the better: call sites survive as `occurrences`, and the new
   `parseRepository()` already returns per-file outcomes, structured diagnostics, exact input fingerprints and a
   `complete` flag. The proposal should consume that contract rather than re-specify it (§2.1).
2. **The design still has four places where it would print a clean result it cannot support**: a Spring endpoint's
   protection, an Express or Nest route's middleware, a file the walker never saw, and a scanner that skipped files
   silently (§2.2). The fixes are contract rules, not engineering: *unknown* is the default verdict, the inventory is
   the denominator, and every adapter must report what it skipped or be marked aggregate-only.
3. **The licence and offline facts need five corrections**, the sharpest being that the CodeQL CLI terms permit far
   less than "free for public repositories and licensed private use", and that three of the four Java "no build"
   paths still perform network dependency resolution by default (§2.3).
4. **The differential design can conceal a new vulnerability in three cases it does not list** (a framework version
   bump that changes semantics without a code edit, a rule narrowed rather than retired, and a heuristic re-resolution
   after a rename), and finding identity should now use the occurrence ids #115 made stable (§2.4).

The execution machinery is more than the first release needs. Leases, heartbeats and fencing are only required on the
one path where a worker lives outside the coordinator's process tree (client-hosted agent review over MCP). For
child-process workers on one host, a coordinator restart interrupts every leased attempt by construction. I recommend
the simpler protocol in §2.6, which halves the state machine that increment B must prove with kill tests.

## 2. Findings, ranked by severity

### 2.1 issue (blocking): the base revision is stale and the fit table describes superseded code

**Verified.** `gh pr list` shows PR #115 `feat(parsers): extract publishable graph and code parser libraries` merged
2026-10-17T18:37:02Z; `origin/main` is `4fce1c8`, one commit past `2ca7f2b`. The worktree and the primary checkout
are both still at `2ca7f2b`. At `4fce1c8`:

| Fit-table row ([repository-fit.md](repository-fit.md) § Verified reuse and gaps) | At `2ca7f2b` (as written) | At `4fce1c8` (now) |
|---|---|---|
| Parser package: "no extracted analyzer package is present" | true | `packages/graph` (`@farsight/graph` 0.1.0, MIT) and `packages/code-parser` (`@farsight/code-parser` 0.1.0, MIT) exist; `@farsight/parsers` depends on both; ADR 11 and `docs/PARSER-LIBRARIES.md` describe the boundary |
| Repeated calls: "adjacency collapses repeated call sites" | true (`store.ts` keyed `kind\|from\|to`) | still keyed that way, but `addFragment` now merges `occurrences` across the collapse (`core/src/store.ts` lines 64–69); `GraphEdge.occurrences?: EdgeOccurrence[]` with `id`, `loc`, `span`, `conditions`, `resolution` (`graph/src/graph.ts` lines 1050–1065). `parseRepository()` always retains them; `ingestRepo()` omits them unless `{ occurrences: true }` (`parsers/test/occurrence-option.test.ts`) |
| Parse omissions: "add per-file outcomes before claiming parsed coverage" | true (`catch { continue }`) | `parseRepository()` returns `AnalysisArtifact.analysis` with `files: FileAnalysis[]` (`analyzed \| skipped \| failed` + reason), `diagnostics: Diagnostic[]` (codes `parse-error \| read-error \| read-boundary \| resource-limit \| cancelled \| unsupported \| adapter-error`), `inputs: InputFingerprint[]`, `fingerprint`, `complete`, `capabilities`, `limits` (`code-parser/src/types.ts` lines 43–84). Both adapters now call `parseError()` and mark the file `failed` (`code-parser/src/tsjs.ts` lines 384–392, `java/index.ts` lines 105–110) |
| Incrementality: "do not describe semantic incremental caching as built" | true | still true; the artifact has exact input fingerprints, which is the input to a cache, not a cache |
| Input inventory and digest rows | true | still true: the walker skips every dot-directory and `node_modules, dist, build, target, .git, coverage` (`code-parser/src/shared/files.ts` lines 11 and 55); `repoContentDigest` is still over adapter extensions only |
| Java resolution, middleware, cross-service rows | true | unchanged in substance; the code moved to `packages/code-parser` so the line numbers no longer hold |

PR #115's body also records a real-ingest comparison the proposal can cite: 6,343 nodes and 13,536 edges byte-equal
between `main` and the PR by default, and the earlier measurement with occurrences on (`graph.json` 18.0 → 26.9 MB,
`farsight.db` 24.3 → 32.4 MB on this repository). That is the cost of per-site evidence in the *application* graph,
which is exactly why Sentinel should keep it in its own artifacts, as the proposal already says.

**Inference.** The proposal's Phase 1 sentence "the implementation must add complete per-file parse diagnostics" is now
half true: `parseRepository()` has them; whether the legacy `ingestRepo()` composition path (the one Farsight's own
sync uses, and the one the proposal says to wrap) retains them is not established by my reading. `ingestRepo` at
`4fce1c8` exposes no `diagnostics` or file outcomes on the fragment (`parsers/src/index.ts`, grep). Experiment E1
settles it.

**Recommendation.**

- Re-pin every file to `4fce1c8`. Replace the four rows above. In the proposal, replace "Any public parser extraction
  in PR #115 must be checked when implementation begins; the reviewed base is `2ca7f2b`" (§2, *Proposed package
  boundaries*) with: *"PR #115 merged at `4fce1c8`. Sentinel's snapshot stage consumes `@farsight/code-parser`'s
  `parseRepository()` artifact (fingerprints, file outcomes, diagnostics, `complete`) and `@farsight/graph`'s portable
  document; it does not wrap the application's `ingestRepo()` for inventory or coverage."*
- Sentinel needs both APIs: `parseRepository()` for the bounded, fingerprinted extraction with diagnostics, and
  `ingestRepo()` (with `design: false`, `openapi` reading local files only, a stripped environment so the Figma call in
  `parsers/src/design/index.ts` lines 63–73 cannot fire) for the enrichment Farsight's guards, routes, contracts and
  journeys depend on. Record which of the two produced each fact. If `ingestRepo` cannot be made to return the file
  outcomes, Sentinel's coverage denominator comes from `parseRepository()` and `ingestRepo` is enrichment only.
- Use `EdgeOccurrence.id` ("stable for a source, span and relationship") as an anchor in finding fingerprints (§2.4).
- The handoff paragraph on this branch says "The parser extraction described in PR #115 is not present at this
  proposal's base"; change it to say it merged the same afternoon and that the proposal was re-pinned.

### 2.2 issue (blocking): four ways the design would imply a clean result

Each item below names where a report could say *no finding* or *protected* when the honest word is *unknown*.

**(a) A Spring endpoint's protection.** Verified: the Java adapter models only method-level annotations
(`SECURITY_ANNS = PreAuthorize, PostAuthorize, Secured, RolesAllowed`, `code-parser/src/java/spring.ts` line 79) and no
`SecurityFilterChain`, `HttpSecurity`, `securityMatcher`, `@Order` or filter registration (grep over
`code-parser/src/java/index.ts`, no hit). Spring's own documentation says "only the first `SecurityFilterChain` that
matches is invoked" (Spring Security 7.0.7 architecture page), that a chain without a `securityMatcher` matches every
request and that **"if no filter chain matches a particular request, the request is not protected by Spring
Security"**, and that a `securityMatcher` "does not automatically affect endpoints provided by the filter chain"
(7.0 Java configuration page, *Multiple SecurityFilterChain instances*). Inference: until the Phase 2 Spring layer
pack exists, every Spring endpoint's authentication status is *unknown*; an annotation can raise a candidate finding
but never clear one. Recommendation: add to contracts §3 a rule that a check requiring the `framework-order` capability
is `unsupported` (never `complete` with no finding) when no stage with that capability ran. Add the "catch-all chain
missing" case and the "`securityMatcher` vs `requestMatchers` mismatch" case to the fixture gates in
[research-scanners.md](research-scanners.md) § Java/Spring Boot requirements.

**(b) An Express or Nest route's middleware.** Verified: the TS/JS adapter recognises a route-argument call whose name
starts `require|ensure|check|assert` as a guard (`heuristic`, MEDIUM, "nobody declared it a guard",
`code-parser/src/tsjs.ts` lines 1216–1231) and a `middleware.ts` beside an `app/` directory as guarding every entry
beneath it without reading its matcher (lines 1284–1296). A grep for `app.use`, `router.use`, `.use(`, `UseGuards` and
`@Controller` finds nothing. Inference: `app.use(auth)` ordering relative to route registration, router mounts, Nest
global guards, interceptors and pipes are not modelled at all today; the proposal's Phase 2 TS/JS list is net-new
work, and "Next matcher excluding a route" is a correctness bug waiting in the current heuristic (a `middleware.ts`
with `config.matcher = ['/admin/:path*']` currently reads as guarding every page). Recommendation: the same
`unsupported`-by-default rule as (a), and a Next matcher reader as the first TS/JS layer deliverable, because the
existing heuristic over-claims today.

**(c) A file the walker never saw.** Verified: the walker skips every directory starting with `.` and the six
`SKIP_DIRS`, and selects files by adapter extension (`files.ts` lines 11, 55–58). So `.github/workflows/*.yml`,
`.gitlab-ci.yml`, `Dockerfile`, `*.tf`, `*.properties`, `target/generated-sources/**` and every Lombok or MapStruct
output are outside both the graph and `repoContentDigest`. The proposal already says Sentinel needs its own inventory
(Phase 1). Inference: the gap is which set is the *denominator* of the check matrix. If a check's scope is "the
parser's file set", a workflow file that no stage read is not a gap, it is invisible. Recommendation: in contracts §1
make `Snapshot.fileInventory` the authoritative set, classify every entry (`parsed · parse-failed · excluded-by-policy
· unsupported-type · generated · binary · too-large · symlink-refused · seen-by-no-stage`), and make *seen by no stage*
a row the report always prints with its count. Generated-source policy deserves its own line: `target/` and `build/`
are skipped by the walker, so a Spring app's generated code is unanalysed unless the build profile exists.

**(d) A scanner that skipped silently.** Verified on the Semgrep CLI reference: `--max-target-bytes` defaults to
1,000,000 bytes and "any input program larger than this will be ignored"; `--timeout` is 5 s per rule per file;
`--timeout-threshold` skips a file after 3 rule timeouts; none of those descriptions say the skip reaches the output,
only that a log may list skipped files. Inference: a minified bundle, a large generated client or a slow rule yields
an empty result that looks like a pass. Recommendation: contracts §3 already says adapters "must report the
granularity they can establish". Make it concrete: every scanner adapter declares `coverageGranularity: per-file |
per-file-per-rule | aggregate`, must parse the tool's skipped-file and timeout output when it exists (Semgrep's JSON
`paths.skipped` with reasons, Gitleaks and Trivy equivalents), and must raise the limits explicitly
(`--max-target-bytes 0` or a chosen bound, `--timeout-threshold 0`) with the chosen values in the invocation record.
A file the inventory holds that no scanner's scanned-set names is `not-run`, not `complete`.

### 2.3 issue (blocking): five licence and offline facts to correct

| Tool | What the proposal says | What the primary source says (2026-10-17) | Correction |
|---|---|---|---|
| **CodeQL CLI** | "free CLI use for public repositories and eligible licensed private use" ([research-scanners.md](research-scanners.md)) | The CLI terms ([codeql-cli-binaries LICENSE.md](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md)) permit: academic research; testing OSI-licensed queries; analysing an *Open Source Codebase*; and generating databases for automated analysis/CI "only for open source code hosted and maintained on GitHub.com". Use "in connection with any codebase that is not an Open Source Codebase" is not authorised unless under a paid GitHub Advanced Security licence; no redistribution, no hosting as a service. GitHub's docs page says the CLI "is free to use on public repositories" and in private repositories of organisations "with a license for GitHub Code Security" | Say it plainly: a private Spring or TS application may be analysed with CodeQL only when the customer holds GitHub Code Security / GHAS. Sentinel must never download the CLI; it detects a user-installed one, records an `entitlement: user-attested` field, and prints the term it relies on |
| **Semgrep CE** | "CE is LGPL; the Rules License permits internal use and prohibits distribution or as-a-service" | Correct, and incomplete. The Dec 2024 post adds: "Certain Semgrep-internal fields in JSON and SARIF outputs are now reserved for our logged-in commercial engine" and "features previously marked experimental are now part of our logged-in commercial engine". Metrics: `--metrics auto` (default) sends "whenever rules are pulled from the Semgrep Registry or the user is logged in"; local rule files send nothing | Never compute finding identity from Semgrep's output fields; Sentinel fingerprints its own. Run with `--metrics=off` and local rule files only; a `p/…` registry config is a policy violation (both the restrictive licence and the telemetry). Pin the CE binary digest |
| **Opengrep** | "a tracked alternative, not an assumed equivalent" | LGPL-2.1 fork of Semgrep 1.100.0; release 1.31.0 on 2026-10-15; self-contained binaries (no Python); "metavariable values and fingerprints are now included in both JSON and SARIF outputs"; `--taint-intrafile` cross-function within a file; interfile exists only as `v2.0.0-nopython-interfile.alpha.3` (2026-09-11) marked "FOR TESTING ONLY". `opengrep-rules` is a fork of semgrep-rules at 2024-12-13, "intended for research, testing & benchmarking", with no licence stated on the page | Opengrep is the better *default engine* for a redistributable tool (no Python, output fields intact), with the same rule-licence problem: original Sentinel rules either way. Do not plan on its interfile mode for v1 |
| **OSV-Scanner** | "Apache-2.0 … offline mode uses a previously downloaded database" | Correct. Also: the README calls the current line "OSV-Scanner V2 beta"; `pom.xml` transitive resolution is on by default, "deps.dev API is queried", and "it is also disabled in the offline mode" | Pin to a named release; in offline mode record that Maven coverage is *direct dependencies only* unless a lockfile exists; treat `--offline-vulnerabilities` as *not* a no-network guarantee (the page says so) |
| **Trivy** | "repository scans target lockfiles; misconfiguration off by default" | For `pom.xml`, Trivy "tries to find the information about these dependencies in the remote repositories" (declared release repositories, then Maven Central) unless `--offline-scan`, which "may skip some dependencies"; JARs trigger a Java DB download; the DB, Java DB and checks bundle come from `mirror.gcr.io/aquasec` then `ghcr.io/aquasecurity` with a fallback on 429/5xx; the checks bundle embedded in the binary is the offline fallback. Licence Apache-2.0 confirmed | Separate the three network behaviours in the stage manifest (`dependencyResolution: none \| local-cache \| remote`, `databaseFetch`, `telemetry`) and record each run's actual mode |

Two more that affect Java specifically. CodeQL's build mode `none` "will attempt to run Gradle or Maven to extract
accurate dependency information" and loses generated code, picks one version where several exist and warns about
colliding class names (GitHub docs, *build options for compiled languages*): the proposal reports this correctly.
Joern's `javasrc2cpg` is "powered by JavaParser", has `fetch-dependencies` to "attempt to fetch dependencies jars",
and its README still lists "Lambda expressions (dataflow still to-do)" and "Handle body of `try`/`catch`" as TODOs;
its data-flow engine "will treat external methods with no semantic definitions as able to propagate taint from all
arguments to all arguments including the return value" (docs, *dataflow semantics*). Inference: Joern without a
written Spring semantics file will flood false positives through every unmodelled framework call, and lambda-heavy
Spring code (WebFlux, streams) has an explicit data-flow gap. The JDK mismatch the proposal noted (README JDK 21,
installation page JDK 19) is confirmed.

### 2.4 issue (blocking): where reused results could hide a new vulnerability, and where identity breaks

The reuse table in [contracts.md](contracts.md) §4 is good. It misses:

1. **A framework version bump with no code edit.** The row *"Lockfile or advisory database → unrelated syntax
   artifacts reusable; refresh dependency assessment"* is wrong for the framework packs. Spring Security 6 → 7 and
   Next.js majors change what a matcher, a default chain or a middleware file *means*. The `StageManifest` already
   carries `frameworkVersions`; the fingerprint must include the resolved framework versions read from the lockfile,
   so a lockfile change invalidates every layer stage whose declared framework moved, not only the advisory stage.
2. **A rule narrowed, not retired.** Rule retirement "remains visible in comparisons". A new `RuleRevision` with
   narrower applicability turns yesterday's finding into *resolved by comparable check* unless the comparison requires
   the same rule revision or a recorded *compatible* mapping. Add `changed detection` as a comparison label distinct
   from `resolved`, emitted whenever the rule revision, engine digest or capability set differs between the two checks.
3. **Heuristic re-resolution after a rename.** The Java adapter resolves a bare receiver by simple name against the
   types it saw, "imports are not read" (LOW, `name-match`). Renaming a guard class, or adding a second class with the
   same simple name, silently re-points the edge. A differential run that reuses the caller's artifacts because the
   caller's bytes did not change would carry an edge that now means something else. Make `resolution.confidence` part
   of the reuse decision: a unit whose inputs include any LOW-confidence edge touching a changed or added declaration
   is never reused.
4. **Finding identity.** Use `EdgeOccurrence.id` for call-site anchors now that #115 made it stable per source, span
   and relationship, and define the versioned matcher's tie-break rules (same rule family + same anchor set = same
   issue; same rule + moved span within the same declaration = *probable*, surfaced for review). GitHub's SARIF
   matching uses only `primaryLocationLineHash` and requires `ruleId` to stay the same across analyses (GitHub SARIF
   support page), so the SARIF projection must set `partialFingerprints` from Sentinel's own fingerprint and keep
   `ruleId` as the rule *family* id, never a revision hash, or every rule update will open and close every alert.

### 2.5 issue (non-blocking, high): false positives and compensating controls need a deployment-assertion record

Verified in the proposal: observation, assessment, disposition and validity are separate; a disposition carries
actor, rationale, evidence hashes, environment and expiry; a changed control invalidates it; a gateway outside the
captured sources stays "unverified unless matched deployment/runtime evidence establishes it".

What is missing:

- **A record for the assumption itself.** "Our gateway protects this" is used by many dispositions. Give it its own
  `DeploymentAssertion` (owner, scope as routes/profiles/environments, evidence references, expiry, trust level:
  `asserted · imported-config · runtime-observed`). A disposition references it; its validity is inherited. An
  assertion with no evidence leaves every dependent disposition in state *asserted, unverified*, which the report
  prints and which **does not count as mitigated for the exit-code policy**. Today the proposal's `exit 1 finding
  policy failed` has no stated rule for an unverified mitigation.
- **Scope arithmetic.** A disposition's scope must be a subset of the finding's affected scope. A finding reached by
  three entry paths and a control proven on one is *partly mitigated*, shown per entry path; the proposal's
  "affected entry-point counts have their own scope" sentence implies this but the disposition record does not enforce it.
- **Invalidation by negative space.** The cookie example invalidates on a change to the control. Also invalidate when
  a *new* entry point reaches the same sink (the control was never proven for it), when the control's `guards` edge
  loses confidence, and when the snapshot's framework version changes (§2.4.1).
- **Expiry is a report fact.** "Reports pin evaluation time" is right. Add that an expired disposition reopens the
  finding on the next run automatically, with a comparison label `reopened: disposition expired`.

### 2.6 suggestion (non-blocking): a simpler worker protocol for the first release

**Verified.** Contracts §2–§3 specify leases, heartbeats, fencing generations and a four-step crash-safe publication for
every work unit. The workflow research correctly says SQLite is one writer on one host.

**Inference.** On one host with one coordinator and built-in workers as its child processes, three of the four hazards
the protocol defends against cannot occur: a worker cannot outlive the coordinator (process group), two coordinators
cannot run (the owner lock), and a worker cannot write the ledger (it has no handle). The only path where a late or
duplicate publisher exists is the client-hosted review: an MCP client claims a packet, the chat ends, another runner
claims the same work, and the first client submits later.

**Recommendation.** Keep the invariants (at-least-once execution, publication unique per accepted work revision,
atomic blob rename before the commit, fingerprint check at commit). Drop heartbeats and lease expiry for child workers;
on coordinator start, every attempt in `leased` becomes `interrupted` and its work `ready`. Keep the fencing generation
only in `sentinel_claim_review` / `sentinel_submit_review`, where it is the capability token the proposal already
describes. This removes the heartbeat timer, the expiry sweeper and two attempt states from increment B's kill tests
without weakening any guarantee a user can observe. Re-introduce leases when a second host exists, which the proposal
already defers to a Temporal-shaped backend.

Two smaller points in the same area. `pausing` that "can permit completion" while `canceling` cannot is right; write
down that a model call in flight at cancel time is charged and recorded as `canceled-after-spend`. And the plan should
state the default concurrency (one deterministic lane per core, one model lane) so the first user can predict wall time.

### 2.7 suggestion (non-blocking): evaluate agent findings against deterministic ones on labelled corpora, and treat the provider as the exfiltration channel

**Verified.** The proposal's lane 3 (rule-guided) and lane 4 (general) are attributed, budgeted, citation-validated and
cannot complete a deterministic check. OWASP's LLM01 page recommends privilege control, human approval for high-risk
actions, segregating untrusted content and adversarial testing. Simon Willison's "lethal trifecta" names private data +
untrusted content + an external channel as the exploitable combination. CamoLeak (Legit Security, October 2025) was a
real injection through hidden markdown comments in GitHub content that made Copilot Chat exfiltrate private source;
GitHub patched it. The VS Code `vscode.lm` API exposes `id`, `name`, `vendor`, `family` and `version` on a
`LanguageModelChat`, and MCP sampling responses carry a `model` field while leaving model choice with the client and
recommending a human in the loop.

**Inference.** Sentinel's agent lanes have all three trifecta elements by construction: the source is private, the
comments are untrusted, and a hosted provider *is* an external channel. The proposal's "no arbitrary shell or network
tools" is the correct containment; the residual risk is a model persuaded by a comment to under-report, which no
citation validator catches because "no finding" cites nothing. The proposal also has no stated method for deciding
whether an agent finding that a deterministic engine did not raise is worth a reader's time.

**Recommendation.**

- Add an **agreement matrix** to the report: for every agent finding, whether a deterministic engine raised the same
  issue (same fingerprint), a related one (same sink, different rule), or nothing. Agent-only findings are a separate
  section with their citation set, never merged into the deterministic count. Treat "deterministic found, agent
  silent" as a measured under-report rate per model.
- Add **canary cases** to the fixture corpus: comments and docstrings that instruct the reader to mark the function
  safe, to skip a file, or to rate severity low. Acceptance: zero influence across repeated trials (E5).
- Record the provider's **retention and training terms** as a field of the provider adapter, shown in the plan
  output next to "intended source disclosure".
- Prefer a **host-reported identity** when one exists: a future VS Code extension can read `vscode.lm` model identity,
  which is stronger than an MCP tool's self-report; keep `identitySource` as proposed and add `host-reported-vscode-lm`.
- Give `plan` a **cost estimate**. A general review that reads every file once costs about `characters ÷ 4` input
  tokens per pass. This repository's `packages/*/src` TypeScript is 59,316 lines and 3,559,049 characters (counted
  2026-10-17), so one full pass is roughly 0.9 M input tokens before any tool round-trips; a reference-app-sized
  codebase is comparable. Require `maxCostPerRun` and `maxTokensPerRun` in settings with a hard stop that records the
  frontier.

### 2.8 suggestion (non-blocking): package boundaries can be one package until a second consumer exists

**Verified.** The proposal proposes `packages/sentinel` and `packages/sentinel-cli` plus a host bridge, and says
"split more packages only when a second consumer needs it". ADR 11 and `docs/PARSER-LIBRARIES.md` now show what a
publishable boundary costs here: paired versions, tarball consumer tests on two platforms, a trusted-publishing
workflow, third-party notice files.

**Inference.** The host bridge talks to the installed service over local IPC, so the viewer never imports Sentinel.
Nothing then forces two packages: one `packages/sentinel` with a `bin` entry (`farsight-sentinel`) and the stdio MCP
server inside it satisfies "hosts the coordinator without requiring the viewer". The second package exists only to
keep scanner and model dependencies out of the viewer's install path, and one package with no runtime dependency on
`@farsight/server` does that too.

**Recommendation.** One package, one ADR, one `MAP-PACKAGES.md` entry; split when a non-Farsight consumer appears.
Keep the worker protocol versioned from day one so the split is mechanical later.

### 2.9 suggestion (non-blocking): ledger and artifact details

- **SQLite version gate.** Verified: SQLite's changes page lists "Fix the WAL-reset database corruption bug" in 3.51.3
  (2026-03-13) and again in 3.53.0 (2026-04-09); Node v24.21.0 on this machine reports `process.versions.sqlite` =
  3.53.4, and Farsight already uses built-in `node:sqlite` (ADR 7). Recommendation: at startup write
  `process.versions.sqlite` into the ledger header and refuse to open a ledger when the runtime's SQLite is below
  3.51.3; the proposal's "patched SQLite runtime" sentence becomes a one-line check instead of an operational note.
- **Codec.** Verified: Node 24's `node:zlib` has `zstdCompress` / `createZstdCompress` (added v23.8.0 and v22.15.0,
  Stability 1, experimental). Recommendation: keep gzip as the v1 codec as proposed, and benchmark zstd in increment A
  since it needs no packaging dependency; record `codec` and `codecVersion` per artifact as the contracts already say.
- **Retention across stores.** The proposal correctly says a Sentinel bundle must survive graph snapshot pruning.
  Verified: `SnapshotDb.prune({ keep, keepPinned })` deletes everything but the newest `keep` and pinned syncs
  (`core/src/snapshots.ts` line 490). Recommendation: Sentinel keeps its own copy of the graph artifact rather than a
  cross-store pin; a pin in `farsight.db` cannot protect a blob that lives elsewhere.
- **`/graph` isolation.** Verified: `/graph` returns the whole file (`server/src/index.ts` lines 908–918) and the
  proposal keeps Sentinel data off it. Keep that as an invariant with a test: no Sentinel field ever appears in
  `GraphStore.toJSON()`.

### 2.10 suggestion (non-blocking): standards pins and the reporting standards

- **OWASP Top 10:2025** is published at `top10.owasp.org/2025` with categories A01 Broken Access Control through
  A10 Mishandling of Exceptional Conditions (and A03 *Software Supply Chain Failures*, A09 *Security Logging and
  Alerting Failures*), while CWE's download page still lists the mapping view as "OWASP Top Ten RC1 (2025)" beside
  "CWE List Version 4.20". The fit note is right to pin artifacts and digests rather than labels.
- **ASVS** 5.0.0, CC BY-SA 4.0, CSV/JSON available: confirmed on the project page.
- **SARIF on GitHub**: 20 runs per file, 25,000 results per run (only the top 5,000 displayed), 10 MB gzipped, and
  `partialFingerprints` / `primaryLocationLineHash` matching. The proposal's "local report remains authoritative" is
  right; add the display cap (5,000) to the reasons, since a large first scan would silently hide results on GitHub.
- **OpenVEX**: four statuses; `not_affected` requires a justification or impact statement; `name` is the only
  required identifier. The proposal's restraint (VEX only for component-vulnerability claims) is correct.
- **MCP 2025-11-25**: tasks are explicitly "experimental" and capability-negotiated; sampling carries `model`. Both
  as the proposal states.
- **Temporal**: activities "may be executed multiple times and may even partially complete more than once", and the
  history records completion only when the activity returns. As the proposal states; keep it out of v1.

### 2.11 nitpicks (non-blocking)

- [research-scanners.md](research-scanners.md) cites Spring Security 7.0 and Spring Framework 7.1 pages; the
  Security page I read documents 7.0.7 and says 7.1.1 is current. Pin a version per framework pack and say which
  versions the pack was written against.
- [contracts.md](contracts.md) §8 exit codes: say what `--detach` prints (the run id) and that `status --wait` is the
  CI primitive, so the "CI must explicitly wait" sentence has a command.
- [contracts.md](contracts.md) §9: `"detectors": ["sentinel", "semgrep-ce", …]` names tools; make these adapter ids
  with a version pin in `tools.lock.json`, so a config file cannot select an unpinned binary.
- The proposal's Phase 1 says "ingest the snapshot through a policy-aware wrapper around the existing parser API";
  after #115 name the API (`parseRepository`) and the composition it does not perform (config, OpenAPI, design, tests).
- "Semgrep CE cannot supply general cross-file proof" is right; the glossary page also says CE "can include
  cross-function analysis" within a file, which is enough for many Express-handler patterns. Say both.

## 3. Verified facts, by revision

| Claim | Revision | Evidence |
|---|---|---|
| TS/JS and Java adapters registered; `ingestRepo()` is the one entry point | `2ca7f2b` | `parsers/src/index.ts` lines 51, 72 |
| Edges keyed `kind\|from\|to`; later metadata replaces earlier | `2ca7f2b` | `core/src/store.ts` lines 63–68 |
| Occurrences merged across the key; `ingestRepo` opt-in; `parseRepository` always | `4fce1c8` | `core/src/store.ts` lines 64–69; `parsers/test/occurrence-option.test.ts`; `docs/PARSER-LIBRARIES.md` |
| Parse failure: skip and continue, nothing recorded | `2ca7f2b` | `parsers/src/tsjs.ts` lines 351–356; `java/index.ts` lines 92–96 |
| Parse failure: `parse-error` diagnostic + `failed` file status | `4fce1c8` | `code-parser/src/tsjs.ts` 384–392; `java/index.ts` 105–110; `repository.ts` 193–204 |
| Walker skips dot-directories and six names; selects by extension | both | `files.ts` (`SKIP_DIRS` line 11; `!entry.startsWith('.')`) |
| Java calls: field-type DI binding MEDIUM, bare simple name LOW, imports not read | both | `java/index.ts` (the `byReceiver` resolution) |
| Spring security = four method annotations; no filter chain model | `4fce1c8` | `code-parser/src/java/spring.ts` line 79 |
| Express middleware = `require\|ensure\|check\|assert` name heuristic; Next middleware without matcher | both | `tsjs.ts` 1177–1255 (`2ca7f2b`), 1216–1296 (`4fce1c8`) |
| Cross-source HTTP stitch is method+path, host not checked, MEDIUM | both | `core/src/stitch.ts` lines 1–12, 61–65 |
| Journey walk bounded by depth 20, steps 1200, repeats 1 | both | `core/src/query.ts` lines 381–438 |
| Design pass calls `api.figma.com` whenever a token env var exists; manifests and specs may be URLs | both | `parsers/src/design/index.ts` 53–73; `openapi/read.ts` 67–70 |
| Snapshot history in `node:sqlite`, SCD2 intervals, pin, prune | both | `core/src/snapshots.ts` 289–315, 480, 490 |
| `isWriteRoute` lists settings, sync, work; `--read-only` refuses them | both | `server/src/guard.ts` 87–94 |
| MCP tiers are `core \| all`; write tools registered only when a source grants them | both | `mcp/src/tiers.ts`; `mcp/src/run.ts` 555–565 |
| Absence words are six; evidence classes three | both | `core/src/journey-counted.ts` 297; `graph.ts` 299 |
| Node 24.21.0 bundles SQLite 3.53.4 | machine | `node -p process.versions.sqlite` |
| PR #115 merged 2026-10-17T18:37:02Z; `origin/main` = `4fce1c8` | GitHub | `gh pr list`, `git log origin/main` |

## 4. Additional research

All pages read 2026-10-17. Each row states the fact the page establishes and the inference drawn from it.

| Source | Version / licence facts on the page | Fact relied on | Inference for Sentinel |
|---|---|---|---|
| [CodeQL CLI terms](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md) · [CLI docs](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-cli) | per-user licence; GHAS carve-out | permitted uses are academic research, OSI-licensed codebases, CI only for open source on GitHub.com; no redistribution or hosting | "customer-provided" means "customer holds GitHub Code Security"; record entitlement |
| [CodeQL build modes](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages) | Java: none/autobuild/manual; Kotlin: no `none` | `none` "will attempt to run Gradle or Maven to extract accurate dependency information"; generated code lost; one version chosen; class-name collisions | "no build" is not "no project tooling"; the proposal's warning is correct |
| [Semgrep repo](https://github.com/semgrep/semgrep) · [Dec 2024 post](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss) · [rules licence](https://semgrep.dev/legal/rules-license/) · [metrics](https://docs.semgrep.dev/metrics) · [glossary](https://docs.semgrep.dev/writing-rules/glossary) · [CLI reference](https://docs.semgrep.dev/cli-reference) | engine LGPL-2.1; rules licence v1.0 (last updated 2024-12-13) | "internal business purposes" only, no distribution or as-a-service; output fields reserved for logged-in engine; metrics default `auto`; `--max-target-bytes` 1,000,000; CE per-file, cross-function within a file | own rules, own fingerprints, `--metrics=off`, explicit limits in the invocation record |
| [Opengrep](https://github.com/opengrep/opengrep) · [OPENGREP.md](https://github.com/opengrep/opengrep/blob/main/OPENGREP.md) · [releases](https://github.com/opengrep/opengrep/releases) · [opengrep-rules](https://github.com/opengrep/opengrep-rules) | LGPL-2.1; 1.31.0 (2026-10-15); interfile only in 2.0.0 alphas "for testing only" | self-contained binaries, fingerprints and metavars in JSON/SARIF, `--taint-intrafile`; rules "for research, testing & benchmarking" | candidate default engine; no redistributable rule pack |
| [Joern](https://github.com/joernio/joern) · [installation](https://docs.joern.io/installation/) · [Java frontend](https://docs.joern.io/frontends/java/) · [javasrc2cpg README](https://github.com/joernio/joern/blob/master/joern-cli/frontends/javasrc2cpg/README.md) · [jssrc2cpg README](https://github.com/joernio/joern/blob/master/joern-cli/frontends/jssrc2cpg/README.md) · [dataflow semantics](https://docs.joern.io/dataflow-semantics/) | Apache-2.0; README JDK 21, docs JDK 19; heap set by `-Xmx` | JavaParser-based Java frontend with lambda data-flow and try/catch TODOs; Babel-based JS frontend via a bundled `astgen`; unknown externals propagate taint from all arguments to all arguments and the return | high false-positive risk without Spring semantics; spike before committing |
| [OSV-Scanner](https://github.com/google/osv-scanner) · [offline](https://google.github.io/osv-scanner/usage/offline-mode/) · [lockfiles](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/) | Apache-2.0; "V2 beta"; OSV-SCALIBR underneath | `--offline` sends nothing; `--offline-vulnerabilities` may still make requests; pom.xml transitive resolution via deps.dev by default, off in offline mode | pin a release; record Maven depth per run |
| [Trivy](https://github.com/aquasecurity/trivy) · [DB config](https://trivy.dev/latest/docs/configuration/db/) · [air-gap](https://trivy.dev/latest/docs/advanced/air-gap/) · [Java coverage](https://trivy.dev/latest/docs/coverage/language/java/) | Apache-2.0 | DBs from `mirror.gcr.io/aquasec` then `ghcr.io/aquasecurity`, 429/5xx fallback; `--offline-scan` stops Maven Central lookups and "may skip some dependencies"; embedded checks bundle is the offline fallback | three network behaviours to declare separately |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | MIT | `git` / `dir` / `stdin` modes; `--redact` default 100 %; baselines omit old findings; `.gitleaksignore` by fingerprint (experimental) | as the proposal says; keep observations in Sentinel's store |
| [TruffleHog](https://github.com/trufflesecurity/trufflehog) | AGPL-3.0 since v3 | verifies secrets live by default; `--no-verification` | not an offline-safe default; AGPL affects redistribution |
| [zizmor](https://github.com/zizmorcore/zizmor) · [usage](https://docs.zizmor.sh/usage/) | MIT | `--offline` / `ZIZMOR_OFFLINE` skip online audits; token enables online mode; workflows, actions, Dependabot, pre-commit | record selected and skipped audits, as proposed |
| [Grype](https://github.com/anchore/grype) | Apache-2.0 | directory, image, SBOM scanning; Java and JavaScript packages | alternative to OSV-Scanner if SBOM-first; needs an offline-DB check |
| [Checkov](https://github.com/bridgecrewio/checkov) | Apache-2.0 | Terraform, Kubernetes, Helm, Dockerfile, GitHub Actions; SARIF | IaC alternative to Trivy misconfig |
| [Bearer CLI](https://github.com/Bearer/bearer) | Elastic License 2.0; JS/TS/Java in CLI; cross-file in Pro via Cycode | "analyze data flows"; free inside an organisation, not as a hosted service | candidate for users without CodeQL, only if Sentinel is never offered as a service |
| [find-sec-bugs](https://github.com/find-sec-bugs/find-sec-bugs) | LGPL-3.0; SpotBugs plugin; bytecode | taint analysis for injections | only with an isolated build profile |
| [SonarQube editions](https://www.sonarsource.com/blog/sonarqube-compare-editions/) | Community Build has no taint analysis | injection rules need Developer Edition and above | not a free deep-engine option |
| [Spring Security architecture 7.0.7](https://docs.spring.io/spring-security/reference/7.0/servlet/architecture.html) · [multiple chains](https://docs.spring.io/spring-security/reference/7.0/servlet/configuration/java.html) | documents 7.0.7; 7.1.1 current | first matching chain only; no `securityMatcher` matches any request; "if no filter chain matches … the request is not protected"; `requestMatchers` must also match the chain's matcher | *unknown* until a chain model exists; two fixtures added |
| [OWASP Benchmark](https://owasp.org/www-project-benchmark/) · [BenchmarkJava](https://github.com/OWASP-Benchmark/BenchmarkJava) | v1.2; Java and Python; GPL-2.0 | "all the vulnerabilities … are actually exploitable" | engine evaluation only; not a Spring corpus |
| [WebGoat](https://github.com/WebGoat/WebGoat) · [pom](https://raw.githubusercontent.com/WebGoat/WebGoat/main/pom.xml) · [licence](https://github.com/WebGoat/WebGoat/blob/main/LICENSE.txt) | Spring Boot 4.1.1, Java 25; GPL-2.0-or-later | deliberately insecure, lesson-documented | the Spring labelled corpus; GPL affects redistribution of WebGoat, not its use as test input |
| [Juice Shop](https://github.com/juice-shop/juice-shop) · [categories](https://pwning.owasp-juice.shop/companion-guide/latest/part1/categories.html) | MIT; Node 22–26 | 16 challenge categories with a companion guide listing every vulnerability | the TS/JS labelled corpus |
| [SARIF Viewer](https://marketplace.visualstudio.com/items?itemName=MS-SarifVSCode.sarif-viewer) · [repo](https://github.com/microsoft/sarif-vscode-extension) | Microsoft DevLabs; MIT | opens local `.sarif`, Problems list and a results panel | a no-code VS Code findings view for increment E |
| [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) | consent required for Copilot models | `selectChatModels` by `vendor`, `id`, `family`, `version`; identity fields on the model object | host-reported model identity in a future extension |
| [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) · [sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) | 2025-11-25 | tasks "experimental"; sampling returns `model`; client controls selection; human in the loop | as proposed |
| [GitHub SARIF support](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support) | limits table | 20 runs, 25,000 results (5,000 displayed), 10 MB gzipped, `primaryLocationLineHash`, stable `ruleId` | projection rules in §2.4 |
| [SQLite changes](https://sqlite.org/changes.html) | 3.51.3 (2026-03-13), 3.53.0 (2026-04-09), newest 3.54.1 (2026-10-16) | "Fix the WAL-reset database corruption bug" | runtime version gate |
| [Node 24 zlib](https://nodejs.org/docs/latest-v24.x/api/zlib.html) | zstd added v23.8.0 / v22.15.0, Stability 1 | `zstdCompress`, `createZstdCompress` | benchmark without a dependency |
| [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) · [CWE downloads](https://cwe.mitre.org/data/downloads.html) · [Top 10:2025](https://top10.owasp.org/2025) | ASVS 5.0.0, CC BY-SA 4.0; CWE 4.20; Top 10:2025 A01–A10 | CWE still maps "OWASP Top Ten RC1 (2025)" | pin artifacts and digests |
| [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) · [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) · [CamoLeak](https://legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code) | | indirect injection through files; three capabilities; a real exfiltration via hidden comments | §2.7 |
| [OpenVEX](https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md) · [Temporal activities](https://docs.temporal.io/activity-definition) | | four statuses, justification required; at-least-once activities | as proposed |

## 5. Alternatives that could outperform the recommendations, and when to choose them

| Decision | Proposal | Alternative | Choose the alternative when |
|---|---|---|---|
| Default pattern engine | Semgrep CE | **Opengrep 1.31** | Sentinel is distributed to users who will not install Python; fingerprints and metavariables are wanted in the engine's own output; the LGPL-2.1 engine posture is the same. Stay with Semgrep CE if a customer already licenses Semgrep Code and wants one engine |
| Deep engine for users without CodeQL | evaluate Joern | **Bearer CLI** (ELv2) for JS/TS/Java data flow, or **Opengrep interfile** once it leaves alpha | Sentinel is used inside organisations and is never offered as a hosted service (ELv2 condition). Prefer Joern when a written Spring semantics file is affordable and the user accepts a JVM and multi-GB heaps |
| Java precision | source-only adapter, JavaParser optional | **find-sec-bugs on bytecode** in an isolated build profile | the user permits a sandboxed Maven/Gradle build (it runs project plugins); then bytecode gives resolved types and generated code that no source-only path sees |
| Dependency advisories | OSV-Scanner | **Grype + Syft** (SBOM first) | the user already produces SBOMs or wants one artifact for both licence and vulnerability facts; otherwise OSV-Scanner's database locality is simpler |
| IaC / CI | Trivy misconfig + zizmor | **Checkov** | Trivy's dependency scanner is not wanted at all, so a single IaC tool with GitHub Actions support avoids two overlapping dependency reports. Keep zizmor either way for Actions-specific audits |
| Secrets | Gitleaks | TruffleHog | only if live verification is wanted and AGPL-3.0 is acceptable; never in the offline profile |
| VS Code findings view | later custom extension | **SARIF Viewer extension** | increment E; the export already exists. Build an extension only for actions (rerun, disposition) that SARIF cannot carry |
| Worker protocol | leases + heartbeats + fencing everywhere | child-process workers, fencing only for client-hosted review (§2.6) | one host, one coordinator (the first release) |
| Packages | sentinel + sentinel-cli + bridge | one package + bridge (§2.8) | until a non-Farsight consumer exists |
| Durable execution | SQLite ledger | Temporal | multi-host workers or an always-on service; not before |

## 6. Experiments, prioritised, with acceptance criteria

Thresholds marked *proposed* are mine for the owner to confirm; the measurement is the deliverable either way.

| # | Experiment | Method | Acceptance |
|---|---|---|---|
| E1 | **Coverage honesty** | Run `parseRepository()` and the Sentinel inventory over this repository, `examples/nx-workspace`, WebGoat and Juice Shop with one deliberately unparsable file and one 2 MB generated file added | every file in the tree appears in exactly one inventory class; `.github/workflows/*` and `Dockerfile` listed; the unparsable file is `failed: parse-error` with path and line; the large file is `too-large` or `not-run`, never absent; `complete` is false and says why. Decides whether `ingestRepo` must change (§2.1) |
| E2 | **Spring chain model** | Six fixtures: two ordered chains with `securityMatcher`; no catch-all chain; `securityMatcher` vs `requestMatchers` mismatch; method security only; custom filter order; a profile-conditioned chain | per endpoint, the pack answers `protected`, `unprotected` or `unknown` with evidence; 100 % correct where it answers, `unknown` allowed and counted; **zero** `protected` on an endpoint no chain matches |
| E3 | **Engine bake-off** | Semgrep CE, Opengrep, Bearer, Joern (+CodeQL where the user holds a licence) on WebGoat, Juice Shop and BenchmarkJava, offline, same snapshot, same budgets | per-CWE precision/recall against the corpora's documented vulnerabilities; wall time, peak RSS, install footprint, offline completion. *Proposed gate for the default deep slot:* ≥ 0.8 recall on the labelled injection lessons at ≤ 0.5 false positives per KLOC, completing WebGoat offline in ≤ 15 min with ≤ 8 GB heap |
| E4 | **Crash safety** | `kill -9` the coordinator at each of the four publication steps, 20 runs each, plus a duplicate submission from a stale client-hosted claim | zero duplicate accepted results; zero lost accepted results; orphan blobs collected after the grace period; `PRAGMA integrity_check` ok; the simplified protocol (§2.6) passes the same tests |
| E5 | **Agent lanes** | 30 labelled cases (15 true, 15 negative controls) as fixed evidence packets; 2 models; 5 trials each; 6 canary comments | citation validator rejects 100 % of fabricated spans; agreement matrix per model; variance across trials reported; canaries change the verdict in **0** of 30 × 5 trials; cost per case recorded with provider-reported usage |
| E6 | **Differential equivalence** | 10 controlled edits: a middleware edit, a framework lockfile bump with no code change, a deleted guard, a renamed guard with a same-named sibling, a new entry point, a narrowed rule, a removed route, a changed advisory, an expired disposition, a corrupted blob | incremental findings = full-scan findings on all 10; every reused unit has a derivation; the bump and the narrowed rule print `changed detection`, never `resolved`; the corrupted blob is an integrity error with broadened scope |
| E7 | **Offline run** | All deterministic adapters with the network namespace disabled | the run completes; coverage records name each skipped online audit (zizmor), each disabled transitive resolution (OSV, Trivy) and each database age; no adapter reports `complete` for a check it could not perform |
| E8 | **Cost and payload** | A general review pass over this repository and the reference app, dry-run estimate vs actual | the estimate is within 25 % of actual tokens; `/graph` byte size unchanged with Sentinel installed |

## 7. Decisions now, questions for evidence, questions for the owner

**Decide now (no new evidence needed).**

- Re-pin to `4fce1c8`; consume `parseRepository()` and the portable document; keep per-site evidence out of the application graph.
- *Unknown* is the default protection verdict for Spring and Express/Nest until a layer pack with the `framework-order` capability has run; the inventory is the check matrix's denominator; `seen by no stage` is always printed.
- Original rules only; Semgrep or Opengrep run with local rules, telemetry off, explicit size and timeout limits recorded; Sentinel fingerprints are its own.
- CodeQL is never downloaded by Sentinel; it is detected and its entitlement attested by the user.
- Stage manifests declare `dependencyResolution`, `databaseFetch` and `telemetry` separately from `build`.
- `DeploymentAssertion` records; dispositions scoped ≤ findings; unverified mitigations never satisfy the exit-code policy.
- Comparison labels gain `changed detection` and `reopened: disposition expired`; framework versions enter the layer-stage fingerprint.
- One package, one ADR; simplified worker protocol for child workers; fencing kept for client-hosted review.
- SQLite ≥ 3.51.3 gate from `process.versions.sqlite`; gzip now, zstd benchmarked.

**Needs evidence (the experiments above).** The default deep engine and whether one is shipped at all (E3); whether
`ingestRepo` must change or Sentinel uses `parseRepository` alone for coverage (E1); Joern's false-positive rate with and
without a Spring semantics file (E3); the agent lanes' under-report rate and cost per KLOC (E5, E8); resource and
retention defaults (E8).

**Needs the owner.**

1. Will Sentinel ever be offered as a hosted or managed service? This decides Bearer (ELv2), the Semgrep rules
   licence posture and the CodeQL terms in one go.
2. Is an isolated build profile that runs Maven/Gradle (project plugins included) acceptable for Java? Without it,
   bytecode tools and generated code are out, and the report says so.
3. Which model providers are in scope for the first release, and is a local model (Echo's Ollama path) a required
   profile? The provider adapter's retention and training terms are a field either way.
4. The proposed thresholds in E3 and E5.
5. Supported framework versions for the first packs (Spring Boot 3.x and 4.x, Spring Security 6 and 7, Next 14 and
   15, Express 4 and 5, Nest 10 and 11 are the candidates; each pack states what it was written against).

## 8. Proposed corrections, by file and section

Suggested replacement text is in quotation marks. Existing files are left as they are for comparison.

| File · section | Change |
|---|---|
| `farsight-sentinel.md` §2 *Proposed package boundaries* | Replace the PR #115 sentence with the re-pin text in §2.1. Collapse `packages/sentinel` and `packages/sentinel-cli` into one row unless a second consumer is named |
| `farsight-sentinel.md` §2 *Initial adapter choices* | "Fast source detectors": *"Opengrep (LGPL-2.1, self-contained binary) or Semgrep CE, with original Sentinel rules loaded from local files and telemetry off; the engine's own fingerprints are never used."* "Deeper cross-file": *"user-installed CodeQL under the user's GitHub Code Security entitlement; Bearer CLI (ELv2) where Sentinel is used internally; Joern evaluated with a written Spring semantics file."* |
| `farsight-sentinel.md` §3 Phase 1 | Replace "the implementation must add complete per-file parse diagnostics" with *"consume `parseRepository()`'s file outcomes and diagnostics; verify the enrichment path retains them (E1)"*. Add the inventory classes from §2.2(c) |
| `farsight-sentinel.md` §3 Phase 2 | Add: *"Until a layer pack with the `framework-order` capability has run, a Spring or Express/Nest endpoint's protection is `unknown`; annotations and name-matched middleware raise candidates and clear nothing. The current Next `middleware.ts` heuristic applies to every entry beneath it and must read `config.matcher` before it may claim coverage."* |
| `farsight-sentinel.md` §4 | Add the `DeploymentAssertion` record and the scope rule (§2.5) |
| `farsight-sentinel.md` §5 | Add the three concealment cases (§2.4) and the `changed detection` label |
| `farsight-sentinel.md` §7 | Add: *"A hosted provider is an external channel; the agent's evidence tools never fetch URLs. Provider retention terms are recorded per adapter. Canary fixtures prove that instructions in comments do not change verdicts."* |
| `farsight-sentinel.md` §8 table | Increment A exit evidence gains E1, E2, E7; increment B gains E4 on the simplified protocol; increment D gains E5; increment F gains E6 |
| `contracts.md` §1 | `Snapshot` gains `fileInventory` with the class per entry and `frameworkVersions` resolved from lockfiles; add `DeploymentAssertion` to the record table |
| `contracts.md` §2 | `StageManifest.effects` gains `dependencyResolution: 'none' \| 'local-cache' \| 'remote'`, `databaseFetch`, `telemetry`; `StageResult` gains `scannedSet` and `skipped[]` with reasons; add `coverageGranularity` |
| `contracts.md` §3 | Child-worker protocol per §2.6; fencing only on `claim/submit`; `canceled-after-spend` |
| `contracts.md` §4 | Fix the lockfile row; add rule-narrowing and LOW-confidence re-resolution rows; occurrence ids in fingerprints |
| `contracts.md` §6 | Add `changed detection` and `reopened: disposition expired`; SARIF projection: `partialFingerprints` from Sentinel's fingerprint, `ruleId` = rule family |
| `contracts.md` §8 | `status --wait`; `tools.lock.json` pins per adapter id |
| `research-scanners.md` decision matrix | Opengrep row from "tracked alternative" to "candidate default"; CodeQL row with the terms as quoted; OSV row "V2 beta; pom transitive via deps.dev, off offline"; Trivy row "Maven Central unless `--offline-scan`"; add Bearer, find-sec-bugs, Checkov, Grype, TruffleHog rows with the licences in §4 |
| `research-scanners.md` § Java/Spring | Add the "unmatched request is not protected" and "catch-all chain" facts and fixtures; name WebGoat (Spring Boot 4.1.1) as the labelled Spring corpus and note BenchmarkJava is not Spring |
| `research-workflows.md` § Execution options | Note Node 24.21 ships SQLite 3.53.4 and the gate; note zstd in `node:zlib` |
| `research-workflows.md` § SARIF | Add the 5,000-displayed cap and the `ruleId` stability rule |
| `research-workflows.md` § MCP | Add `vscode.lm` as a stronger identity source for a later extension |
| `repository-fit.md` | Re-pin to `4fce1c8`; replace the four rows per §2.1; update the handoff sentence about PR #115 |
| `docs/AI-HANDOFF.md` (this branch's addition) | "The parser extraction described in PR #115 is not present at this proposal's base" → *"PR #115 merged at `4fce1c8` on 2026-10-17; the proposal was re-pinned and consumes its `parseRepository()` artifact."* |

## 9. What this review did not do

No scanner, model, build or ingest was run; every capability statement about a tool is what its documentation says
on the access date, which is also the proposal's own standard. Joern's and Bearer's accuracy on Spring and Express
code is unmeasured; E3 is the measurement. I did not read the private round folders or any client material, and this
file names none. Line numbers at `4fce1c8` were read from `origin/main` without checking it out; they will move.
