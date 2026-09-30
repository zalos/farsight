# farsight-diff v1 — the frozen change contract

**Status:** FROZEN 2026-07-29 · **Schema:** [`schemas/farsight-diff-v1.schema.json`](../../schemas/farsight-diff-v1.schema.json) · **Implementation:** `packages/core/src/diff.ts` · **Golden fixtures:** `packages/core/test/fixtures/`

This document is versioned **before** any UI renders it (Anna's ADOPT condition, v3 plan §2.6). The Changes surface (P6) and CI integrations are views over this JSON; a UI change can never silently redefine it.

## Freeze rules

- Everything named here keeps its name, type, and meaning for as long as `schema` says `farsight-diff v1`.
- v1 may **gain optional fields** (consumers must ignore unknown fields); it never loses or repurposes one.
- Any breaking change ships as `farsight-diff v2` alongside a migration note; v1 output remains producible for one minor-release cycle after that.
- The JSON Schema is normative for shape; this document is normative for meaning. The golden fixture test (`packages/core/test/diff.test.ts`) holds both to a real example.

## Envelope

```json
{
  "schema": "farsight-diff v1",
  "base": "sync:39 · 76f7674",
  "head": "sync:41 · 4677268",
  "truncated": false,
  "counts": { "route_added": 1, "...": 0 },
  "changes": [ { "id": "c1", "...": "..." } ],
  "gate": { "policy": "compliance.yml", "result": "fail", "exit": 1, "rules": [] }
}
```

- **`base` / `head`** — human-readable snapshot labels: `sync:<N>` plus ` · <7-char commit>` when the snapshot recorded one. Machine identity is in the permalinks and in the snapshot store; these strings are for reading.
- **`truncated`** — `true` when `changes` was cut at the limit (default 500, caller-settable). **`counts` is always complete**, truncated or not — CI can assert on completeness without carrying every change. `farsight gate` never truncates: the verdict judges every change.
- **`counts`** — every change kind present, zeros included. A missing key is a schema violation, not an implied zero.
- **`gate`** — present only after a policy was applied (see below). The diff itself never carries judgment.

## Change kinds (closed set)

Only these eighteen kinds exist in v1 (fourteen frozen 2026-07-29 plus four added 2026-09 — see the version note below). Graph changes outside this set (a function's body changed, docs changed, …) do **not** appear in the diff — the contract reports contract-level surface, not churn.

| kind | fires when | severity | subject |
|---|---|---|---|
| `route_added` | a `route` node appears | notable | the route |
| `route_removed` | a `route` node disappears | breaking | the route |
| `guard_added` | a `guards` edge appears | info | **the protected node** (the audit question is "which endpoint gained/lost a gate", not "which guard") |
| `guard_removed` | a `guards` edge disappears | breaking | the formerly protected node |
| `journey_changed` | the ordered hop sequence of an entry's `journey()` walk differs between base and head (structural, not textual) | notable | the entry node; `journey` carries `{id, name}` |
| `record_added` | a `table` node appears | info | the table |
| `record_removed` | a `table` node disappears | breaking | the table |
| `record_columns_changed` | a `table` node's column signature changes | notable | the table |
| `message_added` | a `queue` node appears | info | the topic |
| `message_removed` | a `queue` node disappears | breaking | the topic |
| `rule_added` | a `rule` node appears | info | the rule |
| `rule_removed` | a `rule` node disappears | notable | the rule |
| `edge_confidence_changed` | an edge's `resolution.confidence` tier changes | info | the edge's target node |
| `node_renamed` | same node id with a new display name, **or** a removed+added pair of the same non-surface kind (`function`/`component`/`class`/`page`/`module`/`file`) at the same `repo/path:line` | info | the node under its new name |
| `test_added` | a `test` node appears | info | the test case |
| `test_removed` | a `test` node disappears | notable | the test case |
| `coverage_lost` | a `route`, `page` or `flow` that still exists had ≥1 `covers` edge in base and has none in head | notable | the node that lost its last test |
| `uncovered_change` | a `function`/`component`/`page`/`route`/`guard`/`rule` whose body changed (signature, snippet or branches) and which no `covers` edge reaches in head — only when the head graph indexes tests at all | info | the changed node |

Notes:

- **Severity is a fact of this table**, fixed per kind — not a per-diff judgment. Judgment (pass/fail) belongs to the policy file.
- **Journey entries** are nodes with `kind === 'route'` or an `entrypoint` tag, present in both snapshots. In v1 the structural identity is the hop sequence (`via:nodeId` in order) of `journey()`; when `journeySummary()` lands (P5) the comparison upgrades to its step list — same kind, same meaning, stated here so the upgrade is not a silent redefinition.
- A guard node appearing with no `guards` edge emits nothing — a gate that guards nothing is not a contract change.

### Version note — 2026-09, tests in the graph

`test_added`, `test_removed`, `coverage_lost` and `uncovered_change` were added to the closed set on 2026-09-14 (docs/proposals/tests-surface.md Pass 2, with the adjustments of a review §3-C). This is the additive growth v1 allows: no existing kind changed name, type, severity or meaning, and `counts` still carries every kind with zeros included — a consumer that only knows the first fourteen simply sees four extra count keys and, if it enumerates `changes`, four kinds it can ignore. Consumers that pin the JSON Schema must take the 2026-09 revision to validate a diff produced by this build or later.

Two honesty rules travel with them:

- **`coverage_lost` is pure graph.** It says a surface no longer has any `covers` edge — declared, inferred or observed. It says nothing about whether a test passed; run status is not part of the diff contract.
- **`uncovered_change` never fires on a graph with no tests indexed.** A repo that has not been ingested with its spec files would otherwise report every changed function as uncovered, which is noise, not a finding.

The `nodeKind` enum also gained `api`, `design`, `flow` and `test` — the kinds the OpenAPI, design and tests passes emit. The work-items pass (2026-09-30) adds `work`: a work item from a tracker (`work::<sourceId>::<key>`, no `loc`). A `subject.kind` outside the original list was already possible in practice; the schema now says so.

## Per-change fields

```json
{
  "id": "c2",
  "kind": "guard_removed",
  "severity": "breaking",
  "confidence": "resolved",
  "technique": "annotation-scan",
  "subject": { "id": "invoice-app::src/server/routes.ts::POST /api/invoices/:id/finalize", "name": "POST /api/invoices/:id/finalize", "kind": "route" },
  "journey": { "id": "…", "name": "Finalize invoice" },
  "loc": { "repo": "invoice-app", "path": "src/server/routes.ts", "line": 40 },
  "permalink": "/compare/39...41#c2"
}
```

- **`id`** — `c1…cN`, assigned over a deterministic order (kind order as listed above, then subject id, then a per-kind detail key). The same base/head pair always yields the same ids; permalinks reference them.
- **`confidence`** — how sure the *graph* is about the fact underlying the change. `'resolved'` for node-derived changes and for edges that carry no resolution stamp; otherwise the edge's tier (`HIGH`/`MEDIUM`/`LOW`). Honesty note: adapters begin stamping `resolution` on every edge in P4 — until then every change reports `'resolved'`, which is the truth about what the graph currently records, not a claim of certainty.
- **`technique`** — present when the underlying edge carries a resolution; the verbatim `ResolutionTechnique` from `packages/core/src/graph.ts`. The six frozen with v1: `static-import`, `fetch→route`, `db-builder`, `annotation-scan`, `DI-binding`, `name-match`. *(Additive, 2026-09, under the "v1 may gain optional fields" rule — the enumeration grew, no member changed meaning and none went away.)* The OpenAPI and tests passes added `import-resolution` (a test's import of the symbol it exercises), `route-literal` (a string literal in a test matched to a page or route), `coverage-report` (a run observed the node executing) and `method-name` (a member call resolved to the one class method of that name, in-memory and mock twins set aside); the clarity phase adds `interface` (a call dispatched through an interface or class type to its implementer), `hook-binding` (a function reached only through a hook property the container binds), `sdk-import` (an external named by the SDK specifier table) and `constant-host` (a non-literal `fetch` behind a constant host). Lane B5 adds four more, stamping facts the adapters already had (docs/proposals/dependency-impact.md §3.4): `raw-sql` (the table's name was read out of a SQL statement carried on the edge), `same-file` (the callee is declared in the caller's own file — a sibling function, `this.method()`, a Java method of the same type), `jsx-render` (the rendered component is a JSX element written in the caller's own body) and `detected` (the adapter recognised the edge from a shape — a middleware name, a `middleware.ts` file convention — and nobody declared it). The work-items pass (2026-09-30) adds `work-key`: a `tracks` edge from a work item to a node, found because a commit subject, a branch name or a tracker URL in a commit message named the item's key and that commit changed the node (docs/proposals/work-items-sync.md §9; a *declared* work link stays `annotation-scan`). A consumer that does not know a member must print it verbatim rather than drop the change.
- **`subject`** — stable node id plus display name and kind, so a consumer never has to re-derive "what is this about".
- **`loc`** — the subject's source location when the graph has one.
- **`permalink`** — host-relative: `/compare/<baseSync>...<headSync>#<id>`. Resolvable once the Changes surface (P6) lands; the shape is frozen now.
- **`contractStatus`** *(optional; added 2026-09 under the "v1 may gain optional fields" rule)* — on a `journey_changed` whose entry is a route, `{ from, to }` with each side's OpenAPI contract status (`both` · `spec-only` · `code-only` · `declared` · `none`) when they differ. `spec-only → both` is the **planned → built** transition: the declared operation now runs code. Planned steps (synthesized from a declared route's contract by `journey()`) are deliberately **not** part of the hop-sequence identity — a spec edit is not an execution-path change — so `journey_changed` still fires only when real hops differ; the field just says why.
- **`attribution`** *(optional; added 2026-09-23 under the "v1 may gain optional fields" rule)* — `{ commits, level: 'file', unindexed }`: the commits in the compared range that touched **the file this change's subject lives in**. See the version note below for what it does and does not claim.

### Version note — 2026-09-23, attribution (file-level)

`attribution` is an optional per-change object added on 2026-09-23 (docs/proposals/change-history-2026-09.md §2, chunk H4). Additive growth again: no existing field changed name, type or meaning, a consumer that does not know it ignores it, and a diff produced without it is byte-for-byte what this contract has emitted since July — the golden fixture asserts exactly that.

```json
"attribution": { "commits": ["15817419a2f55cdf89898274e6d3c18e4b321e0b", "0196d67f1d2712fccefc1d2be09662a1c998bced"], "level": "file", "unindexed": 2 }
```

- **`commits`** — attributing commit shas, newest first, as git spells them.
- **`level`** — always the literal `"file"`.
- **`unindexed`** — how many of `commits` no sync ever ingested.

Four honesty rules travel with it, and a renderer that breaks one is misreporting the contract:

- **It is file-level, and the word `level` is in the field so it cannot be read otherwise.** These are the commits that touched the *file* the subject lives in, not the commits that changed the *node*. Farsight cannot know the second: for three quarters of a repository's commits no sync ever built a graph (§2), so "commit X changed this function" is unknowable, not merely unmeasured. The sentence a surface prints is *the file this lives in changed in 3 commits*, never *this function changed in commit X*.
- **Absent and empty are different answers.** The field is **absent** when no history has been read for that repository — Farsight has no basis for any claim. It is present with `"commits": []` when the history *was* read and nothing in the range touched the file. Emitting an empty list for an unread history would assert the second while only having the first.
- **`unindexed` makes the list a floor.** A range can contain commits no sync ingested (the reference app: 18 of the 19 commits in sync 24 → 28). Attribution drawn from a partly-ingested history is a floor, not a fact, and the count is what says so.
- **A change with no `loc` is never attributed.** There is no file to join on, so there is no field.

`attribution` is also **not** an evidence chip: evidence says whether something runs (tests), attribution says who touched a file. The two never share a row.

**The diff never produces it.** `diffGraphs()` does not read git and has no access to the history tables; `attributeChanges()` in `packages/core/src/history.ts` joins the `commit`/`commit_file` rows onto a **copy** of a diff on the way out, and `farsight diff --attribute` is the one shipped caller. That is what keeps `diff.ts` pure and the golden fixture frozen. The join normalises the monorepo prefix — `commit_file.path` is repository-root-relative while `loc.path` is source-root-relative — because without it a source mounted below its repository root would attribute nothing and print the earned empty list it has not earned.

## Fingerprints — PLANNED, not shipped

Content-hash fingerprints (rename/move stability across ids: "this is the same function even though the file moved") are **PLANNED** for a later version of this contract and are deliberately absent from v1. The board removed the claim rather than drawing fiction; so does the contract. v1's rename detection is exactly the two conservative cases in the `node_renamed` row above — nothing follows a node across files.

## Policy file format (`compliance.yml`)

Facts in the diff, judgment in the policy, exit code from the verdict. The policy file is repo-owned; `farsight gate --policy compliance.yml` applies it (`applyPolicy` in `core/diff.ts`).

The file is parsed by a **deliberately minimal, zero-dependency YAML subset** — not a YAML library. The complete grammar:

```
file       := line*
line       := comment | blank | top-level | list-item | continuation
comment    := optional-spaces "#" anything
top-level  := "version: " integer          (must be 1)
            | "rules:"                     (starts the rule list)
list-item  := "- " key ": " value          (starts a rule)
continuation := spaces key ": " value      (adds a field to the open rule)
value      := plain scalar; optional single/double quotes are stripped
```

Anything fancier — nesting, multi-line scalars, anchors, flow style — is a **parse error, on purpose**. Each rule needs exactly:

| field | meaning |
|---|---|
| `rule` | display name in the gate output |
| `when` | a change kind from the table above, `severity:<breaking\|notable\|info>`, or `any` |
| `then` | `fail` (matched → gate fails, exit 1) · `warn` (matched → logged, gate passes) · `allow` (matched → recorded as allowed) |

The gate block appended to the diff:

```json
"gate": {
  "policy": "compliance.yml",
  "result": "fail",
  "exit": 1,
  "rules": [ { "rule": "no-guard-removals", "result": "fail", "changes": ["c2"] } ]
}
```

`result` is `fail` iff any rule with `then: fail` matched at least one change; `exit` mirrors it as `1`/`0`. Per-rule `result` is `pass` (nothing matched) or the rule's own `then` verb. The starter dogfood policy lives at the repo root: [`compliance.yml`](../../compliance.yml).

## SARIF rendering

`toSarif()` / `farsight diff --format sarif` emits SARIF 2.1.0: one run, tool `farsight`, one rule per change kind, one result per change. Severity maps `breaking → error`, `notable → warning`, `info → note`; `partialFingerprints` carries `changeId` + `subjectId`; locations use the change's `loc`. The SARIF is a rendering of this contract, never an alternative source of truth.

## Golden fixtures — how they were made

`packages/core/test/fixtures/` holds two full snapshot JSONs plus the exact v1 diff between them:

- `invoice-base.json` — `examples/invoice-app` ingested by the real TS/JS adapter (config applied), meta pinned to `sync:39 · commit 76f7674 · tz UTC` for determinism.
- `invoice-head.json` — the same graph after a **scripted mutation** standing in for a second commit (`make-fixtures.mjs`, checked in next to the fixtures, is the script and the documentation): remove a `guards` edge, add a route, rename a function in place, change a table's columns, remove a rule node, and drop a `calls` edge (which is what flips `journey_changed`). Meta pinned to `sync:41 · commit 4677268`.
- `expected-diff.json` — the frozen expected output; `diff.test.ts` requires byte-for-byte JSON equality and validates it against the schema file.

Regenerating (`node packages/core/test/fixtures/make-fixtures.mjs`) is a **contract event**: if the regenerated diff differs from `expected-diff.json`, either the parser changed (update the fixtures, note it in the commit) or the contract broke (stop).
