# Blueprint timeline — the journey as one horizontal service blueprint

**Status:** landed 2026-09-05 on `feat/blueprint-timeline` — **option C (systems grid)**, plus linked journeys (prerequisite / next flows) and a time axis inside every segment (§7). Three design options on Figma page *06 · Blueprint timeline —
options (2026-09)* of [Farsight — Design](https://www.figma.com/design/VMHP6j8MpK9rVo3FJIL1bt);
runnable HTML mocks in `a design reference` (open `A.html`, `B.html`,
`C.html` in a browser at 1920 wide). Built as §4–§5 + §7 describe; `segments[]` also carries `systems[]` (the rows) and `links`, and a rendered component inside a screen is a *marker* of that screen's segment, not a segment of its own.

## 1 · What is wrong today

The design-source pass landed the three bands (*what the user sees · the business · what the system
does*) as three **independent** rows above the old vertical map, and left the code timeline on the
right untouched. On the reference app's "Submit an invoice" flow (3 screens, 66 steps, 62 planned) that reads as
disjointed — see `today-hybrid.png` / `today-business.png` in the design references:

- **Nothing lines up.** Band 1 is a horizontal row of screen cards, band 2 is a vertical chip list,
  band 3 is a second horizontal lane of 66 tiny cards. A screen never sits above the calls it makes,
  so the reader cannot answer "what happens when the contractor presses Submit?" without hunting.
- **The gates band is noise.** Twelve identical `contractorSession (planned)` chips, one per route,
  when the business fact is "this screen requires a signed-in contractor" — once per screen.
- **The system lane is unreadable.** 104-px cards with truncated names; in the hybrid lens the map
  pane is 38% wide so only 2½ screens are visible and the lane needs a horizontal scroll.
- **The right pane is 62 nested "DECLARED IN THE SPEC — NOT YET BUILT" cards.** For a designed-but-
  unbuilt flow the code timeline has no code, yet it takes 62% of the screen and repeats the flow's
  description and six document links already shown in band 2.
- **Screens and system are in different registers.** The screen cards speak design (SCR-07, Figma,
  manifest freshness); the system cards speak graph (route ids, depth indent). There is no visible
  join between "the screen" and "its calls" other than reading order.

The data underneath is right (the fold in `journeySummary()` is the one truth for HUD + MCP). The
layout is what fails the usability test.

## 2 · The idea — segments on one timeline

One horizontal timeline, left → right, **one vertical segment per screen the user touches**, three
swimlanes stacked inside every segment:

```
            ┌ segment 1 · SCR-07 ─┬ segment 2 · SCR-04 ─┬ segment 3 · SCR-08 ─┐
USER SEES   │ screen card + image  │ screen card + image  │ screen card + image  │  ⧉ Figma · ⧉ page code
── line of visibility ────────────────────────────────────────────────────────
BUSINESS    │ ▶ gate → step →      │ gate → step →        │ gates → step ■       │  flowchart, in words
SYSTEM      │ 11 calls · records   │ 6 calls · records    │ 2 calls · records    │  contract / code on click
```

- A **segment** = one screen and everything the walk does until the next screen: the calls it makes
  (built or planned), the gates it meets (deduped by name), the decisions, rules, records, messages
  and third parties it touches. For a design-only flow the segments come from the flow's screens; for
  a built journey they come from the `screen` rows already on `summary.system.timeline` (a page or
  component step opens a new segment; steps before the first screen form a segment of their own —
  a route entry, a queue consumer).
- The **user lane** is the SCREEN card as it exists today (derived node + design chip + thumbnail +
  ⧉ design / ⧉ page / components / docs). Unchanged content, new position.
- The **business lane** is today's business-lens flowchart, laid horizontally, one slice per segment:
  ▶ start, gate checkpoints, a verb + sentence for the step (`businessSummary()` of the screen; the
  flow's `@business`/design description), decision diamonds with their arms, rule shields, ■ end.
  Documents dock on the lane label, not repeated per segment.
- The **system lane** is the segment's calls as compact route rows (method · operationId · path ·
  returns) followed by a records-and-messages footer. Dashed = declared, not built. Clicking a call
  opens its contract (spec-only) or its spliced code timeline (built) without leaving the timeline.
- **Lenses** keep their meaning: business lens = big thumbnails, full flowchart, system lane folded
  to counts; code lens = user lane folded to a chip strip, business lane folded to gate chips, system
  lane expanded with the code open; hybrid = balanced. The line of visibility is drawn in every lens.
- **Keyboard:** `j`/`k` move along the timeline by *screen* in the business lens and by *step* in the
  code lens; `b` still asks "what does changing this affect?".

Everything above is a fold of data the server already returns. No new parsing, no new node kinds.

## 3 · The three options (Figma page 06)

### A · Blueprint board — *recommended*

The classic service blueprint: all segments visible as equal columns, lane labels sticky on the left,
horizontal scroll when there are more than ~3 screens, a **bottom drawer** for the selected call's
contract (left) and code (right). Best for the business reader and for export/print (it is one
picture). The right-hand code pane goes away; code lives in the drawer, scoped to the selected step.

Board: `A.html` / node `66:2`. Costs: a segment with 11 calls needs folding ("+ 4 more calls") to keep
columns level; long flows (Route 2b has 8 screens) scroll sideways.

### B · Focus rail

A compact rail on top — every screen a stop with a thumbnail, counts, and a fill bar for how far the
reader has walked — and **one segment expanded** below it as three stacked bands, with today's code
timeline on the right scrolling only that screen's steps. `j`/`k` move the focus. Least change to the
existing overlay (the right pane survives), best for the developer working one screen at a time.
Weakest for the business reader: the whole flow is never on screen at once, the flowchart is one
segment long.

Board: `B.html` / node `67:2`.

### C · Systems grid

A's columns, but the system lane splits into **one row per system** the journey touches — web app,
API (per spec), records, messages, third parties, another repo when the walk crosses sources — so a
call lands as a marker in its system's row under its screen, like a sequence diagram. Contract / code
expand **inline as a row**. Best answer to "which systems and APIs are involved"; rows appear only for
systems the graph actually contains (the reference-app board shows the honest empty rows).

Board: `C.html` / node `68:2`. Costs: a segment with 11 calls wraps to three lines of small markers;
the row-per-system only earns its space on multi-source journeys.

### Recommendation

**Build A, take C's row-per-system as a toggle on the system lane, and take B's rail as A's column
header strip.** Concretely: A's layout; the segment header row *is* B's rail (thumb, name, counts,
progress); the system lane defaults to A's call list and switches to C's grid when the journey
touches more than one repo or an external host (or on demand). One layout, one mental model, and the
honest empty states come for free.

## 4 · Server — `segments[]` on `journeySummary()`

The only contract change. Additive, on the same fold that feeds the MCP `journey` tool, so the agent
prints the same segments the HUD draws.

```ts
export interface JourneySegment {
  /** the screen this segment belongs to (page/component/flow row), or null for steps before the first screen */
  screen: JourneySummary['user'][number] | null;
  /** first and last timeline order in this segment */
  from: number; to: number;
  calls: { nodeId: string; name: string; method?: string; path?: string; contractStatus?: string; planned?: boolean; stepOrder: number; repo: string; system: string }[];
  gates: { name: string; planned?: true; count: number }[];        // deduped by name
  rules: { id: string; name: string }[];
  decisions: JourneySummary['business']['decisions'];
  records: JourneySummary['system']['records'];
  messages: JourneySummary['system']['messages'];
  externals: JourneySummary['system']['externals'];
  /** systems touched, in first-seen order: repo names, api ids, external hosts, 'records', 'messages' */
  systems: string[];
  counts: { calls: number; planned: number; gates: number; decisions: number };
}
// JourneySummary gains: segments: JourneySegment[]
```

Rules: a `screen` timeline row opens a segment (the entry flow row does not); items are bucketed by
`stepOrder` between screen rows; gates dedupe by name within a segment and carry a count; `system` on
a call is `contract.apiId` for a spec-backed route, the repo for a built one, the host for an external.
Screens with no calls (SCR-01, static copy) still get a segment — an empty system lane is a fact.
`counts.gates` on the summary changes meaning from "gate edges" to "distinct gates" — it is what the
header prints, and 12 identical chips was the bug.

## 5 · Viewer build sketch (one pass, `feat/blueprint-timeline`)

1. **core** `journeySummary()` → `segments[]` + tests on the two fixtures (invoice-app built journey:
   4 segments incl. one before the first screen; reference-app-shaped design-only flow: 3 segments, gates
   deduped to 1/1/2). MCP `journey` prints segments as headed sections.
2. **viewer** `surfaces/journeys.js`: `jrnBlueprintHtml` becomes `jrnTimelineHtml(summary)` drawing
   the grid (lane labels × segments); `jrnScreenCardHtml`, gate/decision/rule pieces from
   `jrnFlowHtml`, and the call row are reused, not rewritten. The code pane becomes the drawer
   (`jrnDrawer(stepOrder)`) that renders `jrnSectionHtml(i)` for the selected step and the contract
   block for a planned one. `data-order` stays on call rows so scroll-sync, `j/k` and the forks drawer
   keep working. Lens CSS on `body.lens-*` folds lanes. Strings through `t()`, symbols through `sym()`
   (`pnpm lint:strings`).
3. **Journeys tab**: unchanged, except *Run journey* on a flow lands on segment 1.
4. **Acceptance:** on the reference app's "Submit an invoice" the header, the segments and the MCP print name the
   same three screens with 11 / 6 / 2 calls and 1 / 1 / 2 gates; on invoice-app `/invoices` the
   segments carry 3 records, 1 message, 5 decisions in the business lane; the business lens shows the
   whole flow on one 1920-wide screen for a 3-screen flow; nothing hand-placed, nothing invented.

## 6 · Out of scope

Reordering screens by hand; drawing arrows between arbitrary cards; per-viewer layouts; export
(P5's share/export item picks this layout up as-is); any change to the manifest format.

## 7 · Decision (2026-09-05) and two additions

**C · Systems grid** is the direction: it is the cleanest, and the row-per-system lane is the
honest answer to "which systems and APIs are involved". Two things the build must keep in mind:

- **Linked journeys.** A flow rarely stands alone: *Submit an invoice* has *Sign in with email* as a
  prerequisite and *Track an invoice* as what happens next. The timeline shows them as slim link
  columns at either end (◀ prerequisite · next ▶), each running that journey on click. Links come
  from the manifest when declared (`flows[].requires`, `flows[].leadsTo` — flow ids, additive to
  schema v1) and are **derived** otherwise: a flow whose screens sit immediately before / after this
  flow's screens inside a longer declared flow (Route 2b contains sign-in → submit → track). A screen
  entry also lists the flows it is *part of*. Nothing is invented: no containing flow, no link.
- **Time inside a segment.** One screen can carry several moments — pick the vendor, upload, confirm
  the OCR cards, attach documents, submit — each with its own visual and its own calls. The system
  rows keep every marker in execution order on one time axis per segment (the design's operation
  order for a planned screen, call-site order for a built one), and the segment header is a rail
  stop with a progress bar. Multiple visuals per screen (states / moments) are a manifest addition
  for a later pass; the segment layout leaves room for them as sub-columns.
