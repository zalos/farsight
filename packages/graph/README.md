# @farsight/graph

An importable Node 24+ ESM library for Farsight's canonical semantic graph. MIT licensed.
Version 0.2.0; serialized graph format `farsight-graph`, schema version `1`.

```js
import { readFileSync } from 'node:fs';
import { deserializeGraph, indexGraph, reachable } from '@farsight/graph';

const { graph } = deserializeGraph(readFileSync('portable-graph.json', 'utf8'));
const index = indexGraph(graph);
const entry = graph.nodes.find(node => node.name === 'submitInvoice');
const dependencies = entry ? reachable(index, [entry.id], { kinds: ['calls'], maxDepth: 4 }) : [];
```

`graphDocument(graph)` builds and validates the versioned envelope. `serializeGraph(graph)` produces canonical
JSON; `deserializeGraph(json)` rejects an incompatible schema or invalid graph. `validateGraph(value)` returns
`{ valid, errors }` without throwing. Validation covers the entire declared schema, duplicate node/edge/site
ids, dangling edges and source positions. Unknown shapes are rejected; this is validation, not execution.

Farsight's application `graph.json` is a different container with local checkout paths and snapshot bookkeeping;
it is **not** a `GraphDocument`. Export it with
`farsight export --graph graph.json --out portable-graph.json --source-id my-workspace` before loading it here.
Application integrations can use `GraphStore.load(path).toDocument('my-workspace')` from `@farsight/core`.
The export preserves nodes, relationships, cross-source evidence and a sorted `sources` list with per-source
enrichment and content digests. It omits machine roots, mtime hashes, build stamps and snapshot bookkeeping.
It does not re-analyze source or change the saved application graph/history.

`indexGraph(graph)` creates node and incoming/outgoing edge indexes without changing the graph. `reachable`
walks those indexes with optional direction, edge kinds and depth. Structural reachability does not establish
a feasible execution path. It does not refold tests, interpret business rules or read files.

The graph contract is shared with Farsight, including optional enrichment fields. Core re-exports these types;
there is no second analysis schema. `GraphDocument.graph` is a `PortableGraph`: the legacy mtime-based
`meta.sourceHash` is omitted; `sourceDigest` retains its original source-content meaning. Object keys and
node/edge collections are ordered canonically. Array order inside evidence is preserved. Serialization does
not redact arbitrary source text or remove user-supplied dates from enriched graphs.

`GraphEdge.occurrences` is additive source evidence. An occurrence has a stable id, relative location, optional
UTF-16 source span (end exclusive), available branch conditions, metadata and resolution evidence. Identity is
SHA-256 over the source identity, location/span and relationship kind/endpoints. Moving a site changes its id;
re-reading the same site does not. `mergeOccurrences` unions sites by id without multiplying relationships.
Missing occurrences mean the adapter did not supply that evidence; they do not mean zero source calls.

Public exports are the root API, `@farsight/graph/types` (contract only), `@farsight/graph/semantics` (the shared
config-check predicates), `@farsight/graph/schema` (JSON Schema), and `@farsight/graph/package.json`. Internal
paths are not exported. The schema is generated from the canonical TypeScript types and checked for drift.
JavaScript entry points are ESM-only: use `import` or dynamic `import()` from CommonJS. Synchronous `require()`
is intentionally not exported, including under Node 24's `require(esm)` support.

The libraries release as a pair (0.2.0 now; the first release was 0.1.0), independently of Farsight's app version.
See the repository's `docs/PARSER-LIBRARIES.md` for packaging, validation and release instructions.
