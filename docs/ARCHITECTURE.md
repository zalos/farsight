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

## Speed strategy

Requirement: "fast" — parsing monorepos in seconds, 60fps navigation of large graphs.

Phase 1 pragmatics (no Rust toolchain required by consumers):

- **Parsing:** [oxc-parser](https://oxc.rs) (Rust, shipped as napi bindings — parses JS/TS at millions of lines/sec) for syntax; **TypeScript compiler API** only where semantic resolution is needed (types, cross-file symbol resolution), run incrementally and cached.
- **Multi-language (landed 2026-07):** **tree-sitter WASM** substrate (`@vscode/tree-sitter-wasm` — prebuilt runtime + grammars, no native modules) behind the same adapter interface; Java/Spring Boot is the first adapter on it, and the bundle already carries C#, Go, Python, Ruby, Rust grammars for the next ones. oxc remains the TS/JS syntax layer.
- **Graph engine:** TypeScript first, columnar in-memory layout + SQLite persistence. The engine sits behind a narrow interface so hot paths can move to a Rust napi crate (`farsight-engine`) without touching consumers. This is the designated Rust beachhead if/when profiling demands it.
- **Rendering:** Canvas/WebGL (not DOM/SVG) for graph surfaces; level-of-detail culling; layout computed in a worker (ELK/dagre for flows, force/cluster for atlas), cached per lens.
- **Incremental everything:** file-hash-keyed parse cache; graph diffs on re-ingest; watch mode re-parses only changed files.

## Packages

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
- `ts-js` adapter (phase 1): oxc for AST; extractors for functions/classes/imports/exports, React components & JSX render edges, Express/Nest/Fastify routes, fetch/axios call sites, zod/joi/class-validator schemas → `rule` nodes, middleware → `guards` edges, Prisma/TypeORM/Drizzle models → `table` nodes.
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
