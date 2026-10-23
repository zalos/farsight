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


**Positive container memory evidence.** On the qualified native Linux Docker Engine/cgroupv2 profile only,
`execution/cgroup-memory.ts` may observe the exact-owned container's local kernel counters in addition to the raw
daemon state. Its inspected PID and stable kernel start/cgroup association bind the full container leaf; root-owned,
no-follow directory/file identities are pinned and checked before every bounded read. Before the unchanged start,
one bounded setup establishes a fresh baseline while all original protocol, cancellation and deadline limits remain
active. Extra worker data during setup is refused. A witness needs local `max`, `oom` and `oom_kill` increases plus
the actual admitted `memory.max`. These are co-observed limit activity and an OOM kill, not proof of a causally paired
killer. Only failed `workerExited`/137 with no signal and valid owner can receive that refinement; other failures
and cleanup retain precedence. Daemon `OOMKilled:false` stays false. No parent/host counters, guessed cgroup path,
artifact trace, privilege expansion or new public authority is involved. One watcher, fixed read/sample bounds and
a final read before any Sentinel stop still may miss fast teardown; missing/raced evidence grants nothing. Desktop
remains daemon-only. The shared resource error vocabulary also covers coordinator CPU/memory and scheduling capacity.

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
again, prerequisites and the bootstrap are reused as published. A strict subset is a selected rerun (ADR 43).
Changed source is a new `plan`. The report is rendered from the ledger and stored artifacts, pinned to the run's last
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

43. **A selected rerun is a linked run over the parent's retained snapshot that runs exactly its selection and holds
the rest (2026-10-22).**

`rerun <run> --stage <unit,…>` naming a strict subset of an ended run's analysis units plans a new run whose parent
is that run, over the parent's snapshot, under the rule lock, adopted policy and execution profile in effect now. It
reuses the parent's published bootstrap through the parent chain (the same snapshot, published in a run of that
lineage), never capturing or parsing again, even when the source is gone. The analysis is planned afresh from that
evidence; a parent unit maps to the new unit with the same stage, adapter, implementation digest, source, checks,
input-set digest, input fingerprint and scopes. A selected unit with no such match is refused as
`sentinel.service.selectionStale` naming it (another detector build, changed rule bytes, other inputs), never widened.
A unit the revision would have to reuse from the parent is refused as `sentinel.service.prerequisiteNotReusable`, and
a parent with no published bootstrap in its lineage as `sentinel.service.bootstrapUnavailable`. The selected units and
everything downstream run; every other unit is held `disabled-by-policy` with reason
`sentinel.execution.notSelected`, given no inputs and never started.

**The selection is admitted with the plan.** The record `sentinel-rerun-selection/draft-1` (`execution/selection.ts`)
names the parent run, revision, plan digest and snapshot; the selected parent → unit pairs; the downstream units; the
held units with their parent counterparts; and the reused bootstrap. Admission checks it against the revision:
every unit runs or is held exactly once, what runs is closed downstream, nothing that runs depends on a held unit,
and the reused set is the plan's. It is stored as an immutable artifact, linked from the plan and pinned in the
ledger's `plans.selection_id` (migration 5, `plan-selection`), so the coordinator, a resume after a crash and the
service all hold the same units back. The preview `rerun` prints is that same admitted plan. The run is created on
the first `run`, foreground or detached, from an envelope derived from the admitted plan and selection. `retry` of a
selected run reruns only the selected units that did not publish.

**One request is one run; asking again after it ended is a new one.** A rerun's id is its request (parent, selection,
lock, policy, profile) and a generation: the first generation not yet admitted, or admitted and not ended. Repeating
the request while its run waits or runs joins it (`kept`), and a crash resumes it; once it has completed or been
canceled, the same `rerun` is a fresh run with its own id, and the ended one is never handed back as new. A
whole-analysis rerun follows the same rule; a plain `plan` of the same content stays the same run (ADR 37).

**Coverage stays honest.** A held unit's results stay the parent's and are not copied as the child's coverage, so a
selected rerun whose held units carry required checks ends incomplete, and the preview counts them (`requiredHeld`).
The parent's runs, results and report are unchanged.

**A retained full report proves the bootstrap lineage again.** A selected child's completed analysis has no new
inventory stage. The report reader resolves exactly the inventory its admitted plan reuses, following at most 64
runs and refusing cycles. Every selected edge must match the durable parent id and that parent's exact admitted
revision, digest, snapshot and reused inventory. The producer's own admitted bootstrap must name that inventory
work revision; its accepted attempt must be the pinned coordinator inventory operation, with a retained invocation
bound to that plan, snapshot and work. The existing bootstrap reader then verifies the retained inventory and parser
artifacts. A genuine accepted publication from a sibling over the same snapshot is still refused, as is a parse/check
publication or a missing invocation. No live registry, current scanner image or source checkout is needed for this
read. Strict-subset preview and admission use this same retained proof before planning or staging any child work; whole-analysis reruns retain their fresh bootstrap path. Held units remain gaps; no parent observation or coverage record becomes the child's.

Privacy knowledge also survives a selection. An ancestor proven by those same selection bindings may have an accepted
Gitleaks match while the child holds Gitleaks and reruns Pattern. The minimal scanner report inherits matched-name withholding through the same verified lineage and shared accepted-secret validator, without importing any parent records into its observations or counts. The reader assesses that ancestor's accepted secret
publication through the existing record-binding checks and applies the conservative projection to the child (and to a
comparison whose selected baseline inherits that knowledge). It contributes only a withholding flag; no ancestor
finding, coverage or comparison result becomes the child's. A clean accepted ancestor scan preserves ordinary excerpts
and confirmed context labels. Missing/corrupt evidence refuses; a canceled ancestor with an accepted secret-scan
publication conservatively refuses because the completed-run assessment cannot authenticate it. This does not widen
completed-run eligibility or reuse analysis results as prerequisites.

**Open gate: dependency-bearing selections are refused.** A selection where something that runs needs an analysis
unit that does not run is refused (`prerequisiteNotReusable`), even when the parent published that unit under exactly
the same terms; only the bootstrap is reused. The shipped planner's check units depend only on the bootstrap, so no
shipped plan reaches this today. Consuming genuine, eligible parent publications as prerequisites and counting held
results as coverage belong to differential selection (PR 27); until both exist, the selective-stage rerun completion
gate stays open, and a selected rerun never claims complete coverage on its own. **Not in this decision:** selecting
by stage name rather than unit id.


26. **The pattern engine runs behind an original protocol shim inside its pinned image, and coverage is per file per
rule only where the engine timed the rule (2026-10-22).**

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

32. **Sentinel's Nest pack resolves request controls from registrations, and never from names (2026-10-22).**
    `packages/sentinel/src/frameworks/nest/` (PR 16, exported as `./frameworks/nest`) emits `sentinel-controls/draft-1`
    facts for one captured source, with a `sentinel-nest-scope/draft-1` scope report of each surface's ordered chain.
    Its inputs are the snapshot, the bytes the store captured and the public parser's artifact for the same snapshot.
    The parser graph names the surfaces (a route node and the controller method it calls) and nothing more: an
    annotation match, a guard node, a declared `validates` edge or a reachable reader is never protection evidence.
    The pack reads the captured TypeScript itself with the parser's pinned `oxc-parser` (loaded on first analysis),
    converts its UTF-16 offsets to UTF-8 byte spans (refusing one inside a surrogate pair) and cites every resolved fact
    by content id, span and quote digest. Nothing is executed, installed or imported from the target.

    - **One exact version.** `@nestjs/common` and `@nestjs/core` 10.4.15, from the captured `package-lock.json` or an
      exact `package.json` pin, and class-validator 0.14.1 for validation. A range, a missing entry or another release
      leaves `framework.version` null and every fact unknown.
    - **What is followed.** One `NestFactory.create(RootModule)` kept in a named variable and its literal
      `useGlobalGuards`/`useGlobalInterceptors`/`useGlobalPipes`; `@Module` metadata from the root module through local
      imports; `{ provide: APP_GUARD | APP_INTERCEPTOR | APP_PIPE, useClass }`; `@UseGuards`/`@UseInterceptors`/
      `@UsePipes` on a controller or handler and pipes passed to a parameter decorator. The chain is ordered as Nest
      10.4.15 evaluates it: guards, interceptors, pipes, each global → controller → method (pipes also per parameter).
    - **Distinct effects.** Only `ValidationPipe` imported from `@nestjs/common`, with literal options, over a
      parameter whose type is a local class with class-validator rules, is validation. `Parse*Pipe` and the
      `@nestjs/platform-express` file interceptors are parsing; `DefaultValuePipe` and `ClassSerializerInterceptor` are
      transformation. A guard's effect is never inferred, so authentication and authorization are `unknown`
      (`guardEffectUnresolved`) whenever a guard is in the chain, and `does-not-apply` only when the chain has no
      guard, no unmodeled interceptor and no frontier. A local class named `ValidationPipe` is a local pipe.
    - **Frontiers stay explicit.** Dynamic and external modules, provider factories/values/aliases, middleware,
      non-literal registrations, custom decorators, inherited controllers, unregistered controllers, unresolved
      providers and unreadable files are `sentinel.nest.*` frontiers. A frontier that could change a verdict leaves
      it unknown: global frontiers apply to every surface, surface frontiers to that surface only. A handler on the
      HTTP adapter is a frontier outside the controller surfaces.
    - **E2.** The accepted framework corpus's route-scoped ValidationPipe gives `input-validation: applies`; the same
      DTO with no pipe registered gives `does-not-apply`, citing the parameter and the bootstrap. A multipart
      interceptor only parses: the upload stays `does-not-apply` with the interceptor cited.
    - **Only what certainly runs counts (review, 2026-10-22).** The application is the `const` the bootstrap declares from
      `NestFactory.create`; a global registration counts only as a straight-line statement on it, after the create and
      before `init`/`listen`, before any statement that can return or throw, in a bootstrap the module calls
      unconditionally. Every other `useGlobal*` call (conditional, in a `try`, after initialization, in another
      function, on another binding) is `registrationNotFollowed`, and handing the application to other code is
      `applicationEscapes`; both leave the facts they could change unknown. Names resolve lexically: a parameter or
      local declaration that rebinds an imported name (a bootstrap parameter called `ValidationPipe`) is not the
      import, while aliased and namespace imports are. Stacked `UseGuards`/`UseInterceptors`/`UsePipes` register bottom
      to top (each appends to the metadata the decorators below it wrote).
    - **Validation needs its preconditions.** `applies` also needs ValidationPipe options known not to weaken it
      (whitelist, forbidNonWhitelisted, transform, error and debug settings, `forbidUnknownValues: true`), no conditional
      rule on the DTO (`ValidateIf`, `IsOptional`, `groups`, `always`), no inherited rules, and decorator metadata: the
      captured tsconfig nearest the controller must set `experimentalDecorators` and `emitDecoratorMetadata` to true
      itself (cited as evidence); off is `decoratorMetadataOff`, inherited, missing or SWC-built is
      `decoratorMetadataUnknown`.
    - **Owning projects, constraints and interceptors (second review, 2026-10-22).** Versions are those of the project
      that owns each analysed file (the nearest manifest declaring Nest; its nearest lockfile, nested installs before
      hoisted ones; else an exact pin); the envelope's one version is set only when every owning project resolves to the
      supported release. `Allow` is not a constraint; custom (`Validate`, `ValidateBy`, `ValidatePromise`) and nested
      (`ValidateNested`) constraints hold logic the pack does not read, so they leave validation unknown. An interceptor
      the pack does not model runs before the pipes and can answer without the handler, so it blocks `applies`; it, or a
      guard, also blocks `does-not-apply`, since unmodelled code may check the input itself.
    - **Decorators, dependency copies and rewritten code (third review, 2026-10-22).** Any DTO decorator that is not
      class-validator's own (a local wrapper such as one returning `ValidateIf(() => false)`, class-transformer's, one
      on the class) and any rule argument the pack cannot read leave validation unknown. Every dependency resolves as
      Node would from the file that loads it: the nearest lockfile install for that folder, else an exact pin in the
      nearest manifest that declares it; ranges and missing installs are unresolved. ValidationPipe loads
      class-validator from where @nestjs/common is installed and a DTO registers its rules with the copy its own folder
      resolves, so `applies` needs both to be the same installed copy of 0.14.1. Writing to a member of the
      application (`app.useGlobalPipes = ...`) is `applicationMutated`; writing to anything imported from Nest,
      class-validator or class-transformer, through assignment, `Object.defineProperty` and the like, or rewriting
      reflected metadata, is `frameworkMutated`; both block every fact they could change.
    - **Framework values leaving followed bindings (fourth review, 2026-10-22).** A local framework alias is
      followed only through supported identifier/member bindings, type wrappers and conditional/logical alternatives.
      A constructor hidden in a sequence, aggregate or class field, supplied as a parameter/default, returned, or
      handed to an ordinary function is `frameworkEscapes`. Constructor methods such as `bind`, `call` and `apply`
      are also outside the modeled exports and factory call. Such code may mutate the actual framework, so every
      control fact stays unknown. Modeled registration arguments and framework decorators remain supported; type
      names, noncomputed property names and unused shadowed parameters do not pass the imported value anywhere.
    - **Supported uses, with unknown as the default (fifth review, 2026-10-22).** Each runtime reference to a
      framework value is followed only through supported local bindings, member/type wrappers and modeled receivers.
      Any other consumer is `frameworkEscapes`, including tagged-template arguments, constructor instances handed
      to helpers, subclasses, returns and exports. A new syntax form therefore stays unknown until explicitly
      modeled. Types, declaration/property names, discarded reads and unused shadowed parameters are not escapes.
      Existing registrations that cannot certainly run retain their precise `registrationNotFollowed` frontier.
    - **Local binding boundaries (sixth review, 2026-10-22).** Keeping a framework value in a variable is supported
      only when that declaration is local and not inside an unmodeled namespace. Exports, including live bindings
      assigned after declaration, remain unknown at the boundary. Qualified names in runtime TypeScript
      import-equals declarations are values, while type-only imports and qualified type names remain erased.
      Unmodeled framework module loads, dynamic import targets, retained host loaders and Node loader factories
      also leave a frontier; a local function merely named `require` grants no loading capability.
    - **Digests.** `packDigest` covers the support manifest, `environmentDigest` the resolved versions and
      `registrationDigest` every cited registration span; a change to any invalidates the facts.

    Not decided here: CLI and planner integration (PR 09 still pending), CSRF/CORS/rate-limit/header properties,
    guard bodies, Fastify, and versions other than 10.4.15.

36. **Sentinel retains bounded call paths as structural evidence and imports deep analysis only when attested and bound (2026-10-22).**
No evaluated engine qualified for cross-file flow in E3 (`feasibility-decisions.json`, `engine.crossFile`), so
Sentinel selects, bundles, downloads and runs no deep engine, and `interprocedural-flow` stays unavailable with
`sentinel.capability.noQualifiedEngine`. Two draft boundaries replace it honestly, exported as
`farsight-sentinel/analysis`. **Bounded call paths** (`sentinel-paths/draft-1`, `boundedCallPaths`): one index per
parser artifact; a breadth-first search over the parser's `calls` edges (optionally `http` and `renders`; never
guard, validation or test edges) within explicit depth, fan-out and visit bounds; strongly connected components are
reported as call cycles, and every node is visited once, so cycles terminate. A query is `reached` (the shortest
path, each step with the parser's resolution and its captured call sites), `not-reached-bounded` with the frontier
kinds it met, or `not-reached-complete` only when nothing was left unexplored and every visited function's captured
text is accounted for: the parser records no edge for a computed call, a call on an unknown value, a global or a
function handed on as a value, so each visited function's whole-line bytes are scanned lexically (Unicode
identifiers included, a keyword read as a property counted) and any call-like site beyond the recorded ones, or any
function name used as a value, is a frontier (the scan may over-count, never under-count). A parser edge to a
top-level function whose name the calling function also binds (a parameter, a local) is not followed
(`shadowedCall`). The artifact, its parser index, the snapshot and the reader are bound before anything is cached or
read: the index must be the artifact's own analysis (the envelope names the artifact's fingerprint), every location it
cites must be a captured file of that snapshot with the same content id, bytes read must hash to the id cited, and
caches are keyed by the artifact and index together, so nothing computed for one capture is served for another. The envelope binds the snapshot, source, analysis fingerprint, a digest of the graph read and the
bounds, and always states `establishes: call-reachability` with `notDataFlow` and `graphOnly`: a path never claims
flow, taint, sanitization or protection. **Attested deep import** (`sentinel-deep-import/draft-1`,
`importDeepAnalysis`): a customer-run analyzer's flows are untrusted input. A document that does not validate is
refused. Nothing it asserts about itself is trusted: it is used only with the owner's spent receipt for the new
owner-only `evidence.import` action, bound to the canonical digest of the whole document (tool, version,
distribution, licence terms, provenance, configuration and flows) and to the snapshot and source
(`deepImportIntent`); without it, or with one for any other document, snapshot or action, it yields nothing;
one bound to another snapshot or source, or to any file whose content differs from the capture, is unbound; a flow
location outside a file the tool read, or past its bytes, is unknown. Accepted flows become `imported` observations
(producer `imported`, the document digest as provenance) limited to the tool's stated files and configuration; they
never count as executed checks, and the analyzer's mode name and stated build are recorded, never read as a
capability. Runtime control facts and framework packs stay separate: nothing here reads guard edges or turns a path
into an authorization proof. Not decided here: scan wiring (PR 09/10), selecting an engine if a future one
qualifies, and how imported observations are correlated (PR 19). Words are `strings-sentinel-analysis.ts`.

27. **Sentinel's first framework pack reads Spring Security servlet chains from source, for one exact version (2026-10-22).**

`@farsight/sentinel` gains a public `./frameworks/spring` export: `analyzeSpring(input)`, which returns one validated
`sentinel-controls/draft-1` envelope for one captured source's Spring routes, together with `SPRING_PACK`,
`SPRING_ORDER`, `SPRING_SUPPORT`, `SPRING_REASON_CODES` and `matchTemplate`. It is a library: no scan runs it until the
CLI (PR 09) integrates it, so PR 17's full acceptance depends on that work. The `framework-spring` capability is
`available-draft` with reason `sentinel.capability.draftSpring`: source only, exactly the stated versions.

**Scope.** Exactly Spring Boot 3.4.3 with the Spring Security 6.4.3 its dependency list pins, servlet stack. These are
read from the captured `pom.xml` as XML structure (elements by name and nesting, never by child order).
The envelope's version is `null`, and every fact `unknown`, for any of:
- an explicit Spring Security version anywhere;
- a Spring version property;
- managed or imported dependencies;
- profiles or modules;
- WebFlux, a Gradle build, or a build that does not parse.

Documentation for other versions is not evidence for these.

**Registration.** A configuration class counts only when Spring Boot's default component scan registers it: the single
`@SpringBootApplication`'s package and below, for a component class. Any explicit scan or import annotation, scan
attribute or auto-configuration registration makes classes outside that scan `unknown`
(`sentinel.spring.componentScanUnresolved`). A class Spring does not register enables nothing, so
`@EnableMethodSecurity` must sit on a registered `@Configuration` or `@SpringBootApplication` class. Every `@Bean`
whose type is a `SecurityFilterChain`, in any qualified spelling, is a chain. Any other `…FilterChain` bean is an
unknown candidate, never omitted. Names resolve through imports, the package and qualified names in captured source:
composed annotations, superclasses and interface default `@Bean` methods are followed there, and anything resolved
outside Java's or Spring's own types is unknown. Java shadowing is honoured: a type the file declares, or a member
type inherited from a captured supertype, shadows an import of the same name, so where it could, the name is unknown
rather than the import. Spring merges meta-annotations, so `@Bean`, `@Order`, `@Profile` and `@Conditional` are read
through captured composed annotations: a composed `@Bean` declares a chain, while a composed order or condition, or an
annotation from uncaptured code that could carry one, leaves the chain's position or activity unknown
(`sentinel.spring.chainOrderUnsupported`, `sentinel.spring.conditionComposed`, `sentinel.spring.beanDeclarationUnknown`).
Spring registers an inherited `@Bean` but invokes the most specific method, so an inherited chain whose method name a
subclass declares again without `@Bean` is unknown (`sentinel.spring.chainOverridden`), never read from the superclass.
A chain the pack cannot see or place sorts ahead of every known one.
A chain's configurer arguments must be provably inert: a lambda that only configures its own parameter and never
continues past `disable()` (which returns the builder); Spring's own `AbstractHttpConfigurer::disable`; Spring's
`withDefaults()`; Spring constants; or literals. An application method reference, or anything that could reach the
`HttpSecurity` again (for example `removeConfigurer`), makes the chain unknown. The parent POM must be looked up from
the repository (an empty `relativePath`); a relative parent could manage other versions.

**Roles and the anonymous principal.** A role or authority check is always authorization. It is authentication only
when the anonymous principal Spring gives unauthenticated requests cannot hold any authority it admits. By default that
principal holds `ROLE_ANONYMOUS`, so `hasRole("ANONYMOUS")` does not require authentication. `anonymous(disable)`
removes it, and a customised anonymous principal leaves authentication unknown. A `GrantedAuthorityDefaults` bean,
which can change the `ROLE_` prefix, leaves role checks unknown.

**Inputs and evidence.** The input is the captured snapshot, the PR 05 parser evidence for the source, a reader for
captured bytes by content id, and the selected environment (`activeProfiles`, `null` when none was selected). The
public graph supplies route identities only. Its route names are lossy: variables rewritten, the first path kept, and
a method-less `@RequestMapping` named GET. So each route's mapping is read again from captured syntax. So are every
`SecurityFilterChain` bean and its `@Order`, `@Profile`, `securityMatcher`, `authorizeHttpRequests` rules and added
filters, `@EnableMethodSecurity`, method-security annotations, filter beans, `WebSecurityCustomizer` and MVC
interceptors. Syntax comes from tree-sitter's Java grammar (`@vscode/tree-sitter-wasm`, the version the parser pins),
loaded on first analysis. Nothing is compiled, resolved or run. Evidence spans are exact UTF-8 bytes of captured
files; a file that is not exact UTF-8 gives no span, and its facts are unknown. Graph tags and the parser's guard nodes
are never proof.

**Semantics.** The facts follow Spring's own order:
- order 0: filters, unknown when any are present;
- order 1: the first matching chain's first matching rule;
- order 2: MVC interceptors, unknown when present;
- order 3: method security, resolved only with an active proxy-mode enablement for that annotation kind and a
  proxyable handler.

Chains are taken in `@Order`, and a chain without a `securityMatcher` matches every request. Path patterns are compared
as templates: a result is `match` or `no-match` only when it holds for every request the route can receive. A trailing slash is never trimmed: Spring Framework 6.2's patterns do not equate `/x/` and `/x` by default, and configuration can change that, so a pattern or route ending in `/` is unknown. Partial
matches, equal orders that could both match, profiles not selected, conditional beans, non-literal matchers and
helper-built chains are `unknown`. A route no chain matches is `unknown` (`sentinel.spring.noChainMatches`), with every
chain matcher cited, and never protected: source alone cannot exclude a chain a dependency contributes. Missing or
unlisted Java source, configuration that does not parse, or a configured servlet path leave chain selection unknown.

**Keys.** `packDigest` covers the pack identity, its order and `SPRING_SUPPORT`. `environmentDigest` covers the
selected profiles. `registrationDigest` covers the path and content id of every file read. A change to any of them
changes the facts' key. Reason codes are catalog words (`strings-sentinel-spring.ts`).

**Not in this decision:**
- what Spring does when no rule in a selected chain matches;
- Boot's default chain when no chain bean exists;
- XML or adapter-style configuration;
- async dispatch;
- multi-module builds;
- other Boot or Security versions.

Each is unknown, not inferred. Later packs (PRs 14–16) follow the same envelope, positions-in-order and "unknown, never
rounded" rules.

29. **Dependency advisories come from pinned, separately acquired OSV snapshots, matched fully offline, and counted only
where the engine proves it matched (2026-10-22).**

`src/adapters/osv/` runs OSV-Scanner 2.7.0 (`ghcr.io/google/osv-scanner@sha256:4f3b7e2c…69fcd0`, Apache-2.0, official
multi-platform index; linux/arm64 and linux/amd64 measured) through PR 07's isolated execution
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
command (PR 09). No database ships in the package. Native linux/amd64 qualification passed
[21 tests with zero skips and the installed worker](https://github.com/zalos/farsight/actions/runs/39788785215);
the adapter records that evidence, and the workflow rechecks the pinned image on affected changes.

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
    - **Platforms.** linux/arm64 is measured on a darwin-arm64 Docker Desktop host; linux/amd64 is measured on
      native Ubuntu 24.04.5 with Docker Engine 28.0.4 by [CI run 39817213827](https://github.com/zalos/farsight/actions/runs/39817213827/job/119958735627) (33 tests, zero skips, and both installed workers).
      The exact tested revision and pins are in [the evidence record](proposals/farsight-sentinel/evidence/2026-10-22-iac-native.json).

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
    - **Platforms.** linux/arm64 is measured; linux/amd64 is measured on native Ubuntu 24.04.5 with
      Docker Engine 28.0.4 by [the same native CI job](https://github.com/zalos/farsight/actions/runs/39817213827/job/119958735627); its offline gaps remain unchanged.

    The worker change found here applies to every shell worker: a frame binding built in a command substitution never
    advances the sequence number, so a diagnostic followed by a result repeats it and PR 07 refuses the attempt. Both
    PR 13 workers build it in their own shell.

    Not decided here: online audits with an owner-supplied token, pre-commit inputs, other personas, registration and
    planning (PR 08/09).


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
require an explicitly stated published SPDX expression; Trivy checks retain their pinned MIT provenance, independently of the engine's Apache-2.0 license.
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
sh and applets). The shim runs as `/bin/sh /input/<its digest>`; the adapter digest
pins it, and with it the configuration and report template it writes. Image architecture authority comes from the
supervisor-verified outcome and the pinned platform manifest. Qualification is bound to the recorded engine evidence;
the changed canonical command path must also pass its selected native CI gate. **Inputs:** the shim, a
line job (`F <index> <content> <path>`) and each captured content once, in any order (the canonical coordinator lists
captured sources first, then its job record and the auxiliary worker and job). The shim takes as its job the one input
that is neither itself nor a captured source the start's `inputScopes` names, and whose first line is the job header:
a captured file shaped like a job is scanned as a source, never read as the job, and without `inputScopes` two
job-shaped inputs are refused (`inputInvalid`), not guessed. The run record names the job digest it read, which the
coordinator's normalization requires to be the job it sealed. Files over 8 MiB, names with a line break or
another control character, and paths the release's own global allowlist skips — the file or any folder above it,
since the engine prunes a matching folder whole (measured: `images.png/`, `package-lock.json/`, `node_modules/`) —
are not sent; each is a skipped scope with its reason, never a silent omission. The allowlist patterns are matched in
JavaScript's Unicode mode (`u`; RE2's `(?i)` as `iu`), because RE2 folds case by Unicode simple case folding (`ſ` with
`s`, the Kelvin sign with `k`) and ASCII-only folding missed paths the engine skips; a real-engine test holds the host's
skips equal to the engine's over a case-folding corpus. **No repository control:** the shim rebuilds the tree one folder below the
scan root, so a captured root `.gitleaksignore` is an ordinary scanned file; Gitleaks gets the pinned configuration
(the release's built-in rules, nothing allowed), an empty ignore folder, `--ignore-gitleaks-allow` and no baseline.
Measured by a direct probe of the pinned image (2026-10-22): the same root ignore file suppresses a finding when the tree is the scan root, and
nothing under the shim's layout. **Redaction:** Gitleaks runs with full redaction and renders its findings through the
pinned template (rule, lines, file); inside the container an awk pass replaces each file with its job index and the
rendering is deleted, so the report that leaves carries no path. Its stdout is discarded and its stderr stays in the
tmpfs, only its digest leaving. The coordinator accepts a report line only as `F, rule, start, end, index` or
`P, rule, line, line`, the rule one of the 222 the pinned default configuration defines (`rules.ts`, generated from
the release's own `config/gitleaks.toml`), then builds each observation from a closed field list: the rule, a
captured file, a whole-line byte span read from the sealed input copy, a fixed message and fixed limitation keys.
**No path is exported (contract, draft):** a name can hold a secret no detector recognises out of context (a value
assigned in one file and used as another file's name), so the scan withholds every path rather than judging names.
Observation evidence is a union: ordinary `SourceEvidence` (unchanged, with `relativePath`) or
`WithheldLocationEvidence` `{ location: 'withheld', snapshotId, sourceId, entry, content, span }`, where `entry` is
the cited file's index in the snapshot's `entries`. The schema makes the two exclusive (a withheld citation carries no
path; an ordinary one cannot claim `location`), and the validator checks a path only on an ordinary one. Every
secret-scan observation uses the withheld form; scanned, skipped and error scopes are `<sourceId>#entry:<n>` (a source
ID has no `#`). `resolveWithheldLocation(snapshot, evidence)` (`snapshot/locations.ts`) is the one way back to a path:
one bounded lookup that resolves only when snapshot, source, entry kind (an included file) and content all agree, so
two files with the same bytes resolve to their own entries; anything else is `sentinel.capture.locationUnresolved`.
Exact paths stay in the private snapshot and the private job; the scan's targets name entries, and their paths and
digests are taken from the snapshot, never from the caller. The shim also writes every name to `scan/paths.txt` beside
the tree so the same engine screens names; a name it matches is itself a finding (`sentinel.secrets.nameMatch`, a
zero-length span: the value is not in the content). **Failure:** an engine error, a kill, a missing, oversized, malformed or inconsistent report (exit code and findings
disagree), an unknown rule or file, lines a file does not have, an unmeasured platform, or a refused job makes the scan
an `error` over every target with a coded reason; the shim itself reports only a catalog code. **Audit:** the result
names the engine, adapter digest, image reference and id, platform, configuration and default-rules digests, the shim,
job and invocation digests, the exit code, and the stderr and report digests. **Packaging:** `scripts/package-assets-gitleaks.mjs`
ships the shim and a digest/rights manifest as `farsight-sentinel/assets/gitleaks/*`; no image, binary or report ships.
**Canonical command integration:** the owner promotes the original repository-scoped pack and explicitly adopts the
pinned image. The admitted snapshot supplies every included source entry; identical content is sealed once while
findings retain distinct entry identities. The driver preserves the verified supervisor outcome, validates sealed
job/output digests, and publishes normalized findings with canonical per-check coverage in one accepted attempt.
Omissions stay partial and failed scans cover nothing. `run.start` requires the plan's `tool-execution` effect.
Captured names and source-derived job/invocation records remain private; public citations and scopes withhold paths.
**Not decided here:** Git history scanning, finding policy and replay-bundle command acceptance. **Cost:** a location is whole lines, so a long line cites more than the match; the release's per-rule
allowlists and stop words are detector semantics and part of the pin; a path whose file is also another's folder is
refused rather than partly scanned.


31. **Sentinel's Express pack reads registration order from source and never credits a refusal as authentication or authorization (2026-10-22).**
`farsight-sentinel/frameworks/express` (PR 15) answers, for each Express route the public parser found, what runs
before its handler and whether anything there can refuse the request, for exactly Express 4.21.2. It reads only captured
source with Oxc; it installs, builds and runs nothing, and leaves the structural graph unchanged (its surfaces are the
parser's route nodes, its registrations are re-derived from syntax). The version must be pinned exactly in the root
manifest, or be a range the npm lockfile written for it resolves to exactly 4.21.2; overrides, another lockfile with a
range or a path alias for `express` leave every fact unknown and `framework.version` null, and so does any registration
on a route's path that sits under a nested package manifest. Every route the pack discovers is reconciled with the
parser's surfaces: a `route()` chain, an `all()` route or a route on an object the parser does not index is a frontier
(`registrationUnsupported` or `routeNotInGraph`), never a silent omission.
Applications and routers are top-level `express()` / `Router()` constants; their layers are the top-level
`use`, method, `all`, `route` and `param` statements of their own module, in order. Any other use of the object — a
registration inside a function, branch or loop, the object handed to other code or registered on from another module —
makes it open, and every route it could reach is unknown (`sentinel.express.registrationDynamic`): a skipped branch is
never read as either outcome. Dispatch is simulated as Express runs it: for a route's effective path (mount paths
joined, case-insensitive, non-strict), the matching layers registered before it on the application and on every router
on its path, earlier routers whose prefix matches (their own layers), earlier routes matching the same method and path,
then the route's own handlers before the last. A layer registered after the route is never on its path, so late
middleware cannot clear a finding. A partial match is unknown, not either side. Middleware effects come from bodies,
never names: a non-async `(req, res, next)` whose body is one guarded refusal with a literal 401 or 403 on a request
value, then `next()`; a pass-through; or an error handler. A refusal is cited as evidence at its position but never
credited: its status code and the request value it reads (which the client may control) do not establish a principal
or a permission, so both properties stay unknown there (`sentinel.express.refusalUnproven`). Everything else —
third-party or unresolved functions, `next('route')`/`next('router')`, async bodies, param callbacks, router options or
routing settings that change matching, sub-applications — is unknown with its reason. Because Express skips ordinary
layers after an error until an error handler, a refusal followed by an error handler that may resume with `next()`, or
by a layer whose arity is unknown, is unknown (`sentinel.express.errorPathResumes`). Facts per route and property:
never `applies`; `unknown` at each refusal and each unreadable position; and `does-not-apply` at the handler's
position only when every earlier layer was read and none can refuse. Node's `require` is read only where the file does
not bind its own, and only Node's `http`/`https` `createServer` may receive an application without opening it. Proving
a principal or permission would need the provenance of the value a refusal reads, which this pack does not model; it is a draft, source-only capability until PR 09 wires it into a
scan. Reason words are `strings-sentinel-express.ts`.

35. **Sentinel's model providers are one owner-bound broker over a durable shared budget (2026-10-22).**

`@farsight/sentinel/review/providers` is the only Sentinel code that reads a provider credential or contacts a model
endpoint. It is separate from Echo and imports none of it, though it follows Echo's reviewed transport rules:
`redirect: error`, byte caps and one deadline. It supports two kinds: Ollama's native API and an OpenAI-compatible
chat-completions API. Compatibility is per endpoint. `probeCapability` lists what one origin offers (an unpaid
listing), and a binding needs a capability record for exactly its kind, origin and model.

**Binding.** `bindProvider(policy, profile)` joins a provider from the adopted settings (kind, origin, keychain
reference, disclosure, per-action budget) with a model profile. The profile names the model, hard limits, a rate
schedule or an explicit local no-fee basis, recorded hosted terms, and the capability record. A local-only provider
must be a literal loopback address; a hosted one must use https and needs recorded retention and training terms.
An unpriced profile is refused, and only a local runtime may declare no fee. The binding's canonical digest is the
`input` of the `paid.admit` intent (`envelopeIntent`), so the owner's receipt confirms the origin, credential
reference, disclosure, model, limits, price, terms and capability together. Any change needs a new receipt
(`bindingChanged`); so does any change of the policy revision, since each call re-makes the binding under the policy
in force, and a revoked grant therefore stops the envelope. The profile is a Sentinel-owned type, not a settings field yet; moving it into the settings
contract is a follow-up for the policy owner.

**Admission.** `openEnvelope` admits one run budget under one binding through the shared gate (ADR 23).
- The policy verdict is the reused grant matcher, evaluated first with no credential read; a denial reads and
  contacts nothing.
- Capability is the binding's probed record.
- Credential authority is either "local-only, none needed" or a keychain value actually read, in process, through
  core's reader for the approved reference. The value lives in a `Secret` that prints, serializes and inspects as
  redacted, and no error carries it.
- Priced or hosted use needs a spent owner receipt for this exact intent, whatever the grants say. The receipt is
  required before the keychain is read.

**Calls.** `generate` builds one non-streaming request and refuses it if it is over its byte limit or if its worst
case does not fit the model context (Ollama is given `num_ctx`, so input is never cut silently). The worst case is
every request byte as a token, plus a per-message template allowance and the full output allowance, priced at the
trusted rates in exact nano-unit integers, rounded up. That worst case is reserved durably first and marked
dispatched before the request leaves.

The transport is node:http/https with `agent: false`. The URL is the binding origin plus a fixed path and is
re-checked. Any 3xx is refused and never followed. Certificates are always verified, whatever the environment says.
The response is read to its byte cap. One deadline and the caller's signal stop the call. Each error says whether
the request may have reached the provider, judged by whether the (TLS) connection came up.
- A reply with both usage counts settles the reservation at its use.
- No usage, or any failure after sending, leaves it `uncertain` and charged at its worst case.
- Only a call proven never connected is released.

A reply that names no model, or another model, is not used, but its usage is still charged. Identity is recorded at
its actual strength: host-reported for Ollama (with the probe's weight digest as a probe-time fact) and
provider-response for OpenAI-compatible. Output stopped at the allowance is returned as truncated. There is no
retry, and no fallback to another provider: an envelope has exactly one binding.

**Budget ledger.** `BudgetLedger` is a narrow standalone seam until the coordinator's durable store (PR 08) can hold
it. It is one SQLite file behind the store's release gate; every mutation is one `BEGIN IMMEDIATE` transaction, and
it holds no run, work or attempt state.
- A reservation moves `held → dispatched → settled | uncertain`. `released` is only for a call never sent.
- An operation id reserves once: a repeat is refused rather than re-sent, and other amounts conflict.
- Reservations from any number of processes share one envelope; a multi-process test shows exactly the fitting
  number succeed.
- `recover(staleEpochs)`, for epochs the coordinator has fenced, releases what was only held and turns dispatched
  into uncertain, so a restart never forgets a call that may have been billed.
- An uncertain reservation is settled only by `reconcile`, which names its authority (a spent receipt's digest).
- Usage above a reservation is charged in full, recorded as an overrun, and overdraws the envelope, which then
  refuses every further reservation until the owner approves a new budget. Nothing is clamped.

**Tests.** Ordinary tests use original local mock endpoints on 127.0.0.1, a throwaway self-signed certificate for
the TLS check, and in-memory credential sources. No hosted provider is called, no model is downloaded and no real
keychain entry is read.

Not decided here: the evidence broker, prompts and review lanes (PR 22); the coordinator stage that opens envelopes
and fences epochs (PR 08 integration); a settings-contract home for profiles and capability records; live
model acceptance; and a second model configuration.

30. **Sentinel's Next pack decides middleware applicability statically and never claims an effect (2026-10-22).**

`@farsight/sentinel/frameworks/next` (`analyzeNext`) is the first framework pack behind the shared control-fact
contract (`contracts/controls.ts`). Its inputs are the snapshot envelope, the parser evidence for one of its sources
(PR 05, checked through the planner's `plannerAnalysisFrom`) and the captured bytes by content id, each read
hash-checked. It never runs application code, never runs a package manager and never reads the parser's broad
`guard::middleware:` heuristic, whose edges cover every entry under the file's folder without reading its matcher.

Support is one manifest (`support.ts`), and its canonical digest is the pack digest every envelope pins: Next
14.2.25 with React and React DOM 18.3.1, the combination PR 01 measured, and nothing else. Support is the exact
packages, not their version strings: the manifest pins each one's registry tarball integrity, read from the resolved
lockfile PR 01's acquisition captured (the retained archive's SHA-256 is in the manifest). Versions come only from a
lockfile that records what was installed with its content identity (an npm 2/3 entry with the public registry
tarball URL for that version and a sha512 integrity; a pnpm 6.0/9.0 importer version and its package's
`resolution.integrity`), resolved from the project folder upwards. The lockfile and the package manifest are
untrusted input: every value is shape- and size-checked, and a shape the readers do not expect is invalid, never a
crash. These are unknown: a version written only in the package manifest; a manifest specifier that is not a
registry version or range (`file:`, `link:`, Git, a URL, `npm:` aliases, `workspace:`); a local, linked, Git or
mirrored package; an entry without an integrity; the pinned version with another integrity (a repacked or
substituted package); two candidate lockfiles; an unread lockfile kind; and an exact manifest pin that disagrees
with the lockfile. Another registry version is recorded as resolved and analyzed as nothing: every fact is
unknown.

The middleware handler and `config` export, and next.config, are read with Oxc (loaded on first read) as literal
syntax only, with exact UTF-8 spans and a quote digest for every cited span. Anything Next would have to compute,
or syntax not verified to be extracted the same way (`as const`, `satisfies`, identifiers, spreads, re-exports), is
dynamic. Only an absent or statically empty next.config is supported: base paths, locales, rewrites and page
extensions all change which request reaches which file. The middleware must sit beside the router folder (the
project, or `src/` when the router lives there); a file elsewhere is a frontier, never the project's middleware.

The matcher subset is whole path segments: literals of unreserved URL characters and `:name`, `:name?`, `:name*`,
`:name+`, including Next's root form (which also matches `/index`). App Router surfaces are the parser's `route` and
`page` nodes under the router's `app/` folder. Their request paths come from the captured folder segments, never
from the graph's display name, which folds every dynamic form to `:param`. Groups and slots vanish, `[x]` is one
segment, `[...x]` one or more, `[[...x]]` zero or more, and `_private` folders are not routable. A segment automaton
product over the literals of both sides, plus one symbol for every other value, answers whether the matcher reaches
all, none or only some request paths. Unconditional entries prove `all`; every entry, conditional ones included, has
to miss for `none`. An entry outside the subset (custom regular-expression groups, brace groups, escapes, parameters
inside a segment) blocks `none` without blocking another entry's `all`. A decision that changes under case folding
is unknown. Dynamic segments are taken to serve every value, including ones a static sibling would win, which only
turns `all` or `none` into `some`.

Applicability is kept apart from effect. A matched surface's facts stay `unknown`
(`sentinel.next.reason.effectNotEstablished`) for every property: running middleware, and its name, are not
authentication or authorization evidence, and its body is not read. Only provable exclusion resolves, as
`does-not-apply` citing the matcher bytes: the matcher reaches none of the surface's own request paths, so the
middleware is no control on them (a middleware rewrite from a matched path can still arrive there, which only adds
an unprotected route in). No excluded surface can be marked protected and the pack emits no `applies`. One envelope per Next project carries the facts at order 0 and the frontiers. These include the pages
router (the graph has no surfaces for it), router files the graph has no surface for (`route.tsx`, folders that
name one path) and unlisted router folders. Its `registrationDigest` covers the manifest, lockfile, middleware,
next.config and the router's file inventory. Each surface's own `influenceDigest` names what decided it.

Generic parser corrections the pack exposes (Pages Router surfaces, `route.tsx`, lossless dynamic segment names,
`app/` folders outside a Next project) are separate measured parser changes, not reinterpretations here. Not decided:
the coordinator stage and capability-table entry that run the pack (PR 09 integration), populating the snapshot's
`frameworkVersions` from its resolution, effect analysis of middleware bodies, and other Next versions.


38. **Sentinel reports are one pinned document, rendered offline, placed only through a proven application context (2026-10-22).**
PR 19 adds `farsight-sentinel/findings` and `farsight-sentinel/reports`. **Identity:** observations are never
rewritten; normalizing derives a rule family, a severity on Sentinel's scale (the original kept) and one anchor per
evidence location: the canonical symbol (`nodeId`) and a digest of the cited text with whitespace collapsed. No
line or offset enters identity. Observations with the same rule family and anchor set, from any producer or version,
correlate into one finding; a shared sink or symbol alone never merges two. The versioned fingerprint
(`sentinel-issue/1`) has an exact key (rule family and anchors) and a probable key (rule family and symbols).
**Matching** pairs one-to-one on the exact key, then on the probable key; a key shared by more than one finding on
either side is ambiguous and nothing is chosen. **Comparison** labels every current finding (`new`, `persistent`,
`changed-evidence`, `changed-detection`, `reopened`, `reopened-disposition-expired`) and keeps every baseline finding
nothing continues in `historical` with a reason: it is `resolved-by-comparable-check` only when its files and
symbols are still there, a complete current check of its rule family covered all of its files, and detection (rule
revision, engine, capabilities, or a reviewed compatibility mapping) and conditions (environment, limits) are the
same. Otherwise it is a removed surface (file or symbol gone; a folder that could not be listed is unknown, not
removed), unassessed scope (no check, a failed or partial check, a narrower scope), changed detection or
incomparable conditions; probable and ambiguous pairings stay open. Any anchor's code gone (a source removed while the
sink remains) is a removed surface, resolution needs a current analysis showing the code still there, and a withheld
(secret) location is never resolved. **Context:** a retained enriched graph is pinned only when every input file it
names has the captured content id, every node it locates for the source is in a named input, every captured
`farsight.config.json` or `screens.json` is among its inputs, and the owner confirmed exactly this context document for
this snapshot and source (the owner-only `context.pin` action, a spent receipt): matching hashes alone do not show its
journeys and labels are true. The verified graph is copied and frozen, so later changes to the caller's objects reach
nothing; core's folds run on their own working copy. The receipt records what was verified. A pin is also an opaque
runtime capability: its private provenance retains the authentic spent owner grant and exact snapshot/source.
Copying its fields, serialized receipt, prototype or proxy conveys no authority. `placeNodes` and `placeFiles`
require the consumer's `ContextBinding` (`snapshotId`, `sourceId`); both direct placement and report/gap consumers
check that exact binding. Report finding placement also checks observation and citation snapshot/source identities.
Pins for another capture/source are unplaced and excluded from the report's context artifact closure. Artifact and
receipt byte arrays are returned as copies so caller mutation cannot change retained provenance. A mismatched context, a graph without journeys (a portable parser artifact) or no context leaves the place
empty with its reason; no current graph is consulted and nothing enriches or fetches. **Placement** reuses core's cached
`flowWalks`, `impactOf` + `affectedReach` and `personaOfScreen`: direct use where a screen's walk contains the symbol,
potential impact where only dependents reach it, screens deduplicated, personas kept with their screens, bounds
explicit (`of` carries the full count), one business sentence from the same fold. **The document**
(`sentinel-report/draft-1`, extended additively with evidence locations, fingerprints, match strength, `historical`
and `definitions`) carries every word it uses with its definition. A disclosure profile (`private` embeds excerpts,
`shareable` withholds them) never changes a finding, a place or a count; secret evidence is never embedded or located
in any profile, and disclosure covers every field: a secret finding is never placed and carries only the rule pack's
or fixed words, a producer's message appears only in a private report of a non-secret finding, and a withheld-location
citation (secret scan) is never read or located. Every planned check has one coverage record or is a `not-run` gap; the
report is complete only with no gap, no file seen by no check and no unlisted folder; a gap is placed on the screens
relying on the code the check did not cover. **Renderings** read only the document: Markdown escapes and fences source; HTML is one file with
inline styles, no script, no external resource, a content security policy that refuses loads anyway, internal anchors
and a print stylesheet; SARIF 2.1.0 uses the rule family as `ruleId`, Sentinel's fingerprints under their own
`partialFingerprints` keys (never GitHub's line hash), and refuses more results than a limit rather than cutting.
`generateReport` is the integration hook for a CLI or service; it needs no Farsight server, bridge or network, and a
delivered report needs neither product nor the source. Not decided here: dispositions and imported evidence in the
same document (PR 20), the CLI's report command (PR 09), the integrated view (PR 25), and building a context from
captured configuration rather than verifying a retained one.

**ADR 38 extension — the full report through the command path (2026-10-22).** `report <run> --full` and
`compare <run> <baseline>` build the `sentinel-report/draft-1` document from a completed scanner run's accepted
evidence only (`service/full-report.ts`), never from a report file, a structural record a caller supplies, or the
workspace. Each work unit's accepted publication is read for its coverage records (bound to this run, unit, revision
and publishing attempt, and to a check the unit was assigned) and its scanner findings (bound to this run, snapshot,
source, unit, attempt and adapter). A finding becomes one observation per assigned rule family; every location it
cites must be a captured file the unit was assigned, with exactly those bytes, and its span is checked against them
(line ranges and whole-file citations are turned into byte spans over the captured bytes); the canonical symbol is
the innermost bootstrap parser-index node over those bytes containing the span. Anything else refuses the whole
report (`sentinel.report.evidenceUnbound`). Severity is the producer's, else the rule definition's from the exact
packs the run's admitted lock names. Every plan check is a planned check (its files from its scope, symbol or unit);
compare recomputes both sides' findings and per-family check assessments (rule revision, engine and image pins,
trusted capabilities, environment, limits) and the current surfaces from the current run's capture and parse.
An application graph the owner supplies (`--context`) is pinned only after the owner confirms the exact
`context.pin` intent (exit 4 without `--confirm`; `init` grants it to the owner only), and its inputs are the
captured files' bytes as they are on disk now, so a graph of a tree that changed after the capture is `mismatched`,
whatever is confirmed; the spent receipt is the pin's authority and never leaves the process. Shareable is the
default disclosure; `--out` writes one new owner-private file and never replaces one. The command is a read, never a
policy result: its outcome is `answered` with `sentinel.service.policyNotEvaluated` among its limitations. The
minimal `sentinel-scanner-report/draft-1` and the preview report are unchanged. While the background service holds
the store the full report is refused (`ownerServiceRunning`). The HTML policy names only directives a `<meta>`
policy honours, so a delivered file opens with no console error.
**Secret-scan evidence in the full report (2026-10-22).** The report reads Gitleaks' accepted publications as exactly
the observation that scanner may make, and nothing else as one: a `secret` record only from a `secrets-gitleaks` unit
and no other kind from it; bound to the run, snapshot, unit, revision, attempt and adapter digest; assigned exactly the
unit's admitted repository checks; a known pinned detector; the fixed redacted message and limitations; and only
withheld citations, each resolving in the private snapshot (`resolveWithheldLocation`) to a captured file the unit was
assigned, with a span inside those bytes (a name match cites none). Its rule family is the admitted check's, never the
record's. Every scanner unit's own report states how many findings it accepted, and the publication must hold exactly
that many finding records, so a dropped or added record refuses the report instead of reading as fewer findings. A
withheld citation's identity is an opaque key for its file (`findings` `withheldKey`, the capture entry by default; the
command line uses an HMAC of source and path under the store's own secret), so identical bytes in two files are two
findings and a secret finding continues across captures of one store. The store id is public (container labels, owner
records, a bundle's provenance, a failed run's facts) and is never the key: the secret is 32 random bytes per store id
in the owner's private trust folder (`report-keys/`), outside the store directory so no store copy or bundle carries
it, created once by no-overwrite publication, read only as a private single-link file of exactly 32 bytes (an existing
unsafe key refuses rather than being replaced), and never written to a receipt, result, report, log or the service
socket. Withheld-location identity continuity requires that same private key: if the owner loses it or opens a store
under a different private trust folder, the next report creates a new key and its withheld-location identities change.
Existing report files remain unchanged; a store copy or bundle cannot restore the missing key or prove continuity
with the earlier identities. A report and a bundle together, with the store id, confirm no guessed path.
The pinned worker reports only the rule, the lines and a file reference (template `RuleID`, `StartLine`, `EndLine`,
`File`, with `--redact=100`), so a report sees whole matched lines, never the value's position, and cannot prove that any
text a captured file or a confirmed graph supplied is free of a matched value. A report whose run, baseline or proven same-capture selected ancestor has
accepted secret matches therefore fails closed (`withholdSecretRun`): every finding's title and explanation are rebuilt
from the rule pack's catalog words only; every evidence item is withheld with no excerpt and no location; every other
source- or context-controlled string (context ids, labels and references, node ids, count part labels) becomes one
opaque word per distinct original, so references still match and placement keeps its shape; every place records
`sentinel.report.withheld.secretRun`, defined in the report, and the command lists it among its limitations. Trust is by
position in the report contract, never by a key's name or a value's spelling: only positions whose value Sentinel
generates (schema, enums, catalog keys, digests, content and artifact ids, generated run, check, finding, evidence and
report ids, counts' words, a decision's and a definition's exact generated fields, a gap's catalog explanation) are
kept. Without matches in those proven inputs, a report retains ordinary excerpts and labels. The cost is availability: in a run
with any secret match no report shows source excerpts, locations or context names. The precise replacement is an exact
value range: the pinned template would emit, as numbers only, the match's start column and the secret's offset and
length within it (computed inside the container from the unredacted match; Gitleaks fills its match fields with the
redacted placeholder under `--redact`), kept privately in the publication beside the whole-line citation and read over
the private snapshot at render time. That changes the pinned template and worker digest, needs Gitleaks
requalification on both measured platforms and a check of the engine's column semantics for multibyte and multiline
matches, and adds a private publication field; it is not part of this change. A file whose name the secret scan matched is withheld from every scanner's citations in every profile (cited by
its entry, without a symbol, never used to place a gap), and the minimal scanner report replaces such a name wherever it
appears. Refusal reasons never name a path. The minimal scanner report's other names are unchanged; the full report
uses the conservative projection above. The context-graph attestation limitation above is unchanged.

44. **Sentinel runs the four framework packs as one supervised inspection, and their facts are never findings (2026-10-22).**
The internal `frameworks/controls` adapter turns the control facts the Next, Express, Nest and Spring packs (ADRs 30–32,
27) emit for one captured source into the coverage of three inspection rule families, `sentinel.controls.authentication`,
`.authorization` and `.input-validation`. The checks are repository-scoped, one per family and source: the packs read
configuration, manifests and code across the source, and a repository check's sealed inputs are every captured file,
so no surface check claims to have read configuration outside its own inputs. Each check's extent is every route and
page surface the parser indexed, and each surface keeps its own row in the report. The packs run in `worker.ts`, a
built-in adapter the supervisor starts as a child process. The supervisor pins a built-in adapter by the digest of
its one module file, and the worker's behaviour lives in the files it imports, so the registered module is a generated
entry (`closure.ts`) that embeds the byte manifest of the worker's whole closure: every Sentinel file reached by
static or literal dynamic imports, and every package used, whole (each resolved package's folder with its folder
listings, including workspace folders rather than trusting their publish files list), with each package's dependencies
in turn and an absent optional dependency's lookup recorded too. It also binds how Node finds each package: every `node_modules` candidate Node
would try before the one it takes holds no folder, the one it takes resolves to exactly the recorded real path, and
each Sentinel module stays at its own real path. An inner package link must stay within its resolved package root;
its text, resolution and target bytes or folder are bound. Inner links and literal module loads escaping that root
refuse registration, including lazy imports, CommonJS require and ordinary createRequire aliases. Literal loads
through excluded nested node_modules paths or into bare dependencies outside the independently pinned metadata
closure are refused too. Each module's actual lookup is bound, including absent optional loads; a nearer shadow
or a later installation is a change. An unused fixture may name a package already fully bound elsewhere in the
metadata closure, but cannot add an unbound dependency. Builtins and package self references remain supported;
package-import aliases are unsupported. A legacy main outside the package root is refused too. A syntax-invalid unused fixture remains hashed data: it cannot execute as
a Node module. This conservative folder pin includes unused fixtures and generated files; changing them may require
a new registration even when runtime behavior would be unchanged. So a retargeted link, a changed link target or a
nearer new package is a change even when no listed byte moved. A change anywhere in the closure is a different module digest and so a different adapter; an entry whose closure changed after it was written exits before importing the worker, writing nothing.

The boundary is the shipped trusted worker and its audited dependencies, not general JavaScript loader validation.
Computed module paths and arbitrary loader indirection are not resolved by the literal-load check. The current native
Node path pins `oxc-parser` 0.138.0 and audits its three computed loaders (SHA-256, fixed by a regression test):

- `src-js/bindings.js`: `34c500cd0841b07a44d7f41d6394d3692913aa2217425e3d470af5c7dbd92279`.
  Its external override requires `NAPI_RS_NATIVE_LIBRARY_PATH`, which the supervisor does not pass: a real supervised
  worker test sets an executable parent override and proves it never loads. The normal native binding is a literal
  in-package file or a declared optional platform package, whose bytes/resolution/absence are pinned.
- `src-js/raw-transfer/eager.js`: `e2741c33200b644091c6ad3bb365ea7df373c8b7d5e55deef9844bac1d96a465`.
  Its computed deserializer name is one of eight fixed strings selected by three booleans; every selection stays
  inside the pinned package. Missing optional internal files cannot produce a successful analysis.
- `src-js/webcontainer-fallback.cjs`: `e54193c063b0359e5108dd3b3673491cc35b558611278380506fc9f95c46f757`.
  Its download and external temporary-directory loader require `process.versions.webcontainer`. This is not the
  supported native Node runtime and is not selected by the worker's fixed Node executable or four-name environment.

Unused workspace fixture generators are byte-pinned data, not worker entry points. Changes to these dependency
bytes require this audit and test pins to be reviewed. No arbitrary computed external loader is supported. In the canonical tarball, the fixed `dist/frameworks/controls/worker.mjs` is a separately hashed package asset.
The closure pins every regular file and folder listing in the package's real `dist` tree, rejects inner links and
nested dependency shadows there, and resolves all declared installed dependencies from every emitted module folder.
Generated require aliases are therefore not a completeness boundary. The own-package resolver starts inside the
compiled `dist` tree and requires Sentinel's own manifest immediately above it. Only genuinely absent manifests
inside dist allow walking upward; missing, unreadable, malformed, linked or foreign own manifests refuse rather
than selecting an enclosing workspace. The valid own package name selects workspace `.js` or installed `.mjs`
layout. Installed worker and launch-gate paths and SHA-256 pins are mandatory, copied and deeply frozen; no `.js`
sibling substitutes for a missing installed asset. The driver is one fixed internal packer entry, pinned by the
whole dist closure, without a public export or asset-manifest entry. The resolver never pins the consumer's tree. Private generated entries live
under the owner's trust directory, outside dist, with full entry-source SHA-256 names. They are atomically published
without replacement. Relative manifest labels still contain absolute resolution and target-path values: the closure digest and generated
entry are both installation-bound. A second installation has another identity; moving or changing an installation requires a new
plan. Root/store import and CLI help do not load the native parser; closure registration does. The installed npm-only
consumer audits all emitted dist files and exercises real transitive dependency and chunk drift refusal before
worker import. The dependency loader audit above still applies; this is no claim of arbitrary loader completeness.

This detects a changed build or installation, not a writer racing the check and the import. The module runs through
the launch gate with only the worker environment and its sealed inputs (the job, the snapshot envelope, the source's retained
parser artifact, result and index, and its captured files, each read only by id and checked against its digest). The
deadline, cancel and the stdout, stderr and output budgets are enforced by killing the process; memory, CPU and
process counts are not hard limits on this path and the child is not network-isolated. It is Sentinel's own code, it
opens no connection, and it installs, builds, imports and runs nothing from the target. The coordinator selects
`prepared.binding.derived.job` for a closed built-in identity, and the supervisor requires that artifact to be one
of the exact sealed inputs before spawning. Only then do the invocation and start carry the optional `job` field.
The worker requires that explicit role and reads its named retained closure, never searching captured JSON for
a job schema. An absent or invalid job refuses with `sentinel.controls.jobInvalid`; unrelated job-shaped JSON
cannot replace the selected job or deny the inspection. External adapters cannot receive this role. A pack that throws is
recorded as `libraryRefused`, never its message. The worker claims no coverage; `facts.ts` derives it.

Inspection is not assessment. `applies` and `does-not-apply` both mean only that a pack established, within its exact
supported scope, whether a control is on the surface's request path; neither becomes a finding, an observation or a
policy failure (a public route, or one with no input, can be correct). The rules are `candidate` with
`evidenceRequired: control-fact` and the limitation `sentinel.controls.limitation.inspectionOnly`; the report record is
`kind: framework-inspection`, `assessment: none`. Judging facts against a policy is PR 20's. A surface is established
when every pack that claims it gives the property at least one fact, resolves every position it gives, and those
packs agree (a pack that claims the surface and gives no fact for the property leaves it unanswered there); one pack's
positions fold along the path (a Spring chain that permits, then method security that applies, applies). A check is
complete only when every surface in its extent is established and no pack that found its framework left a frontier.
An unknown position, disagreeing packs (`sentinel.controls.conflict`), an unclaimed surface, a property the claiming
pack does not model (Express models no input validation), a frontier or a refused pack each leave it partial with that
reason; every pack refusing leaves it not run. A pack that found nothing (no fact, no resolved version, no source-wide
gap) limits nothing: Nest's missing bootstrap in an Express repository is not a gap. Coverage is `aggregate`, which
the plan accepts only for repository checks. The plan attributes limits by scope and the three families share the
source's scope, so recorded coverage is the conservative union across them; each family's own state is in the report.

Version authority is the packs' own: each reads exact versions from the captured manifests and lockfiles, and the rules
carry no `frameworks` gate (the snapshot's `frameworkVersions` is not populated). Spring runs with no active profile
selected (`activeProfiles: null`), so profile-conditioned chains stay unknown. The result binds the whole job: the
snapshot, the retained analysis and every captured file are its inputs, and nothing is reused across snapshots. The
coordinator driver (`driver.ts`) declares `reads: { analysis: true }` and never builds its own parse evidence: the job
names the coordinator's retained snapshot manifest, parser result, index and artifact by id, and their original bytes
reach the worker only through `retainedAuxiliary`. The generated entry's manifest also lists the driver and what it
imports, so the implementation digest the driver is bound to covers the worker, the packs, the mapping and the
driver. Normalization checks the one output against the sealed job, each envelope against the controls contract and
this snapshot, takes the extent from the planner's own `surfacesFromIndex`, and publishes one
`sentinel-driver-report/draft-1` record (`kind: framework-inspection`) whose canonical digest every covered check
names, plus each pack's envelopes, all source-derived. When no pack recognises a framework it models, every check is
partial (`sentinel.controls.frameworkNotRecognized`), even over an empty extent: routes served another way were not
inspected. Canonical availability requires the exact owner-promoted shipped pack and its definition digests, independently
of merely registering the built-in code. External tools remain container-only. The canonical report authenticates
the accepted attempt, invocation, sealed job, original source analysis ids, raw library output and normalized report,
recomputes the fact fold and coverage, and carries one optional `inspections` section through JSON, Markdown,
offline HTML and SARIF properties. Facts create no SARIF results. The minimal scanner slice uses that same
privacy-projected section instead of raw controls envelopes. Every new source-controlled identity, version and
frontier passes through the coarse secret-run projection before rendering; required partial checks remain gaps.
Per-surface execution and assessment policy (PR 20) remain separate work. Words are `strings-sentinel-framework-controls.ts`; the pack is `rules/framework-controls/`.

The shared retained-source verifier is an internal read boundary, not a new graph contract or public factory.
It proves the exact admitted inventory and parse publications, operation ownership, profile, influence manifest,
lineage and complete included content-hash closure. The read-only proof binds its original owner and epoch,
recorded run revision, deadline and cancellation signal; access can only tighten those bounds. It exposes a
source-filtered view with the original manifest identity and verifies every distinct included body hash. Caller
limits are independently copied, validated and frozen, can only lower fixed ceilings, and bound byte accounting,
reads, lineage depth and cooperative elapsed time. Final copies are prepared before the last owner/deadline fence.
These are cooperative read bounds, not a hard RSS or I/O limit. Execution still separately requires its genuine
validated plan, current revision and original source/owner checks; a read-only proof grants no execution authority.
`retained-bootstrap.ts` and `retained-analysis.ts` share verification mechanics while retaining those different
entry authorities. Execution's body-read behavior is unchanged.

The closed internal descriptor table names `framework-controls` and `bounded-paths`; each resolves its shipped
fixed worker and driver through the same installed closure contract. No caller selects a worker path or export. Framework definitions
import the actual pure support modules, and report reads/imports/help do not resolve assets, load the worker or
load the native parser. Already accepted reports remain readable with worker assets absent; a new execution still
requires the installed assets and exact registration identity.

For new framework records, normalization requires the computed sealed job id, invocation job, prepared execution
binding's derived job and output job to be identical. Report readback treats any own `job` key as the strict form,
including malformed or null values. It reconstructs the exact binding from proven plan/work and original retained
identities, verifies the exact sealed input set, and requires the accepted canonical content by its hash. Equivalent
accepted content fixes the same authority fields; this is not a claim of a separate per-attempt record link. An
invocation without the job key deliberately retains the original legacy readback path. Unrelated preview and
external start/invocation forms remain unchanged.

A framework startup verification refusal is final, without refreshing identity or retrying. Only the closed
built-in descriptor, current trusted driver and adapter id/digest, genuine failed owned-child `workerExited`, exit
71 with no signal, zero protocol frames and bytes, and no result or outputs qualify. The coordinator records
`sentinel.execution.closureRefused` with the original code, exit, pre-hello phase and adapter identity; the raw
supervisor outcome remains unchanged. Cancellation, deadlines, cleanup, ownership and other protocol or output
failures keep their existing precedence. Exit 71 from another worker, a container or after protocol activity keeps
its ordinary failure meaning. Catalog wording says startup verification refused, since that observation alone
does not establish that files changed or that no process started.

45. **Canonical structural path requests are pinned source-derived data; owner-confirmed deep imports remain a separate acceptance boundary (2026-10-22).**

A structural path request has the closed `sentinel-path-request/draft-1` contract: the exact recorded ancestor run,
revision and plan digest; captured snapshot and source; sorted unique exact node pairs; sorted allowed call/http/render
edge kinds; and explicit depth, fan-out and visit bounds matching the bounded-path library. At most 10,000 pairs and
one MiB of serialized request are accepted; the byte/count bounds apply before parsing or expensive processing.
Queries are data, never executable code, a grant or proof of flow. The request's canonical artifact identity is the
optional `PlanPins.pathRequest`; absent pins preserve every old plan's canonical bytes and bootstrap revisions reject
this pin. A path unit's influence and input fingerprint include the request identity. Other sources stay unavailable
rather than reading another source's query, and no request supplies the missing interprocedural-flow capability.
Changed queries, bounds, adopted terms or terminal generation give a different linked task identity.

Admission must prove the actual current ancestor revision, allowed ended state and exact source/capture through the
same retained bootstrap/source authority used by canonical execution. The request is staged as source-derived with
the plan, linked to the exact admitted ancestor and accepted operation/parser closure; callers cannot supply those
links or turn copied artifact JSON into authority. Execution rechecks the pin and uses sealed retained bytes, never
today's workspace or an unpinned prepare-only parameter. The internal admission seam requires the genuine
owner-bound read proof, validates the request's exact path unit fingerprints and included source bodies, and derives
all retention links itself before staging. Proof construction and closure revalidation are separate bounded read
passes; both retain the original absolute deadline and signal. Repeated pre-write assertions check that proof without
copying its large source view or minting execution authority. Execution holds every unrelated unit. Authenticated
request ancestor edges and genuine selected-rerun edges retain their recorded revisions; a parent id alone grants
nothing. Mixed request pins and legacy rerun selections refuse explicitly. An explicit rerun of actual active path
units prepares a new request pinned to that ended path task's executed revision, with the same exact queries and
bounds; it never invents legacy parent-unit mappings. Retry selects only unpublished active units, never held
checks; a successful task has nothing to retry. A non-ended task joins/resumes without a new generation.

The owner command is `paths <ancestorRunId> --request <file>`: adopted policy preflight precedes the one bounded,
non-following regular-file read. It proves the ended ancestor before task writes, discloses exact queries, bounds,
held required checks and prerequisites, then consumes the existing exact preparation receipt when required.
Acceptance atomically retains the request and proven closure before creating the linked planned run. It does not
launch: `run <childRunId>` requires separate current `run.start` admission. A prepared path task
starts its absolute run deadline at admission; a later start after expiry holds every unit with `runDeadline` and
publishes nothing. This timing statement applies to path tasks, not every legacy plan/run path. Identical pending/running/paused
preparation joins; completed/canceled tasks permit a new explicit generation. Admission-before-run recovery
reconciles only the exact retained candidate, and accepted publication survives coordinator death without being
accepted twice. A pending pause follows legal running/pausing/paused transitions without launch, preserving its
original creation/deadline; cancellation wins over a pending pause.

Minimal and full JSON, Markdown, offline HTML and SARIF share the authenticated accepted structural section.
Readback checks actual publication, succeeded owned attempt, exact invocation/job/assignment, immutable request,
retained source closure, raw worker result and normalized records. It does not run a second search or independently
reverify a no-path claim. Every rendering first applies accepted current, explicit baseline, authenticated request
and selected-ancestor secret privacy, including canceled ancestors and executed revisions with merely admitted
successors. Query/node/edge/site/span details are withheld together; ancestor findings and coverage never become
child findings. Counts describe the pinned query's outcomes separately from security gaps. A missing recorded
secret match is not proof of secret absence. Each retained structural section has a cooperative 120-second
proof/readback bound, so a large or slow valid closure can be refused without launching or refreshing its producer.

The shipped `bounded-paths` worker has one explicit sealed job naming its request and the four original retained
roles. A source unit admits at most 1,018 entries before the six fixed roles/job/request, within the existing 1,024
start-input cap. No worker enumerates JSON to discover a job. `DriverContext.pathRequest` is data supplied only
from the coordinator's genuine admitted plan. The driver binds the exact work, attempt, assignment, source, profile,
sealed input set and derived job before normalization; output graph, path steps, sites, cycles and producer identity
are checked against the original parser evidence. Only the exact promoted shipped rule selected by owner policy
can plan this task. Registration does not alter adopted settings, requested families or default stages.

Sentinel's rule evidence vocabulary adds `call-path`: a retained bounded structural query result, including an
explicit no-path or frontier outcome. This is not a new Farsight evidence class, security finding, data-flow fact or
clearance. Structural task completion gives no required security coverage, and unrelated required checks remain
gaps. The worker enforces one budget over all queries: 64 MiB decoded/cache bytes, 1,024 distinct reads, one million
visits, four million traversal/index steps and four MiB output. Limits can only tighten. These are cooperative
accounting limits, not hard heap or RSS claims. The coordinator preserves its original unit prepare-to-accept
cancellation/deadline; a separately bounded normalization pass records its own graph-validation counters without
re-running the queries or re-reading bodies. Worker usage, normalization usage, proof and admission revalidation
are separately stated; none claims a single combined quota.

Deep imports retain ADR 36's separate owner `evidence.import` receipt boundary and tool-scope-only observations.
A consumed in-process receipt cannot be reconstructed from serialized JSON; durable import acceptance and its crash
behavior require their own reviewed transaction and retained closure. No scanner attempt or executed coverage is
fabricated for an import, and no deep engine, build, network permission, model call or target execution is inferred
from an analyzer's mode. This decision reserves the owner boundary; durable import implementation follows the first
canonical structural-path slice rather than being implied by the library contract.

46. **Sentinel captures everything but the exact store it holds, and keeps run scratch in a lease inside that store (2026-10-22).**
A working-copy capture leaves out one folder only: the store this process holds, at its exact canonical path and
with the identity the owner acquired, and only while the hold is still checked there (`store/owner-binding.ts`
`heldStoreRoot`). The store's identity reached under any other name refuses the capture (`capture.storeAliased`), a
source that is or lies inside the store refuses, and a look-alike store object exempts nothing. A committed tree
gets no live-store exemption: blobs at the store's path are committed source. No folder is left out by name, so
`.farsight` is ordinary source in the canonical path and `.farsight/sentinel/settings.json` is captured as bounded
data that never becomes adopted policy. Snapshots captured under the earlier `.farsight` exclusion keep their
recorded boundaries; nothing is reinterpreted, and the same content now plans as a new run.
Every owner command and the background service take their scratch from a lease at
`<store>/scratch/<epoch>/w-…` (`service/scratch-lease.ts`), made only from a genuine held store, one private level at
a time, with the hold and every recorded folder re-checked before and after each step and each new folder required
to resolve to its own path; a folder replaced or linked on the way mints no lease. Release removes only what the
lease can tie to a consumer it watched stop: a container client configuration folder that is exactly the one the
execution layer made (path and identity, recorded in `execution/isolation.ts`) for a runner this lease wrapped, once
no wrapped client is still running. Anything else (an attempt's work or prep folder, a restore, a parser folder, an
unknown name, a file) keeps the whole lease, whatever the ledger says; their owners remove them when they stop, and
one left behind is a consumer the lease cannot prove stopped. A running client keeps even an empty lease. Release is
bounded from its first read (entries, depth, time; listings read incrementally; a caller can only tighten it), and the
hold, the lease's folders and the folder being changed are checked before every chmod, unlink and rmdir; the first
change stops the walk and the rest stays, reported partial. A mode is set through a no-follow descriptor; unlink and
rmdir are path-based, so a same-account process racing paths is detected only when a check observes it — the
owner-only boundary of ADR 19, not a filesystem confinement. Earlier epochs' leases are retained, never swept, and a
fresh lease claims nothing about them; global worker recovery is unchanged.
The trust folder is checked against the captured workspace by its prospective canonical path before anything is
created, and the service refuses a reached runtime-folder candidate inside the workspace before it makes a folder,
socket or descriptor (`ipc.runtimeDirInsideSource`); a disjoint long-path base keeps the `/tmp` fallback. The
multi-source `captureSnapshot` API knows no trust or runtime state and checks only the store boundary; a caller that
captures several sources checks them all (`assertTrustOutside`). Farsight's code parser lists no hidden folder, so a
route under `.farsight` is captured and read by a framework pack but has no graph surface: it is a cited
`routeNotInGraph` frontier, never a fact. Number 45 is reserved for the path protocol.

47. **Sentinel records owner-associated report imports in its existing ledger, separately from worker execution (2026-10-23).**
The internal report-import path accepts bounded SARIF and ZAP data as caller-stated claims. A retained source
proof binds the exact executed run revision, snapshot, source and accepted inventory/parse closure. The trusted
owner Workspace supplies the current adopted policy and receipt directory; nothing in an imported report supplies
that authority. The current implementation supports the existing default Workspace layout. The owner executable exposes
`evidence import`, `read`, `list` and `abandon`. Deep-engine execution, a qualified observation producer and
mitigation decisions remain separate work.

Migration 6 adds evidence operations and append-only acceptances to the same SQLite ledger, and associates each
pending stage with its operation. Private permits bind the genuine held owner, epoch, exact candidate, prior
acceptance head and consumed `evidence.import` receipt. Generic worker publication, generic staging and report pins
cannot accept these stages. Candidate identity covers the retained source closure, workspace/store binding, exact
raw and manifest bytes, normalized data and adapter version. It excludes receipt choice and acknowledgement time;
the completed acceptance root separately binds the actual operation and authority audit, without a hash cycle.

Shared policy preflight precedes caller-file reads. Normalization, byte/layout limits and the full authority-audit
size are checked before spending. Once the shared admission consumes the exact receipt, the operation registers
its six-role stage before writing objects. Acceptance verifies the complete object and link closure and atomically
records the artifacts, acceptance, event and terminal operation while releasing its stage. Accepted roots become
ordinary referenced roots for reachability. Every imported payload keeps at least source-derived privacy; captured
source keeps its stronger floor.

Receipt spending and SQLite commit are separate durable effects. An interruption before publication may leave a
spent receipt and no operation row; the result does not promise the spend can be undone. A lost acknowledgement
revalidates the one existing acceptance before another spend. Resuming an older pending candidate requires fresh
confirmation and a new current-epoch operation; its complete stage is pinned before the old stage is released.
The original receipt and admission remain in the immutable old operation for independent audit. This slice
deletes no payload blobs; that audit would remain if a future explicit collector prunes obsolete unaccepted bytes. Unknown pending operations are retained. Explicit `evidence.abandon`
requires its own current owner receipt for one exact older pending identity and stage set; it releases only that
stage association, records the complete audit, and deletes no physical object.

Retained reads independently verify the acceptance, terminal event, exact closure and normalized bytes, supported
adapter, and local issued-and-spent authority at the original decision time. Expiry today does not erase valid past
acceptance. Reopening reconstructs read authority only; serialized receipts or imported bundles cannot reconstruct
a launch or acceptance permit. Final proof checks preserve the original owner, epoch, source context, deadline and
cancellation signal after asynchronous reads. Known secret findings in current, baseline or selected ancestry
withhold all imported text; canceled runs remain unassessed. Imports do not contribute scanner execution, coverage,
deployment, cryptographic or mitigation credit.

Fixed limits are 64 open operations per store, 256 historical operations per binding, one stage per operation,
six payload roles, 2,048 source-closure artifacts, 4,096 links, 40 MiB payload bytes and 512 KiB operation identity.
Existing 16 MiB per-object limits and the 16 KiB complete authority-audit limit also apply. These are cooperative
bounded operations, not process-memory or operating-system confinement guarantees. Recovery pages old generic
stages in SQL by stable identity, leaving operation-associated evidence stages to their explicit domain recovery.

The initial public command acquires the genuine local owner before touching caller report files. If a detached
service holds the workspace, it returns a typed busy result; it neither steals ownership nor stops the service.
Unexpired MCP read buffers may retain that owner for five minutes. This local-only command is an interim delivery
boundary: the continuous GUI needs separately reviewed receipt transport against the service that already owns
the store. A generic RPC cannot identify itself as the human owner.

Preview returns an exact candidate digest; optional expected-candidate matching refuses stale bytes before receipt
issuance or spending. Confirmation repeats the bounded proofs under the original absolute 120-second operation
deadline. With a prior accepted head, one command can perform up to five complete source proofs; an earlier
three-proof warm-cache measurement is not a worst-case C1 capacity promise. A verified acceptance and its
metadata remain true if subsequent rendering or file delivery fails. The small acknowledgement and the complete
serialized document have separate 16 KiB and 32 MiB limits, including command wrappers. Output is validated and
bounded before one no-overwrite file creation or stdout delivery; overflow refuses rather than truncates.
The new-file export is not crash-atomic: I/O or process failure may leave a new partial file.

The public data-only `sentinel-import-view/draft-1` and `sentinel-import-page/draft-1` schemas support projected
JSON and readable indented-code Markdown, preserving the payload's original characters. One fixed owner-local
disclosure is explicit; a clean imported document is not guaranteed safe to share. There is no shareable flag.
They expose imported claims and honest withholding, never original report bytes or receipts. A default 50 / maximum 100-row metadata page uses a bounded SQL query and a binding-specific cursor;
its availability is explicitly not evaluated, rather than implying that every payload was revalidated. Ordering
is by stable generated operation identity, not chronology. Import/list require a completed run; reading an already
accepted canceled-run import remains wholly withheld. The read
command independently revalidates one acceptance and its current privacy. Claim, exchange and cookie counts
name one accepted import; operation counts name only the returned page. Neither contributes scanner findings,
coverage or mitigation totals.

48. **Sentinel exposes bounded retained reads through its existing owner service and the MCP SDK (2026-10-22).**
The first PR 23a slice is read-only: `service.capabilities`, `run.inspect`, `view.page`, `report.open` and
`delivery.read` are additive operations on the existing versioned socket. The MCP command lazily imports exactly
SDK 1.31.0 as Sentinel's own dependency, connects to that existing service, and exposes these reads plus sanitized
existing describe/status/wait. It never opens a competing store or starts the service. An older service's
`unknownOperation` means unavailable. Starting, pausing, canceling, preparing and rerunning remain owner CLI
operations with their existing confirmation and admission; a transport connection is not a human confirmation.

Inspection copies one admitted revision under the actual held owner, with bounded synchronous copying and
cooperative object reads. All source/work/input/influence/invocation/output identities and implementation digests
become random view-local handles, with private mappings and no evidence-read endpoint. Rows contain fixed stage
and state vocabulary, scoped counts, accepted-publication status and cataloged error codes, never paths, producer
labels, arguments or raw diagnostics. A prerequisite outside that admitted plan is explicitly `reference-only`:
a retained bootstrap/reuse reference, not a missing row or permission to expand ancestry. Historical plan revisions are
labeled; status/outcome explicitly describe the current recorded run, not a second historical status fold. Pages retain the original immutable sequence while workers move on.

The internal store facade meters every physical object-body read, including failed representations and repeats,
through a genuine-owner/store-bound AsyncLocalStorage scope. Limits are 128 MiB each encoded and decoded, 10,000
reads and 20 seconds from the original monotonic start. Nested scopes only tighten; unrelated contexts/stores are
not charged. Declared sizes are reserved before reads and final checks preserve the first typed limit, abort,
deadline or owner error through legacy catches. Budgeted reads yield to the event loop before and after the existing
synchronous verified read, so socket cancellation can be observed between reads. This neither interrupts a read or
fold nor imposes a hard filesystem, RSS or CPU limit. SQLite row reads and trust-folder rule/pack/lock/report-key
reads are outside the object-body meter. Detached callbacks inherit the closed scope and cannot keep reading.

Full-report generation reuses the canonical fold and disclosure/privacy checks, rendering only the requested
format plus canonical JSON for document identity. Legacy `fullReport` keeps all four renderings. Baseline identity
comes from that same assessment. Global ledger drift allows at most one fresh generation within the original
scope/counters/deadline, preserving the first current/baseline run, recorded revision and snapshot. Further drift
returns retryable `viewChanged`; a changed requested run refuses. There is no automatic retry loop. Only after the
scope returns successfully may the service allocate an immutable delivery, perform a final synchronous owner,
signal, original-deadline, current/baseline revision/snapshot and sequence fence, and install it without an await.
Failure installs nothing and evicts no prior delivery. The delivery identifies exact format bytes/hash, canonical
document hash, evaluation time, disclosure, catalog and unavailable context; report ID alone is not its identity.

Provisional finite ceilings are advertised: 2,000 units, 10,000 attempts and 8 MiB per view, eight views/64 MiB total,
60-second absolute TTL, 128 rows/256 KiB per serialized page and 4,096 cursors per view; one report generation,
32 MiB per delivery, four deliveries/64 MiB total and five-minute absolute TTL. Raw byte chunks default to 16 KiB,
maximum 64 KiB, and base64 chunks may split a UTF-8 character. Reads never renew expiry. Reconnects in the same
fixed channel kind retain handles; another channel, store, epoch, service restart or expiry cannot reuse them.
Channel kind is not a principal identity or a cross-account authentication claim. Cancel frames address only an
unsettled read request on their own socket; unknown/finished IDs do nothing, duplicates cannot replace controllers,
and disconnect aborts unsettled preparation while accepted work and prior immutable deliveries remain intact.
Capabilities describe shipped library support separately from untested asset readiness. Mutating MCP tools, model
execution, policy decisions, evidence reads and the graphical interface remain outside this slice.

ADR48 implementation refinements: live unexpired read buffers count as activity for the existing detached idle
policy, without renewing TTLs; a connection by itself does not. After service.stop waits for accepted run tasks,
listener.close destroys only that listener’s accepted sockets, so an idle client cannot prevent store release.
An explicit simultaneous inspection is retryable inspectBusy, whereas projectionLimit remains a permanent size
refusal. MCP status deliberately accepts runId only and returns status/outcome; existing CLI event pagination is
unchanged. The final installation sequence fence can refuse viewChanged without adding a third generation. View
and delivery caches are global insertion-order quotas, so another same-account channel can cause early eviction.
The SDK’s express/hono/cors/jose and other dependencies enlarge the optional installed supply-chain surface, despite
lazy loading keeping the MCP entry out of ordinary imports. Its required zod peer is pinned exactly 3.25.76 beside
SDK 1.31.0; lazy execution does not imply a smaller installation.


ADR48 control extension: `service.control-capabilities` is a separate additive closed document, preserving the
original read capability schema and its literal controlsSupported:false. The lazy SDK adapter advertises start,
pause and cancel only after that negotiation and checks it again before each dispatch, including reconnects.
Closed runtime arguments reject confirmation, receipts and caller identity fields even when a client ignores the
advertised SDK schema. The existing OwnerService admission remains the only execution decision: an ordinary
adopted agent grant or a genuine owner CLI receipt consumed by the legacy service operation. MCP receives no
receipt and cannot confirm; a future HTTP bridge is also an agent. GUI owner confirmation remains an explicit
unbuilt boundary, not a browser boolean or transport label.

The control result is a schema-checked projection of the existing canonical CommandResult vocabulary, exit code,
three cataloged permission verdicts and known lifecycle state, with no raw facts, IDs, hashes or diagnostics.
Requested/submitted is intent or acceptance; existing status/wait establishes the result. Resume starts the same
recorded run, duplicate start joins and terminal replay returns the existing result. Neither response loss nor
MCP cancellation rolls back accepted service work; reconnect reads status without automatic mutation replay.
The retained read scopes do not wrap control execution. Preparation/configuration/rerun and raw evidence access
remain separate slices. A genuine npm-only SDK consumer exercises both grant and owner CLI paths and loses one
actual accepted start response before reconnecting, without changing installed service/adapter bytes.


ADR48 control correction: after a control dispatch, an unreadable/unknown response or transport loss is
nonretryable controlOutcomeUnknown, not proof that the action was unavailable. The existing canonical state is
queried after reconnect; no write is automatically repeated. Per-call negotiation permits a new service epoch on
the same genuine store with fresh admission, while A2 handles remain epoch-bound. A setup pause on a planned
record uses planned → running → pausing → paused without launching work or renewing time/budget; pending cancel
skips that pause branch and wins. Genuine canonical selected-child and actual owner-service setup gates qualify
both branches without depending on the later path worker.


42. **Sentinel owner decisions are source-bound adjudications, with one retained evaluation across reports (2026-10-23).**
The executable exposes `decision propose`, `approve`, `read` and `list`. A proposal names one real accepted
finding; a private held-owner proof rederives its source, executed plan, rule, producer invocation and cited bytes.
Neither caller-supplied scope nor stored JSON supplies authority. Approval requires current adopted policy and
an exact consumed owner receipt. The append-only private `/2` journal binds the workspace/store, prior head,
proposal and admission audit; create-once publication and directory synchronization distinguish uncertainty,
spent-but-unpublished work and readable retained decisions. The earlier `/1` evaluator remains unchanged.

The `/2` projection applies accepted-risk and false-positive decisions only while their source evidence,
approval, scope and expiry remain valid. An owner assertion of mitigation never proves enforcement and leaves
the issue open. Evaluation time is pinned. The canonical report uses the same evaluator for JSON, Markdown,
offline HTML and SARIF; optional journal damage becomes an unavailable section, without hiding independently
validated findings. Shared read-budget, cancellation and ownership failures still propagate. Context-free report
projections cannot evaluate owner history and state that limitation rather than inventing a workspace.

A report-local opaque proof session reuses only source bodies already hash-read by a genuine retained proof;
its final history, current/baseline and selected-ancestor fences remain mandatory. Accepted secret evidence in
any relevant run withholds owner rationale and source-derived details in public acknowledgements, reads and
reports; shareable reports omit rationale even when clean. Unsupported, incomplete or unbound secret evidence
cannot establish a clean result. Lists are bounded metadata only, not evaluated decisions. Input is limited to
64 KiB, history to 1,024 entries/32 MiB, a page to 100 entries and a report to 50 evaluated decisions, with
explicit unavailable/partial outcomes. Local owner commands return busy while the service holds the store;
service-owned and browser confirmation, qualified cookie enforcement and deleting retention remain separate work.
