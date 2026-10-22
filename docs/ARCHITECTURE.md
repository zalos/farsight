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

21. **Sentinel captures source with its own Git object reader, stages before it writes, and records what it cannot read (2026-10-22).**

`@farsight/sentinel` gains a public `./snapshot` export (also re-exported from the root): `captureSnapshot(store,
request)`, `openSnapshot(store, snapshotId)`, `restoreSnapshot(store, snapshotId, target)`, `readSnapshot` and
`reconcileInventory`. Capture works through the store facade only; it never opens the ledger database or the owner
lock.

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

A snapshot is not a run's output, so it is not published under an attempt: the ledger gains **snapshot admission**
(schema step 2). Before a byte is written, the envelope is checked against its contract and every artifact is
registered as *unbound* staging: source bytes as `source`, in stages of at most 4096, then a roots stage holding the
manifest (`source-derived`, linking every content artifact) and the materialization sidecar (`source`, linking the
manifest). An unbound stage may link to content another open unbound stage of the same epoch holds; an attempt's
stage still may not. Bytes are re-read and re-hashed against the inventory as they are stored. `admitSnapshot` then
re-verifies every object through the object store's verifier and, in one transaction, records the artifacts, their
representations and links, an immutable `snapshots` row (manifest, materialization, inventory digest, epoch,
sequence) and a `snapshot-admitted` event, and releases every stage. The manifest and the materialization join the
GC snapshot's accepted references, so a snapshot is never a prune candidate; its content is reachable through
their links. A failure before admission aborts every stage. Adding the event kind needs the event log's CHECK
changed, which SQLite cannot alter in place: step 2 rebuilds the table by SQLite's documented procedure, and the
migration runner now applies every step with foreign keys off (the pragma is a no-op inside a transaction), runs
`foreign_key_check` before commit and switches enforcement back on whatever happens.

The envelope records dispositions only. The **materialization sidecar** (`sentinel-capture-materialization/draft-1`,
canonical JSON, bound to its snapshot by the ledger row and checked against the manifest on every open) records what
a restore and PR 05's reconciliation need beyond it: every listed folder, empty ones included; each included file's
executable bit and provenance (its Git mode and blob id, or the LFS pointer it was resolved from); each recorded
link's target; and every gitlink's commit. A sidecar keeps the root-owned contract unchanged while those facts are
draft. The inventory digest covers those facts too (without the snapshot id derived from it), so equal bytes with a
different mode, folder set or link target are a different inventory; `openSnapshot` recomputes it. `restoreSnapshot`
writes a new read-only tree from the store alone (folders and files), reads it back and lists files and folders
again; any difference fails it. No restored file is executable, whatever its source mode: the original mode is
provenance only, and no option makes restored project code runnable.

Bounds: a capture stores at most the accepted 512 MiB budget (`maxTotalBytes`, the default) and 16 MiB per file; the
manifest must fit the 4 MiB envelope limit, checked on its bytes. The schema's 200 000 entries is a bound only; the
default entry limit is 20 000, and it counts every recorded entry and every listed folder across all sources, reserved
before a folder is listed, so a tree of empty folders cannot outgrow it; a folder that does not fit is an unknown
boundary, and a source root that does not fit refuses the capture. Folders deeper than 256 levels, or whose entries
would have paths over 4096 characters, are unknown boundaries too, never deeper recursion. Folders that collide by case or Unicode normalisation with a file or another folder are
recorded as refused boundaries, not dropped. Working-copy reads go through folders whose identities are checked again
before each listing and before and after each read, and LFS content only through real folders under the permitted
root: these detect a swap between observations; they are not an OS-level audit of every read. The capture reason codes are catalog keys
(`strings-sentinel-capture.ts`); the `source-capture` capability is `available-draft`. Not in this decision: parser
artifacts and file outcomes (PR 05), framework versions from lockfiles (left empty), and any scan coverage.

22. **Sentinel parses a snapshot with the public parser and checks its reads around it (2026-10-22).**

`@farsight/sentinel` gains a public `./parser` export: `parseSnapshot(store, request)` and
`retainSnapshotAnalysis(store, target, analysis)`, with the reconciliation pieces (`reconcileAnalysisInputs`,
`joinFileOutcomes`, `fingerprintTree`, `assertParserInputSafe`) exported for review and tests. It is a separate subpath,
not part of the root or `./snapshot`, because it loads `@farsight/code-parser`. That happens lazily, on the first parse:
the TS/JS adapter has a native binding and the Java adapter a WASM grammar, and importing Sentinel must start nothing.

The parser runs only over a private copy restored from the store (ADR 21), never over the original checkout. The copy
is read-only and non-executable, which `assertParserInputSafe` re-checks before the parse. The parser is the public
`createParser` with the built-in `tsJsAdapter` and `javaAdapter` only; custom adapters are not accepted. Selection
must state `gitignore` and `testFiles`, and may name include/exclude globs. Application enrichment options
(`externals`, `plumbing`, `setup`) are refused. Every `ParserLimits` field must be given, within the accepted
ceilings (`PARSER_LIMIT_CEILINGS`: 120 s, 16 MiB per file, 512 MiB total, 200 000 files and entries). Glob lists
and source lists are bounded and checked. A captured source id the parser cannot use as a node-name prefix (one
holding `::`, a slash, a backslash or a line break) is refused as `sentinel.parse.sourceUnsupported` before anything
is materialized. No application
ingestion, configuration enrichment (API policy, guards, body readers, test reports), network or process is
involved. A config file the parser lists while discovering is never read.

The parser has no reader hook, so integrity is checked around it, as the plan requires:
- The copy is fingerprinted before and after (paths, kinds, file bytes or sorted folder listings, modes), and any
  difference fails.
- Every recorded `analysis.inputs` row is reconciled by kind against the copy and the captured inventory:
  - content against the captured bytes and content id;
  - a folder against its sorted listing;
  - metadata against its kind;
  - a missing path must carry the parser's unavailable encoding, and be either verified absent from a fully listed
    folder, recorded by capture without its bytes, below an unenumerated boundary, or inside a gitlink.
- An escaping, absolute or unexplained input fails `sentinel.parse.integrity`, as does a file the parser reports that
  the capture did not hold.

These checks cover recorded reads and the copy; they are not an operating-system audit of native code.

File outcomes are joined to every captured entry without changing the snapshot: parsed, parse-failed, parser-skipped,
not-selected, not-captured, unknown-scope. Capture's disposition takes precedence. Unknown boundary descendants stay
null, and diagnostic lines are kept as the parser gave them, never invented. The result's `counts` tally captured
entries by class over one source. They are not coverage, and a surface that prints them wires them as `Counted` values
(`docs/COUNTS.md`) when it exists. `parserComplete` is the parser's own selection flag, and `clearsChecks` is always
`false`: syntax evidence never clears a check.

Retention keeps the parser's **portable `farsight-analysis` artifact verbatim**, occurrences included. Sentinel does
not fork its schema: `./parser` re-exports `@farsight/code-parser`'s own `AnalysisArtifact`, `InputFingerprint` and
`ParserLimits`. The packer vendors the declarations of publishable workspace libraries (those with
`publishConfig`, here `@farsight/graph` and `@farsight/code-parser`) under `dist/vendor/` and rewrites their imports,
so a typed consumer sees every graph, resolution and occurrence field. Any other workspace package in a declaration
is still refused. Its import scan ignores comments and string literals (`Pick<T, 'from' | 'to'>` is not an import).
One staged publication of the parse stage's attempt stores, per source, three objects:
- the artifact (`source`, since graph nodes can carry implementation previews);
- an index (`sentinel-parser-index/draft-1`, `source-derived`) of node and call-site locations, citing captured content
  ids with byte spans, bounded at 100 000 entries with the remainder counted. Files are read one at a time and
  released. Line spans come from the raw bytes' newlines, which hold for any bytes. A character span is converted from
  the parser's UTF-16 offsets only when the file round-trips as UTF-8, in one pass over the file. Otherwise, or when
  an offset is out of range or splits a character, the location is kept without a byte span and with its reason
  (`invalidUtf8`, `invalidLine`, `invalidSpan`, `splitSurrogate`). Nothing is estimated or clamped;
- a result record (`sentinel-parser-result/draft-1`, `source-derived`) whose outputs link the artifact and index.

An object over 16 MiB is refused before a byte is written; splitting a large analysis is left open. If a write or the
publication fails, the call aborts its own stage while the store is still held, so a retry can register it again,
and reports the original error. Without the owner, the stage stays pinned for recovery. Parser words are
catalog keys (`strings-sentinel-parser.ts`).

23. **Sentinel's rule packs, rule lock and trusted policy are data and decisions, never pack code (2026-10-22).**

`@farsight/sentinel` gains `./rules` and `./policy` exports (also re-exported from the root) and nine draft envelopes
generated like the others: `sentinel-rulepack`, `sentinel-rulelock`, `sentinel-settings`, `sentinel-repoconfig`,
`sentinel-policy`, `sentinel-adoption`, `sentinel-receipt`, `sentinel-admission` and `sentinel-controls`, all
`draft-1`. (Numbered 23 to leave 21 and 22 to the capture and parser decisions landing beside it.) **Rule packs** are
read as plain files under one canonical folder (no link, device, FIFO or escaping name), within budgets on entries,
files, depth, path length, file size and total size; listing is one entry at a time, and every folder's identity from
the root down is checked before and after each listing and file read, so a swapped folder refuses the pack instead of
being followed. `validatePack` enforces the same budgets on a map handed to it directly, counting each implied folder and each file once, as the directory walk does, and refusing a path that is both a file and a folder. Packs are validated against
their manifest and digested: the pack digest covers the sorted
inventory of every file, and each rule's definition digest covers its definition, rule file and fixtures. A rule
implementation is declarative data for a registered adapter; one shaped like a script is refused, and nothing in a
pack is imported, evaluated or spawned. **The lock** is immutable and content-addressed. A validated pack is deep-frozen and
recognised only when `validatePack` produced it; a structural copy is refused. Promoting a pack (`rule.promote`) or
recording a tool or database digest (`tool.acquire`) needs the owner's spent receipt for exactly the complete entry
promotion writes (inventory, rights, rules and their digests, or the tool/database entry) against exactly that lock
revision; promotion digests and writes its own private copy, and returns a new revision naming its predecessor's digest; a plan pins a lock
digest, so a pack update never changes an existing plan. A rule family is locked by one pack. A planner gets each rule's definition through
`resolveLockedRules(lock, pin, packs, families?)`: pure, no download or re-acquisition; the lock must have exactly the
pinned digest, a pack is used only when it is `validatePack`'s own object whose complete entry equals the locked one,
and each definition digest is recomputed from that pack and must equal the lock's, so a missing, stale, newer, forged
or mismatched pack is refused. Rights (SPDX
expression, origin, upstream for third-party content) travel with every pack, tool and database. Recording a tool
digest authorizes no download and no execution. **Policy:** `.farsight/sentinel/settings.json` is the owner's file
(scrubbed twin `settings.example.json`), holding keychain references only; a credential-shaped value anywhere else
is refused without being echoed. Its place in a checkout grants nothing: an adoption record in the owner's user
state (`$XDG_STATE_HOME/farsight/sentinel/trust`, else the platform user-state folder, never inside the checkout)
binds the settings digest to the canonical workspace path and folder identity, after the owner's receipt for exactly
those bytes and that workspace. Changed bytes, a clone, a moved checkout or a re-created folder fall back to the
built-in defaults, which grant nothing. The repository's `sentinel.config.json` requests: the effective rules are the
mandatory rules united with the requested ones, each threshold takes the stricter side, and a request to remove a
mandatory rule, weaken a threshold, suppress a finding or use an undefined provider is recorded as refused. Only the
redacted effective policy (no endpoint, keychain reference or raw byte) is served. **Admission** records three ANDed
verdicts: policy (core's shared `decideGrants`, ADR 20, plus owner-action, provider and budget bounds), the adapter's
capability, and credential authority (a checked keychain scope, or an explicit local-only reason; unknown denies).
Nothing after a policy denial is asked, so a denied action contacts nothing. Owner actions (approving a disposition,
promoting rules, recording tools, adopting settings) are never granted to an agent and always need a receipt. A
**receipt** binds the intent's canonical digest (action, input, effects, budget, scope), the state and the policy
revision, expires within an hour and is spent once across processes. Issuing one is not reachable through the
package's exports, so MCP tools, the HTTP bridge, model output and other packages can ask and never confirm.
**Trust snapshots:** a validated pack, a spent receipt, the effective policy, the
defaults and an admission's request are private deep copies, deep-frozen, and the pack, receipt and policy are
recognised only as the objects their own function returned; what a spent receipt authorizes is captured when it is
spent and read from there, never from the caller's object. The policy revision a receipt binds is the digest of the
whole trusted snapshot (settings in effect and view), so any grant, provider or budget difference is a new revision.
**Control facts** (`sentinel-controls`) are the shared contract for the framework packs of PRs 14–17: per surface
(a canonical graph identity), property and chain position, a verdict of applies, does-not-apply or unknown; a
resolved verdict needs evidence spans and a resolved framework version, an unknown one names its reason, and there is
no protected-surface flag. **Not decided here:** the planner (rule applicability over discovered surfaces, plan
revisions, batching) waits for PR 05's parser interface; bounded preauthorization of a run or profile, pack staging
commands and durable receipts in the store ledger are later work. **Cost:** nine more draft formats to review, and
owner receipts kept in user state rather than the ledger until the coordinator exists. Same-account code is outside
this boundary, as for the store.

24. **Sentinel plans deterministically into an immutable plan revision that covers exactly what it can run (2026-10-22).**

`@farsight/sentinel/planner` is a pure planner: the same pinned inputs give the same `sentinel-plan/draft-1`
revision, byte for byte, with no clock, file, ledger or network access. Its inputs come from the actual modules:
the rule lock resolved by the rules module's `resolveLockedRules` against its canonical pin and the exact
validated packs (a rule is planned only with the definition whose digest the lock pins), the effective policy (pinned by its `revision`, the digest receipts and admission bind to),
the snapshot envelope and each source's parser evidence. Surfaces are graph nodes of kind `route` (an HTTP endpoint)
and `page` (a UI route); a handler is the function a route reaches, not a surface. A capability is available only
when a capability table Sentinel's own code built records that an adapter in the trusted adapter registry (PR 07)
establishes it, that adapter is still registered with the same digest, and the profile permits relying on it; a
profile, caller or settings label cannot make an unestablished capability available. A rule runs only through a
registered adapter, and an external one only when the rule lock approves exactly that tool: an entry with the
registered version and the registered image's digest (`sentinel.plan.toolMismatch` otherwise). The bootstrap stages run only through
registered operations bound by the profile; an unbound stage stays in the plan and its work is handed off blocked
(`sentinel.plan.operationUnbound`), never run by a generic worker. A whole-repository check reads the source's complete
captured file set (bounded; a larger source is not planned as a whole), and every entry it cannot read, excluded,
refused, unreadable or unlisted, is kept as its own gap. Each unit binds its exact captured input set by digest,
apart from its wider input fingerprint. An unresolved framework version is unknown for the source it names, or for
every source when it names none. A surface rule also keeps, as required gaps, every file of its languages that did
not parse, every folder capture could not list, and a parser index that stopped at its bound or placed locations
outside the capture: surfaces nobody could discover never disappear from coverage.
Parser evidence is accepted only for the snapshot and source it read: the adapter requires the parser's result and
index to agree on snapshot, source and analysis fingerprint, and the planner refuses an analysis of another snapshot,
one that joined other bytes than the snapshot captured, or a surface in an uncaptured file. Planner inputs carry trusted identity only as the deep-frozen views the adapters derive; a copy or an edited view
is refused. The contract's validator re-derives every check and unit id from its content and enforces the pin
graph (each check's rule revision and adapter, its analysed source, the canonical bootstrap shape), so a resealed
revision with a recomputed digest is still refused; every binding handed to the coordinator is a deep-frozen copy.

A bootstrap revision captures once, parses each source and builds the inventory. An analysis revision derives one
check per scope a selected rule names, identified by (scope, rule revision, environment, mode). A check the profile
can run is `planned` and assigned to exactly one work unit (one adapter over one source, bounded); every other check
stays in the plan with its state and reason: unsupported, applicability unknown (a framework whose version is
unresolved for the source it names, or every source if it names none; a framework the snapshot does not
name at all is never read as absent), scope unavailable (not captured, or not parsed where the rule needs parser evidence) or scope unknown
(a folder capture could not list). A policy rule missing from the lock is a rule gap. Required coverage follows
mandatory rules, complete-coverage policy and required capabilities; `requiredCoverageAchievable` says whether a
run can complete it. The contract's invariants refuse a plan in which any unplanned check is covered, any planned
check is uncovered or covered twice, the work graph has a cycle or an unknown dependency, the tallies do not
recount, or the content differs from its digest. A revision is never edited: a new rule lock or policy produces a
new revision (or a child run's first) that depends on the already published bootstrap work, so nothing is captured
or parsed again, and the earlier revision and its lock stay exactly as pinned.

The coordinator receives its `PlanBoundary` (`planBoundaryFor`, analysis revisions only, with the run, including
its requested sources and profile, checked against the plan's pins, and built over its own deep-frozen copy of the
validated plan and snapshot) of canonical `sentinel-work/draft-1` envelopes (`workEnvelopesFor`): stage resources come
from the trusted profile within the work contract's ceilings, and each unit's influence manifest is the canonical
JSON its artifact id names. Each unit's inputs pin the captured content artifacts, which its input fingerprint
covers; `verifyWorkEnvelope` refuses a work envelope whose fingerprint, manifest, dependencies or identity differ from
the plan's unit, and `capturedInputsOf` refuses bytes other than the pinned ones. The boundary also carries the sealed
plan and each work's exact checks. Required coverage is computed by `evaluateRequiredCoverage` from
`sentinel-coverage/draft-1` records alone: a required check is complete only through a `complete` record for this run,
this check and its assigned work revision, executed, at per-file-per-rule granularity (an aggregate record
completes only a whole-repository check). Reuse does not count until a reuse derivation records the exact prior
check, scope, rule, inputs and environment (PR 27). Imported evidence,
reuse and work merely finishing never count; an unplanned required check or a required rule gap keeps
coverage incomplete. Persistence and admission of a plan stay with the coordinator and the policy
gate (`run.start` on the plan digest). Tool matching here establishes version and image support; execution
platform qualification remains an admission requirement and must use the full lock and qualified registry.
Not decided here: framework control-fact work (framework-order stays unavailable until packs exist),
and scheduling for model review.

25. **Sentinel executes only admitted plan revisions, runs its own bootstrap operations, and takes coverage from coverage records (2026-10-22).**

**Admission.** A plan revision runs only once the ledger has admitted it (schema 4, `plan-admission`). `admitPlan`
in `execution/plans.ts` checks first:
- the plan validates and matches its own digest;
- the rule lock's digest and the effective policy's revision are the plan's pins;
- the execution profile record (`sentinel-execution-profile/draft-1`) holds every adapter, capability and operation
  the plan pins, at the same digests.

It then stores all four records and admits them in one transaction. The revision chain must be exact. An analysis
revision pins an admitted snapshot. The plan is a collection root linking the other three, and survives reopen and
prune. A run advances one admitted revision at a time (`advanceRunPlan`); its creation envelope stays as recorded,
and a run with admitted plans takes work only from an admitted revision no later than its current one.

**Opening a run.** The coordinator opens a run by id. It reads the current revision back with `loadPlan`, repeats
every check, and checks the profile again against the live registry. It then binds each unit through PR 06's
canonical boundary: `planBoundaryFor` or `workEnvelopesFor`, then `verifyWorkEnvelope` and `verifyInputSet`.
- Each work names the canonical `influenceManifestOf`, accepted with the work.
- Check inputs come from a read-only restore of the pinned snapshot.
- Work an earlier revision published and this one reuses must already be published, in this run.

**Execution binding and invocation records.** What actually ran is a separate record,
`sentinel-execution-binding/draft-1`: the canonical manifest's id, the adapter digest, the exact inputs and the
protocol fingerprint, beside the plan's wider input fingerprint. The two fingerprints are never forced equal. Each
attempt's invocation record links its binding and is accepted with the attempt's start, so failed, canceled and
interrupted attempts keep both. The start message carries the unit's assigned checks and scopes.

Trusted check drivers prepare the scanner job and normalize verified outputs under the same absolute unit deadline
as the worker and its publication. Drivers receive the combined unit/run/cancel signal; every awaited preparation,
execution, normalization and object write is checked again before continuing. The worker receives only the budget
left after preparation, and durable acceptance rechecks both unit and run deadlines without an intervening await.
Opening the coordinator checks each selected driver's implementation digest against both the live executing
adapter and the admitted unit, even when its driver registry was constructed against another adapter registry.


The internal production drivers bind Pattern, OSV, Trivy and zizmor to this one seam. Each accepts only its original
shipped rule families, revisions and definition digests, plus the exact pinned engine image and the assigned
snapshot inputs. Required database/checks provenance is supplied explicitly from owner-held acquisition records;
a path or adjacent file grants no trust and no driver downloads anything. Missing assets refuse preparation and
leave the unit unpublished; public scanner capability registration and acquisition remain separate integration work.
The bridge seals its job with the plan/unit/check binding, normalizes the exact supervisor outcome frozen in place,
and publishes source-derived reports and findings beside per-check coverage in the same accepted attempt. A trusted
normalizer can refine the actual read set only to sealed captured input scopes; scanned scopes must also have been
read. Expected scopes remain the admitted plan's scopes. The verified worker result stays unchanged as audit evidence.
Original rule packs and their digest manifest ship as data assets; they contain no engine, database or execution grant.


**Coverage.** Each assigned check gets one `sentinel-coverage/draft-1` record per attempt that published:
`complete`, `partial` (scope skipped, unresolved or not scanned) or `not-run`. The record is never finer than the
trusted adapter's registered `coverage` granularity (default `aggregate`); a result cannot claim finer coverage.
The run's outcome is `evaluateRequiredCoverage` over these records alone. A worker's own claims, work finishing,
unplanned required checks and rule gaps can never make it complete.

**Bootstrap operations.** Capture, parse and inventory are registry adapters of kind `operation`, whose digest
covers the Sentinel module that implements each. The coordinator runs them in its own process, under recorded
attempts whose worker is `coordinator-operation`. Each attempt names the operation adapter the plan pinned, and its
invocation record names the plan, the canonical manifest, the snapshot and the parse settings. Their authority:
- **capture** verifies the run's snapshot, admitted in this store by PR 04 capture, and that its sources are
  exactly the plan's and the run's. It publishes a record naming that snapshot; it never captures again.
- **parse** runs the public parser over a restore (PR 05 `parseSnapshot`) with the profile's pinned selection and
  limits, and retains the complete analysis.
- **inventory** gathers exactly the plan's published parse results, each checked to be its own source's analysis
  of this snapshot.

Each operation only reads and prepares its records. The coordinator publishes them only if the unit's grant held:
- its deadline, cut to what is left of the run's, with the parser's signal aborted at it;
- the memory this process grew by, sampled while the operation runs;
- its CPU time against the quota;
- and the run was neither canceled nor expired meanwhile.

An operation starts no process and writes no process output, so its pid grant and `maxOutputBytes` (a bound on a
worker's stdout and stderr) always hold. The size of what it retains is a separate contract: the store's object cap
and the parser's own pinned limits. Because operations run in the coordinator's process,
the memory and CPU bounds are measured on that process, not isolated.

`loadBootstrap` reads that evidence back for `planAnalysis`. A stage with no bound operation stays held, and no
generic worker runs.

**Tests.** `execution-bootstrap.test.ts` captures, runs the bootstrap, plans from what it published, admits and
executes the analysis, and crashes and resumes in both revisions.

**Not decided here:** the run's admission receipt (`run.start` on the plan digest) and its CLI, child runs over a
parent's bootstrap, reuse derivations (PR 27), and planning in the coordinator itself.
26. **The pattern engine runs behind an original protocol shim inside its pinned image, and coverage is per file per
rule only where the engine timed the rule (2026-10-22).** (21–25 are reserved for capture, the parser, the planner and
the command.)

Semgrep 1.181.0 cannot speak the `sentinel-worker` protocol, and PR 07 hands an external worker its inputs only as
content-addressed blobs (`/input/<digest>`, no paths) with a fixed environment. Rather than add a second execution path
or a derived image, the adapter's fixed command runs an original, standard-library shim from its inputs inside the
unmodified pinned image: `/usr/bin/python3 -I -S -B /input/<shim digest>`. The shim's digest sits in the command, so the
adapter digest pins it alongside the image reference and the engine arguments; the scheduler supplies the shim, one job
manifest, the rule config and the targets as ordinary inputs, which PR 07 copies and hashes. The shim is transport: it
reads exactly one job (a second job-shaped input makes it refuse, so captured source cannot stand in for the job),
materializes targets by relative path under the container's noexec `/tmp`, never materializes repository ignore files and
writes its own empty `.semgrepignore` (the engine's built-in ignores would otherwise drop `node_modules/`, `tests/`,
`dist/` silently), runs the fixed arguments with telemetry and version checks off, and returns the bounded raw JSON and a
run record. Authority stays with the coordinator: the run record must name the supplied job; only job rules, job targets
and declared languages count; spans are checked as bytes, lines and columns against the captured bytes; identity is
Sentinel's digest, never the engine fingerprint; no source text is kept; structural locators and local taint stay
distinct and cross-file traces are refused. **Coverage:** the engine's `paths.scanned` cannot certify that each rule ran
on a file (its file prefilter skips rules whose required text is absent), so `--time` match times are the evidence: a
rule is `complete` on a file only with a non-zero match time, `not-run` with zero, `partial` when an engine-reported
timeout names that rule, and `not-established` when timing is missing; a requested file neither scanned nor skipped is
`omitted` even on exit zero. A zero match time stays a required-coverage gap: no policy option turns absence of execution evidence
into completion, and accepting a prefilter as proof would need its exact qualified semantics and independent fixtures.
**Diagnostics:** engine stderr can quote arguments, paths and source text, and a sensitive value
can be a plain lowercase word, so no engine text is ever forwarded or stored. A failed run is reported as one fixed
catalog category (invalid pattern, unparseable or missing config, invalid language, invalid argument, killed, or
unknown) and its exact exit code, as a protocol diagnostic and in the run record; the stderr digest is kept for
provenance. **Platforms:** the pinned reference is a multi-platform index; only linux/arm64 is
measured (darwin-arm64, Docker Desktop), and results from another image architecture are refused. The opt-in
`sentinel-pattern-qualification` workflow measures linux/amd64 on a native runner, where results are accepted only as
`candidate`; a green run is the evidence for marking it measured. **Package:** the tarball ships the pack and the worker
with a digest/rights manifest, but no export can invoke the adapter: the package gate is partial until the PR 09 command
runs the installed adapter, and the consumer test's engine run uses the workspace service on the installed assets.
**Rules** come from PR 06's resolved, pinned rules through `patternRulesFromResolved`, which accepts only rules this
adapter can run faithfully (source-file scope, no framework, source bytes / pattern match / source span, TS/JS/Java),
checks detector bytes against the pinned pack digest, and returns every other rule as an explicit unsupported check.
**Cost:** a Python file inside a string in the package, a tie to the image's `/usr/bin/python3`, and one attempt per job
batch of at most 2,000 targets to keep timed output under its 3 MiB bound. **Not decided here:** registering the adapter
in the production registry, the planner's batching, the scan command (PR 09), and amd64 qualification.
29. **Dependency advisories come from pinned, separately acquired OSV snapshots, matched fully offline, and counted only
where the engine proves it matched (2026-10-22).**

`src/adapters/osv/` runs OSV-Scanner 2.7.0 (`ghcr.io/google/osv-scanner@sha256:4f3b7e2c…69fcd0`, Apache-2.0, official
multi-platform index; linux/arm64 measured, linux/amd64 listed and unmeasured) through PR 07's isolated execution
service only. **Acquisition is separate:** the only network step is `acquireAdvisorySnapshots`, an owner action
(`tool.acquire`) confirmed by a spent receipt for exactly the request (ecosystems, URLs, size bound). It fetches only
`https://osv-vulnerabilities.storage.googleapis.com/<npm|Maven>/all.zip`, refuses redirects and anything over the stated
bound (at most 512 MiB; the npm archive was 219 MB and Maven 10 MB on 2026-10-22), checks the origin's MD5 and stores
each archive by SHA-256 beside a provenance manifest in an owner-only folder; `loadAdvisorySnapshot` re-hashes it before
any scan. The request is a private frozen copy taken before validation, and one spent confirmation admits exactly one
acquisition (a retry needs a new confirmation; a failed one stores nothing). The origin's date is read only as a strict
HTTP date; anything else leaves the snapshot's age unknown, and a scan reports `database-age-unknown`, never fresh. A scan never downloads: snapshots are inputs by digest, the engine runs `--offline` with no network, and the
owner's freshness bound turns an old snapshot into `database-stale`. **The worker:** the official image is
golang:alpine (busybox sh, no Python) and inputs are sealed 0444, so an original POSIX shell shim runs as `/bin/sh
/input/<digest>`; it reads only constrained values (ids, digests, an integer index and a dependency-file basename from a
fixed list per file; real relative paths stay with the coordinator), links the snapshots read-only into the layout the
engine expects, and never forwards engine stderr: it reports the exit code, a fixed failure category, the stderr digest,
which databases the engine reported loading, and the count of packages it dropped. **What counts** (measured, each a
silent false negative of the engine): a failed run still prints packages with no advisories, so a failed run counts
nothing; a database that fails to load leaves the exit code at 1 when another ecosystem matched, so a component counts as
matched only when the engine reported loading its ecosystem's database; and a lock entry without a registry source is
listed with `source=LOCAL` and never matched (`lodash@4.17.11`: 0 advisories without `resolved`, 7 with it), so such a
component is not assessed and its file is `partial`. **Certainty and limits:** lockfiles (npm, pnpm) give resolved
versions and the transitive closure as locked; a CycloneDX SBOM gives components as its producer listed them; a
`pom.xml` gives declared direct dependencies only, read by a deliberately small parser that says how each version was
declared (exact, property, range, managed); ranges and managed versions are not assessed, and a match on a range's lower
bound is refused. Offline, Maven transitives are never resolved (no deps.dev, no registry), so a POM file is always
`partial`. Findings are one per component and advisory group across every file that names it; the assessment id
includes the snapshot digest, so a new snapshot is a new assessment, and `explainAdvisoryChanges` says whether a change
came from the snapshot (same captured bytes) or the source, and reports `unknown` when one side did not assess the
component (a failed run is never a resolution). A component the adapter refuses (another ecosystem, malformed) keeps its
file `partial`. Advisory text is not kept. Package matches never claim
reachability. **Not decided here:** registering the adapter, the planner's scheduling of acquisition and scans, the
command (PR 09) and shipping no database in the package. linux/amd64 is measured only by the
`sentinel-osv-qualification` workflow on a native runner; until a green run is recorded it stays a candidate.
33. **Sentinel checks infrastructure configuration with Trivy's misconfiguration scanner only, against one pinned checks
    bundle, and needs the engine's own evidence for every covered file (2026-10-22).** `src/adapters/trivy/` (PR 13)
    runs `trivy config` from the official Trivy 0.76.1 image index (tag commit e713f67; the image's revision label names
    it), behind an original POSIX shell worker, only through PR 07's isolated execution service: no pull, no network,
    no host fallback. Only the configuration scanner runs, so nothing duplicates the OSV adapter's dependency results;
    the selected types are Dockerfiles, Kubernetes YAML and Terraform (`.tf`, `.tf.json`, local modules). Helm,
    CloudFormation, Azure ARM, Ansible, plans and Kubernetes JSON are listed as unsupported, not silently skipped.

    - **Checks are data the owner acquires once.** The trivy-checks 2.3.0 OCI manifest and its one layer are pinned by
      digest (the manifest's revision names the release tag commit; MIT). `acquireChecksBundle` is an owner action
      (`tool.acquire`) admitted only by a spent receipt for exactly that bundle, used once; it fetches the anonymous
      pull token, the manifest and the layer from `ghcr.io`, follows only the registry's redirect to its blob host
      without the token, checks every byte against the pins and stores the archive privately. Because the request
      names digests it is immutable. Without it nothing runs: every configuration file is `bundle-missing`.
    - **The engine's silent fallback is refused.** Trivy uses the checks compiled into its binary when its cache is
      missing, and says so only in its log. The worker unpacks the pinned bundle into the cache layout, skips updates,
      telemetry and version checks, disables `.trivyignore`, and reports the engine's own "loaded from disk" evidence
      and check count as fixed words and digits. A run without it counts nothing (`bundleNotLoaded`).
    - **Coverage needs positive evidence.** The worker also reports, from the engine's log and filtered to the job's
      own paths, which files and Terraform module folders were scanned, which failed to parse and where a remote module
      failed to load. At exit 0, a Dockerfile or Terraform file the engine never logged is `notReported`, a gap, never
      a pass (the engine silently skips `.git` folders, for one). Files are scanned below one fixed folder so the engine's
      root-relative `proc`, `sys` and `dev` skips cannot hide a captured folder of that name. YAML the engine did not log
      is not applicable only when its bytes prove the engine's Kubernetes rule (a document with apiVersion, kind and
      metadata) cannot match; otherwise it is `notReported`. Inline
      `trivy:`/`tfsec:` ignore comments, which the engine honours with no switch to disable them, a remote module
      (scans have no network, so modules are never fetched) and unread variable files leave a file `partial`.
    - **Findings are configuration facts at captured paths.** A finding keeps the check id, the bundle's severity,
      the configuration type, the captured path and artifact (a module folder has none) and lines validated against
      the captured bytes; never the engine's message, which quotes the file, and never a new graph node. Checks outside
      the pinned bundle's `builtin.` namespace, unknown targets and impossible lines are refused, with a reason.
    - **Platforms.** linux/arm64 is measured on a darwin-arm64 Docker Desktop host; linux/amd64 is unmeasured until the
      native `sentinel-iac-qualification` workflow passes with zero skips.

    Not decided here: registering the adapter in the production registry and planning its checks (PR 08/09),
    Terraform variable files and plans, Helm rendering, and any additional configuration type.

34. **Sentinel audits CI configuration with zizmor offline, and the audits that need the network are a stated gap
    (2026-10-22).** `src/adapters/zizmor/` (PR 13) runs the official zizmor 1.31.1 image index (its build provenance
    names `refs/tags/v1.31.1` at commit effdb35; MIT) behind an original POSIX shell worker, only through PR 07's
    isolated execution service: no pull, no network, no token (the GitHub token variables are unset as well).

    - **Inputs.** GitHub Actions workflows directly in any `.github/workflows` folder, `action.yml`/`action.yaml`, and
      `.github/dependabot.yml`; files keep their paths so zizmor collects them by its own layout. Pre-commit
      configuration, remote repositories and other CI systems are listed as unsupported.
    - **The repository cannot suppress a finding.** `--no-config` and `--no-ignores`: neither a repository
      `zizmor.yml` nor an ignore comment changes what is reported. The regular persona is selected and recorded.
    - **Offline is explicit.** zizmor 1.31.1 skips five audits without the GitHub API (impostor-commit,
      known-vulnerable-actions, ref-confusion, ref-version-mismatch, stale-action-refs) and runs three with less
      information (artipacked, typosquat-uses, unpinned-uses). The worker reports the engine's own "skipping" lines; the
      coordinator requires exactly the pinned online set, so every workflow and action is `partial` with
      `onlineAuditsSkipped` and `offlineDegraded`, never complete; any other audit failing to load is `auditNotLoaded`.
    - **Coverage and consistency need the engine's own evidence.** A file the engine reported completing is covered; one
      it collected but did not audit (unparseable, schema-invalid or empty, all at exit 0) is `notAudited`; one it
      never collected is `notCollected`. The exit code is zizmor's own summary of its highest finding (11–14, or 0 with
      none): a report that disagrees with it, or a run where an online audit loaded, counts nothing.
    - **Findings are CI configuration facts at captured paths.** A finding keeps the audit, severity, confidence and
      its primary and related locations as UTF-8 byte spans checked against the captured bytes; never the engine's
      annotations, quoted features, descriptions or fixes, and never a new graph node.
    - **Platforms.** linux/arm64 is measured; linux/amd64 is unmeasured until the native `sentinel-iac-qualification`
      workflow passes with zero skips.

    The worker change found here applies to every shell worker: a frame binding built in a command substitution never
    advances the sequence number, so a diagnostic followed by a result repeats it and PR 07 refuses the attempt. Both
    PR 13 workers build it in their own shell.

    Not decided here: online audits with an owner-supplied token, pre-commit inputs, other personas, registration and
    planning (PR 08/09).


37. **Sentinel's command line is the owner's entrypoint; its local service never grants owner authority (2026-10-22).**

`farsight-sentinel` is where the owner acts: `init` writes the workspace's settings once (PR 06's defaults plus a
human-only `capture.source`/`run.start` grant for the chosen profile) and never overwrites them; `settings adopt`
shows the settings digest and waits (exit 4) until `--confirm`, when the owner's receipt is issued and spent in that
same process and the exact bytes adopted; `plan`, `run`, `status` and `report` work in the foreground over the store
facade, each change decided first by admission's three verdicts. Commands parse only the options they declare;
every result is typed (`cli/outcome.ts`): Sentinel's exit codes 0–4 for policy results, plus `submitted`,
`unavailable`, `prepared`, `kept`, `answered` and `refused`, which never borrow a policy word, and `--json` always
carries the outcome, the exit code and the three verdicts.

**Who asks is the entrypoint's, never the request's.** The owner channel is the command line in its own process. A
client of the local service (`transport/ipc.ts`) is always a non-owner agent, whatever its hello names: `cli`,
`mcp` and `http-bridge` only label the channel (`local-service`, `mcp`, `http-bridge` in the draft `DecisionChannel`).
A request body that names an actor, principal, channel or confirmer is refused, so owner authority can reach the
service only as a receipt id the owner's own process minted, which the service verifies. The socket lives in a
private runtime folder keyed by the canonical store path and an owner nonce (`$XDG_RUNTIME_DIR`, `$TMPDIR`, else a
short 0700 folder under `/tmp`); its path is measured in bytes with room for the terminator (103 on macOS, 107 on
Linux); folder and socket must be this user's and closed to others; a stale socket of ours is replaced and anything
else refused; frames are length-bounded JSON; the handshake must name the store and owner the client expects.

**The canonical path, with a foundation preview as its only check.** The command line plans nothing itself. `plan`
captures the workspace (admitted as `capture.source`), admits the bootstrap revision, has the coordinator's own
capture, parse and inventory operations publish it (ADR 25), plans the analysis with PR 06's planner from exactly that
published evidence, under the owner's promoted rule lock and the adopted policy, and admits it with the lock, policy
and execution profile before anything is scheduled; `run`, foreground or in the service, executes only the run's
current admitted revision. A run's identity is its captured inventory, lock, policy and profile, so the same content
under the same terms is the same run (`kept`). The profile is the coordinator's execution profile record over the
shipped registry: the bootstrap operations and one check adapter, an original preview detector (SQL text assembled
from strings in TS/JS and Java) shipped as the pack `rules/foundation-preview` the owner promotes. The analysis plans
one scope per unit, because a worker receives its inputs by artifact id and must tell which file is which scope; the
detector covers a unit only when it can, and reports anything else skipped, so an unread file stays partial. Results
are read from the ledger: the recorded outcome and the coverage records. A run resting on the preview rule ends
`required-coverage-incomplete` (exit 2), and this build never prints `satisfied` (findings are judged against the
policy only with the full report). `rerun <run> [--stage <unit,…>]` and `retry <run>` (the units that did not
publish) plan a new run naming an ended one as its parent, over its retained snapshot with nothing captured again,
after previewing the consequences from the parent's admitted plan: the selected units and everything downstream run
again, prerequisites and the bootstrap are reused as published. Only a whole-analysis rerun executes today; a strict
subset is previewed and refused, because planning just those units and reusing another run's published work are not
built yet. Changed source is a new `plan`. The report is rendered from the ledger and stored artifacts, pinned to the run's last
event. The published bundle ships the modules the code names by file URL (the launch gate, the bootstrap operations'
implementations) as entries of their own, references rewritten and digests recorded in its manifest.

**The owner's background service holds the store; authority reaches it as a receipt.** `serve` (or `run --detach`,
starting it on demand as this same executable with a fixed argument list and an explicit environment) opens the
store for its lifetime, listens on the socket and records its address and owner nonce in the owner's private user
state, never the checkout. While it runs it alone opens the store: status, wait and report go through it; plan and
foreground run refuse until it stops (after an idle period, or on SIGTERM, pausing work in flight). Starting or
resuming a run needs either a receipt the owner's own CLI issued after `--confirm`, bound to `run.start`, the run's
current admitted plan digest, the policy revision and the exact instance (workspace identity, store and run), spent
once by the service, or what the adopted grants give the connection's
agent principal, by admission; the defaults give agents nothing. Pause and cancel are writes decided the same way
under their own actions (`run.pause`, `run.cancel`), so a receipt for one never serves another and being connected
grants nothing. The launcher captures its own invocation and stops exactly the process it started; the service
record is removed only by the process that wrote it. One run executes at a time; a second start of the same plan joins it, a start of a
finished run prints its result again, and a run whose service died reads as interrupted and resumes through the
coordinator's recovery with each output accepted once.

**The owner's rule lock is kept in owner-private state, one immutable revision per digest.** `rules promote <pack>`
validates the folder with the rules module's `validatePack` and, only after `--confirm`, promotes it with its
`promote` under a receipt for exactly that candidate against exactly the current revision; each revision is filed once
under its digest and read back through `verifyPinnedLock`, and the current pointer is replaced atomically, only from
the revision the promotion was confirmed against (a create-once link per revision, published whole through a synced
temporary name), and the pack's exact files are kept so a plan resolves the lock against them. A repository supplies
no lock. **Not in this decision:** the full report and finding policy (PR 19); per-input paths in the worker
protocol, which would let a unit cover several files. Same-account code is outside this boundary, as for the store.



**ADR 37 extension — explicit scanner command dispatch (2026-10-22).** The owner CLI composes the four reviewed
production drivers through the canonical coordinator; the preview also has an exact-rule trusted driver and its
worker distinguishes captured scoped inputs from the sealed auxiliary job. The `scanners` initialization preset
selects seven original families; the default `static` preset preserves preview compatibility. A shipped adapter
registry entry does not grant an installed capability: selected external rules need exact owner-promoted tool pins,
a qualified existing local image and required held databases/checks. Plan and execution verify these prerequisites,
including databases removed after planning, before scanner attempts. Production jobs batch at most 32 scopes;
preview jobs retain one scope. Skips and omitted files remain explicit coverage gaps.

`assets adopt-tool` and `assets adopt-database` are owner-only receipt-confirmed promotions, with no network. The
owner names both archive and provenance; metadata never gains trust because it is beside a file. The spent receipt
state digest binds provenance in addition to the candidate and previous lock. Private immutable records are keyed
by that receipt and verified against the admitted lock entry, while archives are held by content digest. OSV imports
require an explicitly stated published SPDX expression; Trivy checks retain their fixed Apache-2.0 provenance.
Separate `assets acquire-database` actions call the existing bounded allowlisted brokers under a one-use receipt,
with a deadline; acquisition never silently promotes or runs an asset. Plans and scanners never autoacquire.

The initial public scanner report is an internal draft document in CLI `facts.report`, not the full report envelope
or a new package export. It reads only accepted same-attempt publications of the exact admitted plan and uses the
shared required-coverage evaluator. Normalized observations and per-check coverage remain separate, with pinned
provenance and shared scoped counts. Regeneration needs neither source checkout nor scanner assets. Full finding
policy, placement, framework/model integration and complete reports remain subsequent work; no command in this
slice declares policy satisfaction. Actual verified worker outcomes retain architecture qualification authority.
28. **Sentinel's secret scan keeps the detector and whole lines, never the value, and a failed scan is never clean (2026-10-22).**
PR 11 scans captured current-tree bytes with Gitleaks 8.30.1 (MIT) through the PR 07 execution service only: an
external adapter, the official multi-platform image index pinned by digest (`ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0…`),
installed ahead of time and never pulled at scan time, no host fallback (`src/adapters/gitleaks/`). **Shape:** Gitleaks
cannot speak the worker protocol, so an original POSIX shell shim does, inside the unmodified image (alpine: busybox
sh and applets). The shim is the attempt's first input and runs as `/bin/sh /input/<its digest>`; the adapter digest
pins it, and with it the configuration and report template it writes. Only arm64 is measured; amd64, listed in the
index, gives `candidate` results under an explicit qualification run and is otherwise refused. **Inputs:** the shim, a
line job (`F <index> <content> <path>`) and each captured content once. Files over 8 MiB, names with a line break or
another control character, and paths the release's own global allowlist skips are not sent; each is a skipped scope
with its reason, never a silent omission. **No repository control:** the shim rebuilds the tree one folder below the
scan root, so a captured root `.gitleaksignore` is an ordinary scanned file; Gitleaks gets the pinned configuration
(the release's built-in rules, nothing allowed), an empty ignore folder, `--ignore-gitleaks-allow` and no baseline.
Measured by a direct probe of the pinned image (2026-10-22): the same root ignore file suppresses a finding when the tree is the scan root, and
nothing under the shim's layout. **Redaction:** Gitleaks runs with full redaction and writes its report through the
pinned template, which names only the rule, the lines and the file; its stdout is discarded and its stderr stays in
the tmpfs, only its digest leaving. The coordinator accepts a report line only as `F, rule, start, end, file` with the
rule one of the 222 the pinned default configuration defines (`rules.ts`, generated from the release's own
`config/gitleaks.toml`) and the file a sent path, then builds each observation from a closed field list: the rule, a
captured file, a whole-line byte span read from the sealed input copy, a fixed message and fixed limitation keys.
**Failure:** an engine error, a kill, a missing, oversized, malformed or inconsistent report (exit code and findings
disagree), an unknown rule or file, lines a file does not have, an unmeasured platform, or a refused job makes the scan
an `error` over every target with a coded reason; the shim itself reports only a catalog code. **Audit:** the result
names the engine, adapter digest, image reference and id, platform, configuration and default-rules digests, the shim,
job and invocation digests, the exit code, and the stderr and report digests. **Packaging:** `scripts/package-assets-gitleaks.mjs`
ships the shim and a digest/rights manifest as `farsight-sentinel/assets/gitleaks/*`; no image, binary or report ships.
**Not decided here:** registration in the production registry and the report/CLI surface (PR 08/09), Git history
scanning. **Cost:** a location is whole lines, so a long line cites more than the match; the release's per-rule
allowlists and stop words are detector semantics and part of the pin; a path whose file is also another's folder is
refused rather than partly scanned.
