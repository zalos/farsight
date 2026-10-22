# Architecture

## Overview

```
┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌────────────┐
│  Repos     │──▶│  Ingestion    │──▶│ Semantic Graph │──▶│  Graph API │──▶ GUI (canvas)
│ (N, multi- │   │  (language    │   │  (store +      │   │  (query,   │
│  language) │   │   adapters)   │   │   query)       │   │   lenses)  │
└────────────┘   └──────────────┘   └───────────────┘   └────────────┘
```

Everything hinges on one contract: **language adapters emit a language-agnostic Semantic Graph**, and **every visual is a lens (a query + layout + labeling strategy) over that graph**.

Related research: [analysis core options — extracted Farsight, GitNexus, and Tree-sitter](research/analysis-core-options-2026-10-17.md)
compares the implemented baselines, integration tradeoffs, and evaluation needed for a reusable analysis platform.
It is a research recommendation, not an adopted replacement architecture.

## Speed strategy

Requirement: "fast" — parsing monorepos in seconds, 60fps navigation of large graphs.

Phase 1 pragmatics (no Rust toolchain required by consumers):

- **Parsing:** [oxc-parser](https://oxc.rs) (Rust, shipped as napi bindings — parses JS/TS at millions of lines/sec) for syntax; **TypeScript compiler API** only where semantic resolution is needed (types, cross-file symbol resolution), run incrementally and cached.
- **Multi-language (landed 2026-07):** **tree-sitter WASM** substrate (`@vscode/tree-sitter-wasm` — prebuilt runtime + grammars, no native modules) behind the same adapter interface; Java/Spring Boot is the first adapter on it, and the bundle already carries C#, Go, Python, Ruby, Rust grammars for the next ones. oxc remains the TS/JS syntax layer.
- **Graph engine:** TypeScript first, columnar in-memory layout + SQLite persistence. The engine sits behind a narrow interface so hot paths can move to a Rust napi crate (`farsight-engine`) without touching consumers. This is the designated Rust beachhead if/when profiling demands it.
- **Rendering:** Canvas/WebGL (not DOM/SVG) for graph surfaces; level-of-detail culling; layout computed in a worker (ELK/dagre for flows, force/cluster for atlas), cached per lens.
- **Incremental everything:** file-hash-keyed parse cache; graph diffs on re-ingest; watch mode re-parses only changed files.

## Packages

The reusable extraction boundary is `@farsight/graph` → `@farsight/code-parser` → the application packages
(ADR 11). The graph package owns the canonical types, portable document schema, validation and traversal;
core re-exports the types and retains application storage/query behavior. The code-parser package owns Oxc,
Tree-sitter and extraction helpers; `packages/parsers` composes those adapters with Farsight enrichment.

### `packages/core` — Semantic Graph
Schema (the heart of the system):

```ts
Node {
  id, kind,          // repo | module | file | class | function | route |
                     // component | table | queue | rule | flag | external |
                     // api (one OpenAPI document) | unknown (the "?" stub)
  name, lang, loc?,  // loc: { repo, path, line, col } → IDE deep link
  docs?, signature?,
  contract?,         // routes: what the OpenAPI spec declares + drift vs the code (core/openapi.ts)
  tags: string[],
  facets: {          // lens-specific presentation data
    business?: { label, description },   // from glossary/config/inference
  }
}
Edge {
  id, kind,          // calls | imports | renders | http | publishes |
                     // consumes | reads | writes | validates | guards
  from, to,
  meta?              // e.g. { method: 'POST', path: '/invoices' }
}
Flow {               // a saved/derived subgraph = "quest"
  id, name, entryIds, nodeIds, edgeIds, lensState?
}
```

Also: tag rule engine, graph queries (reachability, slicing "everything between this component and that table"), SQLite persistence.

### `packages/parsers` — language adapters
Adapter interface: `ingest(repoPath, config) → GraphFragment`.
- `ts-js` adapter (phase 1): oxc for AST; extractors for functions/classes/imports/exports, React components & JSX render edges, routes from Express-style `app.get()` calls, Next.js App Router `route.ts` files, raw `createServer` handlers and NestJS controllers (`@Controller` + `@Get`/`@Post`… from `@nestjs/common`, literal paths only — `code-parser/src/nest.ts`; Fastify's own `fastify.get()` is not read), fetch/axios call sites, zod/joi/class-validator schemas → `rule` nodes, middleware → `guards` edges, Prisma/TypeORM/Drizzle models → `table` nodes.
- **Import resolution** (what call-edge quality depends on): relative specifiers resolve on the filesystem (extensions, `/index` files, TS-style `.js`→`.ts` remap); bare specifiers resolve through **tsconfig `paths`** (nearest `tsconfig.json` above the importer, following relative `extends` — covers Nx `tsconfig.base.json`) with a **workspace-package fallback** (npm `workspaces` / `pnpm-workspace.yaml`, package name → source dir, preferring `src/` over `main`'s `dist/`). Lookups follow **barrel re-exports** (`export * from`, `export { a as b } from`), so an import of `@scope/domain` lands on the file that declares the symbol, not the index. Imports into `node_modules` or outside the repo are dropped — external edges are Phase 2.
- **Stitcher** (cross-repo, first step landed 2026-09): adapters leave an unresolved `fetch()` pointing at an `unknown` stub instead of dropping it; `core/stitch.ts` `stitchHttp()` re-points those edges at a route any other source declares — code or spec — after all fragments merge (`fetch→route · MEDIUM` across sources, HIGH within one; ambiguous paths stay unresolved with candidates listed). Queue/topic stitching and shared-schema links follow in P4.
- **OpenAPI post-pass** (2026-09, `parsers/src/openapi/`): specs are discovered by name/content or declared in `farsight.config.json → openapi`, read (YAML/JSON with operation line numbers), and reconciled against the routes the adapters found (`core/openapi.ts`): matched routes gain a `contract`, declared-only routes are added without a source location, undocumented routes are stamped, an `api` node `contains` them. The same `reconcile()` serves `farsight api diff`, `POST /api/apis/diff` and the `api_drift` MCP tool; `graphToSpec()` generates a document from the code with `x-farsight-inferred` markers.
- **Design post-pass** (2026-09, `parsers/src/design/`): screens manifests (`docs/design/screens.json`, or `farsight.config.json → design`) are discovered by name, read with freshness (Figma `lastModified` via `FIGMA_TOKEN`, else the file's mtime — fail-soft), and reconciled AFTER the OpenAPI pass against the `page`/`component` nodes (`core/design.ts`): matched screens gain `design`, designed-only screens are added as pages without a source location, undesigned pages are stamped, a `design` node `contains` them; drift (`design-only` · `code-only` · `operation-not-in-spec` · `operation-unreached` · `operation-undeclared`) is computed once. `journey()` turns a design-only screen's operations into planned calls; `screensFor()` feeds the journey's SCREEN band; the server resolves images (repo file or cached Figma render) on demand — never into the graph.
- **Registry + shared layer** (2026-07): consumers call `ingestRepo()` — every registered adapter runs over the repo and the fragments merge (nodes deduped, edge ids renumbered, freshness combined). `shared/` holds what every language reuses verbatim: file walking + exclude globs + freshness hash (`files.ts`), the JSDoc/TSDoc/Javadoc doc harvest (`docs.ts`), `// @business` branch-directive labels (`labels.ts`), tag heuristics + path normalization (`tags.ts`). `treesitter/harness.ts` is the WASM grammar loader/walker future adapters build on.
- `java` adapter (first tree-sitter language): Spring-aware semantic pass — mapping annotations (+ class-level base) → `route`, method security + Javadoc `@guard` → `guard`, JPA `@Entity` → `table` (with columns), Spring Data repositories → `reads`/`writes` carrying JPQL/derived-query text, Bean Validation DTOs → `rule` + `@Valid` validates edges, Kafka/Rabbit templates/listeners → `queue` publishes/consumes, `@Scheduled`/`main`/listeners → entrypoints, DI field-type call resolution, Journey branches incl. fall-through switch groups.
- Future: `rust`, `csharp`, `python` adapters = grammar (already in the WASM bundle) + queries + semantics layer.

### `packages/server`
App server exposing the graph to the GUI, plus the workspace control plane implemented today: `/api/settings` (GET/PUT → `.farsight/settings.json`: sources with exclude globs, collections, theme, default lens) and `/api/sync` (materializes each enabled source — git URLs clone/pull into `.farsight/cache` — re-ingests, applies per-repo `farsight.config.json`, merges, saves the snapshot). Long-term, lens resolution (labels, grouping, level-of-detail) moves server-side so the client stays dumb and fast. Auth-light initially (runs on the team's infra).

**API protocols:**
- **Control plane** (flows, tags, config, search): REST + JSON. Boring, debuggable, integration-friendly.
- **Graph/lens queries:** purpose-built `POST /lens/query` returning **columnar JSON** (parallel arrays of ids/kinds/names/positions — 3–5× smaller than object-per-node, parses straight into typed arrays for the canvas renderer). Content-negotiated upgrade path to CBOR / Arrow IPC for large payloads. Deliberately **not GraphQL**: per-node resolver overhead is exactly wrong for streaming 50k-node subgraphs.
- **Live updates** (watch mode, ingest progress): WebSocket pushing graph *diffs*; SSE fallback if client→server messaging isn't needed.
- **gRPC** only server-to-server (distributed ingest fleet → merge service), never browser-facing.

### `packages/mcp` — the agent surface
MCP server (stdio) exposing the graph to LLMs/agents. Same graph as the GUI; different consumer contract — compact, greppable text with stable node ids and `file:line` refs instead of visual lenses. Tools:

| Tool | Question it answers |
|---|---|
| `graph_overview` | "Orient me" — repos, kinds, tags, entry points |
| `search_graph` | "Find the thing named/tagged/about X" |
| `describe_node` | "What is this, what touches it?" (docs + all edges) |
| `trace_flow` | "Show me the invoice process" — end-to-end slice with rules called out |
| `list_rules` | "What validation/auth gates this feature?" |
| `impact_of` | "What breaks if I change this?" (reverse reachability) |
| `api_surface` / `api_drift` / `api_spec` | "What does this API offer, who calls it, where does the spec lie?" · "Does my proposed spec match the code?" · "Write me the spec from the code" |

Query logic lives in `core/query.ts` (pure functions over the graph — shared by GUI lenses and MCP, and portable to the Rust engine unchanged). Design rule for tool output: every node reference carries its id and source location, so an agent can chain into `describe_node` or open the file directly.

### `packages/app` — the GUI
- React shell (panels, palette, inspector) around a **canvas graph surface** (custom WebGL/canvas renderer; PixiJS is the current candidate).
- Client state: viewport, selection, expansion, lens, filters — serializable into the URL (shareable deep links).
- Lens switching = re-labeling + re-grouping + animated layout transition of the *same* node identities; camera anchored on selection so you never lose your place.

## Key flows

**Ingest:** `farsight ingest` (CLI in `core`) → adapters parse repos → fragments merged → stitcher links cross-repo edges → tag rules run → SQLite snapshot.

**"Show me the invoice process":** query resolves against tags + names + docs + routes → seed nodes → graph slice (forward/backward reachability, bounded) → flow saved as a Quest → lens applied → laid out → streamed to canvas.

**IDE deep link:** node.loc → `vscode://file/{abs}:{line}:{col}` (adapter table per IDE; config maps repo → local checkout path per user).

## Scale posture (100+ repos)

100+ repos ≈ 20–100M LOC ≈ 5–20M nodes. What holds, and what must be swapped before then:

**Already scale-ready by design:**
- **Parsing** is embarrassingly parallel and incremental. At org scale, ingest runs per-repo (in each repo's CI), emitting a `GraphFragment` artifact — the fragment-per-repo contract is already the adapter interface.
- **The GUI** never loads the whole graph: server-side lens resolution + bounded subgraph streaming + LOD culling means the client is indifferent to total graph size.

**Phase-1 implementations that must be replaced at scale (interfaces already in place):**
1. **TS in-memory engine → Rust engine (napi crate).** JS object overhead (~100+ B/node) and GC pauses are untenable past ~1M nodes; traversal-heavy queries (reachability, slicing) need native code. The engine interface makes this a swap, not a rewrite. *Scheduled: Phase 2 (Rust toolchain now available).*
2. **Single SQLite file → fragment store + merged index.** SQLite is single-writer; 100 concurrent repo ingests would serialize. Target shape: each ingest writes its own fragment (SQLite/Parquet artifact), a merge service folds fragments into a read-optimized central store (Postgres or RocksDB for hosted deployments) plus a global symbol/route index.
3. **Pairwise cross-repo stitching → indexed stitching.** O(clients × routes) matching is fine at 5 repos, not 150. The merge service maintains route tables, schema registries, and queue-topic indexes; stitching becomes index lookups.

## Decisions & tradeoffs (ADR-style)

1. **TS orchestration + Rust-powered parsers (oxc) over pure-Rust core, for phase 1.** Fastest path to a working vertical slice; Rust migration path preserved behind the engine interface. **Revised 2026-07:** Rust toolchain now available; engine migration pulled forward to Phase 2 (see Scale posture).
2. **Canvas/WebGL over SVG/DOM.** Non-negotiable for game-feel at scale; costs us easy accessibility — mitigated by a parallel DOM outline (also good for screen readers).
3. **Lenses over separate diagrams.** Single source of truth; view toggling preserves context. Costs layout complexity (animated transitions between groupings).
4. **SQLite over a graph DB.** Zero-ops for teams, fast enough with proper indexing; graph traversals done in-process. At 100+ repos this becomes per-repo fragments + a merged central store (see Scale posture); still no graph DB — our traversals are bounded slices, not open-ended graph queries.
5. **REST + columnar JSON over GraphQL/gRPC for the browser API.** Purpose-built lens endpoint beats generic graph query languages for bulk subgraph streaming; binary formats (CBOR/Arrow) are an upgrade path, not a day-one cost.
6. **Tree-sitter via prebuilt WASM (`@vscode/tree-sitter-wasm`) over native tree-sitter or per-language JS parsers (2026-07).** Native `node-tree-sitter` would put platform-specific builds in the install path of `farsight-cli`; per-language parsers (e.g. chevrotain `java-parser`, spiked and viable) reuse nothing for language N+1. The VS Code bundle ships runtime + grammars ABI-matched (the community `tree-sitter-wasms` grammars proved incompatible with current `web-tree-sitter`), so one dependency covers Java today and C#/Go/Python/Ruby/Rust next. Cost: adapter `ingest()` is async (WASM init) and slightly slower than native — irrelevant at repo-ingest sizes. oxc stays for TS/JS (faster, TS-aware, carries the existing semantics).
7. **SCD2 validity intervals in built-in `node:sqlite` over snapshot copies or an external SQLite driver (2026-07).** Snapshot history (`.farsight/farsight.db`, `core/snapshots.ts`) stores each node/edge row once with `first_sync`/`last_sync` + a content hash, closed only when the row changes or disappears. "What did sync N look like" is an interval query, `farsight diff` rides a single `changedBetween()` query instead of an object-graph comparison, and retention is a `DELETE` (pinned snapshots survive pruning). Driver is the built-in `node:sqlite` — same posture as ADR 6: no native module, no `better-sqlite3`, nothing platform-specific in the `farsight-cli` install path. Cost: `node:sqlite` is stable only on Node ≥ 24 (works-with-ExperimentalWarning on 22.5+, which we filter out of CLI/test output), so `engines` moves to `>=24`; runtimes without the module degrade honestly (`SnapshotUnavailable`) to the single-snapshot graph.json path — ingest/serve/mcp keep working while history/`--as-of`/diff report themselves unavailable rather than pretending. graph.json is still written on every sync (now stamped with `sync`/`digest`/`commit`/`tz`), so nothing downstream regresses. At 100+ repos this single file becomes per-repo fragments + a merged store per the Scale posture — the `SnapshotDb` interface is the seam.
8. **E2E against the real server on a fixture graph, with `page.route` for faults — over MSW (2026-09).** The viewer is plain ES modules with no bundler, and almost everything it shows is a fold the server computes (`/api/journey`, `/api/tests`, `/api/apis`, `/graph` …) in `core`. Mocking those responses with MSW would test the viewer against hand-kept copies of core's output — exactly the part most likely to drift — and MSW's browser worker needs `mockServiceWorker.js` served from the page's scope, which our path-confined server does not do (404 today) and should not grow for tests. MSW's Node side (`setupServer`) cannot help either: the server and the MCP server are separate processes, and interception is in-process. So `e2e/` boots the real `farsight serve` on a temp copy of `examples/invoice-app` ingested with an explicit `--out` (≈0.3 s, deterministic, never the dogfood `graph.json`), the MCP spec drives the real `farsight mcp` over stdio with the SDK client, and Playwright's `page.route` injects the faults that a real fixture cannot produce on demand (a 500 from `/api/tests`, a slow `/api/journey`, a newer build on disk for the RESTART chip) — per test, at the network, without a worker. Cost: the suite needs `pnpm build` first and a free port (4510, plus 4511 for the MCP spec's `/api/sync` check), and a fault that only a *different* graph could produce means adding to the fixture, not a handler. An application that renders against an external ERP may well mock that dependency with MSW, and be right to.
9. **Stories are an attribute of the component they render, read from the story files at ingest; a running Storybook is only the renderer, found and never started (2026-09).** Story files are code (`*.stories.*`, Component Story Format), so the stories post-pass (`parsers/src/stories/`, last in `ingestRepo()`) reads each file's default export (`title`, `id`, `component`, `includeStories`/`excludeStories`) and its named exports, resolves `component:` through the file's imports (barrels followed) to the node id, and puts one `StoryRef` per story on that node — `GraphNode.stories`, with the **story id computed exactly the way Storybook computes it** (`core/storybook.ts` `storyIdOf` = `sanitize(title) + '--' + sanitize(storyNameFromExport(export))`, auto-title from the glob base when a file names none). The repo's Storybooks are recorded as `meta.stories[repo].storybooks` (`StorybookRef`): every `.storybook/main.*` found (its `stories` globs, the port its `project.json`/`package.json` scripts start it on, the root script that starts it), merged with `farsight.config.json → storybook { configDir, url, root, command, name }`, and overridable per workspace source (`.farsight/settings.json → sources[].storybook.url`). At serve time `storybookLive()` (one fold for the server's `/api/stories`, MCP `stories` + `describe_node`, CLI `farsight stories`) probes each recorded URL's `/index.json` (fail-soft: refused / timeout / not an index → `reachable: false`, never a throw) and maps every entry onto a node — **by story id first**, then by `componentPath` joined to the Storybook's root (one component in the file, or the one named like the title's last segment), then by title alone — returning every entry it could not place with its reason (`no-node-at-path · ambiguous · no-match · docs-no-story`) and every graph story the running index does not list (`notListed`: a Storybook reads new files and globs when it starts). Measured on the reference app's live Storybook (2026-09-25, 320 stories + 59 docs): 379 of 379 matched by story id / docs title, and with the story files withheld the fallback alone still placed 379 of 379 (243 by component file, 77 by component file + title). **Why an attribute, not a `story` node kind:** a story has no behaviour — no calls, reads or gates a journey, impact walk or coverage denominator would read — and it is always about exactly one component; as nodes, the reference app's 320 stories would triple its component-like nodes on the code map and every consumer (`isCoverable`, journey, impact, the frozen `farsight-diff v1` kinds) would have to learn to skip a new kind, which is the fork-the-schema failure principle 1 forbids. As an attribute, every lens reads the same field, the diff contract is untouched (it compares named facts, not node JSON), and a story that reaches no component is still reported (`meta.stories.unresolved`) rather than dropped. **Why the running Storybook is not the source:** the stories exist whether or not anything runs; the index only confirms which of them the running renderer lists and supplies the frame. **Security:** the viewer frames only origins the graph or a source setting recorded — the viewer page carries `Content-Security-Policy: frame-src 'self' <those origins>` — and the server fetches only those URLs (http/https). Farsight never starts, installs or builds a Storybook; when one is not reached the viewer says so with the command the repo's own scripts use. Cost: story ids for a file with neither `title` nor a matching glob fall back to `<file>#<export>` and meet the index only through the componentPath fallback; CSF features beyond the static shape (a title built from a variable, a `component` passed through a helper) resolve by the fallback or are reported, never guessed.
10. **The map is DOM in a transformed world, not a `<canvas>` (2026-10).** The `#/map` street draws tens of screens and a few hundred nodes at most, each of which must carry a tooltip, a focus ring, a lens-aware label and a click target that the e2e suite can address by selector. A `<canvas>` would re-implement all four for no measurable gain at this size; the code map and the drill already draw DOM cards over an SVG edge layer. So `lib/map-canvas.js` moves one `.map-world` element under a CSS `translate() scale()`, with DOM screens, calls and data nodes in it and one SVG edge layer per district. The one cost is text at small scales, which semantic zoom removes: the neighbourhood level shows poster-size covers and ghosts the street. ADR 2 (canvas/WebGL for the graph) still applies to the full code graph at 100k nodes; this surface is bounded by journeys. (docs/proposals/map-view.md §7.)
11. **Two publishable libraries with an application composition layer (2026-10-17).** `@farsight/graph` owns the single canonical graph contract and its versioned portable envelope; `@farsight/code-parser` owns repository discovery and the existing Oxc/Tree-sitter extraction. Neither imports an application package. `@farsight/parsers` retains configuration and enrichment in their existing order. The libraries release together, separately from the app. **Boundary:** the immutable portable analysis has explicit inputs, versions, diagnostics and gaps; the application's saved `graph.json` also has machine roots, build stamps and snapshot history metadata. `GraphStore.toDocument()` / `farsight export` converts a saved graph to the portable envelope, preserving the named source set and its enrichment without exporting local bookkeeping. There is one node/edge schema, not a second analysis graph. **Cost:** explicit conversion and two library versions to maintain, in return for independent consumers and reproducible analysis artifacts. Portable parsing retains call-site occurrences; application ingestion makes them opt-in until a surface consumes them, so unused evidence does not grow every snapshot and browser payload. `complete` remains false when evidence is omitted, including a declaration's branch cap, with the affected file/declaration identified. Exhaustive path/taint analysis and execution scheduling are separate work. See [Parser libraries](PARSER-LIBRARIES.md).

12. **Nest route declarations share route identity and carry explicit limitations (2026-10-19).** The TS/JS adapter reads `@nestjs/common` controller and verb bindings into the existing method/path route ids. A controller method that only returns an imported handler is linked with `calls` / `meta.via: 'delegate'`; core uses that relation for coverage and authored summaries. `@UseGuards` gates belong to their decorator declaration, including its file and argument, so equal labels cannot merge different guard implementations. Unsupported paths and routing modifiers are optional `meta.routes.gaps` facts in the same graph contract; portable analysis, saved application graphs and exports retain them, and MCP names them. The addition is compatible with graph schema version 1 and ships with paired library version 0.2.0. A routing limitation also makes portable analysis incomplete; an entrypoint documentation mismatch is recorded without making parsing incomplete. Global prefixes, module mounts and versions are not evaluated: the graph records the literal controller paths with a named limitation. See [Parser libraries](PARSER-LIBRARIES.md).

13. **Source selection and declared bindings remain inspectable (2026-10-19).** The shared file collector honors root and nested `.gitignore` rules by default using `ignore`, including directory-relative patterns and negation. Explicit excludes and built-in skips still win; `AdapterOptions.gitignore: false` (CLI ingest `--no-gitignore`) opts out. Only rules inside the source root are read; no Git process or global configuration is consulted. Portable analysis fingerprints rule bytes and directory listings, so selection changes invalidate its result. Configuration import/setup/plumbing declarations are checked against the selected files and symbols, and unresolved decision affects are surfaced at ingest. Existing config/decision notes and the ingest warning channel carry those facts; no field is added to every node. A named Nest body schema resolves to an existing rule and gives a declared `validates` relationship to its method and route; its resolution states that runtime pipe registration was not checked. Types, computed/spread options and unresolved schemas confer no validation credit. This changes selection intentionally while retaining graph schema version 1; the paired libraries advance to 0.3.0. See [Parser libraries](PARSER-LIBRARIES.md) and [Nest schema validation](https://docs.nestjs.com/application/validation).

14. **API delivery policy preserves raw reconciliation evidence (2026-10-21).**

API diff retains its raw operation lists, statuses and counts. A separate `policy` result classifies
spec-only operations as planned only when their `x-phase` is strictly later than the current phase.
`openapi[].phaseOrder` lists phases earliest first; absent that list, document first use defines order.
An unknown current phase or unknown operation phase remains missing. A missing phase is never planned.
`openapi[].phase` supplies the current phase; `api diff --phase` overrides it.

Root config `internalRoutes` declares exact `METHOD /path` operations (parameter spelling is normalized,
no globs). These remain code-only evidence but do not fail undocumented policy. A declared operation
with `x-internal: true` still matches normally and must be implemented when due.
`--strict` checks all policy categories; `--strict=missing,undocumented,notes` selects categories.
`notes` means matched contract drift entries; existing operationId naming observations stay advisory.
No policy fields are added to application graph nodes. Config is read from the selected source's recorded checkout (or configured local source); absent a recorded
checkout, ad-hoc comparisons use the current directory.

15. **Contract guard vocabulary and multipart readers (2026-10-21).**

Operation-level `x-guards: [name]` documents gates that have no OpenAPI security-scheme equivalent.
A name matches an enforced guard's exact name/id, its configured label, or that label's existing
`guards` function matchers. Route-only declarations never prove enforcement. An absent declared guard
reports `security-missing-in-code`; enforced guards without a security scheme or matching vocabulary
retain `security-missing-in-spec`. Existing scheme and scope checks remain in force.

Root-only `validators` lists exact function names or ids for multipart readers. A required multipart
body counts as validated only when the implemented route has a real calls path to a configured reader
in the same source. Merely naming a reader, having it elsewhere in the graph or using it for a JSON body
provides no evidence. Inactive guard or call edges never supply enforcement or multipart-reader evidence.
No application graph field or speculative validates edge is added.

16. **Wildcard UI routes remain pages and design fallbacks (2026-10-21).** React Router paths `*` and paths ending in `/*` retain their existing page ids and receive the `fallback` tag. Design reconciliation exposes undeclared fallbacks in an additive `fallbacks` list, rendered under its own heading, outside undesigned-page drift. A manifest that names the route claims it normally. The shared graph stays at schema version 1; both element and Component route declarations use the same page and render-edge contract.

17. **Test report replacement by project (2026-10-21).**

Results imports retain the latest evidence for each project within the same results report. Reusing a
report path for a second Playwright or Vitest project preserves the first project's case runs; an import
replaces all prior case runs for projects present in the incoming report, including cases removed from that
project's run. An unnamed project is `default`. `tests import --replace` restores replacement of all projects
previously read from the incoming results paths. Coverage reports still replace the whole matching run:
Istanbul has no per-case attribution, so a passing case plus run coverage never proves that case observed
a route. Results and coverage from different files remain independent.

Parameterized titles match the existing printf and named-value templates. A reporter-recorded declaration
line may identify a unique parameterized case in the named file; ambiguous templates remain unjoined.
For a runtime describe title, a reporter may also identify a literal leaf case by its named file, exact declaration line and exact leaf title, only when one case matches. Text-only joins still require the full suite title.
An empty coverage report is retained as `reason: empty` metadata without a gap warning; it proves no
execution and supplies no coverage edges. Empty results remain a reported gap.

18. **Sentinel is an optional package with its own artifact and draft contracts (2026-10-21).**

`packages/sentinel` (`@farsight/sentinel`) holds Farsight Sentinel's contracts and, later, its runtime. It
may depend on `@farsight/graph`, `@farsight/code-parser` and `@farsight/core`; no Farsight application package
depends on it, and core never imports it. `farsight-cli` does not bundle, import or initialize Sentinel, scanners,
containers or model SDKs: its pack preflight (`scripts/pack-preflight.mjs`) requires only the compiled outputs
of the CLI's own `workspace:` dependency closure, so an absent or unbuilt Sentinel cannot block a Farsight
release. Both packers then bundle into a staging directory and replace only their own outputs once the bundle
and the tarball succeed, so an incomplete build (a compiled module re-exporting one that was never built) fails
with every prior artifact intact. Sentinel ships separately as the
`farsight-sentinel` tarball (`scripts/pack-sentinel.mjs`): its bins and root export are bundled with Sentinel's
workspace closure inlined, its third-party dependencies stay declared, tsc's declarations ship as its public types
(every JavaScript export needs a `types` condition, and a declaration that imports a workspace package is refused),
and its schemas travel with it. The
tarball carries Sentinel's own version, `private` flag and Node floor, independent of application releases;
`farsight-cli` now declares the workspace's own `engines.node` (`>=24`) instead of `>=20`. Both
tarballs are verified from a clean `npm init -y` consumer, not a pnpm workspace.

The first contracts are draft versions. A `…/v1` name is adopted only when the contract review completes;
from then on, evolution is additive within a version, and a reader that meets an unknown major version refuses
it explicitly instead of guessing. Existing frozen contracts (`farsight-diff v1`, `farsight-tests-matrix v1`,
`farsight-impact-tests v1`, `farsight-affected v1`, `farsight-work v1`) and graph schema version 1 are
unchanged. The placeholder bin reports that no scanner is available; it claims no support. A later host bridge
(`packages/cli/src/sentinel.ts`, PR 24) reaches Sentinel as a separately installed executable over IPC and
updates this record. Rollback removes the package registration and leaves user data in place. See the
[Sentinel implementation plan](proposals/farsight-sentinel/implementation-plan.md).

19. **Sentinel's local store is one facade over an owner lock, a fenced ledger and verified objects (2026-10-22).**

`@farsight/sentinel` gains a public `./store` export (also re-exported from the root) whose one entry point is
`openStore(storePath)`. It is the only supported way to open a store, and the order is fixed: the SQLite runtime
gate and the store-path checks, then the lifetime owner lock, then the content-addressed object store under that
owner, then the ledger (created or migrated, with a verified backup before any upgrade) bound to the object
store's own verifier. The ledger registers with the owner, so `close()` closes it while the lock is still held; a
failure at any step releases what was taken and reports the step's own error. The facade returns domain
operations only. The SQLite module and connection, the lock database, migration lists, failpoints and the
object store's filesystem seam stay internal test seams; nothing public publishes without byte verification or
under a stand-in owner. Importing the package opens no file and loads no SQLite module.

A publication is accepted only in one ledger transaction, after every object it names was re-read and hashed in
this store, and only for the exact work revision, its active attempt and the current owner epoch. Identities are
registered as staging before a byte is written, so collection can never race a write. Each acquisition has its own
epoch (`epoch-<uuid>`); a run, work or attempt from an earlier epoch is refused. Reachability inspection and the
prune plan are read-only: v1 never deletes an object, and a plan names only candidates for a later, explicit,
separately reviewed prune. Retained provenance is protected: every artifact a retained work or attempt record names
(its influence manifest, invocation, outputs and diagnostics) is a root, so completed work is never a candidate
while its records are kept.

Qualification is bounded, and anything outside it is refused rather than assumed. The runtime's release policy lists
exact host and SQLite pairs (`qualificationFor`); a store opens only for a listed pair, in a canonical owner-only
folder on a file system the path checks identify as local. Measured: darwin-arm64 with SQLite 3.53.3 (Node 24.19.0)
and 3.53.4 (Node 24.22.0), on APFS; linux-x64 with SQLite 3.53.4 (Node 24.21.0), on ext4
([PR 03 CI evidence](https://github.com/zalos/farsight/actions/runs/39723522049/job/119642215934): 134 passed, four explicit platform/permission skips,
including every applicable real-owner, migration and object-publication test). The other local types the path checks accept (hfs on macOS; xfs, btrfs,
tmpfs, zfs and f2fs by Linux statfs) are allowlisted, not measured. Any other pair is refused before a store file
exists. Network, FUSE, overlay and unrecognised
file systems are refused. Durability is claimed for **process death**: SQLite runs WAL with `synchronous=FULL`,
objects are written, fsynced, verified and linked with their folders fsynced before a receipt exists, and the owner
lock is an OS file lock the kernel releases when the holder dies. It is **not** claimed for physical power loss:
`fsync` does not force a drive's volatile cache on macOS (no `F_FULLFSYNC` is issued), and no power-cut trial was
run. The store's reason codes are catalog keys
(`strings-sentinel-store.ts`, `strings-sentinel-storage-errors.ts`). The `ledger` capability is `available-draft`;
no scan capability changes, and the store's draft formats can still change before the contract review.

20. **The grant matcher is one pure core function shared by every gate (2026-10-22).**

`decideGrants()` and its generic types (`GrantLike`, `GrantDecision`, `GrantVerdict`, `GrantPrincipal`,
`GrantConfirm`, `AgentWritesPolicy`) move from `packages/work/src/gate.ts` to `packages/core/src/grants.ts` and are
exported from `@farsight/core`. The function is unchanged: default deny, additive grants with no deny grant, a
grant without principals is for people only, an agent waits for a person unless the policy allows agent writes or
the grant says `confirm: 'never'`, and of the grants that allow an action the first that needs no confirmation
wins. `@farsight/work` re-exports the same function object and types under the names it always had, so tracker
writes (`evaluatePolicy`), code-host posts (`codeHostPolicy`) and their callers keep their imports and behaviour.
**Why core:** Sentinel (PR 06) must apply the same policy matcher to its own actions without importing Work's
tracker sessions, providers or cache, and a second copy of the ordering rules would drift. The core module imports
nothing. **Boundary:** only verdict 1, the consumer's policy, is shared. Each consumer keeps its own grant shape and
target check (`miss`), and its own capability and credential verdicts: Work's `credentialVerdict(Session)` and
`provider.can()` stay in Work and are not a model or scanner credential check. Confirmation receipts, budgets and
Sentinel's settings adoption are not part of this boundary. **Cost:** a public core export that Work, code hosts and
Sentinel must all keep compatible; a change to its rules is a change to every gate at once, which is the point.

20. **Sentinel captures source with its own Git object reader, stages before it writes, and records what it cannot read (2026-10-22).**

`@farsight/sentinel` gains a public `./snapshot` export (also re-exported from the root): `captureSnapshot(store,
request)`, `restoreSnapshot(store, snapshotArtifact, target)`, `readSnapshot` and `reconcileInventory`. Capture works
through the PR 03 store facade only; it never opens the ledger database or the owner lock.

*Committed-tree* capture reads the pinned commit's objects with a plain TypeScript reader (`snapshot/git.ts`): loose
objects and version-2 pack indexes and packs, offset and reference deltas, SHA-1 and SHA-256 object formats, file-based
refs and `packed-refs`, annotated tags, and a linked worktree's Git directory when the request names it. No `git`
process is started, so no hook, filter, attribute, textconv, replace ref, fsmonitor, configured command or promisor
(lazy) fetch can run, and the repository's own configuration is read for its object and ref formats only. Every object
is size-bounded before it is inflated and hash-verified against its id. An object that is not stored locally (a partial
clone, an alternate the capture does not follow, a pruned pack) is recorded as missing, never fetched; reftable refs
and other formats are refused. The alternative, spawning `git cat-file` with hardened flags, was rejected: it trusts the
repository's configuration and git version for every guarantee above, and it would add a second process to a library
whose only spawn is the macOS mount table. *Working-copy* capture reads every file without following a link, stores it,
then enumerates the tree again; any difference discards the attempt (its stages aborted) and retries, and a tree that
never holds still is reported unstable rather than mixed. Its mode says so (`working-copy-stability-checked`); it
never claims an atomic revision, and `dirty` is false only when every tracked file was captured with its committed
blob id and nothing else was.

The inventory is the owner's policy, never the repository's ignore files. Hidden workflow and configuration files are
captured like any source. `.git`, the store itself, dependency caches and policy exclusions are folder boundaries with
unknown (null) descendants, never zero. Links, special files, unsafe names (dot segments, slashes, NUL, backslash, a
committed `.git`), names that are not UTF-8 and case- or normalisation-colliding restore paths are refused; unreadable,
too-large and over-quota files keep their sizes. Missing or corrupt Git objects, LFS content and submodule commits are
recorded; LFS content and submodules are read only from local inputs the request names, and a captured submodule is
a separate source with its own repository identity and commit. `reconcileInventory` accounts every path an
independent walk finds, by its own entry or a boundary above it (E1).

Before a byte is written, the snapshot is checked against its contract and every artifact it will store (source
bytes as `source`, the manifest as `source-derived`) is registered as staging. Bytes are re-read and re-hashed against
the inventory as they are stored. Each stage is then published under a running attempt the caller supplies; a stage
holds at most 4095 artifacts, so a larger capture publishes content stages first and the manifest last, linking only
accepted content. A failure before publication aborts every unpublished stage. `restoreSnapshot` writes a new
read-only tree from the store alone, reads it back and lists it again. The capture reason codes are catalog keys
(`strings-sentinel-capture.ts`); the `source-capture` capability is `available-draft`. Not in this decision: parser
artifacts and file outcomes (PR 05), framework versions from lockfiles (left empty), and any scan coverage.
