# Language adapters: clean multi-language core + Java/Spring Boot

*Proposal / contract for the `feat/java-adapter` pass — 2026-07-25.*

## Why

Farsight's promise is "one graph, many lenses" — but Phase 1 has exactly one
language adapter (`ts-js`) and every consumer (CLI, server `/api/sync`, MCP
`refresh_graph`) imports `ingestTsJs` **directly**. Adding a second language
today would mean touching three consumers and copy-pasting the language-agnostic
half of `tsjs.ts` (file walking, freshness hashing, doc-comment parsing, branch
labels, tag heuristics). This pass makes the adapter seam real, then proves it
with Java + Spring Boot — the most common "second stack" in the mid-size teams
Farsight targets (TS frontend, Java API).

Value framing: a business user or agent pointed at a Spring service should get
the same answers the TS graph gives — *what endpoints exist, who guards them,
what tables they touch, what the code decides along the way* — with zero new
concepts. Same schema, same lenses, same MCP tools.

## Architecture

### Adapter registry (`packages/parsers/src/index.ts`)

`LanguageAdapter` already exists; what's missing is dispatch. New single entry
point used by **all** consumers:

```ts
ingestRepo(repoPath, options): Promise<GraphFragment>
```

- Runs every registered adapter; each adapter scans for its own extensions and
  returns a fragment (empty fragment if no files — cheap no-op).
- Merges fragments into **one** `GraphFragment` per repo: nodes deduped by id,
  edge ids renumbered (`e0…`) so adapters can't collide, `meta.files` summed,
  `meta.sourceHash` = sha1 over the per-adapter hashes.
- CLI / server / MCP switch from `ingestTsJs` to `ingestRepo`. No other consumer
  change: graph shape is identical for TS-only repos (verified in e2e).
- `adapters` array stays exported for tests/tools; adding a language = one new
  directory + one line in the registry.

### Shared layer (`packages/parsers/src/shared/`)

Language-agnostic code moves out of `tsjs.ts` (no behavior change):

| module | contents |
|---|---|
| `files.ts` | `collectFiles(root, exts, options)`, `globToRegExp`, `SKIP_DIRS`, `freshnessMeta(root, files)` |
| `docs.ts` | `parseDoc` (5 Farsight tags + vanilla JSDoc/TSDoc/Javadoc harvest), `cleanProse`, `stripInlineTags`, `javadocAbove(source, offset)` (leading `/** */` harvest, annotation/modifier-tolerant) |
| `labels.ts` | branch `// @business` directives: `leadingBranchLabel`, `trailingBranchLabel`, `capLabel` |
| `tags.ts` | `autoTags`, `normalizePath` |

These are exactly the pieces the Java adapter needs verbatim — the Javadoc
harvest in `parseDoc` was already written Javadoc-aware (HTML stripping,
Javadoc `{@link pkg.Cls#m(int) label}`), and the `@business` branch directives
use `//` comments, which are identical in Java.

`tsjs.ts`, `walk.ts`, `aliases.ts` stay where they are and import from
`shared/`. TS-specific logic (JSX, App Router, Drizzle, zod, barrels) does not
move — the shared layer is only what a second language genuinely reuses.

### Tree-sitter substrate (`packages/parsers/src/treesitter/`)

Syntax layer for **all future languages**: tree-sitter via
**`@vscode/tree-sitter-wasm`** — the VS Code team's prebuilt WASM bundle
(runtime + grammars, ABI-matched by construction; the generic `tree-sitter-wasms`
grammars proved ABI-incompatible with current `web-tree-sitter` in the spike).
Pure WASM: no native modules, no install-time compilation, works everywhere
`npm install -g` does. The bundle already includes Java, C#, Go, Python, Ruby,
Rust, PHP — each future adapter is grammar + queries + a semantics layer, not a
new parser integration. Spike-verified on the Spring fixture: zero-error parse,
S-expression queries capture methods/annotations/branches, nodes carry
`startIndex`/`endIndex` byte offsets and row/column positions, and comments are
ordinary nodes (Javadoc harvest needs no side channel).

`treesitter/harness.ts` owns the reusable machinery: one-time WASM init, grammar
loading from the package's `wasm/` dir, parse-or-skip (unparsable files never
fail an ingest — same rule as TS), and query helpers. `web-tree-sitter` types
come from the same package. Adapter `ingest()` is **async** (WASM init); the
registry and consumers await it. oxc stays the TS/JS syntax layer — it is
faster, TS-aware, and already carries App Router/Drizzle/JSX semantics; there is
no reason to churn it.

Java adapter files: `java/index.ts` (adapter + ingest orchestration),
`java/queries.ts` (tree-sitter query sources), `java/spring.ts` (Spring/JPA
semantics).

### Extraction matrix (Java → graph)

| Java construct | Graph output |
|---|---|
| `class` / `interface` / `enum` / `record` | `class` node `repo::path::Name`; stereotype annotations (`@Service`, `@RestController`, `@Component`, `@Repository`, `@Configuration`) → tags |
| method | `function` node `repo::path::Class.method`, `group` defaults to class name (Javadoc `@group` overrides), signature, snippet, branches |
| `@GetMapping`/`@PostMapping`/… + class-level `@RequestMapping` base path | `route` node `METHOD /base/path` (`{id}` → `:param` — same normalization as TS fetch-stitching), `calls` edge → handler method |
| `@PreAuthorize` / `@Secured` / `@RolesAllowed` (class or method) | `guard` node (expression as label), `guards` edge → route/method; Javadoc `@guard` also works via shared parseDoc |
| `@Entity` class (+ `@Table(name=…)`) | `table` node (columns from fields; `@Column(name=…)` respected); registered as a symbol so repository edges resolve |
| interface `extends JpaRepository<Entity, ID>` | repo methods become `function` nodes with `reads`/`writes` edges to the entity table: `save`/`delete*` → writes; `find*`/`get*`/`count*`/`exists*`/`@Query(select…)` → reads; `@Modifying @Query` → writes. Query/derived-name text on the edge (`code`) |
| method calls | `calls` edges: same-class direct calls; cross-class via injected-field/constructor-param **declared types** (`repo.save(x)` → `InvoiceRepository.save`) and imports/same-package resolution |
| `kafkaTemplate.send("topic", …)` / `rabbitTemplate.convertAndSend` | `queue` node + `publishes` edge |
| `@KafkaListener(topics=…)` / `@RabbitListener` | `consumes` edge + `entrypoint` tag |
| `@Scheduled` | `entrypoint` + `cron` tags |
| Bean Validation on DTO fields (`@NotNull`, `@Size`, …) | DTO class becomes a `rule` node (constraint summary as signature); `@Valid` parameter on a handler → `validates` edge rule → route/method |
| `if` / `switch` (incl. arrow switch) / ternary / `try-catch` | `BranchPoint`s with arms, AST-aware negation for `else`, `exits` flag — identical schema to TS; `// @business` leading/trailing directives label forks/arms |
| Javadoc `/** … */` above annotations/declaration | shared `parseDoc`: `@business @group @tag @guard @entrypoint` + vanilla harvest (`@deprecated`→tag+docs line, `@see`, `@since`, HTML stripped, `{@link}`/`{@code}` inlined; `@param`/`@return`/`@throws`/`@author` dropped) |

`lang: 'java'` on every node. `businessSummary()` (core) already gives the
summary-sentence business fallback — nothing to add for Java.

Out of scope (recorded for later passes): Spring WebFlux functional routes,
`application.yml` property graph, Lombok-generated members, multi-module Maven
resolution across repos, cross-language HTTP stitching between merged fragments
(today stitching stays per-adapter; TS→Java stitching lands with the cross-repo
stitching item on the roadmap).

### Example: `examples/spring-invoice-api/`

The Java twin of `invoice-app` — same product domain so demos can say "same
invoice system, Java backend", and the full annotation matrix has a fixture
(what `invoice-app` is for JSDoc, this is for Javadoc):

```
pom.xml                                   (minimal; never built — parse-only fixture)
src/main/java/com/acme/invoices/
  InvoiceApiApplication.java              @SpringBootApplication
  api/InvoiceController.java              @RestController CRUD + /send, @Valid, @PreAuthorize
  api/dto/CreateInvoiceRequest.java       Bean Validation → rule node
  service/InvoiceService.java             @Service; branches with // @business labels;
                                          calls TaxCalculator + repository + publisher
  service/TaxCalculator.java              vanilla-Javadoc matrix: @deprecated @see @since {@link}
  domain/Invoice.java                     @Entity @Table("invoices")
  domain/InvoiceRepository.java           extends JpaRepository; findByStatus, @Query, @Modifying
  events/InvoiceEventPublisher.java       kafkaTemplate.send("invoice.sent", …)
  jobs/OverdueInvoiceJob.java             @Scheduled + @entrypoint Javadoc
farsight.config.json                      glossary (business names for the Java nodes)
```

Registered as a source in `.farsight/settings.json` and wired into the
"Invoice systems" collection next to `invoice-app`.

### Packaging

`@vscode/tree-sitter-wasm` added to `@farsight/parsers` deps and to `pack.mjs`
externals + standalone `dependencies` (same pattern as `oxc-parser`). The
harness resolves grammar `.wasm` files from the installed package at runtime
(`require.resolve`), so keeping it external means the tarball needs no asset
copying. Pure WASM — global `npm install -g` keeps working on every platform.

## Verification (e2e gate before merge)

1. `pnpm build && pnpm -r typecheck`.
2. CLI ingest of `spring-invoice-api`: assert routes with guards, table with
   columns, reads/writes with query code, rule + validates, queue publishes,
   branches with `business` labels, `deprecated` tag, docs prose from Javadoc.
3. Re-ingest `invoice-app` + dogfood repo: node/edge counts unchanged vs `main`
   (registry refactor is behavior-neutral for TS).
4. `journey` from `POST /api/invoices/:param/send` walks controller → service
   → repository/queue with fork labels.
5. `node scripts/pack.mjs` succeeds.
