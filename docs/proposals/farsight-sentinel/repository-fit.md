# Farsight Sentinel repository fit and supporting research

Reviewed: **2026-10-17**, repository revision **`4fce1c81959901ed04fcdb806c787505579b7730`**.
This is source inspection for a proposal. No scanners, model comparisons, builds or runtime tests were performed
for this documentation change. Line references below describe the reviewed revision and may move later.

The existing [analysis-core options research](../../research/analysis-core-options-2026-10-17.md) is a companion
decision: which semantic backend supplies Farsight's facts. Sentinel's scanner comparison is a separate decision:
which analyzers assess security properties. Keep both behind capability contracts. That research retains Farsight
as the working baseline and evaluates alternatives including GitNexus; it does not select a replacement. Its
licensing and rich-export questions remain gates. A package extraction alone does not add taint or control-flow
precision.

## Verified reuse and gaps

| Area | Existing evidence | Implication |
|---|---|---|
| Language dispatch | [Application registry](../../../packages/parsers/src/index.ts), lines 51–53 and 74; [parser instances](../../../packages/code-parser/src/index.ts), lines 21–43 | Both requested language families already have a baseline adapter; Sentinel explicitly registers them in its `createParser()` instance and calls `parseRepository()` |
| Parser package | [ADR 11](../../ARCHITECTURE.md), [parser-library contract](../../PARSER-LIBRARIES.md), [graph manifest](../../../packages/graph/package.json), [code-parser manifest](../../../packages/code-parser/package.json) and [application parser manifest](../../../packages/parsers/package.json) | PR #115 introduced MIT-licensed `@farsight/graph` and `@farsight/code-parser` 0.1.0; `@farsight/parsers` depends on both and retains application enrichment. Packaged libraries do not imply registry publication |
| Node/edge identity | [Canonical graph types](../../../packages/graph/src/graph.ts), lines 938–947 and 1015–1065; [occurrence hashing](../../../packages/graph/src/portable.ts), lines 24–38 | Reuse canonical IDs, locations, resolution confidence/alternatives and compatible projections. Occurrence IDs hash the relationship, location and span; moved coordinates or a retargeted relationship change them, so cross-run matching still needs a versioned matcher |
| Repeated calls | [Graph store](../../../packages/core/src/store.ts), lines 64–70, keys by `kind\|from\|to` and merges occurrences; [portable parser](../../../packages/code-parser/src/index.ts), lines 43 and 115–122; [ingest option test](../../../packages/parsers/test/occurrence-option.test.ts) | `parseRepository()` retains available call-site occurrences; `ingestRepo()` omits them unless `{ occurrences: true }`. Keep Sentinel's detailed portable artifact in its own store. The parser's stated capability covers supported resolved calls, not every possible source site |
| Traversal | [Query engine](../../../packages/core/src/query.ts), lines 381–438 | Line-ordered bounded traversal provides context, not feasible-path or taint proof |
| Java resolution | [Java adapter](../../../packages/code-parser/src/java/index.ts), lines 65, 124–138 and 155–166 | Syntax-level heuristics, field-type DI binding at MEDIUM, bare simple-name matching at LOW without imports, and skipped unresolved targets require explicit capability limits |
| Middleware | [TS/JS adapter](../../../packages/code-parser/src/tsjs.ts), lines 1216–1230 and 1284–1297; [Spring annotations](../../../packages/code-parser/src/java/spring.ts), lines 78–79 | Guard-name heuristics and Next middleware without matcher semantics cannot justify a security clearance. Spring models four method-security annotations but no filter-chain selection/order; Express/Nest global middleware order is not modeled. Protection remains unknown until a version-qualified layer pack supplies `framework-order` evidence |
| Cross-service links | [HTTP stitcher](../../../packages/core/src/stitch.ts), lines 1–12 and 61–65 | Method/path matching without host identity is candidate evidence, especially across deployments |
| Input inventory | [File collection](../../../packages/code-parser/src/shared/files.ts), lines 11 and 30–68; [digest inputs](../../../packages/parsers/src/index.ts), lines 175–178 | The walker skips dot-directories and `node_modules`, `dist`, `build`, `target`, `.git`, `coverage`; its language selection is not an all-file inventory. Sentinel's inventory is the coverage denominator, including CI/configuration, unsupported and generated inputs, policy exclusions and files seen by no stage |
| Digest | [Legacy freshness/content hashes](../../../packages/code-parser/src/shared/files.ts), lines 77–105; [input hashing](../../../packages/code-parser/src/repository.ts), lines 14 and 167–169; [analysis fingerprint](../../../packages/code-parser/src/index.ts), lines 131–140 | Legacy `sourceHash` and `sourceDigest` remain truncated SHA-1 over their selected inputs. The bounded parser has SHA-256 fingerprints for observed content, directories, metadata and missing reads, plus parser/options/limits. Consume these but also hash Sentinel's complete inventory, framework versions and enrichment inputs |
| Parse omissions | [Artifact types](../../../packages/code-parser/src/types.ts), lines 43–84; [TS/JS](../../../packages/code-parser/src/tsjs.ts), lines 379–394; [Java](../../../packages/code-parser/src/java/index.ts), lines 103–110; [completion rule](../../../packages/code-parser/src/index.ts), lines 137–146 | `parseRepository()` returns `analyzed`, `skipped` or `failed` per discovered source, structured diagnostics, exact input fingerprints and `complete`. That flag is relative to parser selection and declared limits, not security coverage. Parse-error call sites currently omit the optional diagnostic line; E1 must expose that limitation. `ingestRepo()` has no equivalent file-outcome ledger |
| Source retention | [Node snippet](../../../packages/graph/src/graph.ts), line 947; [source reader](../../../packages/server/src/index.ts), lines 360–380 | Snippets and source reads from the current checkout do not preserve historical code for new rules |
| Enrichment | [Composition](../../../packages/parsers/src/index.ts), lines 80–119 and 123–156; [design ingest](../../../packages/parsers/src/design/index.ts), lines 53–88; [OpenAPI reader](../../../packages/parsers/src/openapi/read.ts), lines 67–75 | `ingestRepo()` uses unbounded `extractRepository()` and applies config, specs, design, tests and other enrichment. It can fetch URLs; Figma freshness needs both a file key and token. Use it only as separately attributed enrichment with `design: false`, local pinned OpenAPI inputs, an allowlisted environment and enforced network policy; it supplies no inventory/coverage clearance |
| Incrementality | [Parser inputs/fingerprint](../../../packages/code-parser/src/index.ts), lines 131–146; [selected source loop](../../../packages/code-parser/src/index.ts), lines 64–104 | Exact fingerprints are inputs to a future cache; no semantic incremental cache or safe security-result reuse is implemented. Reuse must account for framework/dependency inputs and declaration changes affecting heuristic resolution |

PR #115 merged at `4fce1c8` on 2026-10-17; this fit assessment and the proposal are re-pinned to it.
Sentinel consumes the shared `parseRepository()` artifact and portable graph contract rather than copying parser
internals. The APIs have distinct provenance: `parseRepository()` runs under `RepositoryRead`, while
`ingestRepo()` invokes `extractRepository()` directly ([composition](../../../packages/parsers/src/index.ts),
line 94). The latter has no read scope for `fileStatus()`/`parseError()` to update
([read context](../../../packages/code-parser/src/repository.ts), lines 193–204). Its spec/report errors do not
replace a parse ledger. E1 will measure the inventory/enrichment join; it must not assume that enrichment retained
bounded-parser outcomes. Ordinary read failures during discovery are reported ([walker](../../../packages/code-parser/src/shared/files.ts),
lines 35–52); unreadable directories still leave unknown descendants that an honest inventory must mark as a gap.

## Storage, plugins and integration

[Snapshot history](../../../packages/core/src/snapshots.ts) already demonstrates SQLite persistence with
transactional graph writes (lines 289–315), pinning (480) and change queries (523–534). Reuse those patterns,
but keep workflow attempts, external claims and evidence outside graph-history tables. Ordinary graph retention must
not remove the source/evidence needed by a retained Sentinel report: Sentinel stores its own retained graph artifact,
not a cross-store pin ([pruning](../../../packages/core/src/snapshots.ts), lines 490–515).

The existing `farsight-diff v1` deliberately does not report arbitrary implementation-body edits; its
[catalog description](../../../packages/core/src/strings.ts), line 1583, states this limitation. Use byte-level
snapshot changes plus conservative semantic dependencies for Sentinel invalidation. [Affected analysis](../../../packages/core/src/affected.ts)
and impact queries help nominate work; they do not certify safe cache reuse.

The [work provider interface](../../../packages/work/src/provider.ts) and [registry](../../../packages/work/src/registry.ts)
separate provider behavior from engine-owned state/policy. This is the useful plugin precedent: a trusted registry
at the composition root, not arbitrary execution from repository configuration.

Integration points are [CLI dispatch](../../../packages/cli/src/cli.ts), line 568 and modular dispatch around
1636–1664; [MCP registration](../../../packages/mcp/src/run.ts), lines 555–565, and
[affected tools](../../../packages/mcp/src/affected-tools.ts), lines 16–28; the
[server guard](../../../packages/server/src/guard.ts), lines 87–94; and the
[viewer shell surface registry](../../../packages/server/public/app/shell.js), lines 58–81. New Sentinel mutation
routes must join `isWriteRoute` to respect `--read-only`; new write/cost-bearing MCP tools need an explicit tier.

The server serves the complete graph file at `/graph` ([route](../../../packages/server/src/index.ts),
lines 908–918). Keeping scan evidence in dedicated paginated APIs prevents every existing surface from paying
for prompts, checks, artifacts and analysis databases it never reads. Implementation acceptance must establish that
installing Sentinel adds no Sentinel fields to `GraphStore.toJSON()` and leaves the `/graph` payload unchanged.

## Model runtime reuse

[Echo's model adapter](../../../packages/echo/src/models.ts), lines 36–74 and 137–204, provides patterns for
bounded requests, aborts, credential resolution, rejected redirects, structured generation and usage identity.
[Submind request types](../../../packages/echo/src/submind-types.ts), lines 41–53, are another compact seam.

Do not couple Sentinel to Echo's memory store or session profiles. Its current
[model gate](../../../packages/echo/src/model-gate.ts) is process-local; its background research jobs expire and
are discarded on restart, as documented in [SECURITY.md](../../SECURITY.md). They are not a durable scan scheduler.
When Sentinel becomes a second model consumer, extract a minimal provider-neutral transport with its own ADR
and tests, or adapt existing transport logic without importing the Echo application. Provider-specific authorization
and credential namespaces remain separate. This is an implementation decision, not an assertion that a reusable
model-runtime package already exists.

## Product invariants

Stored test evidence is `declared | static | observed` ([canonical graph types](../../../packages/graph/src/graph.ts), line 299).
The tests matrix prints/exports `declared | reached | observed` ([tests](../../../packages/core/src/tests.ts),
line 554). Sentinel execution status, producer type and disposition are separate dimensions; an agent opinion
does not become a fourth evidence class or an observed test.

The six absence keys are `noneIndexed`, `notBuilt`, `notInvolved`, `notReached`, `notIndexed` and `notTranslated`
([journey counts](../../../packages/core/src/journey-counted.ts), line 297). The catalog prints none indexed,
not built, not involved, not reached, not indexed and not translated. Sentinel must fit its presentation to
that vocabulary while retaining precise execution diagnostics in its own records.

[Counted](../../../packages/core/src/counts.ts), lines 27–55, provides value, units, scope, source, partitioned
breakdown and optional reproduction command. Add deliberate Sentinel scopes and entries in [COUNTS.md](../../COUNTS.md)
when implementing, and use the same folds in CLI, MCP, GUI and reports. Do not sum overlapping counts such as
findings by both entry point and rule into a larger finding total.

Add a `strings-sentinel.ts` catalog module with both registers and definitions; use `sym()` and existing tooltip
builders. [MAP-VIEWER.md](../../MAP-VIEWER.md) is required reading before implementation. New packages/public
boundaries require an ADR and package map entry; this documentation proposal introduces neither executable code
nor a new frozen schema.

## Additional primary-source research

All links below were inspected on 2026-10-17. The application of each source to Sentinel is a design inference,
not an endorsement or a measured product result. Scanner and workflow specifics are in their dedicated appendices.

| Source | Relevant fact | Proposed use |
|---|---|---|
| [OWASP ASVS](https://owasp.org/projects/asvs) | Version-qualified verification requirements and machine-readable distributions | Pin control identifiers and source releases |
| [CWE downloads](https://cwe.mitre.org/data/downloads.html) | Versioned weakness data and mappings; page labels list 4.20 and an OWASP 2025 RC1 mapping | Hash actual artifacts; do not assume a taxonomy mapping has the same release as OWASP's final publication |
| [OWASP Top 10:2025](https://top10.owasp.org/2025/0x00_2025-Introduction/) | Current published risk grouping at the inspected URL | Executive grouping separate from executable test coverage |
| [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Session secrecy, cookie attributes and transport are distinct properties | Decompose the cookie example into independent controls |
| [Spring Security architecture](https://docs.spring.io/spring-security/reference/7.0/servlet/architecture.html) | Request-specific filter-chain selection and ordering | Require an applicability/order model rather than an existence check |
| [Spring MVC interceptors](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/interceptors.html) | Interceptor/controller matching can differ | Do not accept interceptor presence as sufficient protection |
| [OWASP prompt injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | Code comments and external content can carry indirect instructions | Enforce source/tool permissions outside the model |
| [OWASP Benchmark](https://owasp.org/projects/benchmark) | Labeled application cases support analyzer evaluation | Supplement custom multi-file/framework fixtures; avoid generalizing benchmark coverage to all apps |
| [DefectDojo deduplication](https://docs.defectdojo.com/triage_findings/finding_deduplication/about_deduplication/) | Finding imports and reimports depend on configured matching, including location-sensitive identity | Keep a versioned matching algorithm and explicit observation lineage; consider later export integration |

DefectDojo is a useful downstream finding-management option. It does not remove Sentinel's need to retain
source snapshots, stage attempts, rule applicability and control invalidation. Start with portable exports;
evaluate a connector when a team requests it rather than making a hosted findings system a local-run prerequisite.

## Review incorporated

A separate repository review identified three requirements added to the proposal: artifact-only findings must
be possible; existing ingest enrichment must not grant itself network/credential access; complete parse outcomes
are a prerequisite for coverage claims. Scanner review also clarified that Java support already exists and
JavaParser/Joern are optional enrichment choices. The [independent review](claude-review.md) prompted this re-pin;
[the response](codex-response.md) records accepted findings and qualifications. The parser now exposes bounded
outcomes, while Sentinel's complete inventory, framework-order analysis, execution ledger and security-result
reuse remain proposed. These are design corrections, not claims of implemented Sentinel features.
