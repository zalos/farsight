# V3 build plan — from boards to binary

**Date:** 2026-07-28 · **Status:** in build — P1 (snapshots + frozen diff contract) and P2 (viewer shell) landed 2026-07-29; P3 (scope + metrics + Portfolio) is next
**Inputs:** `a review` (F1–F16) · `a review` (G1–G20, §8 "what to do next") · `docs/proposals/feedback-response-plan-2026-07.md` · `a review` · Figma page *05 · V3 — the reprint* (frames `43:2` Blueprint Journeys, `49:2`/`51:2` Portfolio + light, `52:2` Code map + supply view, `54:2` Grammar Book v1.1, `55:2` Honest States v1.1, `56:2` Developer Trust v1.1, `57:2` Stewardship) · `the 2026-07 MCP agent review` (P0.1–P2.10).

**Standing commitments this plan must honour**

1. Sofia: *"No more boards until the boards are runnable."* Every item below is code.
2. Anna: the `farsight diff` JSON contract is **frozen and versioned before any Phase-2 UI**.
3. Marcus: the stewardship debt queue moves Phase 3 → Phase 2.
4. Every round-2 ADOPT is conditional on shipping **what was drawn** — the boards are the acceptance spec, not an aspiration.
5. F13 still applies to the product itself: numbers render from definitions with lineage, never as decorated literals.

---

## 1 · What the designs actually demand of the system

The nine V3 boards are not nine features. They are four **new capabilities in the core**, one **shell restructure**, and a set of surfaces that fall out of both. Reading the boards as engineering requirements:

| Board / promise | Capability it requires | Where it must live |
|---|---|---|
| Every KPI opens a provenance popover (formula · scope · as-of · origin · uncertainty · evidence) | **Metric definition objects** computed from the graph, with an evidence list and an *uncertainty range derived from what the parser admits it can't see* | `core/metrics.ts` (new) + adapters declaring blind spots |
| "≥ 64%", "SCOPE — Invoice systems" on every count | **A first-class scope model** shared by viewer, server, exports, MCP | `core/scope.ts` (new); today scope exists only in viewer `localStorage` |
| Supply view: `REACHABLE — resolved` / `heuristic · MEDIUM` / `UNRESOLVED — "?" stub`; tier appears in the diff JSON | **Per-edge resolution schema**, closed technique set, tiers, and stub synthesis for "we produced X, nobody consumes it" | `core/graph.ts` + every emission site in `parsers/` + a new merge-time `core/stitch.ts` |
| `SYNC 41 · commit 4677268`, pinned `@sync:41` links, `farsight diff --from sync:39 --to sync:41` | **Snapshots with ordinal sync ids + digests + as-of reads**, retention policy | `core/snapshots.ts` (new), `GraphStore` extension, every HTTP surface |
| Nav = Portfolio · Journeys · Code map · Changes; role-based landing; keymap; register toggle | **A viewer shell with routing, surfaces and a string catalog** — `viewer.js` is one 1,485-line file with a single implicit surface | `packages/server/public/app/*` |
| Three-band blueprint, derived SCREEN cards, 1:1 header, anchor rule | `journeySummary()` + `screensFor()` + a stated anchoring function | `core/query.ts` |
| Debt queue with owner + age, "no per-person aggregation" | Ownership harvest that **structurally cannot** emit per-person data, plus assignable state | `core/stewardship.ts` + `parsers/shared/git.ts` |
| Honest states: staged ingest, last-good on failure, SYNC FAILING ≠ STALE | **Sync lifecycle with progress events and atomic snapshot swap** | `packages/server` (SSE) + `core/snapshots.ts` |

Two things are *not* required by the V3 boards and are explicitly deferred (§7): npm/package nodes with `uses` edges (Concept C's freight lanes — the V3 supply view draws internal edges with confidence, not packages), and the canvas rendering surface (`packages/app`).

---

## 2 · Core-level updates (the load-bearing work)

### 2.1 Schema additions — `packages/core/src/graph.ts`

```ts
// ── resolution: how do we know this edge exists, and how sure are we ──
export type ResolutionTechnique =
  | 'static-import'    // HIGH  — importer resolved on disk / tsconfig paths / workspace pkg
  | 'fetch→route'      // HIGH  — client call site stitched to a route by method+path
  | 'db-builder'       // HIGH  — Drizzle/JPA builder chain or repository method
  | 'annotation-scan'  // HIGH  — @guard/@entrypoint/@covers, Spring annotations
  | 'DI-binding'       // MEDIUM— Java field-type → implementing bean
  | 'name-match';      // LOW   — last-resort symbol name match

export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EdgeResolution {
  status: 'resolved' | 'heuristic' | 'unresolved';
  technique: ResolutionTechnique;
  confidence: ConfidenceTier;
  /** unresolved only: what we considered and rejected/couldn't reach. May be empty — that is the point. */
  candidates?: string[];
  note?: string;
}

export interface GraphEdge {
  /* …existing… */
  resolution?: EdgeResolution;   // absent === legacy/unstamped; lint fails the build on absent (see 2.7)
}

export type NodeKind = /* …existing… */ | 'unknown';  // the "?" stub target

/** What an adapter could NOT see — the source of every uncertainty range in the product. */
export interface BlindSpot {
  kind: 'unread-config' | 'dynamic-dispatch' | 'unparsed-language' | 'bundled-output' | 'reflection';
  /** professional-register sentence, shown verbatim in provenance popovers */
  note: string;              // "4 routes sit behind Spring filter-chain config the parser doesn't read yet"
  affects: string[];         // node ids the gap touches
  metric?: string;           // metric id whose range this widens, e.g. 'guard-coverage'
}

export interface GraphFragment {
  /* …existing… */
  meta?: { files: number; sourceHash: string; blindSpots?: BlindSpot[] };
}
```

**Why `BlindSpot` is the keystone:** the boards' honesty ("at least 64% — true value 64–100%", "app-b: routes not yet indexed — shown as fog, never as zero") is currently a sentence a human typed into Figma. To render it from the product, the adapter that *knows* it skipped `SecurityFilterChain` config must say so in a machine-readable way. Every uncertainty range, fog region, and "not yet indexed" chip derives from this array. Without it we would be hand-maintaining the honesty — exactly the failure mode `docs/proposals/design-concepts-2026-07.md` prohibits.

### 2.2 Scope — `packages/core/src/scope.ts` (new)

```ts
export type Scope =
  | { kind: 'workspace' }
  | { kind: 'sources'; names: string[] }
  | { kind: 'collection'; name: string; names: string[] };

export function parseScope(param: string | null, settings): Scope   // "all" | "src:a,b" | "coll:Invoice systems"
export function serializeScope(s: Scope): string
export function scopeLabel(s: Scope, sourceCount: number): string    // "workspace · 4 sources" | "Invoice systems" | "invoice-app only"
export function repoOf(n: GraphNode): string
export function scopedIndex(index: GraphIndex, s: Scope): GraphIndex // cheap: filter nodes, rebuild adjacency
```

Viewer `repoOf()`/`scopedRepos()`/`inScope()` (viewer.js:22,56,78) collapse into calls against this. `?scope=` becomes a parameter on `/graph`, `/api/journey`, `/api/metrics`, `/api/impact`, `/api/diff` and an argument on every MCP tool. **G6 closes at the source:** any renderer that prints a count must ask for the count *and* `scopeLabel` in one call — enforced by making `computeMetric` return them together (§2.3), so a bare number is not obtainable from the API.

### 2.3 Metrics & provenance — `packages/core/src/metrics.ts` (new)

```ts
export interface MetricDefinition {
  id: 'sources' | 'indexed' | 'journeys' | 'guard-coverage' | 'guard-coverage-nonroute' | 'described';
  version: number;                    // "guard-coverage v1" — bumping is a visible event (Tom: "why did the number drop")
  labelKey: string;                   // string-catalog key, both registers
  formula: string;                    // "route entry points passing ≥1 permission gate ÷ route entry points"
  includes: string; excludes: string; // "scheduled + listener entries excluded"
  companionOf?: MetricDefinition['id'];
}

export interface MetricValue {
  def: MetricDefinition;
  scope: Scope; scopeLabel: string;
  numerator: number; denominator: number;
  value: number | null;
  bound: 'exact' | 'floor';           // floor ⇒ renders "≥ 64%" / "at least 64%"
  range?: [number, number];           // [0.64, 1.0] — derived from BlindSpot, never typed by hand
  uncertainty?: { note: string; affects: string[] };
  origin: { static: number; annotated: number; humanConfirmed: number };
  asOf: { sync: number; commit?: string; at: string; tz: string };   // tz always present (G12)
  evidence: { nodeId: string; name: string; loc?: Loc; note?: string }[];
  definitionChanged?: { fromVersion: number; was: string };          // "was 71% — 29 of 41, all entry kinds"
}

export const METRICS: Record<MetricDefinition['id'], MetricDefinition>;
export function computeMetric(index: GraphIndex, id: MetricDefinition['id'], scope: Scope, ctx: MetricContext): MetricValue;
export function allPortfolioMetrics(index, scope, ctx): MetricValue[];
```

`guard-coverage` v1, precisely: denominator = nodes with `kind==='route'` in scope; numerator = those with an inbound `guards` edge **or** whose first-hop handler has one; `bound='floor'` and `range=[value, 1]` iff any BlindSpot with `metric==='guard-coverage'` affects a denominator member; `evidence` = the ungated ones (the "Open evidence list — the 4 endpoints" button is literally this array). The companion metric (G13) is the same computation over `entrypoint`-tagged non-route nodes.

One module, four consumers: Portfolio KPI cards, the journey guard chip, export footers, MCP `metric_detail`. **No consumer computes a percentage itself** — that rule is what keeps the popover honest everywhere at once.

### 2.4 Snapshots & as-of — `packages/core/src/snapshots.ts` (new, SQLite-backed)

**Decision (D2): SQLite now**, pulling the ROADMAP's "core: SQLite persistence" item into this pass. Snapshots are stored as **SCD2 validity intervals, not copies** — the Snowflake-style mechanism from the research pass. This is the right call precisely because of what P1 needs next: the diff becomes a query over intervals rather than a full object-graph comparison, and retention becomes a `DELETE`, not a file sweep.

**Driver: `node:sqlite` (built-in).** No native module, no `better-sqlite3` in the install path of `farsight-cli` — the same posture that chose prebuilt tree-sitter WASM (ADR 6) and that the cost panel advertises. Cost: it is stable on Node ≥ 24 (flagged on 22.5+). Package `engines` moves to `>=24`, and `snapshots.ts` feature-detects: if `node:sqlite` is unavailable it falls back to a single-snapshot JSON path so `ingest`/`serve` still work (degraded: no history, no `as_of`, no diff — reported honestly, per our own rule).

```
.farsight/farsight.db      the snapshot history
graph.json                 ← still written for the latest sync (compat: serve/mcp/CLI unchanged)
```

```sql
CREATE TABLE snapshot (
  sync INTEGER PRIMARY KEY, at TEXT, tz TEXT, commit_sha TEXT,
  digest TEXT, files INTEGER, nodes INTEGER, edges INTEGER, pinned INTEGER DEFAULT 0);
CREATE TABLE snapshot_source (sync INTEGER, name TEXT, commit_sha TEXT, files INTEGER, status TEXT);
-- SCD2: a node/edge row is written once and closed when it changes or disappears
CREATE TABLE node (id TEXT, first_sync INTEGER, last_sync INTEGER, hash TEXT, json TEXT);
CREATE TABLE edge (key TEXT, first_sync INTEGER, last_sync INTEGER, hash TEXT, json TEXT);
CREATE TABLE blind_spot (sync INTEGER, kind TEXT, note TEXT, metric TEXT, affects TEXT);
CREATE INDEX node_alive ON node(id, first_sync, last_sync);
CREATE INDEX edge_alive ON edge(key, first_sync, last_sync);
```

```ts
export interface SnapshotRef { sync: number; at: string; tz: string; commit?: string; digest: string }

export class SnapshotDb {
  constructor(dbPath: string);                 // opens/migrates; throws SnapshotUnavailable if node:sqlite is missing
  write(store: GraphStore, ctx: {commit?: string; sources: SourceStat[]}): SnapshotRef;  // one transaction: close changed rows, open new ones
  read(ref: 'latest' | number): { store: GraphStore; ref: SnapshotRef };                 // WHERE first_sync <= N AND (last_sync IS NULL OR last_sync >= N)
  list(limit?: number): SnapshotRef[];
  pin(sync: number): void;                     // set when a pinned link is generated
  prune(policy: { keep: number; keepPinned: boolean }): number;
  changedBetween(base: number, head: number): { nodes: RowChange[]; edges: RowChange[] };  // ← P1's diff rides this
}
export function digestOf(store: GraphStore): string;   // sha1 over sorted node ids + edge keys + resolution tiers
```

- Row `hash` = sha1 of the node/edge JSON, so "unchanged" is a hash comparison, not a deep diff — `changedBetween()` is one SQL query and gives `diffGraphs()` its raw material for free.
- `GraphStore.meta` gains `sync`, `digest`, `commit`, `tz`. `GraphStore` itself stays an in-memory map — SQLite is persistence *behind* it, not a rewrite of it (the engine-interface discipline from ARCHITECTURE "Scale posture").
- Every HTTP surface accepts `?as_of=sync:41`; a pruned sync answers **410 with an explanatory body**, never 404-with-nothing (Sofia: "an audit link that 404s in six months is worse than no link").
- Needs a new ADR (7) in `docs/ARCHITECTURE.md`: SCD2 snapshot intervals + `node:sqlite` + the Node-24 floor.

### 2.5 Stitch & "?" stubs — `packages/core/src/stitch.ts` (new)

Runs once after all fragments merge (CLI ingest, server sync, MCP refresh — all three go through `ingestRepo` today; they will all call `stitch(store)`):

1. **fetch→route** across sources (today it only stitches within a fragment) → `resolution: {status:'resolved', technique:'fetch→route', confidence:'HIGH'}`.
2. **publish→consume** across sources by topic.
3. **Stub synthesis:** any `queue`/`external` produced in scope with no inbound `consumes` gets an `unknown` node `<repo>::unknown::<topic>` and an edge `{status:'unresolved', technique:'name-match', confidence:'LOW', candidates: []}`. This is `invoice.finalized → ? — no consumer in indexed sources` on board `52:2`, computed rather than drawn.
4. **Cross-source edge count** becomes a derived statistic (the board's honest `0`).

### 2.6 Diff — `packages/core/src/diff.ts` (new) + frozen contract

The contract doc is written and versioned **before** the UI (Anna's condition): `docs/contracts/farsight-diff-v1.md` + `schemas/farsight-diff-v1.schema.json` + golden fixtures.

```ts
export type ChangeKind =
  | 'route_added' | 'route_removed'
  | 'guard_added' | 'guard_removed'
  | 'journey_changed'
  | 'record_added' | 'record_removed' | 'record_columns_changed'
  | 'message_added' | 'message_removed'
  | 'rule_added' | 'rule_removed'
  | 'edge_confidence_changed'
  | 'node_renamed';

export interface DiffChange {
  id: string;                                  // "c1" — stable within a diff, referenced by permalinks
  kind: ChangeKind;
  severity: 'breaking' | 'notable' | 'info';
  confidence: ConfidenceTier | 'resolved';
  technique?: ResolutionTechnique;
  subject: { id: string; name: string; kind: NodeKind };   // stable id + display name (G11)
  journey?: { id: string; name: string };
  loc?: Loc;
  permalink: string;                           // …/compare/39...41#c1
}

export interface GraphDiff {
  schema: 'farsight-diff v1';
  base: string; head: string;                  // "sync:39 · 76f7674"
  truncated: boolean;                          // CI asserts on completeness (G11)
  counts: Record<ChangeKind, number>;
  changes: DiffChange[];
  gate?: { policy: string; result: 'pass' | 'fail'; exit: 0 | 1; rules: {rule: string; result: string; changes: string[]}[] };
}

export function diffGraphs(base: GraphStore, head: GraphStore, opts?: {limit?: number}): GraphDiff;
export function applyPolicy(diff: GraphDiff, policy: PolicyFile): GraphDiff;   // facts in the diff, judgment in policy
export function toSarif(diff: GraphDiff): object;
```

Fingerprints (content-hash rename/move stability) are declared **PLANNED** in the contract doc, not shipped — matching the board, which removed the claim rather than drawing fiction.

### 2.7 Two-register strings — `packages/core/src/strings.ts` (new)

```ts
export type Register = 'hud' | 'professional';
export interface StringEntry { hud: string; professional: string; define?: string; invariant?: true }
export const STRINGS: Record<string, StringEntry>;
export function t(key: string, register: Register): string;
```

Rules encoded, not just documented: keys under `sys.*` are `invariant: true` (errors, permissions — same words in both registers); export paths call `t(k, 'professional')` unconditionally; `define` supplies the first-use tooltip and feeds the jargon budget.

### 2.8 Ownership, without per-person data — `packages/parsers/src/shared/git.ts` (new)

```ts
/** Group-level ownership only. This function has no return path for a person identifier — F14 enforced by types. */
export function suggestOwners(repoRoot: string, paths: string[]): { path: string; group: string; basis: 'CODEOWNERS' | 'commit-history' }[];
```

CODEOWNERS teams are used directly. Where absent, commit history is read, mapped to a group via `farsight.config.json → ownership.groups` (path globs / email-domain rules), and **the person-level intermediate never leaves the function**. Diane's privacy edge and Sofia's OKR-ammunition guard both reduce to this signature.

### 2.9 Testing substrate (prerequisite for "contract-first")

The repo has no tests today. A frozen contract without golden fixtures is a promise, not a contract. Add zero-dependency `node --test`:

- `packages/core/test/diff.test.ts` — golden fixtures: two snapshot JSONs in, exact `farsight-diff v1` JSON out.
- `packages/core/test/metrics.test.ts` — guard coverage over `examples/invoice-app` = 5/5; over `spring-invoice-api` = 2/6 with a floor bound and one BlindSpot.
- `packages/parsers/test/resolution.test.ts` — every edge emitted by both adapters carries a `resolution` (the lint that makes §2.1 real).
- `pnpm -r test` already exists as a script; wire it per package.

---

## 3 · The viewer shell (`packages/server/public`)

`viewer.js` is one file, one surface, ~1,485 lines with 90+ top-level functions and `@group` JSDoc that the dogfood graph depends on. Four nav destinations, a register toggle, a router (pinned links must address `#/journeys/<entry>@sync:41`), and provenance popovers everywhere do not fit it.

**Plan: split into ES modules under `public/app/`, keep vanilla, keep the `@group` tags.** No build step, no framework, still Phase 1 disposable — but with seams.

```
public/
  viewer.html            shell markup: nav, chrome (sync chip, READ-ONLY, register toggle, Share, ⌨), surface mount
  app/
    shell.js             hash router + nav + chrome + role-based landing        @group Shell
    store.js             GRAPH / SCOPE / REGISTER / AS_OF + fetch layer         @group Shell
    strings.js           t() over the catalog served from /api/strings          @group Grammar
    sym.js               SVG symbol sprite accessors (12 symbols + status glyphs) @group Grammar
    provenance.js        metric chip + popover (one component, all metrics)     @group Provenance
    share.js             pinned/live link, PNG/PDF export, embed card           @group Share
    keymap.js            b · j/k · f · ⌘K · y · ?  + the published panel        @group Keymap
    impact.js            change-impact panel (button, right-click, `b`)         @group Change impact
    surfaces/portfolio.js  codemap.js  journeys.js  changes.js  stewardship.js
    lib/graph-render.js  the existing node-card/lane/edge renderer, extracted   @group Graph rendering
```

Routes: `#/portfolio` · `#/journeys/<entryId>` · `#/codemap?repo=x&view=map|supply` · `#/changes/39...41` · any route accepts `@sync:N` and `?scope=`. Deep link always overrides the role-based default landing (Power BI rule from the research pass).

Server serves `/app/*.js` via a path-confined static handler (same confinement discipline as `sliceFromDisk`).

**Grammar Book as a live fixture:** a `/grammar` route renders every symbol, every status glyph, and every string in both registers from `sym.js` + `STRINGS`. It is the lint fixture G7 demands — a symbol or string that isn't in the book cannot render, because there's no other source for it.

---

## 4 · The passes (branch per pass, dependency-ordered)

Each pass = one `feat/…` branch, conventional commits, merged `--no-ff`, ending with: dogfood re-ingest, `docs/FEATURES.md` + `ROADMAP.md` updated, and the findings it closes named in the merge commit.

---

### P1 · Snapshots + the frozen diff contract — *core + CLI only, no UI*
**Closes:** G11, F1b, Anna's ADOPT condition, part of Sofia's escape hatch. **Size:** M–L.

**Files:** `core/snapshots.ts` (new, SQLite per §2.4), `core/diff.ts` (new), `core/store.ts` (meta: sync/digest/commit/tz), `cli/cli.ts` (+`diff`, +`gate`, +`snapshots`, `--as-of`), `package.json` (engines → `>=24`), `docs/ARCHITECTURE.md` (ADR 7), `docs/contracts/farsight-diff-v1.md` (new), `schemas/farsight-diff-v1.schema.json` (new), `core/test/*` (new), `.github/actions/farsight-gate/` (thin CI wrapper, optional this pass).

**Work:**
1. SQLite snapshot store per §2.4 — schema + migration + `SnapshotDb`; `syncSources` and `farsight ingest` write through it; `graph.json` keeps being written so `serve`/`mcp` regress in nothing; feature-detect `node:sqlite` with an honest degraded mode.
2. `diffGraphs()` per §2.6, built on `changedBetween()`, keyed on node ids with display names alongside; `journey_changed` computed by comparing `journeySummary()` step lists (structural, not textual).
3. Policy: `compliance.yml` (repo-owned) → `applyPolicy()` → exit code. Facts/judgment split is the whole point; the diff never decides.
4. `farsight diff --from sync:39 --to sync:41 --format json|sarif|md`, `farsight gate --policy compliance.yml`.
5. Golden fixtures over `examples/invoice-app` at two commits.

**Acceptance:** the exact JSON on board `56:2` is reproducible from the dogfood repo (modulo real values); schema file validates it; `truncated` and per-change `confidence` present; contract doc marks fingerprints PLANNED.

---

### P2 · Viewer shell: four tabs, two registers, one grammar
**Closes:** F2, F6, F7 (landing), F12, F15, G3 (nav decision), G7, G16 (keymap), G19. **Size:** L.

**Files:** `viewer.html` rewrite of chrome + mount; `public/app/*` per §3; `core/strings.ts`; `server/index.ts` (static `/app/*`, `/api/strings`, `/grammar`); `scripts/lint-strings.mjs` (new).

**Work:**
1. Module split — mechanical but touches everything; preserve every `@group` tag (dogfood surface) and add groups for new modules.
2. Hash router + nav (Portfolio · Journeys · Code map · Changes) + role-based landing in settings (`defaultSurface`), deep link wins.
3. String catalog + register toggle in chrome ("Professional terms · switch to HUD"); exports forced professional; `sys.*` invariant.
4. SVG symbol sprite: the 12 business symbols + `◉ ◷ ⏚ ⬣ ▲ ↗` status glyphs, always glyph+word; **all emoji removed from chrome** (🔒 ⑂ ⧉ → drawn). Amber policy (G19): amber = lens tint + attention family; STALE always clock+word; incomplete-arm terminal gets its own barred-ring glyph.
5. READ-ONLY chip + consequence subtexts on every action button; `?` keymap panel; `b`/`j`/`k`/`f`/`⌘K`/`y` bound centrally in `keymap.js`.
6. `/grammar` fixture page + `lint-strings.mjs` (no raw user-facing literal outside `t()`; ≤5 undefined terms per surface; every symbol used exists in the sprite).

**Acceptance:** every existing viewer capability still works after the split; `/grammar` renders the full book; lint passes; a fresh user can find "what does changing this affect?" without a keyboard.

---

### P3 · Scope + provenance + the Portfolio surface
**Closes:** G1, G5, G6, G13, G15, G18, F3. **Size:** L.

**Files:** `core/scope.ts`, `core/metrics.ts`, `parsers/**` (BlindSpot emission), `server/index.ts` (`/api/metrics`, `?scope=`), `public/app/provenance.js`, `public/app/surfaces/portfolio.js`, light-theme token audit in `viewer.html`.

**Work:**
1. Scope model; viewer scope selector rewired to it; every API takes `?scope=`.
2. Metric definitions + `computeMetric` + evidence lists.
3. **Adapter blind spots** — tsjs: bundled/unparsed sources (an Electron app), dynamic route registration; java: `SecurityFilterChain`/`WebSecurityConfigurer` files present but unread (this is exactly the 64–100% range). Each emits a `BlindSpot` with a professional-register sentence.
4. Portfolio: KPI row (sources · indexed · journeys · guard coverage · described) each with `ⓘ` popover and scope chip; per-source table with the same definitions at source scope; freshness legend glyph+word; attributed risk advisory with "Open evidence list"; cost-of-ownership panel (static content from the board, sourced to this doc — it is prose, not a metric, and is labelled as an estimate with a stated basis).
5. Light theme: audit every new token pair; ship the Portfolio light rendering as the projector proof.

**Acceptance:** every number on Portfolio opens a popover whose numerator/denominator/evidence are clickable into real nodes; no bare count renders anywhere (lint: `provenance.js` is the only module allowed to print a metric); `≥ 64%` on the chip, "at least 64%" in prose, range in the popover **and** in exports.

---

### P4 · Edge resolution, "?" stubs, and the Code map
**Closes:** G2, G3 (surface), F9, plus the supply view. **Size:** L.

**Files:** `core/graph.ts` (§2.1), `core/stitch.ts`, `parsers/src/tsjs.ts` + `parsers/src/java/index.ts` (stamp every edge), `parsers/src/aliases.ts` (technique reporting), `core/query.ts` (min-confidence filter), `public/app/surfaces/codemap.js`, `server` (`/api/codemap`).

**Work:**
1. Stamp `resolution` at every edge emission site — a table of emitter → technique → tier lives in the contract doc; the parser test asserts 100% coverage.
2. `stitch()` per §2.5; `unknown` node kind rendered as the "?" stub (dash + chip + desaturation — three redundant encodings, CVD-safe).
3. Code map surface: repo altitude with group cards (`src/ui`, `src/api`, `src/server`, `src/db` — derived from `effectiveGroup()`), keyboard-first j/k/⏎/b, ⧉ file:line on every card.
4. Supply-view toggle: edge rows with `REACHABLE — resolved` / `heuristic · TIER` / `UNRESOLVED — "?" stub`, technique chip on hover, min-confidence view toggle serialized into the permalink (CodeQL pattern).
5. The stated semantics block: "REACHABLE = call-graph reachable, not guard- or condition-aware in v1" rendered in-product, not just on the board.

**Acceptance:** `invoice.finalized → ?` appears without anyone typing it; cross-source edge count renders whatever it truly is; the confidence tier that appears on an edge is the same string that appears in `farsight diff` JSON for that edge.

---

### P5 · Blueprint Journeys v3 + share/export
**Closes:** G4, G8, G9, G10, G12, F1a, F4, F10 (button). **Size:** L.

**Files:** `core/query.ts` (`journeySummary`, `screensFor`, `anchorFor`, `sharedRecords`), `server` (`/api/journey` returns the summary; `/embed/*`), `public/app/surfaces/journeys.js`, `public/app/share.js`, `public/app/impact.js`.

**Work:**
1. `journeySummary()` — the 1:1 header: trigger (with screen), STEPS row where **gate, decision and message are first-class rows**, produces, used-by. Same shape feeds the MCP `journey` summary and the export payload (one truth, three consumers — G10 can't drift again).
2. `screensFor()` — walk upstream from the entry over `http`/`calls`/`renders` to `page`/`component` nodes; render the SCREEN band as **derived cards** with file:line + ⧉ + freshness. Never an image. (8/8 reviewer guard.)
3. Three bands + labeled LINE OF VISIBILITY in the business register; code lens keeps today's spliced timeline.
4. Anchor rule (`anchorFor`): a step anchors to the first line of its work inside the entry function; a step that is one named call anchors to the callee's definition. Stated in-product next to the file:line.
5. Journey identity (G9): names carry a source qualifier when ambiguous — computed by detecting duplicate display names across sources.
6. Share menu: pinned link (`@sync:N`, `y` copies it by default), live link, PNG/PDF export with a burned-in provenance footer (repo · commit · sync time + TZ · author), Confluence embed card that shows freshness before anyone clicks. Export renders professional register unconditionally. **Zero-dependency export path:** serialize the surface to SVG → PNG via canvas; PDF via a print stylesheet. No headless browser in the install path.
7. "What does changing this affect?" as a visible button on every step card (also right-click, also `b`).

**Acceptance:** the header STEPS row and the map name the same things in the same order; every step shows file:line + ⧉; nothing occludes the USED BY column; a pinned link opened tomorrow shows today's numbers.

---

### P6 · The Changes surface + change impact
**Closes:** F10, the "Changes" nav tab, D (Agent Ledger) v1. **Size:** M–L.

**Files:** `core/query.ts` (`changeImpact`), `server` (`/api/diff?from=&to=`, `/api/impact?node=`), `public/app/surfaces/changes.js`, `public/app/impact.js`.

```ts
export interface ChangeImpact {
  node: NodeRef;
  callers: NodeRef[]; callees: NodeRef[];
  records: NodeRef[]; messages: NodeRef[]; gates: NodeRef[];
  journeys: { id: string; name: string }[];
  sentence: string;   // "Changing this affects invoice finalization, the accounting ledger, and the customer email"
}
```

The Changes surface renders the **already-frozen** P1 contract — deliberately: the UI is a view over the JSON, so a UI change can never silently redefine the contract. Includes the diff-to-journey mapping, the policy verdict chip, and per-change confidence.

---

### P7 · Honest states + the sync lifecycle
**Closes:** F5, G8 (progress/stage agreement), G17. **Size:** M.

**Files:** `server/index.ts` (`/api/sync` → SSE), `core/snapshots.ts` (atomic swap, last-good), `.farsight/state.json`, `public/app/shell.js` (banners, fog), `core/config.ts` (escalation block).

**Work:** staged ingest events (`discover → parse → merge → stitch → metrics → save`) with a progress number **computed from files done/total** so the bar can't run ahead of its own stages; failed sync keeps the last-good snapshot and shows `⏚ SYNC FAILING` (never blanks the view, never dresses as STALE); minute-one state (machine-named/unconfirmed dashed borders + confirm-owner CTA); the viewer's own failure state; repo-owned escalation thresholds + channel-agnostic notify (`{type: 'webhook'|'slack'|'teams', …}` in `farsight.config.json`).

---

### P8 · Stewardship — the debt queue
**Closes:** G14, F8, F14. **Size:** M.

`core/stewardship.ts` + `parsers/shared/git.ts` (§2.8) + `.farsight/stewardship.json` + `surfaces/stewardship.js`. Debt items derive from the graph: ungated route entries, undescribed items (machine-named, unconfirmed), unresolved edges, suspect answers. Each carries age, suggested owner (group), and a verb-consequence action. Private completeness meter; the no-OKR / no-per-person boundary rendered as product copy with a link to the written policy (Tom asked for the document; it goes in `docs/POLICY.md`).

---

### P9 · MCP parity + scale exhibit
**Closes:** MCP P0.1–P0.4, P1.5–P2.10, G20, the round-3 asks. **Size:** M–L.

1. Output budgets + truncation markers + `limit` across all renderers; cap `graph_overview` entry points; dedupe overlapping source roots.
2. `read_source(node_id)` / `describe_node(code: true)` slicing `loc.line..endLine` with path confinement.
3. New/updated tools: `scope` + `as_of` arguments everywhere, `metric_detail`, `diff`, `path_between`, `journey(summary: true)`.
4. Scale exhibit: ingest a real 100k-line codebase (a second real app, 6,249 nodes, is the honest start), record layout determinism (seeded, run-to-run stable — state the seed and assert it in a test), publish timings.
5. Test⇄journey coverage matrix, degraded first cut: `@covers journey:<id>` declared links → CSV export (Anna's "pull one degraded audit artifact ahead of Phase 3").

---

## 5 · Sequencing at a glance

```
P1 contract ─┬─► P4 resolution ─► P5 journeys ─┬─► P6 changes ─► P9 MCP/scale
             │                                  │
P2 shell ────┴─► P3 portfolio ─────────────────┴─► P7 honest states ─► P8 stewardship
```

P1 and P2 are independent and can run in parallel (core+CLI vs viewer). Everything else has a real dependency: P3 needs the scope+metrics core and the shell; P4 needs the schema; P5 needs P4's confidence data and P2's symbols; P6 needs P1's contract; P7 needs P1's snapshot atomicity; P8 needs P3's metrics (debt = the negative space of the metrics).

Rough shape: P1–P3 is the "first runnable V3" milestone (Diane's screenshot + Anna's contract), P4–P6 is the developer half, P7–P9 the day-2 half.

---

## 6 · Decisions — settled 2026-07-28

| # | Decision | Outcome |
|---|---|---|
| D1 | Viewer architecture | **Split `viewer.js` into ES modules under `public/app/`, stay vanilla** (§3). Phase 2's canvas stays a separate bet; `packages/app` untouched. |
| D2 | Snapshot storage | **SQLite now** (§2.4) — SCD2 intervals via built-in `node:sqlite`, `graph.json` still written for compat, `engines` → Node ≥ 24, honest degraded mode if the module is missing. Pulls the ROADMAP's SQLite item into P1 and needs ADR 7. |
| D3 | Export rendering | **Zero-dep**: SVG → canvas → PNG, print CSS → PDF. A headless browser in the install path would contradict the cost panel we just published. |
| D4 | First branch | **P1 (contract) and P2 (shell) in parallel** — independent trees (core+CLI vs viewer). Portfolio (P3) lands next, on the metrics engine it needs. |
| D5 | Test runner | **`node --test`**, zero deps, wired into the existing `pnpm -r test`. |

---

## 7 · Explicitly out of scope (and why)

- **Package/dependency nodes + `uses` edges** (Concept C's freight lanes, npm-why, Sankey). The V3 supply view draws *internal* edges with confidence; package weaving is a follow-on pass once resolution metadata exists (it rides on P4's schema).
- **`packages/app` canvas surface / Rust engine.** Phase 2 per ROADMAP; nothing in the V3 boards needs them.
- **Content-hash fingerprints** in the diff — declared PLANNED in the contract, shipped later. Drawing them now would be the fiction the boards refused.
- **Test⇄journey inference** (graph-inferred links, suspect propagation). P9 ships the declared-`@covers` degraded cut only; inference is Phase 3.
- **Natural-language querying, glossary authoring UI, JetBrains/Zed links** — Phase 4, untouched by this feedback.

## 8 · Risks

1. **The module split (P2) touches the dogfood surface.** `viewer.js`'s `@group` tags are nodes in our own graph; a careless split changes the graph we demo. Mitigation: preserve tags verbatim, re-ingest and diff the farsight source before/after (P1's diff tool, dogfooded on its own arrival).
2. **Stamping every edge with a resolution (P4) is broad and mechanical.** Mitigation: the parser test asserts 100% coverage, so an unstamped edge fails the build rather than rendering as false confidence.
3. **Blind spots are a promise about honesty.** If adapters under-report, the ranges silently narrow and we ship the exact "clean number lie" the reviewers rewarded us for avoiding. Mitigation: each known gap is a fixture-backed test; adding a resolver requires removing its BlindSpot in the same commit.
4. **The Node-24 floor (D2).** `node:sqlite` is stable on Node ≥ 24; today `engines` says ≥ 22. Anyone on 22 loses history/`as_of`/diff. Mitigation: feature-detect and degrade honestly (single-snapshot JSON, surfaces state "history unavailable on this Node version") rather than crash — and say it in `GETTING-STARTED.md`, not in a stack trace.
5. **Scope creep from the boards' prose.** The boards contain a lot of sentences that are copy, not features. Rule: a sentence on a board becomes a string in the catalog; only a *computed* claim becomes code.

## 9 · Traceability

| Finding | Pass |
|---|---|
| F1a share/export · F1b diff/CI | P5 · P1 |
| F2 registers · F6 grammar · F15 salience | P2 |
| F3 provenance · F13 derived numbers | P3 |
| F4 round trip · F10 blast radius | P5 · P6 |
| F5 honest states | P7 |
| F7 landing/jargon | P2 (landing) · P2 lint (jargon) |
| F8 stewardship · F14 privacy | P8 |
| F9 edge confidence | P4 |
| F11 tests⇄journeys | P9 (degraded cut) |
| F12 view vs action · F16 one product | P2 |
| G1 Portfolio · G5 floor · G6 scope · G13 companion · G15 cost · G18 light | P3 |
| G2 supply view · G3 code map | P4 |
| G4 three bands · G8 hygiene · G9 identity · G10 1:1 header · G12 anchor rule | P5 |
| G7 grammar v1.1 · G16 keymap · G19 amber | P2 |
| G11 diff contract | P1 |
| G14 debt queue · G17 escalation config | P8 · P7 |
| G20 scale/determinism | P9 |
| MCP P0.1–P2.10 | P9 |
