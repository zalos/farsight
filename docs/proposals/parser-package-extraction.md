# Publishable code parser and shared graph

Status: proposed; implementation has not started.

Date: 2026-10-17. Code review baseline: `2bc655b`.

## Objective

Extract Farsight's code exploration and graph construction into reusable, publishable libraries. Farsight
must consume those libraries while preserving its current behavior. Other tools must be able to consume the
parser independently, save its graph, and use that graph as input to their own analysis.

The longer-term use case is security analysis across code sections and entry points, with independently
executed checks and agents. A configurable execution graph would let stages reuse earlier artifacts and run
serially or in parallel, producing reports with explicit evidence and validation outcomes. This proposal
focuses on the package boundary and analysis artifact needed to support that future work.

## Recommendation

Create two publishable libraries in the existing monorepo. Keep the existing parser package as Farsight's
compatibility and composition layer. Package names below are working names; registry availability and
ownership have not been verified.

| Package | Responsibility |
|---|---|
| `@farsight/graph` | Canonical graph types, runtime validation, portable serialization, basic indexing and traversal. |
| `@farsight/code-parser` | Repository discovery, language adapters, symbol/call/route/data-access extraction, source evidence, diagnostics, and analysis identity. |
| Existing `@farsight/parsers` | Farsight's configuration and enrichment passes, preserving the existing `ingestRepo()` entry point and behavior. |

Dependencies flow from Farsight into the parser and graph libraries. The reusable libraries must not depend
on Farsight's application packages. The parser depends on the shared graph contract.

Move the existing graph definitions into the shared package and re-export them from core. Keep one canonical
graph schema, including its optional enrichment fields. Do not copy the types into a second security-specific
graph. Preserve the frozen downstream contracts and existing evidence vocabulary.

Initially, keep TS/JS and Java in the parser package with explicit adapter entry points. Separate language
packages can follow if installation size or independent release schedules justify them.

## Existing foundations

- [`LanguageAdapter`](../../packages/parsers/src/types.ts) defines a common interface. TS/JS and Java both
  produce `GraphFragment` values.
- [`ingestRepo()`](../../packages/parsers/src/index.ts) is the shared ingestion entry point for Farsight's
  CLI, server, and MCP consumers.
- [`graph.ts`](../../packages/core/src/graph.ts) supplies the common node, edge, location, and resolution
  definitions. Confidence, unresolved candidates, and evidence already have representations worth preserving.
- [Echo's packaging script](../../scripts/pack-echo.mjs) demonstrates an independently installable artifact.
  Its shipped artifact is a bundled executable; this extraction requires an importable library with
  declarations and a supported public API.

The current parser package also combines code extraction with configuration, OpenAPI, design manifests,
tests, Storybook, project discovery, and business annotations. Its dependency on
[`@farsight/core`](../../packages/core/src/index.ts) exposes application concerns such as presentation
strings, history, readiness, and storage. These boundaries need to be separated before publication.

## Review findings

Findings below describe the review baseline, not guarantees about a later checkout.

| Finding | Evidence | Consequence for independent consumers |
|---|---|---|
| `include` is declared but ignored by file collection. | [`shared/files.ts`](../../packages/parsers/src/shared/files.ts), `collectFiles()`; reproduced with a two-file temporary repository. | Consumers cannot reliably restrict analysis to the requested files. |
| Invalid source can produce an empty graph without a diagnostic. Thrown parse failures are skipped. | [`tsjs.ts`](../../packages/parsers/src/tsjs.ts), per-file extraction loop; reproduced with an invalid TypeScript file. | Missing analysis could be mistaken for a clean result. |
| Repeated calls are deduplicated during extraction. Storage also collapses edges with the same kind and endpoints. | [`tsjs.ts`](../../packages/parsers/src/tsjs.ts), `seenEdge`; [`store.ts`](../../packages/core/src/store.ts), `GraphStore.addFragment()`; both reproduced. | Individual call locations and their conditions can disappear. |
| The content digest covers source files, while configuration and other inputs can change the graph. | [`repoContentDigest()`](../../packages/parsers/src/index.ts) and [`contentDigest()`](../../packages/parsers/src/shared/files.ts); a glossary change altered output without changing the digest. | The current digest is insufficient as a cache key for an entire analysis run. |
| Cross-source HTTP matching uses method/path without verifying the host. | [`stitchHttp()`](../../packages/core/src/stitch.ts) explicitly records this limitation in resolution evidence. | Downstream checks must retain confidence and unresolved alternatives. |

The current graph is useful for structural checks and identifying areas to investigate. It does not establish
exhaustive execution paths or data propagation. Packaging must preserve that distinction.

## Implementation sequence

### 1. Establish compatibility fixtures

Capture representative TS/JS, Java/Spring, mixed-language, and workspace examples. Record graph structure,
resolution evidence, and Farsight enrichment results. These become the acceptance tests for moving code
without unintentionally changing behavior.

Keep extraction changes and deliberate behavior fixes distinguishable. Normalize only documented volatile
metadata when comparing outputs; do not normalize away missing nodes, edges, evidence, or diagnostics.

### 2. Extract the shared graph foundation

Move the canonical graph types and add a versioned JSON schema. Re-export the types from core to preserve
existing imports. Extract genuinely generic indexing and traversal functions individually.

Do not move entire modules without reviewing their behavior. Today's
[`buildIndex()`](../../packages/core/src/query.ts) also refolds test results, and
[`GraphStore`](../../packages/core/src/store.ts) includes Farsight persistence behavior and edge
deduplication. Copying either wholesale would carry application assumptions into the library.

Acceptance: existing consumers compile against the shared types; graph validation and serialization round
trips pass; the new package has no dependency back into Farsight application code.

### 3. Extract a configurable parser instance

Introduce an API along the lines of `createParser({ adapters })` and
`parseRepository({ root, sourceId, include, exclude })`. These names are proposed API shapes, not existing
exports. Adapter registration belongs to each instance, replacing reliance on the exported mutable global
array.

The result should contain:

- The graph and its schema version.
- Structured diagnostics and files successfully analyzed, skipped, or failed.
- Supported analysis capabilities and known limits.
- Input fingerprints and parser/adapter versions.

Keep file selection separate from enrichment selection. Today, `tests: false` also changes whether test
files become ordinary code nodes; that coupling needs an explicit replacement.

Farsight's wrapper must preserve the current pass ordering, including configuration before adapter execution
and tests after route/design enrichment. Configuration must still be applied once; guard renames are not
idempotent. Retain the current code-derived semantics and annotation handling through that wrapper.

Acceptance: Farsight continues to use `ingestRepo()` with equivalent behavior, while a caller can use the
new parser directly with explicit options and without loading Farsight-specific enrichment services.

### 4. Make the artifact reproducible and sufficiently detailed

Add an analysis fingerprint covering source bytes, relevant configuration, dependency-resolution inputs,
enabled adapters/passes, and their versions. Hash the bytes actually analyzed. Preserve the existing
`sourceDigest` meaning for test freshness rather than silently repurposing it.

Use canonical ordering, normalized relative paths, explicit source identities, and separate volatile run
metadata from graph content. The portable artifact must not depend on absolute checkout paths or file
modification times. Pin or fingerprint external inputs whenever a consumer enables them.

Preserve individual call-site occurrences, with locations and available conditions, while retaining
Farsight's existing relationship-level representation. Define the additive occurrence representation and
its identity rules before changing extraction or storage. Storage must preserve those occurrences rather
than overwrite them when relationships have the same endpoints.

Add cancellation, resource limits, explicit read boundaries, and diagnostics for truncation. Filesystem-only
parsing is the default; external inputs are supplied or enabled explicitly. Missing, failed, unsupported, or
truncated analysis must remain visible to consumers.

Acceptance: equivalent inputs produce equivalent canonical artifacts across relocated checkouts; changing
an analysis-relevant input changes the analysis fingerprint; malformed files and bounded analysis produce
diagnostics; repeated call locations survive serialization and reload.

### 5. Package and prove outside consumption

Ship Node 24+ ESM, TypeScript declarations, explicit exports, a file whitelist, documentation, license
material, and package versions. Use an explicit public API rather than exposing internal file paths.

Test the actual tarballs in a temporary project outside the workspace. Verify:

- TS/JS and Java parsing without Farsight installed.
- Native/WASM dependency loading on supported platforms.
- Public imports and TypeScript declaration resolution.
- Published dependency versions, with no unresolved workspace dependency references.
- Graph validation, JSON round trips, and use of a saved graph by another process.
- Farsight compatibility through its wrapper and the repository's applicable validation checks.

Version the two libraries together initially, independently of the application release. Version the
serialized schema explicitly. Extend the release workflow to publish these artifacts, with trusted
publishing and provenance. Library version changes must be handled explicitly: the current release script
updates the root application version.

Acceptance: a clean external consumer installs only the packaged libraries, parses a fixture, saves and
reloads its graph, and runs a small structural analysis against it.

## Relationship to future security and agent execution

The parser output should be a versioned, immutable analysis artifact. Later stages reference that artifact
and produce their own results. This supports cached runs, independent agents, and serial or parallel
execution without reparsing or mutating shared state.

Keep the future execution graph separate from the graph describing the application. Stage inputs,
prerequisites, outputs, validators, and retry policies belong to the runner. The package extraction does not
need to build that scheduler, an agent runtime, or a complete security rule engine.

Today's semantic graph can support structural security checks, but exhaustive path or taint analysis needs
additional capabilities. Future work may add control-flow and data-flow evidence while preserving the
shared schema and distinguishing inferred relationships from validated behavior.

A deterministic runner can reproduce scheduling, validation, and recorded results. Fresh agent inference
can still vary. Retain each agent finding's evidence and validation outcome; incomplete analysis must remain
distinguishable from a passed check. Replay of recorded output must not be represented as a fresh independent
validation.

SARIF is a suitable future report export. The richer graph remains the working artifact, while reports
reference the exact inputs, checks, and evidence that produced them.

## First release acceptance criterion

Farsight and a small independent analysis tool consume the same packaged parser. Farsight retains its
existing behavior. The independent tool can save, reload, and query a reproducible graph with explicit
analysis gaps.

This release proves reusable packaging and the artifact contract. Security rules, complete data-flow
analysis, agent orchestration, and serial/parallel stage execution remain subsequent work.

## Research references

Reviewed on 2026-10-17:

- [Node.js package entry points](https://nodejs.org/api/packages.html#package-entry-points): explicit
  `exports` define the supported package interface and subpath entry points.
- [pnpm workspace publishing](https://pnpm.io/workspaces#publishing-workspace-packages): packing/publishing
  converts workspace dependencies into ordinary version dependencies. Validate the emitted artifacts using
  this repository's pinned pnpm version.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): CI publishing through OIDC, with
  provenance for supported public-package/public-repository workflows.
- [CodeQL data-flow analysis](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/):
  data-flow analysis models value propagation and differs from syntax structure.
- [Joern code property graph](https://docs.joern.io/code-property-graph/): a shared program representation
  combining syntax, control flow, and data dependencies, with additional analysis layers.
- [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html): a standard interchange
  format for static-analysis results.

## Validation performed during the review

At baseline `2bc655b`, core and parsers were rebuilt under Node 24.21.0. All 230 parser tests passed.
Temporary-repository probes confirmed ignored `include`, an invalid file yielding no diagnostic, repeated
call-site loss during extraction, occurrence loss during storage, and a configuration-only graph change
without a source-digest change. A modification-time-only change altered `sourceHash` while preserving
`sourceDigest`.

Those checks assessed the existing implementation. No package extraction or independent tarball installation
was performed. The checks above are historical review evidence, not validation of a future implementation.
