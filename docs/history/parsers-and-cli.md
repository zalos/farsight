# Parser libraries, NestJS routes and the CLI gaps

Archived from `docs/AI-HANDOFF.md` on 2026-10-28 (2026-10-17 → 10-21). Dated records, verbatim apart from
re-pointed relative links; read on demand, never loaded at session start. Index: [README.md](README.md).

## Custom node patterns — 2026-10-30

Lanes S1, D, A, B and C of [the custom node patterns proposal](../proposals/custom-node-patterns.md) (the viewer
lanes S2/S3 are in [viewer-passes.md](viewer-passes.md)), implemented by Sol over the agent bridge in three waves
(S1 ∥ D ∥ A → S2 ∥ B → S3 ∥ C), each PR reviewed twice by Opus on its own diff and squash-merged by the lead after
*may merge*; every parser lane carried a real ingest of this repository against a `main` build in its body.

- **#256 S1 — the workspace overlay.** `IngestOptions.configOverlay` / `openapiRegistered` / `openapiIgnored`; the
  overlay is a root-scoped config applied after the repository's root file (root wins the same key with a
  `from: 'workspace'` conflict; maps merge key by key down to the alias; lists union), listed in `meta.config.files`
  and audited; `CONFIG_OVERLAY_FIELDS` in core; `settingsProblem` validates `sources[].config` against the embedded
  config schema (`scripts/config-schema.mjs`, ajv from `@farsight/graph`, `./config` subpath) and `sources[].openapi[]`
  through the same schema; `POST /api/settings/check` (allowed read-only), `POST|DELETE /api/sources/<id>/openapi`
  (write routes); `GET /api/version` → `configFields`/`overlayFields`; one `sourceIngestOptions` builder shared by
  the server's sync and MCP's refresh. Blocked and fixed: the merger dropped every overlay field it had no case for
  (A's `frameworks` never reached `merged`); a raw `config.conflict.overlay` key on Settings; a second rule set for
  `openapi[]`; false *matches no indexed* warnings for every matched overlay declaration (the audit scoped the
  overlay to `./`). Real ingest: 12,448 nodes · 26,599 edges · digest `4c20bd135cf2` identical; the reviewer's own
  tree 12,469 · 26,626 identical.
- **#257 D — OpenAPI candidates.** Discovery sniffs every `.json`/`.yaml`/`.yml` (2 KiB head, ≤ 8 MiB) and
  classifies `applied` (named, under `openapi/` by the historical whole-text rule, declared, or registered →
  `origin: 'settings'`) against `candidate` (never applied, so every graph stays byte-identical); `meta.openapi`
  one GraphStore family; `farsight api candidates|register|dismiss [--into-source]`; Register/Dismiss doors on
  Settings; MCP `config_files` and one `graph_overview` line; a dismissal applies to would-be candidates only (the
  repository's word wins; the CLI refuses to dismiss an applied path). Blocked and fixed: the applied set under
  `openapi/` moving in both directions; an out-of-source symlink dropped silently (now reported as *path leaves the
  source*); counts under the wrong scope. Real ingests: this repository 12,448 / 26,599 and the reference app
  5,711 / 15,346 identical, the only growth the `meta.openapi` block.
- **#258 A — framework aliases and the delegate join.** `frameworks.spring.{mappings,security,delegates,listeners}`,
  `frameworks.nest.{verbs,guards}`, `frameworks.express.middleware` (type in `@farsight/graph` beside
  `ExternalDecl`; root-only this lane); readers read their name tables from the options and emit the same ids;
  paths and holes fill from string literals only (a constant records a `non-literal-path` gap, never a URL; an
  enum never becomes a grant); `joinDelegates` after `applySpecs` matches public `ResponseEntity` overrides on a
  `*ApiDelegate` class to `operationId`, moves the contract to `both` and repairs the route like a controller route
  (drift via the exported `operationDrift`, mirrored guards with `meta.requires`); `implements:` tags and class
  signatures only when `delegates` is configured, so a graph without a block is byte-identical; `config list`
  prints the aliases; an unmatched alias is an audit note. The Spring example gained an `@ApiRoute` endpoint, a
  policy-annotated handler, a generated-style delegate and a spec covering all eight operations; the invoice example
  an aliased Nest verb and its `@nestjs/common` declaration — fixture digests, extraction snapshots, deps counts and
  Sentinel's retained-report and planner goldens re-derived, each tied to an example edit. Real ingest: this
  repository 12,448 / 26,599 identical under both builds; main's examples byte-equal; PR examples 67/56 → 68/61 and
  133/171 → 134/173.
- **#260 B — `patterns[]`.** Four matchers (call · decorator · annotation · query → one tree-sitter query per
  grammar through `code-parser/treesitter/queries.ts`; regex per line) emitting route · guard · external · queue ·
  rule · flag · entrypoint in the readers' id shapes, attaching to an existing route found by
  `METHOD normalizeRoutePath(path)` instead of minting a twin; `enclosing` = the innermost declaration span (never a
  route node, never a self-loop); `$handler` same-file; evidence `config-pattern` HIGH (syntax) / MEDIUM (regex) —
  the diff contract grew by exactly one member with its pin, schema and doc line; one parse per file shared across
  rules, deterministic file and byte caps per rule with a sync warning on any stop; `meta.patterns[]` as Counteds;
  `farsight patterns test`, MCP `patterns_test` (`all` tier) and `GET /api/patterns/test` (early return without
  rules, one run per source, foreign-origin GET refused — a new cost-bearing-GET rule in `guard.ts`); ADR 49 (the
  technique and the config-contract family frameworks · patterns · nodes); SECURITY.md's bounds. Blocked and fixed:
  twin routes beside reader routes with parameters; `enclosing` on point-located nodes; `declared` on pattern nodes
  causing false drift; a non-deterministic 1-second budget; the unbounded dry run; any all-letter word accepted as an
  HTTP method. Real ingest: 12,547 / 26,849, digest `4567d7c5ceb3`, identical; a rule over this repository repeats
  with the same site hash.
- **#261 C — hand-made `nodes[]`.** route · guard · external · queue with `loc?`, `handler?`, `guards?`, `tier?`,
  `requires?`, `business?`; applied inside `applyConfig` before `applyRouteGuards`; ids as the person wrote them with
  attach-not-twin by the normalised key; `declared` only on nodes the declaration creates (an attach adds only the
  sentence, tier, grant and edges, keeping the reader's evidence); a declared route a spec also declares reads
  `both` with or without `loc` through an explicit `declared` branch in `core/openapi.ts`; `implemented` became
  *supplied* with a summing breakdown (found in code · declared by a person) on the front door, the APIs card, the
  CLI legend and MCP `api_surface`; overlay `nodes` schema-validated; a nested file cannot change a root-owned node
  (audit note); a `loc` is kept only for a file the collector would select, so an ignored or excluded file is never
  served by `/api/source`; per-row audit notes on `ConfigMeta.files[].nodes[]`. Real ingest: 12,689 / 27,085,
  digest `577950333329`, identical.

## Parser and CLI gap delivery — 2026-10-21

Seven independently reviewed changes close the parser and CLI gaps: API delivery policy, raw test-server
exclusion, explicit guard and multipart vocabulary, wildcard design fallbacks, stale configuration
declarations, retained project test evidence, and packaging prerequisites. The raw route/contract evidence
remains inspectable. Paired parser libraries are prepared at 0.3.1. Public class methods were already
supported; optional interface graph nodes remain deferred. MCP build reporting, graph refresh and tagged
release artifacts were already delivered.

Validation on the final combined runtime in isolated worktrees under Node 24/pnpm 9: build and all
typechecks passed; 1,617 unit tests completed with 1,615 passed and two opt-in live tests skipped;
345 browser/MCP tests, 22 script tests and all 11 small-preset performance checks passed. Catalog lint
checked 3,490 entries. Echo package smoke and actual parser tarballs installed outside the workspace
passed. Independent re-review covered the reporter path, dynamic-suite identity and source-level fixes.
A separate Echo follow-up uses joined request arguments so valid handles beginning with a dash reach
polling and cancellation commands intact; a deterministic regression covers both commands.

Fresh main/gap ingests of the same Farsight source retained 6,136 nodes, 13,216 edges and source digest
`5ec2c23dfc70`, with unchanged node/edge content. Graph bytes were 17,458,002 before and 17,457,996 after;
the six-byte difference is workspace/build metadata, not semantic growth. SQLite was 23,601,152 bytes
in both builds.

The reference validation retained sequential projects and joined all supported default-project cases.
Three report rows with unsupported dynamic case names remain unjoined; identity is never guessed.

Owners still declare source phases, internal routes, guard vocabulary and multipart readers. Unknown
phases stay missing; declared-only and inactive paths prove no enforcement. Aggregate run coverage never
becomes per-case observed coverage because another report says a case passed. Fresh ingest reads reports
on disk; separate result files preserve sequential projects across a fresh ingest. Registry publication
remains separate. Installing the CLI under all three runtime prefixes and restarting servers/reconnecting
MCP follows the final merge.

## Stale glossary, gate tiers and flow documents — 2026-10-21

Branch `codex/gap-stale-declarations` (dependent on the wildcard-route branch) extends existing ingest
warnings to unbound glossary names, unmatched gate tier keys and unreadable local flow document paths.
Glossary auditing uses the same class/member fallback and folder scope as label application; it does
not invent node-id matching. Remote document URLs are skipped. Local document paths retain their
source-root semantics; duplicate references within one flow produce one warning. Diagnostics name the
file and line (the first matching literal in the declaration file).

The parser build, parser typecheck and all 256 parser tests passed on Node 24. The mixed example
compatibility check explicitly expects its newly visible stale glossary and copied document references;
its baseline graph is preserved. Integration owns real-app measurement, the paired parser version
update and clean final browser checks. No installation or publication occurred.

## Raw test servers and wildcard UI pages — 2026-10-21

Branches `codex/gap-test-servers` and dependent `codex/gap-router-fallbacks` exclude raw HTTP route inference
in exact `testing` directories and `*.test-server.*` files, and list undeclared wildcard UI pages separately
from undesigned-page drift. Production inspection endpoints remain indexed. Both React Router `element`
and `Component` declarations remain supported. Wildcard page ids are unchanged; a manifest may claim them.

Node 24: builds, all typechecks, string lint and 18 targeted parser/design tests passed. The full unit run
hit an unrelated randomized Echo hook CLI request id beginning with a dash; Node rejected its separate
argument. The browser run passed 340 and failed five (build freshness, layout and gesture timing); concurrent
builds changed its build stamps, so a clean combined validation remains required. Real-ingest comparison,
public parser version update and final browser verification remain with the integration lead. No install
or publication occurred.

## API delivery policy — 2026-10-21

Branch `codex/gap-api-policy` adds a separate reconciliation `policy` without changing raw operation
lists, counts or graph node contracts. API diff supports `--phase` and selective
`--strict=missing,undocumented,notes`; config supplies `openapi[].phase`, `phaseOrder` and root-only
`internalRoutes`. Unknown phases remain missing. ADR 14 and the walkthrough describe the public contract.

Checked in an isolated worktree with Node 24/pnpm 9: workspace build; affected CLI/parser typechecks;
32 focused core/count/CLI tests; 12 parser OpenAPI tests; catalog lint and commit-title lint passed.
Reference-app acceptance, main comparison and browser validation belong to the integration pass;
no global install, primary build, live-server restart or reference-source edit was performed here.

## API guard and multipart vocabulary — 2026-10-21

Branch `codex/gap-api-vocabulary`, based on the delivery-policy commits, reads operation `x-guards`
against enforced guard names/ids and existing config `guards` labels/matchers. Missing declarations and
missing enforcement remain distinct differences. Reconciliation reads direct handler guards and then
only proven delegate links; route-only declarations do not prove enforcement. Root `validators` lists
exact multipart-reader names/ids and requires an actual same-source calls path for a multipart body.
No new graph field or speculative validation edge is emitted. ADR 15 records the contract.

Focused core/parser/CLI API suites (31 tests), affected builds/typechecks and catalog/title lint passed.
The real application's contract/config declarations remain an owner follow-up; this branch contains
only generic fixtures. Parent integration owns real-ingest comparison and browser validation.

G3 review follow-up: inactive guard edges and inactive direct/delegated handler or reader calls no longer
earn enforcement/body-validation credit. Regressions cover every hop and preserve an alternate active path.

## Test evidence import follow-up (2026-10-21)

Branch `codex/gap-test-evidence`: sequential results imports preserve other projects when a reporter reuses one
results path. `--replace` clears all prior projects from those paths. Exact joins respect the report's file;
ambiguous parameter templates stay unjoined, and a reporter-recorded declaration line may identify one unique
template. Empty coverage keeps metadata without a warning. Coverage remains run-level evidence, even when a
separate results file says a route case passed. Generic regression fixtures cover the distinction.

Validated with Node 24 / pnpm 9: complete build, workspace typecheck, string catalog lint, and focused parser
test-evidence suite. The integrating lead owns combined CI checks and real-application ingest comparison.

## Packaging prerequisite follow-up (2026-10-21)

Packaging now prints `pnpm build && node scripts/pack.mjs` when compiled workspace entries or the core version module are missing,
before touching prior build artifacts. The regression test uses a disposable unbuilt checkout. Release docs
show a pinned GitHub tarball install for CI and distinguish a release commit from subsequent `main` changes.
MCP already reports its running build in `graph_overview`; `refresh_graph` already re-ingests and reloads,
so upgrading the process still requires reconnecting it.

## Declared paths and parser release preparation — 2026-10-19

Branch `codex/declared-paths-ingest` adds ingest warnings for unresolved external class imports,
setup/plumbing declarations and decision affects. The shared collector honors source-root and nested
`.gitignore` files by default; explicit excludes still win and `--no-gitignore` / `gitignore: false` opts out.
Nest named body schemas now produce declared `validates` edges to methods and routes, with an explicit
note that runtime validation-pipe registration is unverified. Declared external classes also recognize
injected fields typed as the global `fetch`; a similar property name alone earns no binding.

The paired parser libraries are prepared at 0.3.0 with graph schema version 1 unchanged. External tarball
installation (native Oxc, Java WASM, public types, serialization and traversal) and publication dry runs
passed. **npm publication remains pending by owner direction**: scope access, initial publication and
trusted-publisher setup are still required. See [Parser libraries](../PARSER-LIBRARIES.md).

Validation used Node 24 in isolated worktrees: build, all typechecks, full unit suites (1,592 passed,
two live tests skipped), targeted suites again after the final refinements, 20 script tests, string lint,
345 browser/MCP tests, 11 small performance tests, and the packaged Echo smoke. Against main `0c8c747`,
fresh ingests of the same source produced identical 6,126 nodes and 13,200 edge sets, with source digest
`96158ffec1b4`; graph bytes were 17,429,937 before / 17,429,932 after, and both SQLite files were
23,564,288 bytes. Fresh front-door, Map and code-map pages had no page or console errors; screenshots
were inspected. Existing primary-checkout editor settings were preserved. No npm publication occurred.

## PR #119 review — 2026-10-19

Merged as `320ca5d` on 2026-10-19 after all required GitHub checks and both parser-package checks passed.

Review fixes on `codex/pr-119-review`, pushed to `feat/nest-routes`: Nest guard nodes are scoped to their
decorator declaration and argument, so equal names in different modules and factory calls cannot combine
unrelated checks. Guard resolution follows renamed barrel exports. Computed controller options are gaps;
controller version options and aliased/namespaced RouterModule mounts are reported. A method parameter that
shadows an imported handler no longer borrows its gates or coverage. Portable analysis and application exports
retain `meta.routes.gaps`. ADR 12 records the additive contract and its consumers.

Verified in isolated worktrees under Node 24: build and all typechecks; 1,587 unit tests passed, two opt-in live
tracker tests skipped; 20 script tests; catalog lint; schema drift check; actual parser tarballs installed and
exercised outside the workspace; 345 browser/MCP tests. The Nest suite now has 15 cases, including reproduced
review regressions; the portable-export test also retains each source's route gaps.

A separate `main` build at `04c3c63` and the reviewed build ingested the same repository from scratch directories,
excluding examples and prototypes: both produced 6,126 nodes and 13,200 edges, with identical node/edge fields
and source digest `96158ffec1b4`. Saved graph bytes: 17,691,608 / 17,691,603 (main / PR); SQLite bytes:
23,834,624 / 23,834,624. Fresh browser pages on the front door, Map and code map had zero page, console or HTTP
errors; screenshots were inspected. This source has no design manifest, so the Map correctly shows its empty
state; the e2e suite exercises populated journeys. The primary checkout, deployed servers, global installs and
dogfood graphs were untouched. Registry publication and acceptance
in the reference application's new host remain separate follow-ups.

## NestJS controllers as HTTP routes — 2026-10-19

Branch `feat/nest-routes` (worktree `.claude/worktrees/nest-routes-7f776a`; a detached `main` baseline worktree at
`../farsight-wt/nest-main-baseline` for the measurement, to be removed after the merge), PR title
`feat(parsers): read NestJS controllers as HTTP routes`. The reference app is moving its HTTP API from App Router
`route.ts` files into a NestJS host; Farsight read no TypeScript decorator, so every one of its handlers would have
left the route map, the drift gate, the journeys and the design status. The brief stays outside the repo.

`packages/code-parser/src/nest.ts` holds the framework semantics (the Spring `spring.ts` ↔ `index.ts` split);
`tsjs.ts` assembles: a class decorated with `@nestjs/common`'s `@Controller` gives one route per prefix × verb path
with **the id App Router gives the same endpoint** (a port is a moved location in `farsight diff`); `calls` route →
`Class.method` HIGH by the decorator; a body that is one `return handler(…)` makes the handler a route handler too
(guards and rules mirror, one hop) and stamps the method → handler call `via: 'delegate'`, which core `cellTwins()`
reads as one coverage cell, `graphToSpec` as one summary and `journeySummary` as one set of words; `@UseGuards` →
guard nodes, walked into `canActivate` when the class is in the repo; class docs read from the earliest of
decorators, `export` and `class`. Not read, each a named `meta.routes.gaps` entry (a new optional graph-contract field,
schema version 1 unchanged) and an `unsupported` library diagnostic: a non-literal path, `@All`, `@Version`,
`setGlobalPrefix`, `enableVersioning`, `RouterModule.register`; an `@entrypoint` that disagrees with the decorators is
recorded too (the decorators win). `reconcile().notes` says when a controller method is not named after its
`operationId` — never drift. React Router data mode's `Component:` key is read (second commit). The paired libraries
are 0.2.0.

Verified under Node 24: build, `pnpm -r typecheck`, **1,584 unit tests — 1,582 passed, 2 live-tracker skips** (ten new
in `parsers/test/nest.test.ts`), 20 script tests, string lint (3,480 entries), schema regenerated. Real ingest of this
repository with the `main` build (`04c3c63`) and this branch from scratch directories: 6,121 nodes · 13,199 edges on
both, 0 node ids or edge keys on one side only, 0 nodes changed, `sourceDigest` `1dd89463f21a` on both, `graph.json`
17,423,143 vs 17,423,144 bytes (the build stamp), `farsight.db` 23,556,096 on both; the branch graph served read-only
gave 0 page and 0 console errors on the front door, the Map and the code map. Nothing was installed globally and no
dogfood or reference-app graph was re-ingested: the reference-app session does that from its brief after the merge
(pack → install under both prefixes → restart → MCP reconnect), then checks that the dark-launch pair of ingests
agree on route ids, `contract.status`, guard and rule counts.

Left open, the owner's calls: `@Body({ schema })` → `validates` (not read); a non-literal path stays a gap rather than
a heuristic route by `operationId`; publishing `@farsight/code-parser` (`docs/PARSER-LIBRARIES.md`). Smaller: no
`examples/` fixture for a Nest host; mirrored handler guards carry no `resolution` (pre-existing); `@Controller({ host })`
is the empty prefix; optional and wildcard segments stay literal.

## Parser library review follow-up — 2026-10-17

PR #115 remains on `codex/parser-package-extraction`, now including main at `2ca7f2b` (PR #116).
The follow-up adds `GraphStore.toDocument()` and `farsight export` for saved, merged graphs: a validated
portable envelope preserves the named sources and their enrichment without application bookkeeping.
Both library READMEs distinguish this from the application's `graph.json`; ADR 11 records the boundary.
Portable parsing retains call-site occurrences, while application ingestion now requires
`ingestRepo(root, { occurrences: true })` to store them. Diagnostics identify truncated declarations by
path, line and node; exactly-at-limit is complete, omitted branches are not. Symlinks report one boundary
diagnostic, and cancellation does not masquerade as an adapter or read failure. The ESM-only contract and
the published declaration dependency on `@types/node` are explicit. Real export also exposed and fixed a
generated-schema error for nested test-project status literals, pinned by a regression test.

Verified under Node 24: build and package/e2e typechecks; 1,572 unit tests passed, with two opt-in live
tracker tests skipped; 20 script tests; string lint (3,480 entries); schema drift check; isolated parser
tarball installation on macOS/arm64; 345 browser/MCP tests; 11 small-preset performance checks. The full
unit/e2e run precedes only commit-trailer and documentation changes. After incorporating PR #116, the
rebuilt PR at `64397a3` and a separate main build ingested the same repository from scratch directories:
all 6,343 nodes and 13,536 edges were equal without removing fields, and both source digests were
`7895bca53311`. Saved graph / actual `/graph` response bytes: main 18,007,211, PR 18,007,207; compact JSON:
14,594,980 / 14,594,976; SQLite: 24,317,952 / 24,317,952. No occurrence fields were stored by default.
The real exported document validated with all nodes and edges. The front door, Map and code map rendered
with zero page, console or unexpected HTTP errors; known missing example design-image 404s remain.

Process correction: the original extraction built and tested in the primary checkout. Review work now
lives in its own managed worktree, with another worktree for the main baseline. The primary checkout is
back on main at `2ca7f2b` and rebuilt from main. This task's old feature-stamped e2e report was archived
outside the checkout and removed from the primary report location. The existing editor-settings change
is untouched. Follow-up commits carry the Codex co-author trailer. Running dogfood services, global
installations and the multi-source graph were not changed; their normal refresh follows merge. Final
GitHub checks and re-review belong to PR #115; registry publication remains separate.

## Parser library extraction — 2026-10-17

Branch `codex/parser-package-extraction`, including main at `056b9a6`, implements
`docs/proposals/parser-package-extraction.md`. The paired MIT libraries `@farsight/graph` and
`@farsight/code-parser` start at 0.1.0, independently of application releases. Graph types remain canonical;
core re-exports them. Farsight's parser composes the same Oxc 0.138.0 and Tree-sitter WASM 0.3.1 adapters and
retains configuration/enrichment ordering. Four pre-extraction fixtures pin TS/JS, Java, mixed and workspace
structure, resolution evidence and enrichment. New occurrence evidence survives relationship deduplication
and portable storage; application storage is opt-in after the review follow-up above. See
`docs/PARSER-LIBRARIES.md` for API, boundaries, tarballs and release instructions.

The portable instance API adds explicit selection, per-file outcomes, diagnostics, bounded local reads,
cooperative cancellation, immutable artifacts, and fingerprints of the bytes actually analyzed and resolution
inputs. Graph v1 has generated runtime validation, canonical serialization and independent traversal.
The low-level composition API preserves Farsight's legacy IO; its output is not the portable analysis cache key.

Local validation under Node 24: workspace build and typechecks, 1,564 unit tests passed (two opt-in live tracker
tests skipped), 20 script tests, string lint (3,477 entries), schema drift check, actionlint, 345 browser/MCP
checks and 11 small-preset performance checks. Final portable-only file-selection and public-type corrections
were followed by parser and compatibility reruns. Actual tarballs installed outside the workspace on
macOS/arm64, parsed TS/JS and Java, resolved every public TypeScript entry point without skipLibCheck, and
saved/reloaded/queried the graph in a separate process. CLI and Echo tarballs also built successfully.
Linux/macOS tarball CI and the repository's six required checks run on the PR.

Registry publication is separate: the owner must confirm npm scope/package access, bootstrap the two names
and configure their trusted publisher and `parser-libraries` environment before the manual provenance
workflow can publish. No npm publication, global install, deployed service or dogfood graph was changed.
Complete execution/taint analysis and an agent-stage scheduler remain later work.

## PR #115 review (parser library extraction) — 2026-10-17

Claude reviewed `b074600` on a detached worktree under Node 24 beside a `main` build: build, typecheck, schema drift
check, 1,566 unit tests (two live-tracker skips), 20 script tests, 345 e2e, string lint and the tarball consumer
test all passed. Ingesting this repository with both builds from scratch directories gave byte-identical nodes
(6,332) and edges (13,510) apart from the new `occurrences`, the same `sourceDigest`, and zero page errors on five
viewer surfaces. Nothing blocks the merge; the review on the PR lists seven non-blocking findings, the two that
deserve follow-up issues first: Farsight's own `graph.json` does not validate as a `farsight-graph v1` document
(no `repo`, application-only `meta` keys), and occurrence evidence is stored and served with no consumer yet
(`graph.json` 18.0 → 26.9 MB, `/graph` +43 %, `farsight.db` +33 % on this repo). Process: the work was done in the
primary checkout, which rebuilt the dogfood workspace's `dist/` on the branch (4478 now reports RESTART into
`1044d4d`) and left it checked out on the branch; `AGENTS.md` now requires a worktree, a real-ingest comparison
against `main` for parser/core/store changes, an assistant trailer on every commit and an ADR per new boundary.
After the merge: check `main` out in the primary checkout, rebuild, pack, reinstall under both prefixes, restart
4477 and 4478 and re-sync, as for any pass.
