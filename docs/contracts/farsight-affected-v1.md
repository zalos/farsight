# farsight-affected v1 — a change placed on the journeys

**Status:** FROZEN 2026-10-10 · **Schema:** [`schemas/farsight-affected-v1.schema.json`](../../schemas/farsight-affected-v1.schema.json) · **Implementation:** `packages/core/src/affected.ts` (`affectedRange`) · **Tests:** `packages/server/test/affected-range.test.ts` · **Design:** [round-2026-10-10.md](../proposals/round-2026-10-10.md) proposal 6

What a commit range or a pull request touches, in the product's own terms: the parts its changed lines sit in,
the journeys (and their storyline step) whose walk runs them or what uses them, the gates, record writes and
calls on **the changed path**, and the test cases that reach any of it — **each case once**, with its own last
run. `farsight affected --from <sha> --to <sha> --json` and `farsight affected --pr <n> --json` print it; the
pull-request comment, the check and MCP `affected` are views over the same document.

## Freeze rules

- Everything named here keeps its name, type and meaning while `schema` says `farsight-affected v1`.
- v1 may **gain optional fields** and **gain enum members**; it never loses or repurposes one. Consumers ignore unknown fields.
- A breaking change ships as `farsight-affected v2` with a migration note.
- The schema is normative for shape, this document for meaning. The test validates real output against the
  schema and pins every closed enum (`AFFECTED_RANGE_KINDS`, `AFFECTED_GRANULARITY`, `AFFECTED_GATE_KINDS`,
  `AFFECTED_CONTRACT_STATUS`, `AFFECTED_RUN_STATUS`, `AFFECTED_EVIDENCE`, `AFFECTED_VERDICT_CLASS`,
  `AFFECTED_TEST_LEVELS`, `AFFECTED_TEST_RUNNERS`) to an explicit literal list in both places.

## What it may claim

| it says | it means |
|---|---|
| `changed[]` | the definitions a changed line **starts in or sits under** (`nodesTouched`, the commit spine's rule). The graph records where a part starts, not where it ends, so this is a floor; `files[].granularity` says `lines`, `file` (no hunks: every part of the file) or `none` (the file defines nothing indexed) |
| a journey at `hop: 0` | its walk runs a changed part itself — not a distance, a fact about the walk |
| a journey at `hop: n` | its walk meets something the impact reports list `n` edges from a changed part. Reachability, never consequence |
| **the changed path** | the actions (moments) of a hop-0 journey whose own steps run a changed part. `gates`, `writes` and `contracts` are what those actions meet, plus any gate or call that changed itself (`changed: true`) |
| `writes[].moves` | the status moves the record's lifecycle records **for that writer** (`from` only when the writer compares the prior status) |
| `tests[]` | every case that covers a changed part (`hop: 0`), a case whose own file changed (`hop: 0`), or a case that covers what uses one (`hop: n`) — each once, at its nearest hop; `status` and `at` are **its own** last run. Whole-run coverage reports are counted in `run_level`, never listed as cases |
| `verdict` | `testVerdict()` over those cases — the one verdict every surface prints: the evidence class and catalog key, every case by its own last run (the parts sum to `tests.length`), the newest run, and the head's commits after it (`commits_since`, null when the history or a run is unknown) |
| `select` | the active cases with a file, by runner — the `farsight-impact-tests v1` shape, so a CI job runs them |
| `bound: "floor"` | a hunk was credited by file, a changed code file defined nothing indexed, an impact report was cut, or more than `AFFECTED_MAX_SEEDS` parts changed |

It may not say a test **proves** a change, that the change **breaks** anything, or add counts across hops.
Every number in `counted` is a `Counted` scoped `count.scope.affected` (docs/COUNTS.md § Affected).

## Envelope (abridged)

```jsonc
{
  "schema": "farsight-affected v1",
  "identity": { /* the farsight-tests-matrix v1 identity block */ },
  "range": { "kind": "pr", "repo": "invoice-app", "from": "main", "to": "fix/send", "pr": { "number": 48, "title": "…", "url": "…", "base": "main", "head": "fix/send", "host": "github" } },
  "commits": [{ "sha": "…", "subject": "fix(invoices): …", "at": "…", "author": "dev" }],
  "files": [{ "path": "src/server/invoiceService.ts", "status": "M", "parts": 1, "granularity": "lines" }],
  "changed": [{ "id": "invoice-app::src/server/invoiceService.ts::finalizeInvoice", "name": "finalizeInvoice", "kind": "function", "file": "…", "line": 58 }],
  "journeys": [{ "id": "invoice-app::flow::billing-cycle", "name": "Billing cycle", "hop": 0, "by": "…finalizeInvoice",
                 "storylines": [{ "id": "invoice", "name": "An invoice, end to end", "step": 2, "of": 2, "branch_of": null, "when": null }],
                 "screens": [{ "id": "invoice-app::page::/invoices", "name": "Invoice list", "segment": 1, "hop": 0 }] }],
  "gates": [{ "id": "…", "name": "requireScope: billing:admin", "kind": "guard", "tier": null, "changed": false, "journeys": ["…"] }],
  "writes": [{ "id": "invoice-app::table::invoices", "name": "invoices", "store": "Invoice DB", "writer": "…", "writer_name": "finalizeInvoice", "moves": [{ "from": null, "to": "open" }], "journeys": ["…"] }],
  "contracts": [{ "id": "…", "name": "POST /invoices/:id/finalize", "method": "POST", "path": "/invoices/:id/finalize", "contract": "code-only", "changed": false }],
  "tests": [{ "id": "…", "title": "finalizeInvoice assigns a number…", "file": "test/invoiceService.test.ts", "line": 21, "level": "unit", "runner": "node:test",
              "project": "default", "evidence_class": "reached", "status": "skipped", "at": "…", "hop": 0, "inactive": false }],
  "run_level": 0,
  "verdict": { "class": "reached", "word": "journey.evidence.reached", "passed": 0, "failed": 0, "skipped": 1, "flaky": 0, "no_run": 0, "last_run": "…", "commits_since": 2 },
  "select": { "node:test": [{ "file": "test/invoiceService.test.ts", "title": "…", "project": "default" }] },
  "counted": { "commits": {…}, "files": {…}, "changed": {…}, "journeys": {…}, "screens": {…}, "gates": {…}, "writes": {…}, "contracts": {…}, "tests": {…} },
  "bound": "floor",
  "notes": []
}
```

`gates[].tier` reads the gate's tier (business · policy · technical) when the graph carries one; `null` otherwise.
