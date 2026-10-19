# Parser libraries

`@farsight/graph` and `@farsight/code-parser` are paired Node 24+ ESM libraries at version **0.2.0**, independent
of the application's root version (0.1.0 was the extraction; 0.2.0 reads NestJS controllers as routes and records
route gaps on `meta.routes`, an optional addition to the graph contract — schema version stays 1). Both are MIT licensed. They are packaged by this repository; registry
publication is a separate owner-controlled release step. Package names do not establish npm scope ownership.

The canonical graph contract lives in `packages/graph/src/graph.ts`; core re-exports it. Its generated JSON
schema is `packages/graph/schemas/graph-v1.schema.json`. The graph library supplies validation, canonical
serialization, occurrence identity/merging and pure structural indexing/traversal. It does not include
Farsight's storage, test refolding, readiness or presentation modules.

The application's `graph.json` remains its local snapshot container, not the portable document. Run
`farsight export --graph graph.json --out portable-graph.json --source-id my-workspace` to convert a saved
single- or multi-source graph. `GraphStore.toDocument(sourceId)` is the same conversion for application code.
The document names the merged source set and preserves its per-source enrichment and content digests, nodes,
edges and resolution evidence. Machine roots, snapshot/build bookkeeping and mtime hashes are omitted.
Export leaves both the input file and snapshot history unchanged; overwriting the input is refused.

The code-parser library owns the existing Oxc TS/JS and Tree-sitter Java implementations and their extraction
helpers. Adapter entry points are explicit and registration is per instance. The parser's root import does not
load native or WASM engines. `packages/parsers` retains configuration and all application enrichment passes;
its compatibility facades delegate to the packaged implementation. `ingestRepo()` reads config before adapters,
applies it once, retains the existing enrichment order, and retains `sourceDigest` for test freshness.

The bounded `parseRepository` API returns an immutable `farsight-analysis` artifact with the shared schema
version, source identity, graph, exact input fingerprints, versions, file outcomes and diagnostics. It does not
read Farsight configuration or call external enrichment services. Caller-supplied extraction settings are
fingerprinted. The low-level composition API preserves Farsight's legacy behavior and is not a full-enrichment
analysis cache key. See the package READMEs for code examples and the exact contract/limits.

## Build and verify

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/graph-schema.mjs --check
pnpm --filter @farsight/graph --filter @farsight/code-parser --filter @farsight/parsers test
pnpm test:parser:package
```

The package check builds actual pnpm tarballs under `build/parser/`, installs just those libraries into a
temporary directory outside the workspace, loads Oxc's native binding and Java's WASM grammar, resolves public
TypeScript declarations, saves a graph, and queries it from a second process. It verifies package versions,
licenses and absence of workspace references/application dependencies. npm installation requires registry access;
install scripts are disabled, optional native dependencies are retained. CI runs this on Linux and macOS.

Compatibility fixtures were captured from the pre-extraction implementation for TS/JS, Java/Spring, mixed
languages and the NX/workspace example. Input mtimes are fixed for file-derived design/report dates; only the
legacy `sourceHash` is omitted from comparisons. Default application ingestion is asserted to carry no
occurrences; the opt-in evidence is tested separately. Nodes, edges, resolution evidence, enrichment and source
digests remain compared in full.

Intentional behavior changes are tested separately: `include` is honored; recursive glob matching is fixed;
new direct parsing reports malformed and incomplete inputs; adapter registration is immutable; call occurrences
survive relationship deduplication, flag folding, GraphStore save/load and portable serialization. Tree-sitter
parsers and trees are released after file extraction.

`parseRepository()` always retains call sites. Application ingestion defaults to relationships without sites;
`ingestRepo(root, { occurrences: true })` is an explicit opt-in until an application surface needs them. This
keeps unused detail out of new application snapshots, browser payloads and MCP responses. Existing detailed
snapshots keep their evidence. Branch truncation still makes `complete` false, but its diagnostic identifies the
file and declaration; exactly reaching the cap is not truncation. Cancellation and refused symlinks each retain
their own diagnostic and file reason rather than being relabelled as adapter or IO failures.

## Release the pair

1. On a normal PR branch, run `node scripts/library-version.mjs X.Y.Z` (or `--dry-run` first), then
   `pnpm install --lockfile-only`. This updates both library manifests and the parser stamp, not the app version.
   Update the library README version notes, check the schema and run the checks above. Review and merge the PR
   through the normal Conventional Commit/squash flow. The initial 0.1.0 pair is already versioned.
2. Establish npm ownership/access for **both** names. Configure a trusted publisher for each package for this
   repository, workflow **publish-parser.yml**, environment **parser-libraries**. npm's initial package/scope
   setup may require an owner bootstrap before OIDC publication is available. No npm token is stored here.
3. Create/configure the GitHub `parser-libraries` environment and its desired release reviewers. Run
   `publish-parser` from main with the exact reviewed version and `dry_run: true`. Inspect both platform checks.
4. Run the same workflow with `dry_run: false` when ready. It rechecks the pair, builds and tests actual tarballs,
   then publishes graph followed by code-parser using npm trusted publishing and provenance. The workflow pins
   an OIDC-capable npm CLI. A partial release can be retried only when an existing version has identical bytes.

The application `release.yml`/`publish.yml` continue to release the application. They do not bump these libraries.
Schema version 1 is explicit and independent of package semver. Schema-changing work must update the canonical
types, regenerate using `node scripts/graph-schema.mjs`, and assess consumer compatibility. Downstream frozen
Farsight contracts remain unchanged.

Upstream references: [Oxc parser](https://oxc.rs/docs/learn/architecture/parser.html),
[VS Code's Tree-sitter WASM distribution](https://github.com/microsoft/vscode-tree-sitter-wasm),
[pnpm workspace publishing](https://pnpm.io/workspaces#publishing-workspace-packages), and
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
