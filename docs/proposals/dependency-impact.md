# Dependency impact — by hop, with the weakest edge showing

2026-09-24 · lane **B5** `feat/dependency-impact`, the last lane of the clarity phase · brief: 2026-09-14 swarm §3-D · second brief: 2026-09-23 clarity-phase-B swarm · requirement **R25** (00-requirements) · code shape: 01-code-plan §7 · contract house style: [`farsight-diff v1`](../contracts/farsight-diff-v1.md), [`farsight-tests-matrix v1`](../contracts/farsight-tests-matrix-v1.md)

Every number below was measured on **The reference app's sync 53** (`0a88031`, content digest `51999f1b66f9`, 1,505 nodes / 3,098 edges) read-only from its live server, and on the Farsight dogfood graph (16,383 nodes / 19,573 edges) on 2026-09-24. Nothing was restarted, synced or written.

**In short:** impact is one upstream fold over the graph that already exists, answered **per hop and never summed**, stopping at five named kinds of cut point, carrying the **weakest recorded resolution on the path** plus a count of edges that recorded nothing, and refusing to call reachability consequence. It ships as an MCP answer, a CLI command, an inspector tab, rings on the sheet, one business sentence with a *because* clause, and `farsight-impact-tests v1` for CI. It needs **no new parsing** — but it does need one chunk of edge stamping, because **83% of the reference app's non-test edges record no technique at all** (§3.4), and a confidence-ranked answer over unstamped edges is theatre.

---

## 1 · The question, and what today's answer gets wrong

> **"What breaks if we change the invoices table?"** — my single most expensive recurring question. `mcp-impact-invoices-table.txt` answers *"388 nodes transitively depend on invoices"* and then lists 388 things starting with `PgInvoiceRepository.createDraft`. **That is not an answer, it's a haystack.** To its credit it says so: *"impact by hop lands in pass 6."* Honest, and still a meeting.
> — ops product owner, 2026-09-23

Re-measured on sync 53, today's `impact_of` returns **388** nodes (409 if setup and deferred edges are not skipped). What is wrong with it is not the size:

1. **It is one number over four different questions.** Nine functions read or write the table. Fifteen more call those nine. Twenty-four more call *those*. Summing them makes the answer useless at every distance: the first nine are a code review, the next fifteen are a regression list, the rest is "the application".
2. **It has no provenance.** All nine hop-1 edges are `reads`/`writes` from the raw-SQL pass and **not one of them carries an `EdgeResolution`** — so the tool's strongest answer is delivered by its least-documented edges. The staff engineer's sentence for the whole pack was *"its strongest words are carried by its weakest evidence"*; this is the purest instance of it.
3. **It confuses reachability with consequence.** A path existing does not mean a change travels along it. The onboarding developer found the sharpest case: Farsight draws a solid unbroken arrow from submit to `⇄ [external] Business Central`, while `buildBcHandoffOps` reads exactly **four of eighteen** fields (`bc-handoff.ts:116,128,143,148`) and everything else dies in `invoices.field_edits`. *"Farsight is a call graph, not a data-flow engine"* is a fair limit — and a picture that hides the limit invites the wrong answer.
4. **It hides what it did not look at.** 388 is a ceiling produced by a depth of 10 and a silent stop; the reader cannot tell it from a complete answer. `journey()` solved exactly this in lane A1 with `cutPoints[]`, and impact must inherit that model rather than re-invent the cliff.
5. **The same fault in its sibling.** `trace_flow {"query":"storeInvoiceDocument","depth":3}` returns **395 nodes and 23 routes** — including `DELETE /api/v1/auth/session` — for a four-line question; **130 of those 395 are test nodes**. The staff engineer classed both tools as *decoration* and asked for a verdict. §6.

What the same reader wants instead, in their own words: *"changing the invoices table touches 9 of 10 flows and 40 of 79 e2e tests"* (exec skeptic, 2026-09-20). That sentence has a hop structure, a denominator and a *because*. This design is that sentence, made earnable.

---

## 2 · What impact may claim, and what it may not

The phase rule is honesty before beauty. Applied to a dependency answer, that is four statements the surfaces are allowed to make and three they are not.

**May claim**

| claim | what backs it |
|---|---|
| *n things use this directly* | one edge, with its kind (`reads · writes · calls · guards · renders · http · publishes · consumes`), its file and line, and its resolution |
| *n more reach it through those* | a path of length ≥ 2, with the weakest recorded tier on that path and the number of edges on it that recorded nothing |
| *these tests reach the things that use it* | `covers` edges with their evidence class — `declared · reached · observed`, never promoted |
| *n more lie behind what I did not walk* | a cut point with a reason and a count |

**May not claim**

- **That a change propagates.** The verb for a hop is the edge's own verb — *writes it · calls it · guards it · renders it*. Never *breaks*, never *is affected by*, never *depends on* where the graph only saw a call. The word *affected* survives from the brief only as a **grouping label for hops ≥ 2**, defined on the Grammar page as *"reaches it through something else — a path, not a prediction"*.
- **That data travels.** For an `http` or `sdk-import` edge into an `external`, the surface prints the existing absence word: *Business Central — on the path · what travels is **not indexed***. That is the BC field-subset case answered by refusing to answer it.
- **That an unstamped edge is a weak one.** 83% of edges record no technique (§3.4). "Records nothing" is not a confidence tier and is never rendered as one.

**No seventh absence word.** The six stay closed (`none indexed · not involved · not built · not reached · not indexed · not translated`). Impact uses three of them: *none indexed* when nothing in the indexed code uses the seed, *not built* for a declared-only route among the dependents, *not indexed* for what travels over an external edge. Everything else it has to say — a cut point, a hop budget, an unrecorded technique — belongs to vocabularies that already exist (`journey`'s cut points, the resolution ladder) and is printed in those words.

---

## 3 · The data model and the fold

New file `packages/core/src/impact.ts`, pure, over `GraphIndex`. No parser change except the stamping chunk (§3.4), no new node kind, no new edge kind, no change to `farsight-diff v1` or `farsight-tests-matrix v1`.

### 3.1 The types

```ts
import type { ConfidenceTier, EdgeKind, EdgeResolution, GraphNode, Loc } from './graph.js';
import type { GraphIndex } from './query.js';
import type { CoverageTestRef } from './coverage.js';

/** Which way the question runs. `upstream` = what uses this (the default and the
 *  only one the business sentence is written for); `downstream` = what this uses,
 *  which `journey()` answers *in order* and this answers as a set. */
export type ImpactDirection = 'upstream' | 'downstream';

export interface ImpactOptions {
  hops?: number;              // default 2. 0 is not a question; > 5 is refused (§8)
  direction?: ImpactDirection; // default 'upstream'
  includeSetup?: boolean;     // default false — the boot is not a dependent
  includeDeferred?: boolean;  // default false — later work is reported apart
  expandShared?: boolean;     // default false — see 3.3
  tests?: boolean;            // attach covers edges per node
  flows?: boolean;            // attach the journeys/actions each node appears in
  perHopCap?: number;         // default 50; overflow becomes a `cap` cut point, never a silent drop
}

/** The edge that first reached a dependent, kept whole so a consumer never re-derives it. */
export interface ImpactEdgeRef {
  id: string;
  kind: EdgeKind;
  from: string; to: string;
  loc?: Loc;                  // the call site
  resolution?: EdgeResolution; // absent === the adapter recorded no technique (§3.4)
  deferred?: true; origin?: 'setup';
}

/**
 * How well the path from the seed is known. Deliberately a **pair**, not a tier:
 * `tier` is the weakest tier actually recorded on the path (null when nothing on
 * it recorded one) and `unstamped` counts the edges that recorded nothing.
 * Collapsing the two into one ladder would invent knowledge — see §10.2.
 */
export interface PathStrength { tier: ConfidenceTier | null; unstamped: number; hops: number }

export interface ImpactNode {
  nodeId: string; name: string; kind: GraphNode['kind']; loc?: Loc; repo: string; group?: string;
  hop: number;                 // fewest edges from the seed, within the budget
  via: ImpactEdgeRef;          // the last edge of the best-known path
  path: string[];              // seed → … → this, the best-known path, node ids
  strength: PathStrength;
  /** the via-edge resolved a call site to one implementer and set others aside:
   *  the code picks at run time, so this dependent is one of several. Never folded away. */
  oneOf?: { chosen: string; alternatives: string[] };
  tests?: CoverageTestRef[];   // opts.tests
  flows?: { flowId: string; name: string; actions: { screen: string; label: string; rank: number }[] }[];
}

export type ImpactCutReason =
  | 'hops'       // the budget ended here
  | 'shared'     // a plumbing or presentational node: expanding it reports the application
  | 'setup'      // meta.origin === 'setup'
  | 'deferred'   // meta.deferred
  | 'cap';       // more dependents at this hop than perHopCap

export interface ImpactCut { reason: ImpactCutReason; nodeId: string; name: string; behind: number; hop: number }

export interface ImpactReport {
  seed: { id: string; name: string; kind: GraphNode['kind']; loc?: Loc };
  direction: ImpactDirection;
  /** one entry per hop, in order. There is deliberately **no total**: the type
   *  cannot carry the number the brief says never to print. */
  hops: { hop: number; nodes: ImpactNode[] }[];
  excluded: { setup: ImpactNode[]; deferred: ImpactNode[] };
  cutPoints: ImpactCut[];
  /** `floor` whenever anything was cut, capped, unstamped or `oneOf` — which on
   *  today's graphs is always. `exact` is reachable only over a fully stamped,
   *  uncut neighbourhood, and the word says which. Same vocabulary as MetricValue. */
  bound: 'exact' | 'floor';
  uncertainty?: { note: string; affects: string[] };
  asOf: { sync?: number; commit?: string; farsight: string; generatedAt: string };
}

export function impactOf(index: GraphIndex, id: string, opts?: ImpactOptions): ImpactReport;
export function impactSentence(r: ImpactReport, register: 'hud' | 'professional'): string;
```

`ImpactReport` has no `total`, no `count`, no `nodes[]`. A consumer that wants the haystack has to build it itself, and the house rule says it must not.

### 3.2 The walk

Breadth-first over `index.in` (upstream) or `index.out` (downstream), layer by layer, at most `hops` layers. It is `trace()`'s traversal with four differences, all of which are the point:

1. **`covers` edges are never followed.** A test is evidence about a node, not a dependent of it. Today's `trace_flow` follows them: 130 of the 395 nodes in the staff engineer's example are test nodes. Tests reach an impact answer only through `opts.tests`, attached to the node they cover.
2. **Layers are kept.** `hop` is the fewest edges from the seed within the budget.
3. **`strength` is a widest-path relaxation, not a shortest-path by-product.** A node may be reached by several paths; the honest label is the **best** of the weakest links, because if one well-recorded path exists, the dependency is well recorded. Relaxation runs inside the budget only, and ties break toward fewer unstamped edges.
4. **Every stop is named.** Nothing is dropped silently; each stop appends an `ImpactCut` with its reason and how many further nodes sit behind it.

### 3.3 The five cut points

| reason | rule | why |
|---|---|---|
| `hops` | the budget ran out at this node | `journey()`'s model, verbatim: what the reader has not seen is part of the answer |
| `shared` | the node is tagged `plumbing` (config globs) or satisfies `isPresentational()` from `metrics.ts` | a node with 39 direct dependents is a utility, not a feature — expanding `cx` reports the UI |
| `setup` | the in-edge carries `meta.origin: 'setup'` | the boot is not a dependent (lane A1's rule, reused) |
| `deferred` | the in-edge carries `meta.deferred` | later work, reported apart and never summed with request-time work |
| `cap` | more than `perHopCap` dependents at one hop | the count is printed and grouped by repo/group instead of listed |

`shared` reuses **the one coverable predicate** (`isCoverable`/`isPresentational`, lane A2.1) rather than inventing a hub heuristic — the same nodes the denominator already excludes are the ones whose expansion destroys an impact answer. Measured on the reference app, the ten highest-in-degree nodes are exactly that set: `cx` (39) · `getContainer` (26) · `handle` (25) · `apiInit` (24) · `Button` (23) · `json` (20) · `readJson` (20) · `Card` (18) · `StatusChip` (18) · `requireContractorSession` (17). Effect, measured: `submitDraftInvoice` at 4 hops goes from **88 nodes to 52**, naming `assertSameOrigin` (15 dependents) and `requireContractorSession` (17) as the two it did not expand; `cx` at 4 hops goes from 117 to 84 with **28** named shared helpers. `--expand-shared` turns it off for someone who really is changing `handle`.

Honest note the document keeps: the shared rule does **not** rescue the `invoices` answer (it changes nothing below 4 hops there). What rescues that answer is answering at hop 1 and refusing to sum. The stop rule is for the neighbourhood of plumbing, not for the headline.

### 3.4 The stamping problem — measured, and a chunk of its own

| graph | non-`covers` edges | carrying no `resolution` | share |
|---|---|---|---|
| The reference app's sync 53 | 1,693 | **1,407** | **83.1%** |
| Farsight dogfood | 15,824 | **13,659** | **86.3%** |

By kind on the reference app: **all** 42 `reads`, **all** 32 `writes`, 909 of 1,060 `calls`, 152 of 157 `guards`, all 33 `validates`, 236 of 269 `renders`. Consequence, measured on the headline example: every one of the nine hop-1 edges into `invoices` is unstamped, so a tier-ranked answer prints *nothing recorded* for the fact the product owner most needs, at every hop, for every path — the distribution of `weakestOnPath` over the whole 4-hop `invoices` neighbourhood is **80 nodes, all unstamped**.

So B5 opens with a parser chunk that stamps what the adapters already know, using techniques the frozen contract already permits ("v1 may gain optional fields and gain enum members"):

| edge | technique | tier | why it is earned |
|---|---|---|---|
| `reads` / `writes` from `shared/sql.ts` | **`raw-sql`** *(new member)* | HIGH | the statement text is on the edge; the table name came out of the SQL |
| `reads` / `writes` from the Drizzle/repo builder path | `db-builder` | HIGH | already enumerated |
| `calls` resolved through an import | `static-import` | HIGH | already enumerated; the resolver already knows it took this route |
| `calls` to a sibling in the same file / `this.x()` | **`same-file`** *(new member)* | HIGH | no heuristic was used |
| detected `guards` / `validates` | `annotation-scan` when declared, else **`detected`** *(new member)* | HIGH / MEDIUM | a `@guard` claim and a shape match are not the same fact |
| `renders` from JSX | **`jsx-render`** *(new member)* | HIGH | the element is in the caller's tree |

Four new enum members, additive, each documented in `farsight-diff-v1.md` under the rule that already grew that list twice. After the chunk, *not recorded* should be the exception rather than the answer — and the acceptance chunk measures exactly that, with no target invented here.

### 3.5 The bound

Reuse `MetricValue`'s vocabulary rather than inventing one: `bound: 'floor' | 'exact'`, with `uncertainty.note` naming the reason and `affects` listing what caused it. An impact count is a **floor** whenever any of these hold, which on both live graphs is always:

- a cut point of any reason exists (something was not walked),
- any node's `strength.unstamped > 0` (a path's provenance is incomplete),
- any node carries `oneOf` (a call site resolves to several implementations and the code chooses at run time),
- the graph's `sourceDigest` no longer matches the checkout.

The printed form is the one the phase already uses: `≥ 9 things use it directly`, with the reason inline. Nothing prints `exact` until it can earn it.

### 3.6 *One of these* — the swarm's blocker 3, in the impact answer

The reference app carries **51 edges with `alternatives`** (all `interface`), setting **38 distinct nodes aside**. In an upstream walk this cuts both ways and both are drawn:

- A dependent reached through such an edge carries `oneOf: { chosen, alternatives }` and prints *one of several implementations — the code chooses at run time*. It is never silently counted as a certainty.
- A **seed** that appears in someone's `alternatives` (every `InMemory*` twin: `InMemoryBcOutboxRepository.enqueue` is set aside three times) gets a line of its own: *3 call sites resolve to `PgBcOutboxRepository.enqueue` instead and set this aside* — so a twin's honest `none indexed` is explained rather than looking like a bug.

---

## 4 · What each surface draws

### 4.1 MCP — `impact_of`, rewritten

Inputs gain `hops` (default 2), `direction`, `include_setup`, `include_deferred`, `expand_shared`, `tests`, `full`. Output, budgeted like every printer B1.7 touched:

```
invoices — 9 things use it directly, 15 more reach it through those (sync 53 · 0a88031)
≥ a floor: 24 more lie behind the 2-hop edge, and no edge on any of these paths records how it was resolved.

## hop 1 — uses it directly
  writes  PgInvoiceRepository.createDraft        pg.ts:543   how we know: not recorded
  reads   PgInvoiceRepository.getById            pg.ts:569   how we know: not recorded
  …  (9 · 7 function · 2 guard)
  tests reaching hop 1: none indexed

## hop 2 — reaches it through those
  calls   submitDraftInvoice: submit readiness   submissions.ts:940   via PgInvoiceRepository.transition · interface MEDIUM · 1 edge records nothing
  …  (15 · 10 function · 5 guard)
  tests reaching hop 1–2: 19 unit (18 reached · 1 observed) · 0 e2e

## not walked
  2-hop edge        24 nodes behind 25 edges
  start-up, once    build — the container, reached by every first request
  afterwards        BcOutboxWorker.execute — runs later, on its own

Journeys: 9 of 10 use it directly, in 19 actions. Sync ops verify and approve: not involved.
```

`journey`'s conventions are kept exactly: `⚙ start-up, once` and `⧗ afterwards` are reported apart and never summed into the hop counts; the cut list prints whenever anything was cut.

### 4.2 CLI — `farsight impact`

```sh
farsight impact <id|name> [--hops N] [--direction upstream|downstream] [--tests] [--flows]
                          [--include-setup] [--include-deferred] [--expand-shared]
                          [--changed <path[:line[-line]]>…] [--format text|json]
```

`--format json` emits `farsight-impact-tests v1` (§5) when `--tests` is on, and the bare `ImpactReport` otherwise. `--changed` resolves file hunks to nodes by `loc` range — the seed list becomes several, and `seeds[].from` says `hunk`. Exit code is 0 for an answer and 1 for usage only; an absence is never an error (`farsight history`'s rule).

### 4.3 The sheet — rings, by shape

Clicking a chip on the system sheet (or `b` on a selected card) rings the cells: **solid** ring = hop 1, **dashed** = hop ≥ 2, **dotted** = behind a cut point. Shape, not colour — the brief's rule, and it passes the grayscale check the 2026-09-14 swarm asked for. The chip halo reads `↑9 · ~15 · ⋯24`, three numbers that never add up and are labelled so on the Grammar page. The *Verified by* row filters to tests whose `covers` edges land on a ringed cell, ranked observed > reached > declared — and prints *none indexed* when, as with `invoices` hop 1, there are none.

### 4.4 The inspector — the IMPACT tab stops being dashed

`02-design-changes.md` §4.8 shipped a dashed IMPACT tab whose body is a paragraph and a command. It becomes the real panel, last in the ladder (DOCS · REQUEST/RESPONSE · CODE · FORKS · TESTS · IMPACT), key `b` from anywhere, `?impact=<id>&hops=N` in the hash and in `y` share links. Body: the seed line, hop 1 as a list with edge verb + file:line ⧉ + resolution chip, hop 2 collapsed to a count that opens, the cut list as clickable rows (each jumps to the node, opening folds above it — `jrnRevealFold`'s behaviour), and the *not walked* block. In the **business register** the tab shows only §4.5's sentence and the journeys list; no ids, no file names, no hop arithmetic.

### 4.5 The business count line, with its *because*

One sentence, built by `impactSentence()`, never a graph. Measured on the reference app for `invoices`:

> **Nine things use the invoice record directly** — the nine database operations that read or write it. **They appear in 9 of the 10 journeys, across 19 actions**, from *Start a draft submission* to *Submit the invoice*. **Because** nothing under those nine is covered by a test of its own, a change here would be caught only by the 19 unit tests one step further out — **no end-to-end test touches any of the nine**. *Sync ops verify and approve* is not involved.

Rules the sentence obeys: one clause per hop, never a sum; the *because* clause is always the evidence clause, because that is the half a business reader can act on; no identifier, no file, no percentage without its scope; RULE 5's banned units (`steps · cuts · beats · moments · truncated · helpers`) do not appear, and `lint:strings` gains `impact.biz.*` to the prefixes it checks.

### 4.6 Strings

Thirteen new keys under `impact.*`, plus the two stubs this lane retires — `impact.notYet` (*"ships with the Changes pass (P6)"*) and `impact.nothingSelected` — whose call sites in `impact.js` become the real panel. `impact.title` already exists (`strings.ts:213`) and **keeps its shipped words**: retitling a thing a reader has already learned is the churn RULE 2 exists to expose.

| key | hud | professional | define |
|---|---|---|---|
| `impact.title` *(exists; gains a define)* | Blast radius | Change impact | What uses this, by distance — direct users first, then what reaches it through them. Never added together. |
| `impact.hop1` | uses it directly | uses it directly | One edge from this node: it reads, writes, calls, guards or renders it. |
| `impact.hopN` | reaches it through {n} others | reaches it through {n} others | A path, not a prediction: the graph gets from there to here. It does not say a change travels. |
| `impact.strength` | how we know: {tier} · {n} record nothing | resolution on this path: {tier}, with {n} edges recording none | The weakest recorded technique on the path, and how many edges on it recorded none. A path is only as strong as its weakest edge. |
| `impact.notRecorded` | how we know: not recorded | the adapter recorded no technique for this edge | Not a confidence level and not an absence of the thing — an absence of provenance about the edge. |
| `impact.oneOf` | one of several — chosen at run time | one of several implementations; the call site resolves to {chosen} and sets aside {n} | The code picks at run time. Counting all of them would overstate; counting one would understate. |
| `impact.setAside` | {n} call sites use {other} instead | {n} call sites resolve to {other} and set this aside | Why a production twin's counterpart shows nothing. |
| `impact.cut.hops` | {n} more behind the {h}-hop edge | {n} more nodes were not walked at hop {h} | The budget, drawn. What you have not seen is part of the answer. |
| `impact.cut.shared` | {name} is shared by {n} — not opened | {name} is used by {n} things; expanding it would report the application | Plumbing and rendered primitives are stopped by the same rule that keeps them out of the coverage denominator. |
| `impact.cut.cap` | {n} at this distance — grouped | {n} dependents at this hop, grouped by area | Too many to list is a fact, not a reason to truncate silently. |
| `impact.excluded.setup` | start-up, once | reached only through container construction | The boot is not a dependent. Listed apart, never summed. |
| `impact.excluded.deferred` | afterwards | registered here, run later by something else | Deferred work, reported apart. |
| `impact.external` | on the path · what travels is not indexed | on the path; the payload is not indexed | Farsight follows calls, not data. That a call happens is not a claim about which fields travel. |
| `impact.biz.line` | — | {direct} things use {subject} directly, in {actions} actions across {flows} journeys. Because {evidence}. | The business sentence. One clause per distance, a because clause about evidence, no graph. |

Plus seven `grammar.impactWords.*` rows so `#/grammar` defines *direct · through · hop · path · cut point · not recorded · one of several* in both registers, with their catalog keys visible — the artefact all four personas praised.

---

## 5 · `farsight-impact-tests v1`

A new frozen contract beside the other two, **additive-only from birth**, documented at `docs/contracts/farsight-impact-tests-v1.md` with a JSON Schema in `schemas/`. It extends the sketch in 03-tests-pages §2.8 with what measuring the reference app taught.

```jsonc
{
  "schema": "farsight-impact-tests v1",
  "identity": { /* the farsight-tests-matrix v1 identity block, verbatim */ },
  "seeds": [{ "id": "example-app::…::submitDraftInvoice", "name": "…", "kind": "guard",
              "from": "hunk", "hunk": "apps/api/src/submissions.ts:930-975" }],
  "hops": [{ "hop": 1, "nodes": [{
      "id": "…", "name": "…", "kind": "guard", "file": "…", "line": 940,
      "edge": { "kind": "guards", "technique": null, "confidence": null },
      "strength": { "tier": null, "unstamped": 1, "hops": 1 },
      "one_of": null,
      "tests": [{ "id": "…", "title": "…", "file": "…", "line": 12, "level": "unit",
                  "runner": "vitest", "project": "libs/shared/domain",
                  "evidence_class": "observed", "technique": "coverage-report",
                  "confidence": "HIGH", "run_level": true, "inactive": false }] }] }],
  "select": { "vitest": [{ "file": "…", "title": "…", "project": "…" }],
              "playwright": [{ "file": "e2e/tests/api/invoice-submission.pw.spec.ts", "title": "…", "project": "api" }] },
  "unselectable": [{ "node": "…", "name": "POST", "reason": "no covers edge" }],
  "fallback": "run-all",
  "excluded": { "setup": ["…"], "deferred": ["…"] },
  "cut": [{ "reason": "hops", "node": "…", "name": "…", "behind": 30, "hop": 2 }],
  "bound": "floor"
}
```

**Freeze rules** (the diff contract's, word for word in intent): names, types and meanings hold for as long as `schema` says v1; v1 may gain optional fields and enum members and never loses or repurposes one; consumers ignore unknown fields; breaking changes ship as v2. Two rules are specific to this document:

- **`select` is a floor and says so.** `bound` is part of the envelope, not an afterthought — a selection computed over a cut, unstamped or `one_of` neighbourhood is a floor, and a CI job may not treat it as a complete set.
- **`fallback: "run-all"` is never implied and never omitted.** It is `"run-all"` when *any* seed or hop-1 node is `unselectable`, when a cut point of reason `hops` exists at hop 1, or when `identity.source_digest` does not match the working tree; otherwise `null`. `unselectable[].reason` is closed: `no covers edge · declared only · inactive · run-level only`.

`run-level only` is a member this contract needs because of a measured the reference app fact: of the four hop-1 dependents of `submitDraftInvoice`, `POST` has no `covers` edge at all, and two of the three guards are reached **only** by a run-level synthetic node (`unit run · apps/api`). A coverage report proves the run reached the code; it cannot name a case to re-run. Selecting nothing for them would be a silent under-run, so both become `unselectable` and the answer falls back honestly.

**The CI use case.** A PR job runs

```sh
farsight impact --changed $(git diff --name-only origin/main...) --hops 2 --tests --format json > impact.json
jq -r '.fallback // empty' impact.json   # non-empty ⇒ run the whole suite, and say why
```

and feeds `select.vitest[].file` to `vitest run` and `select.playwright[].project` to `playwright test --project`. The gate the SDET asked for is `unselectable[] | length == 0` — empty means every direct dependent of every changed node has at least one runnable test. **Measured today, the reference app passes that gate for neither seed in §7**, which is the honest state of its suite, not a defect of the format.

---

## 6 · Verdict on `trace_flow`

> *"What is the plan for `trace_flow` — hop-ranked like `impact_of` pass 6, or retire it?"* — staff engineer

**Hop-rank it, and narrow its default — do not retire it, and do not let it keep answering two questions at once.**

Measured on `storeInvoiceDocument`, sync 53:

| call | nodes | what is in there |
|---|---|---|
| `trace_flow depth:3` (today: both directions, `covers` followed) | **395** | 203 function · **130 test** · 28 guard · 23 route · 8 table |
| the same, depth 2 | 129 | |
| upstream only, depth 3, tests not followed | **69** | |
| downstream only, depth 3, tests not followed | **96** | |

Three of the four faults are the same ones §1 lists, and the fix is the same fold. The reasoning for keeping the name:

1. **It is the only neighbourhood answer an agent has**, and agents that already call it would silently lose a capability. Renaming a tool is a breaking change to a consumer we do not control.
2. **Its unique question is legitimate** — *what is around this node* — and is neither `journey` (downstream, ordered, one entry) nor `impact_of` (upstream, by hop).
3. **Its faults are all in the walk**, and the walk is being written anyway.

So: `trace_flow` keeps its name and its `Subgraph` return shape (additive), and is re-implemented over `impactOf`, running it once per direction. It gains `hops` per node and the cut list, stops following `covers` edges, stops expanding shared nodes, and **its default direction becomes `upstream` rather than `both`** — because `both` is what turns 69 into 395 and puts `DELETE /api/v1/auth/session` in the answer to an upload question. Its description gains one line: *for what this uses, in order, call `journey`; for what uses it, by distance, call `impact_of`*. Same measured question, same build: **395 → 69**.

---

## 7 · Worked examples, measured on the reference app

Sync 53 · `0a88031` · digest `51999f1b66f9` · read-only from its live server on 2026-09-24. Every number here is reproducible from `/graph` and `/api/journey`.

### 7.1 `example-app::table::invoices` — the question everyone cites

| | today | this design |
|---|---|---|
| headline | `388 nodes transitively depend on invoices — 17 more through deferred hooks` | `9 things use it directly, 15 more reach it through those` |
| hop 1 | — | **9** (7 function · 2 guard), every one a `PgInvoiceRepository` accessor, all `reads`/`writes`, **all unstamped** |
| hop 2 | — | **15** (10 function · 5 guard) — `submitDraftInvoice · createDraftSubmission · findDuplicateInvoice · storeInvoiceDocument · listInvoicesForContact …` |
| hop 3 · 4 | — | 24 · 32 — printed only when asked for |
| not walked | silent | 24 nodes behind 25 edges at the 2-hop edge; `build` (start-up); `BcOutboxWorker.execute` (afterwards) |
| tests | — | hop 1: **none indexed**. hop 1–2: **19 unit** (18 reached · 1 observed) · **0 e2e** |
| journeys | — | **9 of 10**, in **19 actions**; *Sync ops verify and approve*: not involved |
| bound | unstated | **floor** — "no edge on any of these paths records how it was resolved" |

The two facts a reader gets that 388 never gave them: **the nine are the whole direct answer**, and **not one of the nine is covered by a test of its own** — which is also why `describe_node invoices` has been printing *verified by: nothing* beside an impact list of dozens. Both readings are now the same fold.

### 7.2 `submitDraftInvoice` — the other case

- **hop 1 = 4**: the `POST` route (`calls`) and three guards — `loadDraft: invoice ownership`, `computeReadiness: submit readiness`, `guardInvoiceTransition: invoice state machine` (`guards`). All four edges unstamped.
- **hop 2 = 14** (1 route · 5 guard · 7 function · 1 component). **hop 3 = 30 without the shared rule, 16 with it**, naming `assertSameOrigin` (15) and `requireContractorSession` (17) as the two it did not open.
- **tests**: hop 1 = 4 (all unit); hop 1–2 = **20** (19 unit + 1 e2e), evidence 17 reached · 3 observed; the one e2e file is `e2e/tests/api/invoice-submission.pw.spec.ts` (project `api`).
- **unselectable at hop 1** = `POST` (no covers edge) and two guards (**run-level only**) → `fallback: "run-all"`, with the reason printed.
- **journeys**: used directly by **2** flows (*Submit an invoice with OCR confirm*, *POC — vendor invoice*) in **10 actions**; reached through others by **5** more flows in **10** further actions. The two numbers are printed on separate lines and never added.

Business sentence, generated from that report:

> **Four things use the submit check directly** — the submit route and three gates. **They appear in 2 journeys, across 10 actions**; five more journeys reach it through something else. **Because** one of the four (the route itself) has no test of its own and two are covered only by a whole-run report rather than a named test, a change here cannot be checked by running a chosen few — the full suite is the honest answer today.

### 7.3 What it refuses to say

`describe_node` on the submit action's ERP edge, under this design: *Business Central — on the path · what travels is **not indexed***. The reference app's `buildBcHandoffOps` reads 4 of 18 fields; Farsight has no data-flow pass and this design adds none. The refusal is the feature.

---

## 8 · Risks, and what this does not scale to

**Speed is not the risk.** A 2-hop walk from *every node* costs **2 ms** on the reference app (1,505 nodes) and **18 ms** on the Farsight dogfood graph (16,383 nodes / 19,573 edges); a 4-hop sweep of every node costs 4 ms and 14 ms. One answer is microseconds. `/api/impact` needs no cache.

**Answer size is the risk, and it is measured.** The largest 2-hop answer on the dogfood graph is **260** nodes (`join`, `t`, `esc` — the string helpers), and 4 hops reaches **441**. Hop 1 alone is **190** for `t`. So *hop 1 is not automatically small*: for a shared utility the honest answer is a count plus a grouping, never a list, which is what `perHopCap` and the `cap` cut point are for. A reader who seeds a utility gets *used directly by 190 things — this is a shared helper*, and that is the correct answer to a question that was not really about a feature.

**What this does not scale to, stated plainly:**

- **Beyond ~4 hops it stops meaning anything.** At hop 4 the `invoices` neighbourhood is 32 more nodes and the cut list still holds 31; by then "reaches it through three others" describes the application. `hops > 5` is refused with a sentence rather than served.
- **Cross-repo.** The fold is repo-agnostic and `stitchHttp` edges are walked like any other, but the only multi-repo evidence available is the dogfood workspace; a real second-repo impact answer has never been measured and the document does not claim one.
- **Data flow.** Field-level propagation (the BC four-of-eighteen case) is out of scope, needs a different pass, and must not be approximated by call reachability.
- **Change → consequence over time.** `--changed` resolves hunks to nodes at **file-and-line** granularity, exactly as `H4`'s attribution does, and inherits its caveat verbatim: the commits that touched a file are not the commits that changed a function, and only one of those is knowable.
- **A stale graph.** Every answer carries `asOf` and the digest check; when the digest does not match the checkout the bound is a floor and `fallback` is `run-all`. Impact over a stale cache is the one place a wrong answer costs a missed regression.

**Two build risks.** (1) The stamping chunk touches the adapter's hottest path; it is additive metadata only, and the check is that node/edge counts are byte-identical before and after. (2) `trace_flow` changing its default direction is a behaviour change for existing agents — mitigated by keeping the return shape, printing the new default in the tool description, and landing it in the same chunk as the MCP printer so a reconnect gets both.

---

## 9 · The chunks — lane B5

`feat/dependency-impact`, cut from `main` after lane B4. B5.0 is this document (4 h, done). Definition of done per chunk is the phase's: the diff stays inside the lane's files, `pnpm build && pnpm -r typecheck && pnpm -r test && pnpm lint:strings` green from the lead's shell, no frozen contract's shape changed.

| chunk | commit | files | the check that says it is done | h |
|---|---|---|---|---|
| **B5.1** | `feat(parsers,core): stamp the edges the adapters already know` | `parsers/src/tsjs.ts` (call/render/guard/validate stamping), `parsers/src/shared/sql.ts` (`raw-sql`), `parsers/src/java/*` where free, `core/src/graph.ts` (`ResolutionTechnique` +`raw-sql · same-file · detected · jsx-render`), `docs/contracts/farsight-diff-v1.md` (the enum paragraph), `parsers/test/classes-sql.test.ts` + `resolution.test.ts` (new) | a fresh ingest of `examples/invoice-app` and of the reference app has **identical node and edge counts** before and after, and the unstamped share of non-`covers` edges falls from the measured 83.1% (the reference app) / 86.3% (dogfood) — the new number recorded in the handoff, no target invented here; every new technique appears in the diff contract | 6 |
| **B5.2** | `feat(core): impactOf by hop, cut points, path strength; farsight-impact-tests v1` | `core/src/impact.ts` (new), `core/src/index.ts`, `docs/contracts/farsight-impact-tests-v1.md` (new), `schemas/farsight-impact-tests-v1.schema.json` (new), `core/test/impact.test.ts` (new) | on the `journey-honest` fixtures: setup and deferred edges excluded by default and included on request; a shared node is a `shared` cut with its `behind` count; `strength` over an unstamped edge is `{tier:null, unstamped:n}` and never a tier; `hops` carries no total; the envelope validates against the schema in `validate.ts` | 7 |
| **B5.3** | `feat(cli,mcp,server): farsight impact; impact_of by hop; trace_flow hop-ranked; /api/impact` | `cli/src/cli.ts` (new `impact` case), `mcp/src/run.ts` (`impact_of` 484-495, `trace_flow`), `server/src/index.ts` (`GET /api/impact?node=&hops=&tests=`), `cli/test/*` | `impact_of example-app::table::invoices` prints **9 / 15 / 24-behind-the-edge** with the not-walked block and no total; `trace_flow storeInvoiceDocument depth:3` returns **69**, not 395, and no `test` node; `farsight impact …submitDraftInvoice --hops 2 --tests --format json` validates and names `e2e/tests/api/invoice-submission.pw.spec.ts` with `fallback: "run-all"` and three `unselectable` entries | 6 |
| **B5.4** | `feat(viewer): the IMPACT tab, rings on the sheet, the business line` | `public/app/impact.js` (the stub becomes the panel), `surfaces/journey-drill.js` (`jrnInspTabs` + `jrnInspImpactHtml`), `surfaces/journeys.js` (sheet rings, halo chip), `viewer.html` (ring CSS — solid/dashed/dotted), `keymap.js` (`b` reaches it from the drill), `shell.js` (`?impact=&hops=`), `core/src/strings.ts` (13 new `impact.*`, 2 stubs retired, 7 `grammar.impactWords.*`), `scripts/lint-strings.mjs` (`impact.biz.*` under RULE 5) | on the reference app, live: the tab renders only when hops come back; rings pass a grayscale check; the business register shows the sentence and the journeys and **no identifier, file or hop arithmetic**; `?impact=…&hops=2` round-trips through `y`; zero page errors across three registers | 6 |
| **B5.5** | `docs: lane B5 acceptance on the reference app; the grammar rows; reshoot` | `docs/AI-HANDOFF.md`, `a design reference` (impact screens + MCP answers, **one build, one sync**, stamped in every caption), `docs/proposals/dependency-impact.md` (measured-vs-predicted deltas) | every number in §7 re-measured on the post-B5 build and written down, including the ones that moved; the pack is from one build against one sync (the 2026-09-23 swarm's blocker 9); `farsight status` clean on both servers | 3 |

**Total ≈ 28 h**, matching the lane's budget in `04-implementation-chunks.md`. B5.1 is new relative to that table and B5.2 absorbs the contract work the old B5.1 carried; the shape of the lane is otherwise unchanged.

---

## 10 · Where I disagree with the briefs

**10.1 · Key `i`.** Both swarm §3-D and 02-design-changes name `i` for impact. The shipped keymap has bound **`b`** since P2 and prints it in the `?` panel. One key per concept is the house rule; adding `i` as an alias makes two names for one thing, which is precisely what §3-B told the team to stop doing. **Keeping `b`.**

**10.2 · The `HIGH > MEDIUM > unstamped > LOW` ranking.** 01 §7 puts `unstamped` between MEDIUM and LOW. That asserts an unrecorded edge is better known than a `name-match` one, which nothing supports: 83% of edges record nothing, and they range from a same-file call (certain) to a `renders` edge inferred from JSX (very likely) to a detected guard (a shape match). **`strength` is a pair** — the weakest *recorded* tier plus a count of edges recording nothing — and B5.1 shrinks the second number instead of ranking it.

**10.3 · "Affected" as a headline word.** §3-D's *active / affected* pair reads like a prediction, and the 2026-09-23 swarm's own finding (the ERP arrow) is what a predictive word does to a reader. **Kept as a grouping label for hops ≥ 2 only**, defined on the Grammar page, never in a sentence with a verb of consequence. The headline words are *uses it directly* and *reaches it through others*.

**10.4 · Retiring `trace_flow`.** The staff engineer offered "hop-ranked or retire". I decline the retirement (§6): the tool is the only neighbourhood answer agents have, its question is real, and removing a tool consumers already call is a breaking change made for tidiness.

**10.5 · "40 of 79 e2e tests".** The exec's target sentence assumes e2e tests attach to the things a change touches. Measured: **zero** e2e tests reach any of the nine `invoices` accessors, and the one e2e file reaching submit's neighbourhood is a single spec. The sentence this design can earn is smaller and truer, and the gap is a fact about the reference app's suite that the Tests tab should carry, not one the impact answer should paper over.

**10.6 · The per-hunk `#/changes` view.** §3-D asks for impact per diff hunk in the Changes tab. `--changed` and the JSON support it, but the **surface** is deliberately out of lane B5: the Changes tab is `feat/change-history`'s (H5–H7), attribution there is already file-level, and stacking a second file-level inference on top of it in the same phase would put two floors in one sentence. Proposed as the first chunk of whatever follows, once both lanes have landed.
