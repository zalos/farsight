# Analysis core options: Farsight, GitNexus, and Tree-sitter

Date: 2026-10-17  
Status: research recommendation; no replacement engine selected

**Recommendation:** own a reusable analysis contract and Farsight's business interpretation, retain the current engine as the working baseline, and evaluate GitNexus as a serious candidate to become the primary analysis backend. Keep Tree-sitter replaceable within the parsing layer. Do not commit to either rebuilding all semantic analysis ourselves or replacing the working TS/JS parser merely to standardize on one parser.

The intended platform should support Farsight, architecture scans, impact analysis, and deep exploration from application entrypoints. That requires more than a graph viewer: it requires reliable identities, call-site evidence, language semantics, links across system boundaries, and an honest account of uncertainty.

## Scope and evidence

The comparison assumes the current Farsight analysis code can be extracted into its own package. Independent packaging is therefore available to all three options; it is not an advantage awarded only to GitNexus or Tree-sitter.

| Subject | Reviewed baseline | Evidence and limits |
| --- | --- | --- |
| Farsight | [`2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2`][fs-revision] | Source inspection and a synthetic check of repeated-edge storage. Existing product capabilities are credited only where implemented. |
| GitNexus | Version 1.6.12, [`f1599e992c94bd6b87611540112d90cbb4a11f71`][gn-revision] | Source inspection plus a successful isolated build and local reference-app smoke test: indexing, viewer exploration, HTTP queries, and MCP queries. Optional PDG analysis was not enabled in that run. |
| Tree-sitter | [Upstream project][ts-repo] and official documentation, accessed 2026-10-17 | Parser capability review and inspection of Farsight's existing Java integration. No replacement TS/JS implementation or comparative performance benchmark was built. |

The local smoke test establishes that GitNexus can run in this environment. It does **not** establish superior accuracy, complete end-to-end coverage, portability, or production integration cost. Application-specific source, screenshots, scan outputs, and session evidence remain outside tracked documentation. No conclusion below depends on comparing raw graph sizes: the tools emit different entities and different projections.

Some statements in [ARCHITECTURE.md](../ARCHITECTURE.md) describe target architecture. At the reviewed revision, Farsight's active graph store is an in-memory map with JSON persistence; snapshot history separately uses SQLite. Its TS/JS adapter uses OXC and custom resolution rather than the TypeScript compiler's type checker. File freshness hashes should not be mistaken for a demonstrated incremental semantic-analysis cache. [Store][fs-store], [snapshots][fs-snapshots], [parser dependencies][fs-package], [TS/JS adapter][fs-tsjs].

## The three alternatives

1. **Extract Farsight's current analysis engine.** Preserve OXC for TS/JS and the existing Tree-sitter Java adapter, then separate reusable analysis from product enrichment. We own the semantic engine and its maintenance.
2. **Use GitNexus as the analysis engine.** Consume its facts and queries through an integration boundary, then add Farsight's journeys, business language, tests, rules, and other product features. We own the contract and integration; upstream supplies substantial analysis machinery.
3. **Build an analysis engine on Tree-sitter.** Standardize syntax extraction on Tree-sitter and implement or integrate resolution, graph storage, queries, framework knowledge, and cross-system analysis above it.

These alternatives sit at different levels. GitNexus already builds on Tree-sitter; Farsight already uses Tree-sitter for Java. Tree-sitter supplies syntax trees and syntax queries, not a ready-made repository semantic graph. Choosing option 3 therefore leaves most of the difficult engine work with us. [GitNexus dependencies][gn-package], [Farsight harness][fs-harness], [Tree-sitter introduction][ts-intro], [query syntax][ts-query].

## Comparison

The judgments below describe the reviewed implementations and likely engineering tradeoffs, not measured rankings.

| Criterion | Extract current Farsight | GitNexus underneath Farsight | Tree-sitter underneath our engine |
| --- | --- | --- | --- |
| Graph processing available today | Application-aware relationships, journeys, impact, guards, records, tests, and product evidence. Generic resolution and graph identity need strengthening. | Broader reusable resolution machinery, graph queries, clustering, impact, tracing, and optional dependence analysis. Greater capability does not establish greater accuracy on our applications. | Concrete syntax trees and structural queries. Semantic graph construction and analysis remain to be supplied. |
| Graph fidelity | Strongest where supported framework patterns match the application; custom resolution and edge aggregation limit deeper analysis. | Explicit scopes and callable-value propagation are promising. Heuristics, budgets, and provider-specific limitations still apply. | Depends on the semantic engine built above it. Parser uniformity alone cannot improve call-target correctness. |
| Architecture and deep entrypoint scans | Existing domain-aware paths are useful; service identity, call-site detail, and boundary composition need work. | A substantial starting point, including group-aware contract links. Reviewed cross-repository trace supports one boundary; complete cross-program data flow is not provided. | Full design freedom, with responsibility for building and validating all those capabilities. |
| Maintenance | Least migration disruption; all semantic defects, new languages, and framework support remain our responsibility. | Reuses upstream work, but adds integration, native dependency, schema, release, and licensing obligations. A long-lived fork could erase the savings. | Reuses parsing infrastructure, but grammar compatibility and nearly all semantic maintenance remain ours. |
| Compatibility | Best initial fit with current Farsight contracts. Extraction must preserve consumer behavior. | Requires a tested translation layer, sufficient raw evidence, and version pinning. Browser graph output alone is insufficient. | Existing Java path demonstrates one integration. Replacing TS/JS still entails substantial extraction and behavior parity work. |
| Extensibility beyond Farsight | High potential if reusable facts and analysis contracts are separated from product assumptions. A package move alone does not achieve this. | Internal provider and phase boundaries support meaningful extension; a stable general-purpose SDK boundary is not established by the inspected package surfaces. | Broad language substrate. Each new grammar still needs semantic and framework support before it yields useful architecture analysis. |
| Business and journey features | Already integrated. | Farsight must retain and adapt these layers; generic communities and processes are not equivalent to business journeys. | Farsight must retain these layers over the new analysis implementation. |
| Adoption cost | Lowest immediate disruption; potentially high long-term analysis investment. | Potentially fastest route to broader analysis if the adapter stays thin and licensing fits. | Justified when a measured parser or multi-language benefit outweighs migration plus semantic-engine costs. |

Sources for the implementation comparisons: [Farsight ingestion][fs-ingest], [schema][fs-graph], [query engine][fs-query], [GitNexus architecture][gn-architecture], [scope contract][gn-scope], [cross-repository trace][gn-cross-trace], and [Tree-sitter documentation][ts-intro].

## Findings that materially affect the choice

### Call sites must survive graph construction

Farsight's `GraphStore.addFragment()` keys edges by `kind|from|to`. Two calls from the same caller to the same callee therefore become one stored relationship, with later metadata replacing earlier metadata. This supports an adjacency view, but does not preserve all call sites for branch-sensitive explanations, repeated writes, or value-flow analysis. [Implementation][fs-store].

A synthetic probe against the built store confirmed the behavior:

```js
import { GraphStore } from './packages/core/dist/store.js';

const store = new GraphStore();
store.addFragment({
  repo: 'probe',
  nodes: [],
  edges: [
    { id: 'call-at-10', kind: 'calls', from: 'a', to: 'b', meta: { line: 10 } },
    { id: 'call-at-20', kind: 'calls', from: 'a', to: 'b', meta: { line: 20 } },
  ],
});
console.log(store.allEdges());
// One edge: calls|a|b, with meta.line === 20.
```

Run from a built checkout of the reviewed revision using Node's module mode. This isolates a storage behavior; it does not measure parser accuracy or use application data.

GitNexus's generic scope-to-graph bridge normally includes line and column in its edge deduplication key and records resolved callees before deduplication. Providers can opt into caller/target collapse; the TypeScript provider does not. That is a useful foundation for richer evidence, although an integration still needs to prove that the evidence survives persistence and export. [Graph bridge][gn-edges], [TypeScript provider][gn-ts].

**Design implication:** retain per-site facts in the reusable engine and derive collapsed adjacency when needed. Mapping richer facts into Farsight's existing graph must preserve its frozen public contracts, using additive changes or compatible projections.

### Semantic resolution is the expensive reusable layer

Farsight's TS/JS pass resolves imports and calls with custom indexes and framework/type/name heuristics. Its `LanguageAdapter` emits an already formed Farsight `GraphFragment`; it does not expose a common intermediate model of lexical scopes and callable values. Separating the package will improve dependency boundaries, but will not by itself produce that shared semantic layer. [TS/JS adapter][fs-tsjs], [adapter contract][fs-adapter].

GitNexus has a shared scope-resolution contract and a language-neutral callable-value pass. The latter propagates callable targets through assignments and arguments, is flow-insensitive, and has explicit limits. These are meaningful assets to evaluate rather than casually reimplement. They still require correctness tests for the languages and patterns we need. [Scope contract][gn-scope], [callable-value analysis][gn-callable].

Tree-sitter can efficiently update syntax trees after edits and handle selected ranges in mixed-language documents. Deciding which downstream symbols, imports, call targets, and architecture links must be recomputed remains the analysis engine's responsibility. Syntax incrementality does not imply repository-wide semantic incrementality. [Advanced parsing][ts-advanced].

### A bounded process summary is different from the underlying graph

GitNexus's process builder selects entrypoints and limits exploration. Its process summaries can therefore omit paths that exist in the raw call graph. The separate trace implementation traverses underlying call relationships with its own bounds. A missing displayed process must not automatically be counted as a missing extracted edge. [Process builder][gn-process], [query backend][gn-backend].

Farsight's journeys are bounded too: `JourneyOptions` has depth, step, and repeat budgets, and the implementation distinguishes cutpoints from the global truncation condition. Neither product's default journey display demonstrates exhaustive path coverage. [Journey implementation][fs-query].

Evaluation must distinguish three failure locations: a missing or incorrect extracted fact, a query that stopped before exploring it, and a presentation that chose not to show it. Raising a query limit cannot recover facts never extracted.

### Deep end-to-end analysis needs explicit system boundaries

Farsight's HTTP stitcher joins unresolved calls to routes using method and normalized path, without checking the host. It preserves ambiguity when several sources serve the same path and labels cross-source matches with reduced confidence. This is useful connectivity evidence, but insufficient to establish the destination service in every deployment. [HTTP stitcher][fs-stitch].

GitNexus's group trace joins repository segments through a contract link, but the reviewed implementation supports one cross-repository boundary. Optional dependence enrichment remains within a procedure on each side; it does not propagate values across the repository boundary. [Cross-repository trace][gn-cross-trace], [architecture contract][gn-architecture].

For an entrypoint that travels through a client, API, service, queue, worker, and database, the platform will need service identities, protocol contracts, queue/topic identity, framework lifecycle semantics, and evidence for each join. No reviewed option supplies complete, feasible, arbitrary end-to-end execution paths out of the box.

Three questions must stay distinct:

- **What may this entrypoint reach?** Static relationships and bounded reachability can answer this conservatively.
- **Under what conditions, and with which values?** This requires progressively stronger control-flow, data-flow, alias, dispatch, and framework modeling.
- **What actually ran?** This needs execution evidence, such as appropriately attributed test results or runtime traces. A static path is not an observed execution.

The proposed analysis metadata must map into Farsight's existing evidence and absence vocabulary rather than introduce conflicting product verdicts. See [coverage semantics][fs-coverage] and [count contracts](../COUNTS.md).

### Internal extensibility and a supported integration API are different

GitNexus has provider contracts and reusable passes despite its statically registered phase graph. A static registry is not evidence that extension is impossible; Farsight also registers adapters in code. The integration question is how much ongoing coupling a downstream product must accept. The inspected CLI package and private shared package do not establish a documented, versioned general analysis SDK. [Phase runner][gn-runner], [CLI package][gn-package], [shared package][gn-shared], [Farsight registry][fs-ingest].

GitNexus's browser graph endpoint projects relationships to a limited set of fields and reconstructs their identifiers. It should not become our canonical import format for call-site-rich analysis. Prefer a supported rich export/query boundary, or a small explicit adapter whose compatibility is tested against pinned releases. [HTTP graph projection][gn-api].

Native Tree-sitter bindings, grammars, LadybugDB, and its associated search support add installation and upgrade considerations. The successful local build is encouraging, but does not settle compatibility across CI runners, operating systems, or deployment formats. [Dependencies and packaging][gn-package].

### Licensing is a decision gate

The reviewed GitNexus revision uses **PolyForm Noncommercial 1.0.0**. Establish terms that cover the intended product use and downstream reuse before selecting it as a foundation for commercial tooling. Do not assume that running a separate process or using an API settles those rights. This report does not determine the legal eligibility of a particular deployment. [Pinned license][gn-license].

Tree-sitter's core uses the MIT license. Grammars, bindings, database components, and other dependencies still need their own license inventory when selecting a distributable engine. [Core license][ts-license].

## Fresh counterpoint review

After the initial comparison, a separate subagent reviewed the evidence and challenged the emerging preference for an owned engine. Its strongest objection was that **owning the public analysis contract does not require owning every semantic implementation behind it**.

| Counterpoint | Effect on the final recommendation |
| --- | --- |
| Extracting Farsight does not fix scopes, callback propagation, or call-site identity. | Treat extraction as a migration and product-boundary improvement, not proof that our engine is the best foundation. |
| GitNexus already contains reusable machinery we would otherwise have to build. | Evaluate it as a possible primary backend, not merely a benchmark or source of inspiration. |
| Process sampling does not prove raw graph incompleteness. | Compare facts first, reachability second, and presentation separately. |
| Both projects have static extension registration. | Judge extension effort and coupling through an actual change, not whether either has a runtime plugin loader. |
| A uniform Tree-sitter capture layer could reduce long-term duplication. | Keep this option open if a narrow prototype demonstrates lower maintenance or better required capabilities. Uniformity alone is insufficient. |

This changed the recommendation from an implicit preference for owning the whole engine to a staged choice of implementation behind an owned contract. GitNexus can win that evaluation. Keeping the present engine is a practical baseline, not a permanent commitment.

## Proposed reusable platform boundary

The following is a target design, not a claim about current implementation:

| Layer | Responsibility | What should be replaceable or extensible |
| --- | --- | --- |
| Capture | Parse syntax and obtain compiler or framework facts. | OXC, Tree-sitter adapters, compiler-backed providers, or an external analysis engine. |
| Semantic facts | Identify symbols and call sites; retain locations, relations, provenance, unresolved candidates, and completeness limits. | Producers can differ; consumers receive a versioned contract with declared capabilities. |
| Architecture joins | Connect services, routes, queues, jobs, stores, and external systems with evidence for each boundary. | Framework and protocol adapters; explicit configuration may augment code evidence. |
| Analysis | Reachability, impact, architecture rules, conditions, data flow, and test attribution. | Analyses declare required facts and report unsupported or bounded results. |
| Products | Farsight journeys and business views, CI checks, architecture scanners, developer tools, and other consumers. | Product policy and presentation stay independent of parser internals. |

Preserve one canonical semantic model with compatible projections. Do not fork Farsight's graph per consumer or put business-language presentation requirements into every language parser. A GitNexus adapter may fill much of the capture and semantic layers; that does not require Farsight to adopt its UI, every internal schema, or its release cadence as the product's public contract.

The contract should make identities, source revisions, evidence, capability support, and truncation explicit. Confidence values from different producers are not automatically comparable probabilities. Stable identity across re-ingestion also requires a deliberate policy; a line number alone is not sufficient when edits move code.

## Evaluation before selecting an engine

Use the same frozen source snapshots, exclusions, generated-code policy, and declared query budgets. Include the reference application for continuity, an unfamiliar TS/JS application to expose overfitting, and a different framework or language to test generality. Keep private fixtures private; publish small synthetic reproductions where possible.

| Test area | Required cases | Evidence to compare |
| --- | --- | --- |
| Symbols and calls | Lexical shadowing, duplicate names, repeated calls, callbacks, factories, inheritance, dependency injection. | Source-reviewed targets and call sites; correct, incorrect, missed, and unresolved cases reported separately. |
| Architecture joins | HTTP wrappers, identical routes on different services, queues, scheduled jobs, database operations, multiple service boundaries. | Correct service/resource identity, join provenance, ambiguous candidates, and unsupported boundaries. |
| Entrypoint analysis | Known reachable paths, impossible or ambiguous alternatives, cycles, branches, budget exhaustion. | Raw facts, reachable sets, path explanations, and completeness limits evaluated separately. |
| Product compatibility | Existing journeys, rules, guards, record writes, tests, API drift, and machine-readable contracts. | Preserved behavior and evidence, with explicit losses introduced by translation. |
| Extension cost | Add the same missing framework pattern to each viable engine. | Files and layers touched, code added, required upstream patches, regression coverage, and evidence quality. |
| Upgrade and operation | Pin an initial version, upgrade a dependency/backend, repeat the fixtures. | Schema and identity changes, migration effort, cold/warm indexing, memory, query latency, and installation results. |

Measure precision and recall only against a source-reviewed expected set, and state the unit being counted: symbols, call sites, boundary links, or paths. Report unknowns and truncations separately from wrong answers. A larger graph can contain both more useful facts and more noise. Similar raw counts can hide different coverage.

For Tree-sitter, prototype one existing TS/JS slice and one required new language or mixed-language use case. Measure the extraction migration and semantic work separately; do not compare an imagined completed engine with two implemented systems.

Select GitNexus if licensing fits, raw evidence survives integration, required capabilities beat or match the baseline, and extension/upgrade work stays concentrated in a thin adapter. Prefer the extracted Farsight engine if the required analysis is better served by its semantics or GitNexus requires a persistent invasive fork. Expand direct Tree-sitter use when a measured language, embedding, or maintenance requirement justifies it.

## Decision and remaining questions

Proceed with a product-independent contract and compatibility layer while keeping current Farsight behavior available. Trial GitNexus behind that boundary before committing to a new semantic engine. Retain OXC and the existing Tree-sitter integration until measured requirements justify changing them.

The engine decision remains open on four material questions: which implementation produces the most trustworthy facts for required scenarios; whether GitNexus offers suitable licensing and a maintainable integration boundary; how much custom work is needed for multiple architecture boundaries; and whether a second consumer can use the contract without inheriting Farsight-specific assumptions.

Revisit this recommendation when those results exist, when upstream integration/licensing terms change, or when a new language or analysis requirement changes the cost balance. Record the selected implementation and measured tradeoffs in an ADR at that point.

## Source index

Farsight and GitNexus source links below are pinned to the reviewed commits so later code changes do not silently change the evidence. Tree-sitter documentation and its `master` license link are living references, accessed on the date above. The comparison tables and proposed platform are engineering judgments derived from these sources, not upstream guarantees.

- **Farsight implementation:** [revision][fs-revision], [ingestion][fs-ingest], [adapter interface][fs-adapter], [TS/JS semantics][fs-tsjs], [Tree-sitter harness][fs-harness], [dependencies][fs-package], [graph schema][fs-graph], [store][fs-store], [snapshot history][fs-snapshots], [queries][fs-query], [HTTP stitching][fs-stitch], [coverage][fs-coverage].
- **GitNexus implementation:** [revision][gn-revision], [architecture][gn-architecture], [scope contract][gn-scope], [callable-value analysis][gn-callable], [call-site bridge][gn-edges], [TypeScript provider][gn-ts], [process construction][gn-process], [query backend][gn-backend], [cross-repository trace][gn-cross-trace], [phase runner][gn-runner], [HTTP graph export][gn-api], [CLI package][gn-package], [shared package][gn-shared], [license][gn-license].
- **Tree-sitter:** [repository][ts-repo], [introduction][ts-intro], [syntax queries][ts-query], [incremental and mixed-language parsing][ts-advanced], [core license][ts-license].
- **Related Farsight guidance:** [vision](../VISION.md), [architecture](../ARCHITECTURE.md), [roadmap](../ROADMAP.md), [count and evidence contracts](../COUNTS.md).

[fs-revision]: https://github.com/zalos/farsight/tree/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2
[fs-ingest]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/parsers/src/index.ts
[fs-adapter]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/parsers/src/types.ts
[fs-tsjs]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/parsers/src/tsjs.ts
[fs-harness]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/parsers/src/treesitter/harness.ts
[fs-package]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/parsers/package.json
[fs-graph]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/core/src/graph.ts
[fs-store]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/core/src/store.ts#L51-L68
[fs-snapshots]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/core/src/snapshots.ts
[fs-query]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/core/src/query.ts
[fs-stitch]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/core/src/stitch.ts
[fs-coverage]: https://github.com/zalos/farsight/blob/2bc655b4dd0a5bfe9b5501bfd98d2e0a998b2be2/packages/core/src/coverage.ts
[gn-revision]: https://github.com/abhigyanpatwari/GitNexus/tree/f1599e992c94bd6b87611540112d90cbb4a11f71
[gn-architecture]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/ARCHITECTURE.md
[gn-scope]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts
[gn-callable]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts
[gn-edges]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts#L159-L190
[gn-ts]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/ingestion/languages/typescript/scope-resolver.ts
[gn-process]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/ingestion/process-processor.ts
[gn-backend]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/mcp/local/local-backend.ts
[gn-cross-trace]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/group/cross-trace.ts
[gn-runner]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/core/ingestion/pipeline-phases/runner.ts
[gn-api]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/src/server/api.ts#L416-L453
[gn-package]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus/package.json
[gn-shared]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/gitnexus-shared/package.json
[gn-license]: https://github.com/abhigyanpatwari/GitNexus/blob/f1599e992c94bd6b87611540112d90cbb4a11f71/LICENSE
[ts-repo]: https://github.com/tree-sitter/tree-sitter
[ts-intro]: https://tree-sitter.github.io/tree-sitter/
[ts-query]: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html
[ts-advanced]: https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html
[ts-license]: https://github.com/tree-sitter/tree-sitter/blob/master/LICENSE
