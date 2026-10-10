# farsight-tests-matrix v1 — the journeys × tests contract

**Status:** FROZEN 2026-09-22 · **Schema:** [`schemas/farsight-tests-matrix-v1.schema.json`](../../schemas/farsight-tests-matrix-v1.schema.json) · **Implementation:** `packages/core/src/tests.ts` (`testsMatrixRows`, `testsMatrixV1`, `testsMatrixCsv`, `testsIdentity`) · **Tests:** `packages/core/test/coverage.test.ts`

The matrix is the machine-readable half of the tests surface: **one flat row per (flow, node, test, covers edge)**, with the evidence class, the run and the identity of the code it was computed from. `farsight tests matrix --format json|csv` and `GET /api/tests/matrix` print this document; the Tests tab, MCP `test_coverage` and the journey foot are views over the same fold, so a CI artefact and a screen can never disagree about what is covered.

It is versioned the way `farsight-diff v1` is, and for the same reason: a CI job that selects tests or a spreadsheet that tracks coverage is a consumer, and a UI change must not silently redefine what its columns mean.

## Freeze rules

- Everything named here keeps its name, type and meaning for as long as `schema` says `farsight-tests-matrix v1`.
- v1 may **gain optional fields** and **gain enum members** (`technique` is an open string for exactly that reason); it never loses or repurposes one. Consumers must ignore unknown fields.
- Any breaking change ships as `farsight-tests-matrix v2` with a migration note.
- The JSON Schema is normative for shape; this document is normative for meaning. `packages/core/test/coverage.test.ts` holds both to a real example.

## Envelope

```json
{
  "schema": "farsight-tests-matrix v1",
  "identity": {
    "sync": 41,
    "source_commit": "4677268",
    "source_digest": { "example-app": "9f2c1ab77d04" },
    "farsight": "farsight 0.1.0 · built 2026-09-22T09:00:00.000Z · commit 8d121e2 · workspace",
    "generated_at": "2026-09-22T09:04:11.000Z"
  },
  "metric": { "def": { "id": "test-coverage", "version": 2 }, "value": 0.62, "bound": "floor", "scopeLabel": "…", "numerator": 99, "denominator": 160 },
  "journeys": [ { "flowId": "…", "name": "Submit an invoice", "screens": 3, "built": 3, "e2e": "reached", "gap": "…" } ],
  "rows": [ { "flow_id": "…", "…": "…" } ]
}
```

- **`identity`** — what the document was computed from. `sync` and `source_commit` are absent when the graph records none; `source_digest` maps repo → the content digest of that checkout (`parsers/shared/files.ts` `contentDigest`), and is `{}` when nothing recorded one — which is also why a run's `freshness` can only read `unknown`. `generated_at` is the only field that changes between two runs over the same graph.
- **`metric`** — the `test-coverage` `MetricValue` for the scope, carried whole so a consumer never recomputes a percentage. Its shape is owned by `packages/core/src/metrics.ts` and carries its own `def.version`; **this contract freezes that the value is present with its scope label, not the internals of `MetricValue`**. A value produced under an older metric version is not comparable with a newer one — `definitionChanged` on the value says so.
- **`journeys`** — one `TestMatrixRow` per flow: the same rows the catalogue and the HUD read (screens, built, the coverage facts, the declared / inferred / observed lists, the `e2e` word and the gap sentence).
- **`rows`** — the matrix proper, below.

## One row per (flow, node, test, covers edge)

The node set of a flow is **the one journey scope** (`coverage.ts` `journeyScope`: the entry, the flow's *full* screen list, every step of the walk and every gate met). It is the same list the denominator is computed from, so the rows on a journey and the number printed beside it can never come from different sets (README, "one denominator per scope").

A node with no `covers` edge produces **no row** — absence is a gap, and gaps are named in `metric.gaps` and in `journeys[].gap`, not as empty rows.

| column | meaning |
|---|---|
| `flow_id` · `flow_name` | the flow this row is about |
| `screen_id` | the design id of the screen when the node is one of the flow's screens (the node id when the screen has none), `''` otherwise |
| `node_id` · `node_kind` · `node_name` | the node the test's edge lands on |
| `test_id` · `file` · `line` · `suite` · `title` | the test case; `suite` is the describe path outermost first, joined with ` > `; `line` is `null` for a run-level node |
| `level` · `runner` · `project` | `unit \| integration \| e2e`; the runner; the Playwright / Nx project (`''` when the runner records none) |
| `run_level` | the edge came from a coverage report with no per-test attribution: **the run reached it, no single test did** |
| `inactive` | the case is `.skip`/`.todo` (or the edge is marked inactive): it is listed, and it lifts no word and no chip |
| `evidence_class` | `declared` · `reached` · `observed` — **the printed vocabulary** |
| `technique` · `confidence` · `resolution_note` | the covers edge's resolution (`ResolutionTechnique` from `farsight-diff v1`), `''` when the edge carries none |
| `match` | observed edges only: how the coverage row met the node — `name+line` · `name` · `line±1` |
| `run_id` · `run_at` · `status` · `retries` · `duration_ms` | the run behind this case; `''`/`null` when it has never run |
| `freshness` · `stale` | `unchanged` · `changed` · `unknown`; `stale` is `null` when freshness is `unknown` |
| `source_digest` · `sync` · `source_commit` | `identity`, repeated so a CSV row taken out of the file still says which code it describes |
| `evidence_word` · `verdict` | *added 2026-10-10, additive, appended after every v1 column* — the case's own word on this node and the run behind it, **exactly as the screen prints them** (see below) |

### The words, and what they are not

- **`evidence_class` is the printed vocabulary, not the graph's field.** The graph stores `declared | static | observed` on a `covers` edge; `static` prints as **`reached`** everywhere a person or a CI job reads it. *Declared* is an `@covers` claim by the test's author. *Reached* is a body signal — what the test imports, renders or requests. *Observed* is a run that executed the node. A claim is never rendered as an observation.
- **`run_level: true` is a report, not a test.** The row's `test_id` is the synthetic node a coverage report hangs off; the honest sentence is "the `unit` run reached this", never "this test reaches it".
- **`stale: null` is not `false`.** `unknown` freshness means no source digest was recorded, so whether the code changed since the run cannot be answered. "Not stale" and "not proven fresh" are different facts and this contract keeps them apart. The CSV prints the null as `unknown` — never as `false`.
- **`status: "flaky"` is its own verdict.** The reporter retried and the case then passed; it is not `passed` and never prints as one.
- **`inactive` rows are kept.** A skipped case is a fact about the suite; dropping it would make the matrix flatter and less true.

### `evidence_word` and `verdict` — the screen's words (added 2026-10-10)

`evidence_class` is the edge's class, and two of its rows read differently on screen: a declared end-to-end case
whose last run passed is *passed, by its own declaration* (the edge still says `declared`), and an `observed` row
from a coverage report is *seen by a coverage run* (its `status` is `unknown`: a coverage report records no
verdict). A consumer that wants the screen's words reads the two appended columns instead of re-deriving them:

| `evidence_word` | when | `verdict` |
|---|---|---|
| `declared only` | an `@covers` claim, nothing ran | `''` |
| `reached by tests` | a test body imports, renders or requests it | `''` |
| `verified by a run` · `verified · stale` | a results report named the case and coverage placed it here | the case's run status |
| `passed, by its own declaration` · `… · stale` | a declared e2e case whose last run passed | `passed` |
| `seen by a coverage run` · `… · stale` | a coverage report with no case named (`run_level`) | `''` |

`· stale` is the case's run on a commit the code has moved past (`freshness = changed`). The word is core
`caseWord()` in the professional register, the same word the Tests page prints beside each case of a scoped cell
and the Map property prints on each case row. `verdict` is `status` only where a named case's run earned the
word — a claim, a reading or a coverage report has no verdict beside it; the case's own run stays in `status`.
Both enums are pinned by `packages/core/test/scope-words.test.ts` against this schema.

## Determinism

`rows` is sorted by **every column, in the order of the table above** (`TESTS_MATRIX_COLUMNS` in `tests.ts`): absence first, numbers numerically, strings by code unit — never by locale. The same graph and the same reports therefore produce byte-identical `rows`, so a CI job can diff two matrices and see only what actually changed. `identity.generated_at` is the single field that moves between two runs over one graph.

## CSV

`--format csv` prints `TESTS_MATRIX_COLUMNS` as the header and one line per row, in the same order, RFC-4180 quoted. It carries no `identity` block of its own — that is why `source_digest`, `sync` and `source_commit` are row columns. `null` prints as `unknown` for `stale` and as an empty field elsewhere.

One printer produces it (`testsMatrixCsv` in `packages/core/src/tests.ts`), so `farsight tests matrix --format csv` and `GET /api/tests/matrix?format=csv` are the same bytes for the same graph — the CLI adds the trailing newline `console.log` adds, the HTTP body ends with its last row.

## Relationship to the other contracts

- `technique` draws from the same `ResolutionTechnique` set as [`farsight-diff v1`](farsight-diff-v1.md); that document enumerates the members.
- `farsight-impact-tests v1` (planned, `the clarity-phase plan` §2.8) reuses this document's `identity` block verbatim.
