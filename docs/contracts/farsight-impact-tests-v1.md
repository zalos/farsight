# farsight-impact-tests v1 — the change-impact and test-selection contract

**Status:** FROZEN 2026-09-24 · **Schema:** [`schemas/farsight-impact-tests-v1.schema.json`](../../schemas/farsight-impact-tests-v1.schema.json) · **Implementation:** `packages/core/src/impact.ts` (`impactOf`, `impactTestsV1`) · **Tests:** `packages/core/test/impact.test.ts` · **Design:** [dependency-impact.md](../proposals/dependency-impact.md) §5

This is the machine-readable half of the impact answer: **what uses the changed code, by distance**, which tests a CI job can run for it, and the reasons it must not trust that list. `farsight impact --tests --format json` prints it; the MCP answer, the inspector tab and the business sentence are views over the same fold, so a pipeline and a screen can never disagree about what a change touches.

It is versioned the way `farsight-diff v1` and `farsight-tests-matrix v1` are, and for the same reason: a job that selects tests from it is a consumer, and a UI change must not silently redefine what its fields mean.

## Freeze rules

- Everything named here keeps its name, type and meaning for as long as `schema` says `farsight-impact-tests v1`.
- v1 may **gain optional fields** and **gain enum members**; it never loses or repurposes one. Consumers must ignore unknown fields.
- Any breaking change ships as `farsight-impact-tests v2` with a migration note.
- The JSON Schema is normative for shape; this document is normative for meaning. `packages/core/test/impact.test.ts` holds both to real output, and pins every closed enum against the exported constant the code switches on (`IMPACT_CUT_REASONS`, `IMPACT_UNSELECTABLE_REASONS`), so the contract and the union cannot drift apart.

## What this document may claim, and what it may not

| it says | it means |
|---|---|
| a node at `hop: 1` | **one edge** connects it to the seed: it reads, writes, calls, guards or renders it. `edge.kind` is that verb |
| a node at `hop: 2+` | a **path** exists — the graph gets from there to here. Not a prediction, and never a claim that a change travels along it |
| `strength` | how well that path is **recorded**, not how likely the dependency is |
| `cut` | what the walk did **not** look at, by reason. What the reader has not seen is part of the answer |
| `bound: "floor"` | every count in the document is a lower bound, for the reasons in `cut`, `strength.unstamped` and `one_of` |

It may not say that a change **propagates**, that **data** travels (Farsight follows calls, not fields), or that an unstamped edge is a weak one. There is no total across hops: `9 direct` and `15 through those` answer different questions, and adding them produces the haystack this design replaces.

## Envelope

```jsonc
{
  "schema": "farsight-impact-tests v1",
  "identity": { /* the farsight-tests-matrix v1 identity block, verbatim */ },
  "seeds": [{ "id": "example-app::…::submitDraftInvoice", "name": "submitDraftInvoice: submit readiness",
              "kind": "guard", "from": "hunk",
              "hunk": "apps/api/src/submissions.ts:930-975" }],
  "hops": [{ "hop": 1, "nodes": [{
      "id": "…", "name": "POST", "kind": "route", "file": "…/submit/route.ts", "line": 24,
      "edge": { "kind": "calls", "technique": "static-import", "confidence": "HIGH" },
      "strength": { "tier": "HIGH", "unstamped": 0, "hops": 1 },
      "one_of": null,
      "tests": [{ "id": "…", "title": "submits a draft", "file": "…", "line": 12, "level": "unit",
                  "runner": "vitest", "project": "apps/api",
                  "evidence_class": "observed", "technique": "coverage-report", "confidence": "HIGH",
                  "run_level": false, "inactive": false }] }] }],
  "select": { "vitest": [{ "file": "…", "title": "…", "project": "…" }],
              "playwright": [{ "file": "e2e/tests/api/invoice-submission.pw.spec.ts", "title": "…", "project": "api" }] },
  "unselectable": [{ "node": "…", "name": "POST", "reason": "no covers edge" }],
  "fallback": "run-all",
  "fallback_reason": "run the whole suite: 3 of the changed things and their direct dependents have no test a job could name and run",
  "excluded": { "setup": ["…"], "deferred": ["…"] },
  "cut": [{ "reason": "hops", "node": "…", "name": "…", "behind": 79, "direct": 6, "hop": 2 }],
  "bound": "floor"
}
```

### `identity`

The `farsight-tests-matrix v1` identity block, unchanged: `sync` and `source_commit` are absent when the graph records none, `source_digest` maps repo → the content digest of that checkout and is `{}` when nothing recorded one, `farsight` is the build that produced the document, and `generated_at` is the only field that moves between two runs over one graph.

### `seeds`

What the question was asked about. `from: "node"` means a node was named; `from: "hunk"` means a changed file range resolved to it, and `hunk` is that range. Hunk resolution is **file-and-line** granularity and inherits H4's caveat verbatim: the commits that touched a file are not the commits that changed a function, and only one of those is knowable.

### `hops`

One entry per distance, nearest first, holding the nodes at that distance **across every seed** — a node that is hop 1 of one seed and hop 3 of another is listed once, at hop 1, because the nearest claim is the one that has to be evidenced. A seed is never listed as its own dependent.

- **`edge`** — the edge that reached the node, and how it was resolved. `technique` and `confidence` are `null` when the adapter recorded none. That is an **absence of provenance about the edge**, not an absence of the edge and not a low confidence: the four classes B5.1 deliberately leaves unstamped include a call to a function literal written in place, which is certain.
  *(Additive, 2026-09-30.)* `edgeKind` gained `tracks` (a work item → what it is about, docs/proposals/work-items-sync.md §9) so the enumeration stays the graph's own. The walk never follows a `tracks` edge — a work item is a fact about the code, not a dependent of it — so no v1 document carries one today; the member is there so a consumer's switch matches the schema.
- **`strength`** — a **pair**: `tier` is the weakest tier actually recorded on the path (`null` when nothing on it recorded one) and `unstamped` counts the edges on it that recorded nothing. They are never collapsed into one ladder. `hops` is the length of the path, which equals the node's hop.
- **`one_of`** — the call site resolves to several implementations and the code chooses at run time. Counting all of them overstates and counting one understates, so the fact is carried and never folded away.
- **`tests`** — every `covers` edge landing on the node. `evidence_class` is the printed vocabulary (`declared` · `reached` · `observed`); the graph stores `static` and every consumer reads *reached*. `run_level: true` is a report, not a test: the honest sentence is "the unit run reached this", never "this test reaches it". `inactive: true` is a `.skip`/`.todo` case — listed, and it lifts nothing.

### `select`

The tests a job can name and run, over **every node in the document and the seeds themselves** — an active, named case in a file, never a run-level report and never a skipped one. One key per runner seen (`vitest`, `playwright`, …); a runner this graph holds none of has **no key**, and an absent key is not an empty suite.

**`select` is a floor whenever `bound` is `floor`.** A selection computed over a cut, unstamped or ambiguous neighbourhood is not a complete set, and a CI job may not treat it as one.

### `unselectable` and `fallback`

`unselectable` lists the **seeds and their direct dependents** that yield no test a job could name and run. Its `reason` is closed:

| reason | when |
|---|---|
| `declared only` | a route declared in a spec and not built — nothing runs it, so nothing can test it |
| `no covers edge` | nothing claims, reaches or observed it |
| `inactive` | every covering case is `.skip`/`.todo` |
| `run-level only` | only a whole-run coverage report reached it. A report proves the run executed the code and **cannot name a case to re-run**; selecting nothing for it would be a silent under-run |

A node **no test could cover** is not listed at all: a table, a queue or a third party is not a testable thing, and calling it a gap would invent one. That judgement is `isCoverable` from `packages/core/src/metrics.ts` — the same predicate every coverage denominator uses, so the gate and the denominator cannot disagree.

`fallback` is `"run-all"` or `null`, **never implied and never omitted**. It is `"run-all"` when any entry of `unselectable` exists, when a `hops` cut sits at hop 1 (the direct dependents are not all known), or when the caller states the graph no longer matches the working tree. `fallback_reason` carries the sentence behind it and is `null` exactly when `fallback` is.

The gate an SDET asked for is `unselectable | length == 0`: every changed thing and every direct dependent has at least one runnable test.

### `excluded`

Node ids reached **only** across an edge the walk does not cross: `setup` (the container boot — `meta.origin: 'setup'`; the boot is not a dependent) and `deferred` (work registered here and run later by something else). Named apart, never summed into a hop. A node that the walk also reached on a path of its own is a dependent and is not listed here.

### `cut`

Where the walk stopped, by reason — `hops` · `shared` · `setup` · `deferred` · `cap`. `node`/`name` are absent for `cap`, which is a fact about a **hop** and not about any one node.

- **`behind`** — everything upstream of the stop that the document does not list. **Never add two of these**: cut points routinely sit in front of the same ancestors, so the sets overlap. Each number answers "how much more is behind *this* one".
- **`direct`** — the first ring only: unlisted nodes one edge behind the stop. *"`cx` is shared by 39"* is `direct`; *"everything behind `cx`"* is `behind`. A surface that prints one must not label it with the other's words.

`shared` is the stop for a node tagged `plumbing` or a rendered UI primitive — the same nodes the coverage denominator excludes, because a node with 39 direct dependents is a utility and expanding it reports the application rather than the change.

## The CI use case

```sh
farsight impact --changed $(git diff --name-only origin/main...) --hops 2 --tests --format json > impact.json
jq -r '.fallback_reason // empty' impact.json   # non-empty ⇒ run the whole suite, and say why
jq -r '.select.vitest[].file' impact.json | sort -u | xargs vitest run
jq -r '.select.playwright[].project' impact.json | sort -u | sed 's/^/--project=/' | xargs playwright test
```

A job that treats an empty `select` as "nothing to run" is reading the document wrong: check `fallback` first, then `bound`.

## Determinism

`impactOf` sorts every hop by name, then by id, and relaxes path strength with a deterministic tie-break, so the same graph in any insertion order produces the same report; `impactTestsV1` sorts nodes by id and select entries by file then title. `identity.generated_at` and `asOf.generatedAt` are the only fields that move between two runs over one graph. `packages/core/test/impact.test.ts` asserts it by rebuilding the index from reversed node and edge arrays.

## Relationship to the other contracts

- **`farsight-diff v1`** is unchanged by this document. `technique` and `confidence` are the same `ResolutionTechnique` and `ConfidenceTier` values that contract enumerates; `tier` here adds `null`, which the diff contract has no use for because a change with no stamped edge simply carries no technique.
- **`farsight-tests-matrix v1`** owns the whole journeys × tests picture; this document owns one change's neighbourhood. `identity` is shared verbatim so an artefact from each can be joined, and `evidence_class` carries the same three words with the same meanings.
