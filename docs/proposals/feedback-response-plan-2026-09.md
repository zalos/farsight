# Farsight — Response plan: design intent in journeys (September 2026)

**Input:** a review
— the reference-app consumer's research report on representing UI, Figma and design docs in Farsight
journeys, written after their OpenAPI contract landed and before their first page exists. §4 of that
doc is the feedback list; this plan triages it against the code as of `main` (`15274d4`).

**Read of the room:** the consumer tested the OpenAPI surface the week it shipped and it held —
declared routes are in the graph, consumers walk back to screens on the dogfood app, the empty state
is "honest and correct". Every ask is about the same gap: *intent that exists before code* (a spec's
description, a Figma screen, a capability URL's gate) is either invisible or shows up as a leaf with
no story. Nothing attacks the principles; the report explicitly restates them (derived screens, never
images; provenance on derived nodes, never content). Three of the five items are papercuts we can
close in a day; one is a real feature (planned journeys); one is a new source type (design) that is
the exact twin of the OpenAPI pass and belongs on the roadmap next to P5.

---

## 1 · Triage — each item verified against the code

| # | Ask | What the code does today (verified) | Becomes | Size | Priority |
|---|---|---|---|---|---|
| 4a | Spec `summary` should be the headline for spec routes | `businessSummary()` (`core/query.ts:321`) prefers `facets.business.description`, then the first sentence of `docs`, then `contract.summary`. `applySpecs` puts the spec **description** into `docs` (`core/openapi.ts:434`), so the long form wins over the authored headline. Consumer works around it by repeating the summary as the first description sentence. | When `contract.summary` exists and no `@business` was authored, summary wins; description stays the long form in `docs`. | XS | **P0** |
| 4b | HUD `/api/journey` takes only exact ids | `server/index.ts:281` does `index.byId.has(entry)` and 404s; the MCP `resolveJourneySeed` falls back to `search()` and picks the first runnable kind. | Share one resolver in core (`resolveEntry(index, query)`); the HUD returns the resolved id in the payload so the URL can canonicalize. | XS | **P0** |
| 4c | `counts.declared: 0` next to `declaredOnly: 31` reads as a bug | Two count objects use `declared` for different things: `reconcile().counts.declared` = all declared operations (`openapi.ts:395`); `apiSurface().counts.declared` = operations with status `declared` (spec-only *source*), `declaredOnly` = status `spec-only` (`openapi.ts:754-755`). The reference app declares its spec through `farsight.config.json → openapi`, so its routes are `spec-only` and `declared` is 0. | One vocabulary: `declared` = every operation the spec names (all statuses), `implemented`, `notImplemented` (was `declaredOnly`), `undocumented`, plus `specSource: true` on a spec-only source instead of a count. CLI/MCP/viewer read the same names. | S | **P0** |
| 4d | Surface `x-phase` / `x-internal` | No `x-*` extension is read anywhere in `parsers/openapi` or `core/openapi.ts`. | Harvest operation-level `x-*` into `contract.extensions` and mirror scalar ones as tags (`phase:2`, `internal`); searchable, filterable, printed by `describe_node`. | S | **P0** |
| 3a | `@see` should be a link | `shared/docs.ts:110` collects `@see` targets into one text line inside `docs`. Viewer prints `docs` escaped (`graph-render.js:329`), journey cards likewise. | Keep `docs` as prose; add `links?: {kind:'see'\|'design', url?, ref?}[]` on the node; viewer/journey/MCP render URLs as anchors (external ⧉ glyph in the symbol sprite, register-invariant). | S | **P0** |
| 3b | A sixth tag, `@design <url\|id>` | Only the five tags + vanilla harvest exist. | `@design` harvested by the shared layer for every adapter; lands in `node.design` (see §2). Surfaced on the SCREEN card, the inspector, `describe_node`. | S | **P0** |
| 5 | Config-declared gates for capability URLs | `config.guards` matchers only ever convert **functions** (`config.ts:47`, `node.kind !== 'function'` skips). A declared route with `{token}` in the path renders ungated; drift only knows `security-*` from the spec. | Accept `METHOD /path` matchers (route-shaped, like `glossary` already does): create a synthetic guard node `<repo>::guard::<label>` and a `guards` edge onto the route. `reconcile` treats config guards as the code side: a built handler with no guard while config declares one → `security-missing-in-code`; a config gate the spec never names → `security-missing-in-spec` only when the spec uses security. | S | **P0** |
| — | `trace_flow` seeds pull in off-topic scripts | `resolveSeeds` is name-match over the whole graph; no filter args. | Optional `repo` and `group` filters on `trace_flow` / `search_graph` / `journey` (the first step toward scope-aware MCP, already on the roadmap). | XS | **P0** |
| — | "Which graph am I looking at" | The sync chip shows `SYNC N · commit · ago`, never the graph path or workspace; `graph_overview` leads with freshness but not path. A second workspace's server on :4477 looked like a stale graph. | `meta.workspace` (dir basename) + `meta.graphPath` written by ingest/sync; chip title + `#/portfolio` header + `graph_overview` first line print them. `farsight serve` refuses to bind :4477 silently when another Farsight answers there with a different workspace (409 in the UI, not a stale render). | S | **P0** |
| 2 | Spec-only routes should still journey | `journey()` from a route with no `loc` and no out-edges is one step. The contract on that node already holds `security`, `summary`, `requestBody.schema`, `responses[].schema`. | **Planned steps** synthesized at query time from the contract (§3). Dashed in the viewer, `(planned)` in MCP, `planned → built` in `farsight diff`. | M | **P1** |
| 1 | A design source, the way OpenAPI is a source | No `design` field, no source type, no drift. Next.js pages are already named by route path (`<repo>::page::/submit`), so a route-keyed manifest reconciles by construction. `screensFor()` (P5) is where SCREEN cards will render. | **Design source pass** — `docs/proposals/design-source.md` when built (§4). Manifest + optional Figma freshness → `page`/`component` nodes with `design` + status; `design_drift` twin of `api_drift`; ⧉ for design next to ⧉ for code. | L | **P2** (schedule with P5) |

**Amended 2026-09-05 (owner's direction):** images and Figma frames *are* welcome on the journey —
they are what lets business and developers gather around the same screen. The rule that survives: an
image is **provenance attached to a derived or declared screen node**, never a substitute for the
derived graph, never bytes inside the graph, never a hand-placed picture on a code node with no design
row. The server resolves images on demand (a repo file, or a Figma render fetched with a token and
cached); freshness comes from Figma when it can, and says so.

---

## 2 · Schema additions (`packages/core/src/graph.ts`) — additive, no fork

```ts
export interface GraphNode {
  // …existing…
  /** Harvested references that are links, not prose: @see URLs, @design. Prose stays in `docs`. */
  links?: { kind: 'see' | 'design' | 'spec'; url?: string; ref?: string; label?: string }[];
  /** page/component nodes only: where this screen was designed + how the design and the code relate.
   *  Filled by `@design` (annotation) or a design manifest (source). Never carries an image. */
  design?: DesignRef;
}

export interface DesignRef {
  /** both = designed + built · design-only = designed, not built · code-only = built, not designed (only when a manifest exists) */
  status: 'both' | 'design-only' | 'code-only';
  /** owning `design` node id (the manifest/Figma file) — absent for a bare @design annotation */
  designId?: string;
  /** stable id the docs use ("SCR-07"), the Figma node id, the deep link */
  id?: string; nodeId?: string; url?: string; name?: string;
  /** Figma lastModified when the source could reach it; manifest mtime/commit otherwise. Always labelled with its origin. */
  lastModified?: string; freshness?: 'figma' | 'manifest';
  /** operationIds the design says this screen uses — checked against consumersOf() once built */
  operations?: string[];
  phase?: string;
  drift?: { kind: DesignDriftKind; message: string }[];
}

export type DesignDriftKind =
  | 'design-only'            // designed, no page/component at that route
  | 'code-only'              // page exists, no design row (manifest present)
  | 'operation-not-in-spec'  // manifest names an operationId the contract does not declare
  | 'operation-unreached'    // built page never reaches an operation the design says it uses
  | 'operation-undeclared';  // built page calls an operation the design does not list

export interface OperationContract {
  // …existing…
  /** operation-level x-* extensions, verbatim scalars/objects (x-phase, x-internal…) */
  extensions?: Record<string, unknown>;
}

export type NodeKind = /* existing */ | 'design'; // one node per design source (file/manifest), like `api`
```

`JourneyStep` gains `planned?: true` and steps may carry `plannedKind: 'gate' | 'step' | 'receives' | 'returns'`
with a `label` instead of a `nodeId` (§3). `farsight-diff v1` is unchanged in shape; a new entry kind
`contract-status` (`spec-only → both`) is added under the contract's own versioning rule — it is an
addition to the enum, documented in `docs/contracts/farsight-diff-v1.md` as v1.1.

---

## 3 · Planned journeys — from the contract, at query time (P1)

**Principle:** synthesize, don't invent nodes. A spec-only route's contract is authored fact; the
timeline renders what the contract commits to, marked as not built. No placeholder nodes enter the
graph, so counts, search and impact stay honest and nothing needs cleaning up when the handler lands.

`journey()` (pure, `core/query.ts`): when a step's node is a `route` with `contract.status` of
`spec-only` or `declared` **and** has no outgoing `calls`/`reads`/`writes`/`publishes`, append:

1. `gate` — one per `contract.security` entry (`bearer`, `oauth2: billing:write`), plus any config
   guard already attached (item 5 makes those real gates, not planned ones).
2. `step` — `contract.summary` (the authored headline; falls back to `operationId`).
3. `receives` — `requestBody.schema` name when declared ("receives SubmissionCreate").
4. `returns` — one per distinct `responses[].schema` with a 2xx status ("returns Submission").

Each carries `planned: true`, `depth+1`, `via: 'planned'`. Payload schemas are labelled as
**payloads**, not records — a DTO is not a table, and the blueprint's RECORDS band stays for
`table`/`topic` nodes.

Consumers: the viewer draws planned steps dashed with the `planned` chip and the professional-register
sentence "declared in the spec; not yet built" (same vocabulary family as fog: *we know what it should
do; we cannot show it running*). MCP `journey` prints `⋯ (planned) 🔒 bearer` / `⋯ (planned) Submit an
invoice`. `journeySummary()` (P5) counts planned steps separately.

`farsight diff`: when a route's `contract.status` moves `spec-only → both` between snapshots, emit a
`contract-status` entry (severity info) with the message "planned → built"; `both → spec-only`
(handler removed) is severity high. `gate` picks it up through the existing policy subset.

**Dogfood:** `examples/invoice-app/openapi.yaml` already declares operations with no handler (the drift
fixture); the golden test asserts their journey is `gate + step + returns`, and a second golden covers
the diff transition by adding the handler in the "after" fixture.

---

## 4 · Design source — the OpenAPI twin (P2, its own proposal when scheduled)

The consumer's §3b manifest (`docs/design/screens.json`) is the right authoring artifact: versioned,
reviewable, diffable, and independent of Figma access. Farsight ingests it exactly the way it ingests
an OpenAPI document, and the two reconcile against each other through `operations[]`.

**Config:** `farsight.config.json → design: [{ manifest: "docs/design/screens.json", figma?: { file: url,
token?: env } , name?: string }]`. Discovery by filename (`screens.json` / `design.json` under `docs/`)
like specs. A source may be `type: 'design'` with no code (design-only project) the way `openapi`
sources are.

**Manifest schema (v1, frozen once published):**

```json
{ "file": "https://www.figma.com/design/EXAMPLE…", "screens": [
  { "id": "SCR-07", "name": "Quick submit", "nodeId": "26-9", "route": "/submit",
    "operations": ["lookupContractorByVendorId", "createSubmission"], "phase": "1" } ] }
```

**Ingest (`parsers/design/`, pure reconcile in `core/design.ts`):** one `design` node per manifest;
for each screen, match `route` against `page` nodes by name (App Router pages are already
`<repo>::page::<route>`; React-Router/Angular pages the same; Java/Spring MVC views by mapping). Match
→ `design.status = 'both'`; no page → emit a `page` node with no `loc`, tags `design-only`,
`design:<id>`; page with no row when a manifest exists → `code-only`. `operations[]` is checked
against the contracts (`operation-not-in-spec`) and, for built pages, against `consumersOf()`
(`operation-unreached`, `operation-undeclared`). `@design SCR-07` on a page joins it explicitly when
the route differs from the manifest. Drift is computed **once** at ingest and re-run on demand for a
proposed manifest, mirroring `reconcile`.

**Freshness:** with a Figma token, one `GET /v1/files/:key?depth=1` for `lastModified` (fail-soft,
labelled `figma`); without, the manifest's commit/mtime (labelled `manifest`). Never an image fetch.

**Surfaces:** ⧉-for-design (a distinct glyph in the sprite, professional label "Open design") wherever
⧉-for-code appears — inspector, SCREEN cards, journey step cards, API consumer rows. Journeys tab lists
design-only pages under "Designed, not built" with their planned timeline (§3 chains: page → operations
→ planned steps — the consumer's *see journeys before the first page ships*). APIs tab consumer rows
show the screen's design id. CLI `farsight design list|diff [--strict]`; MCP `design_surface` /
`design_drift`; `describe_node` prints the design block. Portfolio (P3) gets a "designed / built"
KPI with provenance like every other number.

**Dogfood fixture:** `examples/invoice-app/docs/design/screens.json` with one `both`, one `design-only`,
one operation drift; `examples/claims-mini` gets the consumer's three routes as the Next.js shape.

**Sequencing:** lands with or immediately after P5 (Blueprint Journeys v3), because `screensFor()` is
the renderer the design cards need. Do not build it before `screensFor()` exists — it would ship a
second screen-card implementation.

---

## 5 · Passes

### Pass A · `fix/ui-journeys` — papercuts (P0) — **landed 2026-09-05**
Items 4a–4d, 3a, 3b, 5, `trace_flow` filters, which-graph chip. Files: `core/query.ts`
(`businessSummary`, `resolveEntry`), `core/openapi.ts` (counts vocabulary, extensions), `core/config.ts`
(route guards), `core/graph.ts` (`links`, `design`, `extensions`), `parsers/shared/docs.ts` (`@see` →
links, `@design`), `parsers/openapi/*` (x-*), `server/index.ts` (journey resolver, meta), `mcp/run.ts`
(filters, links/design output), viewer `graph-render.js` / `journeys.js` / `apis.js` / `shell.js`
(anchors, chip title), strings catalog entries for every new label, golden fixtures for each.
**Acceptance:** the reference app's `POST /api/v1/submissions/{id}/submit` headline is the spec summary without
the workaround; `/api/journey?entry=submitSubmission` resolves; `api list` prints `declared 31 ·
implemented 0 · not implemented 31`; `GET /api/v1/track/{token}` shows 🔒 `tracking token` from config
and `api_drift` stays quiet until a handler without a guard appears; `@see https://…` is clickable.

### Pass B · planned journeys — §3 (P1) — **landed 2026-09-05** (same branch)
`core/query.ts` (`journey` planned steps), `core/diff.ts` (+ contract doc v1.1), viewer journey
renderer + business flowchart (planned checkpoints/steps dashed), MCP `journey`, goldens.
**Acceptance:** the consumer's one-step journey becomes gate → step → returns, marked planned, in all
three consumers; `farsight diff` reports "planned → built" on the invoice-app fixture.

### Pass C · design source — §4 (P2) — **landed 2026-09-05** (same branch; pulled ahead of P5 at the owner's direction — `screensFor()` landed with it and P5 reuses it)
Own proposal doc first (`docs/proposals/design-source.md`), manifest schema frozen, then core →
parsers → server/viewer → CLI/MCP in that order, like the OpenAPI pass.

### Consumer-side guidance (send back with Pass A)
Their §3a plan is the right build order and needs no change from us: App Router pages per Figma row,
thin client functions named by `operationId`, figma-index sentence first in JSDoc, `@guard` on
resolvers, `@entrypoint email:magic-link`, `// @business` fork labels, `@covers` on Playwright specs.
Two adjustments once Pass A lands: use `@design SCR-07` instead of `@tag figma:SCR-07` (the tag form
keeps working), and drop the repeated-summary workaround in the spec descriptions.

---

## 6 · Roadmap and doc updates on landing
- `docs/ROADMAP.md` Phase 2: add "Design source (manifest + Figma provenance) → `design_drift`" and
  "Planned journeys from contracts"; mark `trace_flow` filters as the first scope-aware MCP step.
- `docs/ANNOTATIONS.md`: `@design` as the sixth tag; `@see` URLs documented as links.
- `docs/proposals/openapi-surface.md` follow-ups: counts vocabulary, `x-*` extensions, config route guards.
- `docs/contracts/farsight-diff-v1.md`: v1.1 `contract-status` entry kind.
- `CLAUDE.md` layout line for `core/design.ts` when Pass C lands.
