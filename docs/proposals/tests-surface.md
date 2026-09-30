# Tests in the graph: a Tests tab, coverage on every journey, and the end-to-end code view

Proposal · 2026-09-08 · branch `feat/journey-action-proposals` (documentation only; nothing built)

**Recommendation.** Put tests in the semantic graph as first-class nodes, attach them to what they verify with one `covers` edge that carries its evidence class (declared · static · observed), and then serve the same facts three ways: a **Tests** tab in the viewer, a **coverage foot** on every journey segment and business step (linked into the tab), and a restored **end-to-end code view** of a journey whose gutter shows which lines and functions the unit and e2e tests reached. The reference app is the test bed: it already runs Vitest with the v8 coverage provider and Playwright with a file-level `@covers` convention, so the first pass needs no new annotations, only a report or two.

The four boards in a design reference are the acceptance pictures. They are HTML in the product's own tokens and sprite, rendered to PNG; every name on them is a real the reference app or invoice-app test, screen, flow, or symbol, and every number is illustrative until the adapter exists.

This document accelerates F11 (*Test ⇄ journey linkage*, [FEATURES.md](../FEATURES.md)) from the P9 "declared `@covers` degraded cut" in the [v3 build plan](v3-build-plan.md) to a full pass, and it sits after the journey-action work in [journey-action-timeline-2026-09.md](journey-action-timeline-2026-09.md): coverage rides on whichever journey projection ships (segments today, actions later), because it hangs off node ids, not off layout.

## 1. What exists today

### In Farsight

- **No test vocabulary in the schema.** `NodeKind` has no `test`; `EdgeKind` has no `covers` (`packages/core/src/graph.ts:6-37`). `ResolutionTechnique` already lists `'annotation-scan' // @guard/@entrypoint/@covers`, so the idea has a reserved slot but no implementation.
- **Test files are parsed as ordinary source.** `tsjs.ts:40` skips only `.d.ts`. A colocated `foo.spec.ts` becomes `import` edges and stray `function` nodes; the only defence is the user's `--exclude`, which is why the reference app source excludes `e2e/**` in `.farsight/settings.json`. Every consumer therefore sees either polluted graphs or no tests at all.
- **The end-to-end code pane was removed.** Commit `8b6c0fc` (Journey view) rendered every root of the step tree through `jrnSectionHtml` into a scroll-synced `#jrn-code` pane. Commit `ddf5e04` (blueprint timeline, 2026-09-05) deleted that loop with `jrnDrawArrows`/`jrnObserve`. `jrnSectionHtml` survives only as the fallback of `jrnExpHtml` (`journeys.js:1335`), one selected marker at a time. The code lens today is a *register* (hides business chrome, `viewer.html:766-773`), not a view.
- **The plan already reserves the shape.** v3 §2.3 says no consumer computes a percentage itself (`computeMetric` returns value + scope + evidence); `MetricDefinition.id` is a closed union that has to widen for `test-coverage`. P9 item 5 plans `@covers journey:<id>` → CSV; §7 puts inference in Phase 3. `gate` reads a closed `ChangeKind` list (`diff.ts:18-26`); a coverage rule needs one new kind or one new `when` prefix.
- **A tab is a known recipe.** `shell.js` `NAV` + `SURFACES`, a `surfaces/<name>.js` exporting `mount<Name>(route, el)`, `nav.<name>` in the catalog, an `<option>` in the landing select, an entry in `lint-strings` `CHROME_FILES`. `apis.js` (cards → detail → panel, every fact from `/api/apis*`, every navigation an `href`) is the template.

### In the reference app

- **Unit: Vitest 4.1 through Nx**, 68 colocated `*.spec.ts(x)` files (patterns 23 · primitives 18 · api 19 · shared 8 · portal 6), jsdom + Testing Library for the two ux libs, MSW for the portal data layer, `*.integration.spec.ts` variants. Every config declares `coverage: { provider: 'v8', reportsDirectory: '../../../coverage/<project>' }` and **nobody runs it**: no `--coverage` script, no reporter list, no `coverage/` on disk, CI runs `nx affected -t test` without it.
- **E2E: Playwright 1.62**, 18 `*.pw.spec.ts` under `e2e/tests/` in four projects (`pipeline`, `api`, `desktop-1440`, `mobile-390`), `list` + `html` reporters, no junit/json, `test-results/.last-run.json` = `{"status":"passed","failedTests":[]}` (2026-09-08), `playwright-report/index.html` present. Selectors are role/label/text only; no `data-testid`, no tags, no `test.step`.
- **The mapping convention is already there.** Eleven e2e files open with a file-level JSDoc block: `@covers invoice-submission` / `@covers example-app::flow::my-invoices` (flow ids, bare or graph-qualified) and `@covers SCR-07` (screen ids from `docs/design/screens.json`, which Farsight already ingests as the design source). Unit specs carry no `@covers`, but their imports name the functions they exercise (`submissions.spec.ts` imports nine functions from `./submissions`; `wizard-state.spec.ts` imports the reducer and its selectors).

So the raw material for three evidence classes exists: **declared** (`@covers`), **static** (a test's imports, `page.goto('/route')`, `request.post('/api/v1/…')`), and **observed** (v8/istanbul coverage from Vitest; Playwright coverage via `page.coverage` plus `NODE_V8_COVERAGE` on its `webServer`). What is missing is the adapter that reads them, the schema that holds them, and the three surfaces that show them.

## 2. Principles this pass must keep

1. **One graph, many lenses.** A test is a node; what it verifies is an edge. Tests tab, journey foot, code gutter, CLI, MCP, and `gate` are views over the same `covers` edges. No consumer computes a percentage; `computeMetric('test-coverage', scope)` does (v3 §2.3).
2. **Code is the source of truth; evidence is labelled.** `@covers` is a claim, an import is an inference, a coverage report is an observation. Each `covers` edge says which, with the same `resolution` block every other edge carries. A claim never renders as an observation.
3. **Gaps are drawn, not omitted** (F11). A journey with zero tests, a step no test reaches, an orphan test that verifies nothing the graph knows, a report older than the code: each is a visible state with a sentence, never an absent row.
4. **Two audiences, same nodes.** Business sees *"Verified end to end by 3 tests, last passed today"* on the step card; a developer sees the same edge as a cyan/amber gutter beside the line. The link between them is the Tests tab, both ways.
5. **Runtime evidence is time-stamped and can go stale.** A run is joined to the graph by node ids and a source digest. If the source changed after the run, the edge is *stale*, the way `graph_overview` already reports freshness.

## 3. Model

### 3.1 Schema (additive)

```ts
// graph.ts — additions only; nothing existing changes shape
type NodeKind = … | 'test';
type EdgeKind = … | 'covers';

interface TestRef {                       // on a `test` node, like `contract` on a route or `design` on a page
  level: 'unit' | 'integration' | 'e2e';
  runner: 'vitest' | 'jest' | 'node:test' | 'playwright' | 'cypress' | 'junit' | 'other';
  suite: string[];                        // describe path, outermost first
  project?: string;                       // Playwright project / Nx project
  file: string;                           // repo-relative spec path (loc.path is the same; kept for grouping)
  declares?: string[];                    // raw @covers values as written, resolved or not
  run?: TestRun;                          // last observed run, joined by test id
}
interface TestRun {
  id: string;                             // report file digest or reporter run id
  at: string;                             // ISO, from the report
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  durationMs?: number;
  sourceDigest?: string;                  // repo sourceHash at run time when the reporter recorded it
  stale: boolean;                         // sourceDigest !== fragment.meta.sourceHash
  report?: string;                        // repo-relative path to the html/json report for the ⧉ link
}
```

- A **`test` node** is one test case (`it`/`test`), `name` = its title, `docs.summary` = the describe path joined with ` › `, `loc` = the call span, `tags` = `['test:unit', 'runner:vitest']` so the existing tag filters and `search_graph` kind filter work unchanged. Its `group` is the spec file, so the Code map collapses a file to one box exactly as it does for `@group`.
- A **`covers` edge** goes from a test to any node it verifies: `page`, `route`, `function`, `component`, `flow`, `design` screen, `rule`, `guard`. `meta.evidence: 'declared' | 'static' | 'observed'`, `meta.runId` for observed, `meta.lines` (hit line count) when a report gives it. `resolution.technique` is `annotation-scan`, `import-resolution`, `route-literal`, or the new `coverage-report`; confidence follows the existing tiers (declared to a resolved id = HIGH, an import that is also called = HIGH, an import only = MEDIUM, `page.goto` with a template literal = LOW + candidates).
- **Observed coverage** enters the graph the same way, so every consumer stays a graph view. It is attributed at the finest granularity the report supports: Vitest's istanbul JSON has no per-test attribution, so its edges hang off a synthetic run-level `test` node per project (`suite: ['vitest run', '<project>']`, `name: 'unit run · 2026-09-08'`, `level: 'unit'`); a Playwright coverage fixture (below) attributes browser-side coverage per test; server-side Next coverage under `NODE_V8_COVERAGE` is run-level. The UI says *"reached by the unit run"* vs *"reached by this test"* accordingly.
- `GraphFragment.meta.tests` records what was read: report paths, their mtimes, run ids, and whether each was stale against `sourceHash`. `graph_overview` and `farsight status` print it next to freshness.

### 3.2 The adapter — `packages/parsers/src/tests/`

Runs inside `ingestRepo()` as a post-pass after the language adapters, like `openapi/` and `design/`, and is skipped with `options.tests:false`.

1. **Claim test files first.** A file is a test when its path matches the configured or default globs (`**/*.{test,spec}.{ts,tsx,js,jsx,mts}`, `**/*.pw.spec.ts`, `e2e/**`, `**/__tests__/**`, `**/test/**/*.ts`) *or* it imports a known runner (`vitest`, `@jest/globals`, `node:test`, `@playwright/test`, `cypress`). Claimed files are not walked by `tsjs.ts` as source (they keep their `file` node and `imports` edges; they stop producing `function` nodes), which removes today's pollution and lets the reference app `e2e/**` exclude go away.
2. **Extract cases.** Walk `describe`/`it`/`test` (+ `.each`, `.skip`, `.only`, `test.describe.configure`) with the existing oxc walker; a title that is a template literal keeps its raw text and gets `resolution: heuristic`. Playwright `test.step` titles become `docs.remarks` lines on the case.
3. **Declared edges.** Harvest `@covers` from the file header and from any case-level JSDoc (`shared/docs.ts` learns the tag). Resolve each value in order: full node id · `flow` id · design screen id · route `METHOD /path` · `repo::path::name` · bare symbol name unique in the repo. Unresolved values stay on `test.declares` and render as *"declares `CON-99`, which nothing in the graph matches"*.
4. **Static edges.** Unit: each imported symbol that resolves through `aliases.ts` gets a MEDIUM edge, promoted to HIGH when the file also calls it; `render(<X …/>)` in a jsdom test covers component `X`. E2E: `page.goto('<literal>')` matches a `page` by route (App Router route groups dropped, `[param]` segments matched as patterns); `request.<method>('<literal>')` matches a `route`; helper calls (`createDraft(request)` from `e2e/helpers/contractor-journeys.ts`) are followed one level so the shared journey helpers attribute their routes to the calling test.
5. **Observed edges.** Read what `farsight.config.json → tests` points at, fail-soft:
   ```json
   "tests": {
     "unit":  { "runner": "vitest",     "results": "coverage/**/vitest-results.json", "coverage": "coverage/**/coverage-final.json" },
     "e2e":   { "runner": "playwright", "results": "e2e/test-results/results.json",   "coverage": "e2e/.coverage/**/*.json", "report": "e2e/playwright-report/index.html" }
   }
   ```
   Istanbul `coverage-final.json` (`fnMap` + `f` counts, `statementMap` + `s`) maps to `function`/`component` nodes by `path` + declaration line, with hit line counts on `meta.lines`. Vitest's `json` reporter and Playwright's `json` reporter give per-case status, duration, and the run timestamp; junit XML is accepted for other stacks. `stale` is set when the report predates the newest mtime of any file it names, and when a recorded `sourceDigest` differs.
6. **Freshness and exclusion.** The adapter never runs tests. It never fails ingest: a missing report leaves observed edges out and writes one `BlindSpot`-style sentence into `meta.tests` (*"No unit coverage report found; declared and static evidence only"*), which the Tests tab and `graph_overview` print.

### 3.3 Coverage as a metric, not a number in a template

`core/metrics.ts` (P3) gains `test-coverage` with the value/bound/evidence shape from v3 §2.3, computed at any scope: workspace, source, collection, a flow, a segment, a single node.

- **Numerator/denominator by audience.** For a *journey*: steps (unique node ids on the walk) covered by ≥1 test ÷ steps; split into `unit`, `e2e`, `either`. For a *business step* (segment or, later, action): the same over the nodes in that segment, plus a boolean *verified end to end* = at least one e2e test declares the screen/flow or observes a node inside it. For a *gate/rule*: covered when a test's static or observed edge reaches the guard function or a test title names its outcome (LOW, heuristic; shown as *"probably"*).
- **Bound.** Declared + static evidence gives a *floor*; an observed report gives *exact* at report time and *floor* when stale. `computeMetric` returns `scopeLabel` with the value, so the chip reads *"≥ 64% · unit run stale"* and the popover lists the evidence edges.
- **`coverage-suspect`.** When `diffGraphs` reports `journey_changed` for a flow, every declared `covers` on it is marked suspect until a newer run passes (F11's "suspect when the journey changes shape"). This is derived from snapshot history, not stored on the edge.

### 3.4 Where the same facts are served

| Consumer | What it gets | Files |
|---|---|---|
| `GET /api/tests[?scope=&level=&flow=&node=]` | catalogue: per-source suites, counts, last runs, freshness sentences; `journeys[]` matrix rows (flow → declared/static/observed tests, verified-e2e, metric); `orphans[]`; `gaps[]` | `server/src/index.ts` |
| `GET /api/tests/<testId>` | one test: suite path, run, every `covers` edge with evidence and ⧉ locations, the journeys it participates in | same |
| `/api/journey` | `summary.coverage` on the journey, on each segment, and `coverage` on every step (`{unit, e2e, tests[]}`) — so the overlay draws the foot and the gutter with no second request | `core/query.ts` `journeySummary()`, `server` `enrichStep()` |
| MCP `test_coverage` | `flow:` or `node:` → tests with evidence; `gaps:true` lists uncovered steps; `describe_node` prints a *Verified by* block; `graph_overview` prints the tests freshness line | `mcp/src/run.ts` |
| CLI `farsight tests list \| matrix [--format csv\|json] \| import --results … --coverage …` | the P9 CSV artifact and a way to attach a report produced elsewhere (CI) to an existing graph without re-ingesting | `cli/src/cli.ts` |
| `farsight gate` | new `ChangeKind`s `test_added` / `test_removed` / `coverage_lost` (a flow or route that had ≥1 declared/static test and now has none) — pure graph, no run status, so the frozen `farsight-diff v1` grows by an additive kind under a version bump note | `core/diff.ts`, `docs/contracts/farsight-diff-v1.md` |

## 4. The three surfaces

### 4.1 Tests tab — `#/tests[/<testId>][?scope=&level=unit|e2e&flow=<flowId>&view=matrix|suites|orphans]`

Board **01**. The APIs-tab shape: a KPI strip whose numbers are metric chips (each with the ⓘ provenance popover, never a bare count), then **source cards** (*example-app · unit · vitest · 68 files · 412 cases · unit run 2026-09-08 · coverage report stale*) with an *Open* link, then the **Journeys × tests matrix**: one row per flow in scope with the e2e tests that declare it, the unit tests that reach its steps, the verified-end-to-end chip, the coverage meter, and the gap sentence (*"Resume draft (SCR-04) has no e2e test; 2 of 9 handler functions unreached"*). Rows link to `#/journeys/<flow>?band=code` and to the test detail. Two more views on the same data: **suites** (spec files → cases with verdict chips, filterable by level) and **orphans** (tests that cover nothing the graph knows, and declared ids that resolve to nothing).

Board **02** is the detail (`#/tests/<testId>`): the suite tree on the left with the selected case highlighted; the inspector on the right with *Story* (title, describe path, `@covers` as written, ADR/plan citations from the header prose), *Covers* (every edge grouped by evidence class with the ⧉ line link and a *Run journey* button when the target is a flow/screen), *Run* (status, duration, report ⧉, stale sentence). Business register renders the same panel with humanized names and the evidence classes spelled out (*"declared by the test author" · "inferred from what the test imports" · "observed when the test ran"*).

### 4.2 Journey coverage — the foot on every step, in every lens

Board **04**. In the business lens every business step card (today's segment; the action once the action-timeline pass lands) gets a **Verified by** foot: *end to end ✓ 3 tests · unit 7 tests · last passed 2 h ago* with an *Open in Tests* link that lands on the matrix filtered to this flow and step. A step with nothing is drawn with a dashed warning foot: *"No test reaches this step"*, never blank. Gates get the same chip inline. The header strip carries the journey's metric chip. In hybrid the foot is compact (chips only); in code it collapses to the gutter described next. Nothing here is computed client-side; it is `summary.coverage` from `/api/journey`.

### 4.3 The end-to-end code view — `rows | ladder | code`

Board **03**. The band toggle gains a third state, `code`, on the same key `l` (cycles), persisted in `fs-jrn-view`, deep-linked by `?band=code`. It restores the deleted pane as a band mode rather than a separate overlay: under the compact rail, every root of the step tree renders through `jrnSectionHtml` (Wallaby-style splice, fork markers, gates, contract cards for planned steps) in one scrolling column, with the screen's design thumbnail and business sentence as the sticky segment header so the reader always knows which screen the code belongs to. `j`/`k` walk sections; the seam card still opens its splice in place.

What is new in the pane is the **coverage gutter**: `jrnCodeSeg` paints a 3px bar per line from `step.coverage` (cyan = unit, amber = e2e, green = both, hatched = no evidence, dotted = report stale) and each section header carries the test chips (*unit ×3 · e2e ×1 ↗*) that open the test detail. Lines are coloured only from observed evidence; declared and static evidence colour the section header, not the lines, so a `@covers` claim never looks like an execution trace. The code lens is the natural home, but the view is available in every lens because business readers asked to "see the full process from the code side" too.

## 5. The reference app as the test bed — what has to change there

Nothing in the reference app's tests needs rewriting. Three small, reversible configuration steps make the observed class available; each is the reference app's decision and is listed, not made, here.

1. **Vitest:** add `reporters: ['default', 'json']` with `outputFile` and `coverage.reporter: ['json']` to the shared config block, and a root script `test:coverage` = `nx run-many -t test --coverage`. Output lands in the already-declared `coverage/<project>/coverage-final.json`.
2. **Playwright:** add `['json', { outputFile: 'test-results/results.json' }]` to `reporter`. For browser-side per-test coverage, a fixture in `e2e/helpers/coverage.ts` that calls `page.coverage.startJSCoverage()` / `stopJSCoverage()` around each test and writes `e2e/.coverage/<testId>.json` (Chromium projects only; the mobile project inherits). For server-side coverage, `NODE_V8_COVERAGE=e2e/.coverage/server` on the `webServer` command; Next dev serves source maps, so the v8 output converts with `c8 report --reporter=json`. Server-side is run-level; say so.
3. **Farsight config:** the `tests` block from §3.2 in the reference app's `farsight.config.json`, and drop `e2e/**` from the workspace source's `exclude` once the adapter claims test files.

Until step 1–2 land, the pass still shows declared + static coverage for all 18 e2e specs and 68 unit specs, which is already more than any consumer sees today.

The **invoice-app fixture** gains its own tests so the pass has a golden fixture that does not depend on a sibling checkout: `examples/invoice-app/test/invoiceService.test.ts` (node:test, imports `createInvoice`/`updateInvoice`/`finalizeInvoice` → static edges, one `@covers new-invoice` declared edge) and `examples/invoice-app/e2e/billing.pw.spec.ts` (a Playwright-shaped file that is parsed, not run: `@covers INV-01`, `page.goto('/invoices')`, `request.post('/invoices')`), plus a checked-in miniature `coverage-final.json` for one function so the observed path has a fixture too.

## 6. Passes

Each pass is a feature branch, conventional commits, `pnpm build && pnpm -r typecheck && pnpm -r test && pnpm lint:strings`, then re-pack + reinstall + restart 4477 + `/api/sync`, then a visual check of the reference app and invoice-app in three lenses and both themes.

### Pass 1 — tests in the graph (schema + adapter + fixture) · size M

**Files:** `core/src/graph.ts` (kinds, `TestRef`, `TestRun`), `parsers/src/tests/{index,cases,covers,reports}.ts`, `parsers/src/tsjs.ts` (hand claimed files to the adapter), `parsers/src/shared/docs.ts` (`@covers`), `parsers/src/index.ts` (post-pass + `options.tests`), `core/src/config.ts` (`tests` block), `examples/invoice-app/{test,e2e}/`, `parsers/test/tests.test.ts`, `docs/ANNOTATIONS.md` (`@covers` grammar).

**Acceptance:** invoice-app ingest yields `test` nodes with suite paths, declared edges resolving to `flow`/`design`/`route`/`function` ids, static edges with the documented confidence tiers, one observed edge from the fixture report, and an unresolved `@covers` kept on `declares`. The reference app ingest with `e2e/**` un-excluded produces zero `function` nodes from spec files, 18 e2e files → cases, every file-level `@covers` resolved to the design screen or flow node (`SCR-07.2` and `SCR-14c` are expected unresolved and must say so). `pnpm -r test` gains the fixture-backed parser test; every `covers` edge carries a `resolution`.

### Pass 2 — coverage facts on every existing surface · size M

**Files:** `core/src/metrics.ts` (`test-coverage`, id union widened), `core/src/query.ts` (`summary.coverage`, per-step `coverage`), `server/src/index.ts` (`/api/tests`, `/api/tests/<id>`, journey enrichment), `mcp/src/run.ts` (`test_coverage`, `describe_node` block, overview line), `cli/src/cli.ts` (`tests list|matrix|import`), `core/src/diff.ts` + `docs/contracts/farsight-diff-v1.md` (additive kinds, version note), `compliance.yml` (an `announce-coverage-loss` warn rule for dogfood), `core/test/{metrics,journey-coverage,diff}.test.ts`.

**Acceptance:** `farsight tests matrix --format csv` is the P9 artifact; MCP `journey` prints a one-line coverage summary per segment and `test_coverage flow:invoice-submission gaps:true` lists uncovered steps by id; `gate` fails a fixture diff where a flow lost its last test; no endpoint returns a percentage without `scopeLabel` and `evidence`.

### Pass 3 — the Tests tab + the journey foot · size M

**Files:** `public/app/surfaces/tests.js` (new), `shell.js` (`NAV`, `SURFACES`), `viewer.html` (landing option, CSS for meter/chips/foot, light-theme tokens), `core/src/strings.ts` (`nav.tests`, `tests.*`, `journey.verifiedBy`, `journey.noTest`, evidence-class defines), `keymap.js` (no new keys), `scripts/lint-strings.mjs` (`CHROME_FILES`), `surfaces/journeys.js` (`jrnBizCellHtml` foot, header chip), `docs/GETTING-STARTED.md`.

**Acceptance:** boards 01, 02, 04 reproduced on the reference app at 1920×1080 and readable at 1280×720; every number opens its provenance popover; the matrix row → journey → *Open in Tests* → matrix round trip preserves scope and filter; `lint:strings` passes with the jargon budget; the business register never shows a file path outside the ⧉ link.

### Pass 4 — the end-to-end code view with the coverage gutter · size M

**Files:** `surfaces/journeys.js` (`jrnCodeViewHtml` over `jrnSectionHtml`, three-state `jrnToggleView`, gutter in `jrnCodeSeg`, section test chips), `keymap.js` (`key.l` copy), `viewer.html` (`.jrn-gut*`, sticky segment headers), `core/src/strings.ts` (`journey.bandCode`, gutter legend), `a design reference` (built screenshots beside the boards, the system-band precedent).

**Acceptance:** board 03 on the reference app submission journey and on invoice-app *Invoice list*; the whole walk renders end to end with no per-marker clicking; the gutter colours only from observed edges and the stale state is visibly dotted; `?band=code&test=<id>` highlights one test's path; performance stays acceptable on the 251-step depth-30 the reference app walk (virtualize sections beyond a budget, with the *▾ n more* fold the ladder already uses).

### Pass 5 (optional) — observed per-test attribution and CI import · size S–M

`farsight tests import` accepting junit/CTRF from a CI artifact; the Playwright coverage fixture published as a snippet in `docs/ANNOTATIONS.md`; a GitHub Action recipe that uploads reports and runs `farsight gate` against the previous snapshot.

## 7. Acceptance scenarios (the boards, in words)

| Scenario | Required visible result |
|---|---|
| Open `#/tests` on the reference app scope | Source cards for unit and e2e with counts, last run, and a freshness sentence; a matrix with one row per flow; rows with zero tests are present and say so |
| The reference app `invoice-submission` row | e2e tests listed by title (`create → upload → edit → attach → submit …`, `a second submit of the same draft is a 409`, …); unit tests reaching its steps (`wizard-state.spec.ts`, `submissions.spec.ts`); verified-e2e ✓; SCR-04 flagged as declared-only if no `page.goto('/submit/…')` test exists |
| Click a test | Detail with `@covers` as written, resolved targets by evidence class, ⧉ to the spec line and to each target, *Run journey* on the flow |
| Business lens journey | Every step card has a *Verified by* foot or a dashed *No test reaches this step*; gates carry the chip; header chip opens the metric popover |
| `l` twice on a journey | `rows → ladder → code`: the end-to-end spliced code with gutter and section test chips; `?band=code` reproduces it |
| Report older than code | Gutter dotted, chip *stale*, sentence names the report and the newer file; `graph_overview` repeats it |
| No reports configured | Declared + static evidence only, stated in the tab, the overview, and the journey header; no line colouring at all |
| Orphan `@covers CON-99` | Listed under orphans with the file:line and *"nothing in the graph matches"* |
| `gate` after deleting a flow's only test | `coverage_lost` fires the dogfood warn rule; `diff --format sarif` carries it |

## 8. Boundaries and risks

- **Not a test runner.** Farsight reads results and coverage; it never executes tests. A *Run* button is out of scope for every pass.
- **Not a trace.** Observed coverage says a line executed during a run, not that a specific business path was exercised; the UI says *reached*, never *verified*, for observed-only evidence. Declared evidence says what the author claims; static evidence says what the test touches.
- **Attribution honesty.** Istanbul coverage is run-level; the run node exists so the edge has a truthful source. Do not spread a run's coverage across the cases in the run.
- **Schema growth is additive** and the diff contract changes only by new kinds under a recorded version note. Old graphs without `test` nodes load unchanged; the Tests tab then shows the *no tests indexed* state.
- **Performance.** the reference app's 412 unit cases × static edges are small; observed edges from a full-repo istanbul report are the large input (one edge per reached function, not per line; line hits stay in `meta.lines`). Budget the adapter at the same order as the OpenAPI post-pass.
- **Test files as source.** Claiming spec files changes graphs that included them before (fewer stray `function` nodes); `diffGraphs` will report `node_renamed`/removals on the first sync after Pass 1. Note it in the handoff and the ROADMAP line.
- **Other stacks.** Java/Spring fixtures (`spring-invoice-api`) get JUnit XML + JaCoCo XML support through the same `tests` config block in a later pass; the adapter's report readers are format-keyed so this is additive.

## 9. Decision to take next

Build Pass 1 and Pass 2 together on one branch (`feat/tests-in-graph`): the schema, the adapter, the metric, the endpoints, MCP and CLI. That alone makes coverage answerable for agents and for `gate`. Then Pass 3 (tab + foot) and Pass 4 (code view + gutter) on a second branch (`feat/tests-surface`) once the boards are approved as the acceptance spec. Ask the reference app for the two reporter lines before Pass 2 so the observed class can be validated on real reports rather than only on the invoice-app fixture.
