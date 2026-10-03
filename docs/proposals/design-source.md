# Design source — screens, Figma and images as provenance on the journey

**Status:** landed 2026-09-05 (Pass C of [feedback-response-plan-2026-09.md](feedback-response-plan-2026-09.md)).
**Why:** the goal of Farsight is business and developers walking the *same* journey — screens the
business recognises, code and API calls and rules the developer trusts — around one product. A
design source lets a team see its journeys **before the first page ships** and, once pages exist,
see *built as designed* or not. Images and Figma frames are welcome on the screen cards: they are
**provenance attached to derived or declared screen nodes**, never a substitute for the derived
graph, and never image bytes inside the graph.

## 1 · The manifest is the authoring artifact

`docs/design/screens.json` (discovered by name — `screens.json` / `design.json` under `docs/` or
`design/` — or declared in `farsight.config.json → design: [{ manifest, name? }]`). Versioned,
reviewable, diffable, independent of Figma access. The design analogue of `openapi.yaml`.

```json
{
  "name": "the reference app's POC — Phase 1 Journeys",
  "figma": { "file": "https://www.figma.com/design/EXAMPLEFILEKEY0000000", "token": "env:FIGMA_TOKEN" },
  "screens": [
    { "id": "SCR-07", "name": "Quick submit", "route": "/submit",
      "url": "https://www.figma.com/design/EXAMPLEFILEKEY0000000?node-id=26-9",
      "image": "docs/design/scr-07.png",
      "operations": ["lookupContractorByVendorId", "createSubmission"],
      "phase": "1", "description": "No login: vendor lookup, upload with OCR confirm, submit." }
  ]
}
```

`flows[]` *(added the same day)* name a **feature** — `{ id, name, description, screens: [ids in order], docs: [repo paths or URLs], operations, phase, requires?: [flow ids], leadsTo?: [flow ids] }` (`requires`/`leadsTo` added 2026-09-05 for linked journeys; unknown ids are `flow-unknown` drift) — and become `flow` nodes (tags `entrypoint`, `flow`) that `renders` their screens in order: a journey from the flow walks the feature screen by screen, each screen continuing into its code or its planned calls; `screensFor()` returns the flow's screens in order for the SCREEN band; the design surface lists flows with *N of M built*. The authoring recipe is `designGuide()` in core, served by MCP `design_guide` and `GET /api/design/guide`.

Per screen: `id` (the name the docs use — required), `name`, **`route`** (the page's identity —
matched against `page` nodes however the adapter spelled params: `[token]`, `{token}`, `:token`) or
`component` (a component's name for a screen that is not a page), `url` or `nodeId` (Figma), `image`
(repo-relative PNG/JPG/SVG/WebP), `operations` (operationIds the design says the screen uses), `phase`,
`description`. Manifest schema v1 is frozen with this doc: fields may be added, never repurposed.

## 2 · Model — additive, on the same nodes

- One **`design` node** per manifest (kind `design`, like `api`), `contains` its screens.
- Each screen resolves to the **same `page`/`component` node the adapter emitted** and gains
  `node.design: DesignRef` — `status` **both** (designed + built) · **design-only** (designed, not
  built: a `page` node with no `loc`, tags `design-only`, `design:<id>`) · **code-only** (a page with
  no design row, only when a manifest exists). Plus `id`, `name`, `nodeId`, `url`, `image`
  (a reference, resolved by the server), `operations`, `phase`, `lastModified` + `freshness`
  (`figma` when the file's `lastModified` could be read; else `manifest`).
- **Drift, computed once at ingest** (`core/design.ts reconcileDesign`, re-run on demand for a
  proposed manifest): `design-only`, `code-only`, `operation-not-in-spec`, `operation-unreached`
  (built page never reaches an operation the design lists), `operation-undeclared` (built page calls an
  operation the design does not list — only when the design lists any).
- `@design <url|id>` on a page (Pass A) joins it explicitly when the route in code differs from the
  manifest; the manifest refines the annotation.

## 3 · Journeys light up by construction

- A **design-only page journeys**: `journey()` treats its `design.operations` as planned calls
  (`via:'planned'`, `planned.kind:'calls'`) into the real route nodes, which then continue as built
  steps or as their own planned steps (Pass B). A product sees screen → operation → gate → payloads
  before a line of UI exists.
- `/api/journey` returns **`screens`** — `screensFor(entry)`: the entry itself when it is a screen,
  else the pages/components upstream — each with its `design` so the viewer draws the **SCREEN band**:
  derived card + design chip (status · id · freshness) + the image when one resolves.
- Images: `GET /api/design/image?node=<pageId>` serves a repo-relative file path-confined, or a Figma
  render fetched with `FIGMA_TOKEN` (`GET /v1/images/:key?ids=<node>&format=png`) and cached under
  `.farsight/cache/design/`, refreshed when Figma's `lastModified` moves. No token → the deep link
  only, and the chip says freshness is unknown. Nothing is ever fetched into the graph.

## 4 · Surfaces

- **Journeys tab:** a *Designs* section per design source (flows first — *N of M screens built*, Run
  journey — then counts designed / built / not built, drift, and a *Designed, not built* list) — each
  flow and screen runs as a journey. **Journey overlay = the three-band blueprint** (the V3 P5 board,
  pulled forward): *What the user sees* (screen cards in order with image / Figma frame, design chip,
  ⧉ page and component code, ⧉ Open design, documents) · a labelled line of visibility · *The business*
  (description, documents, gates / rules / decisions in words, each jumping to its step) · *What the
  system does* (a horizontal lane timeline of screen → call → gate → step → record / message rows in
  execution order, planned rows dashed, above the detailed flow map) · *Records & messages* footer.
  `journeySummary()` in core is the one fold behind the HUD bands and the MCP `journey` output.
- **APIs tab:** consumer rows show the screen's design id.
- **Inspector:** the Design section (Pass A) gains the thumbnail.
- **CLI** `farsight design list|diff [--manifest <path>] [--repo <name>] [--strict]`.
- **MCP** `design_surface` (list, or one source's screens with status, operations, drift) and
  `design_drift` (ingest-time drift, or a proposed manifest on the fly). `describe_node` prints the
  design block (Pass A).
- **Settings:** source type `design` — a manifest as a source with no code (a design-only project).

## 5 · Honest states

- No manifest → nothing changes anywhere (no fog invented).
- Manifest, no pages yet → every screen is *designed, not built*; journeys are planned end to end.
- No Figma token → links only; freshness `manifest`; the image slot shows the link, not a broken image.
- A screen with no `route`/`component` is listed and flagged `unmatched`, never dropped.

## 6 · Acceptance

- The reference app: 31 declared routes + a manifest of their Figma screens → the Journeys tab lists every
  screen as *designed, not built*, each journey reads screen ⋯ operation ⋯ gate ⋯ payloads, all
  marked planned; `design list` counts 0 built; when `apps/web` ships a page at `/submit`, the screen
  flips to *designed + built*, its journey grows real steps, `farsight diff` says planned → built.
- Dogfood: `examples/invoice-app/docs/design/screens.json` — two built screens (one with an SVG
  wireframe image), one design-only screen listing `deleteInvoice`, one operation drift.

## 7 · Out of scope (stated)

Figma as content (components, tokens); generating screens from Figma; hand-placed screenshots on
code nodes that have no design row; per-viewer image uploads. Figma writes of any kind.
