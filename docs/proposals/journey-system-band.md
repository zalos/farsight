# Journey · "What the system does" — reorganising the system band

*Draft for review · 2026-09-06 · follows [blueprint-timeline.md](blueprint-timeline.md) §7 (option C, system rows).*

The blueprint timeline landed with the third band — *What the system does* — as one row per
system the journey touches, every marker in execution order. It is honest, but on a built journey
it reads as a wall of chips. This note diagnoses why, states the one change already decided (the
API row moves above the method calls, with a link to each side of the seam), and drafts five ideas
for the rest, with a recommended sequence.

Reference journey throughout: `invoice-app` → *Invoice list* (`#/journeys/invoice-app::page::/invoices`),
the built fixture. **Boards:** every idea below is mocked on that journey's real data in
`a design reference`
(`today` · `A` … `F`, HTML + PNG, same viewer shell, only the band differs).

## 1 · What the band shows today, and why it is busy

One screen, one segment, and this is what the four rows hold:

| row                     | markers | of which repeats | note |
|-------------------------|--------:|-----------------:|------|
| `invoice-app` (repo)    | 19      | 6                | browser code **and** server code in one row |
| `API · Billing API`     | 6       | 1                | sits *under* the repo row |
| `records`               | 13      | 9                | `Invoices READS` ×7, `Invoices WRITES` ×4 |
| `messages`              | 1       | 0                | |

Thirty-nine chips for a page with six user actions. Five distinct causes, all structural — none is
a styling problem:

1. **Rows are in first-seen order, not request order.** The walk starts at a component, so the repo
   row is always first and the API row lands below it. The reader's mental model is *screen → API →
   service → records*; the band shows *code → API → records* with the code row holding both ends.
2. **One repo row holds both sides of the HTTP boundary.** `listInvoices` appears twice — once as the
   browser client (`src/api/client.ts:4`) and once as the server handler (`src/server/routes.ts:9`) —
   and nothing on the chip says which is which. The seam where the UX meets the API is the most
   important line in the whole journey and it is invisible.
3. **Markers flow-wrap, so vertical alignment is lost.** The API call, its handler, and the tables it
   touches are related by causation, but each row wraps independently; a marker on the records row
   sits under whatever the wrap left there.
4. **Depth is flattened.** `computeTax` and `nextInvoiceNumber` are helpers inside a handler; they
   get the same chip as the handler. `journey()` knows the depth (steps carry `depth`); the band drops it.
5. **Repeats are drawn as new events.** 15 of the 39 steps are `repeat: true` (the same node already
   walked). `Invoices READS` seven times in a row carries no information after the first.

Everything below keeps the two principles the band was built on: every fact comes from
`journeySummary()` (one fold for HUD + MCP), and nothing is drawn by hand.

## 2 · The decided change — API above the method calls, both ends of the seam linked

The request: move the API row above the code calls, because that row is where the UX meets the API,
and link each call to *where it happens in the UX* and *where it starts in the API*.

The data already has both ends. For every `via:'http'` step *N* on the journey:

- **the UX side** is `steps[N].callSite` — the `fetch()` line in the client (`src/api/client.ts:5`),
  inside the client function at step *N−1*;
- **the API side** is the route node itself (`src/server/routes.ts:8`, the Express registration)
  and its handler, step *N+1* (`via:'calls'`, depth+1, `src/server/routes.ts:9`).

So a call marker can carry `caller: {nodeId, path, line}` and `handler: {nodeId, path, line}` with
no new parsing — `journeySummary()` reads them off the neighbouring steps. Planned calls (the reference app)
have neither, which is exactly right: the seam has one built end at most, and the marker says so.

Row order becomes a fixed rank rather than first-seen. Proposed, top to bottom:

```
WHAT THE SYSTEM DOES
  ▸ the screen asks         browser-side code: components, client functions      (repo · ux side)
  ▸ API · Billing API       the operations called, with both ends of the seam    (api)
  ▸ the service does        handler + helpers behind the route                   (repo · server side)
  ▸ records                 tables read / written
  ▸ messages                queues, events, outbox
  ▸ third party             external hosts
```

That is the request path read downward. Idea A below is this change in full; every other idea
assumes it.

## 3 · Ideas

### A · Rows in request order, the repo split at the seam

**What it looks like**

```
                        │ 1 · Invoice list
────────────────────────┼──────────────────────────────────────────────────────────────────────
the screen asks         │ ▢ Invoice list page  ▢ List invoices  ▢ Create invoice form  ▢ Create invoice
invoice-app · browser   │ ▢ Edit invoice drawer  ▢ Get invoice  ▢ Update invoice  ▢ Finalize invoice  ▢ On save
────────────────────────┼──────────────────────────────────────────────────────────────────────
API · Billing API       │ ⇄ GET listInvoices   ⇄ POST createInvoice   ⇄ GET getInvoice
declared operations     │ ⇄ PATCH updateInvoice   ⇄ POST /invoices/:id/finalize   ⇄ PATCH updateInvoice ↺
────────────────────────┼──────────────────────────────────────────────────────────────────────
the service does        │ ▢ listInvoices  ▢ createInvoice ▸ computeTax  ▢ getInvoice
invoice-app · server    │ ▢ updateInvoice ▸ computeTax  ▢ finalizeInvoice ▸ nextInvoiceNumber
────────────────────────┼──────────────────────────────────────────────────────────────────────
records                 │ ▤ invoices reads ×7 · writes ×4   ▤ customers reads ×2   ▤ ledger_entries writes
messages                │ ✉ invoice.finalized
```

**What it fixes.** Causes 1 and 2. The reader now sees the two halves of one repo as two systems,
which is what they are at runtime (a browser and a server), and the API row sits on the seam
between them. Duplicate names stop being ambiguous because the row says the side.

**What changes.**

- `packages/core/src/query.ts` · `systemOf()` decides the side: a step is *server-side* when any
  ancestor on its path from the segment's screen crossed an `http` edge (or the node is a route or
  is reached via `consumes` — a queue consumer is server-side by definition). `SystemRow` gains
  `side?: 'ux' | 'server'` for `kind:'repo'`; keys become `repo:<name>:ux` / `repo:<name>:server`
  so a repo with only one side still gets one row. `systems[]` is sorted by a rank
  (`ux → api → server → records → messages → external`) then first-seen.
- `SegmentMarker` gains `caller?` and `handler?` on `kind:'call'` (§2).
- Viewer · `jrnRowLabel()` names the halves; `jrnSystemRowsHtml()` renders as before. Strings:
  `journey.row.ux` / `journey.row.server` (+ `rowSub.*`) in both registers.
- MCP `journey` prints the new order for free (same fold). The `farsight-diff v1` contract is
  untouched — the summary is not part of it.

**Lens.** Business: the two repo rows are counts (as today), the API row stays expanded — it is the
row a business reader can actually name. Code: everything expanded.

**Cost.** Small — one pass, mostly core. **Risk.** A single-repo full-stack app where the client and
server share helper functions (a `validate()` used on both sides): the same node lands in both rows
at different steps. That is true and fine; the marker's `data-order` keeps them distinct.

### B · Moments — one sub-column per user action inside the segment

**What it looks like**

```
                  │ 1 · Invoice list
                  │  ◦ list          ◦ create               ◦ open drawer     ◦ update           ◦ finalize             ◦ save
──────────────────┼────────────────┬──────────────────────┬────────────────┬──────────────────┬──────────────────────┬────────────
the screen asks   │ ▢ List invoices│ ▢ Create invoice form│ ▢ Edit drawer  │ ▢ Update invoice │ ▢ Finalize invoice   │ ▢ On save
                  │                │ ▢ Create invoice     │ ▢ Get invoice  │                  │                      │ ▢ Update ↺
API · Billing API │ ⇄ GET list     │ ⇄ POST create        │ ⇄ GET get      │ ⇄ PATCH update   │ ⇄ POST finalize      │ ⇄ PATCH ↺
the service does  │ ▢ listInvoices │ ▢ createInvoice      │ ▢ getInvoice   │ ▢ updateInvoice  │ ▢ finalizeInvoice    │ ▢ updateInvoice
                  │                │   ▸ computeTax       │                │   ▸ computeTax   │   ▸ nextInvoiceNumber│
records           │ ▤ invoices r   │ ▤ customers r        │ ▤ invoices r   │ ▤ invoices r/w   │ ▤ invoices r/w       │ ▤ invoices r/w
                  │                │ ▤ invoices w         │                │ ▤ customers r    │ ▤ ledger_entries w   │
messages          │                │                      │                │                  │ ✉ invoice.finalized  │
```

**What it fixes.** Causes 3 and 4 (and most of 5, because a moment is a natural dedupe unit). The
segment becomes a grid the eye can read in either direction: **down** a column is one transaction
(what the screen asked → the contract → the handler → what it touched → what it announced);
**across** a row is one system's part in the whole screen. Blueprint §7 already reserved this
room ("the segment layout leaves room for them as sub-columns").

**What changes.**

- Core · `JourneySegment.moments[]`: one per *top-level action* inside the segment — a step whose
  parent is the segment's screen (a rendered component or a direct call from the page) that leads
  to at least one call, record or message. Steps under it belong to the moment; a rendered
  component that makes no calls is a marker on the screen-asks row of the previous moment, not a
  moment of its own. Every marker gets `moment: number`. Label = the caller's business label or name
  (`Create invoice form`), the design's operation name once manifests carry moments (§7 again).
- Viewer · `jrnRowStyle()` nests a per-moment grid inside each segment cell; `JRN_SEG_W` becomes a
  minimum, segments widen with their moment count. Segment header shows moment stops under the name.
- MCP · `journey` prints moments as sub-headings inside a segment.

**Lens.** Business: moment labels + the API row + counts — the flowchart in the business band and
the moments line up (a decision diamond *is* a moment boundary). Code: everything.

**Cost.** Medium — the layout is the work; the fold is a few lines on top of A. **Risk.** Wide
segments on a page with many actions (the reference app's *Submit an invoice* declares 11 operations). Mitigate
with a moment cap per segment (+ "n more" that expands), and horizontal scroll is already the axis.

### C · The seam card — the API call as the hero marker, both ends linked

**What it looks like** (one marker on the API row, hybrid lens)

```
┌ ⇄ GET  listInvoices  · View invoices ─────────────── CONTRACT ┐
│ ← from  src/api/client.ts:5 ⧉      → handled  src/server/routes.ts:9 ⧉ │
└──────────────────────────────────────────────────────────────┘
```

and its expansion slot (click) opens **both ends spliced**, not the route alone:

```
STEP 3  View invoices  GET /invoices                                      ✕
 ← the screen asks · List invoices · src/api/client.ts:4 ⧉
    4  export async function listInvoices() {
    5 ↳  const res = await fetch('/invoices');
 ⇄ CONTRACT  GET /invoices · 200 Invoice[] · requires billing:read · implemented
 → the service does · listInvoices · src/server/routes.ts:9 ⧉
    9  router.get('/invoices', requireScope('billing:read'), (req, res) => listInvoices())
```

**What it fixes.** The second half of the decided change. The seam is the thing a developer opens
first ("which fetch, which handler?") and the thing a business reader can name ("the *View
invoices* operation"). One card answers both. The contract chip states declared / implemented /
undocumented, the drift vocabulary the APIs tab already uses.

**What changes.**

- Core · `caller` / `handler` on the marker (§2). Nothing else.
- Viewer · `jrnMarkerHtml()` gets a two-line variant for `kind:'call'`; `jrnExpHtml()` for a call
  splices caller line → contract → handler head using the same `jrnSectionHtml` splicer, with the
  existing `vsl()` ⧉ links. A `y` keypress already yanks; add ⧉ on both ends.
- MCP · `describe_node` on a route already prints the contract; `journey` gains `called from` /
  `handled at` on call lines.

**Lens.** Business: the card shows `View invoices · CONTRACT` and hides the file lines. Code: the
file lines are the card. **Cost.** Small. **Risk.** None new — it draws data already on the steps.

### D · Fold repeats and helpers; rows collapsed to a ledger until asked

**What it looks like**

```
records            │ ▤ invoices  reads ×7 · writes ×4    ▤ customers  reads ×2    ▤ ledger_entries  writes    ▸ show 13 in order
the service does   │ ▢ listInvoices   ▢ createInvoice ⟨+1⟩   ▢ getInvoice   ▢ updateInvoice ⟨+1⟩   ▢ finalizeInvoice ⟨+1⟩   ▢ updateInvoice ↺
```

Three folds, each a rendering rule over data the summary already has:

1. **Repeats** (`step.repeat`) draw as a ↺ ghost chip, or fold into the first occurrence as ×n on
   the records / messages rows where the *set* of tables matters more than the sequence.
2. **Helpers** (a step at depth > its row's entry depth for that moment) fold under their parent as
   ⟨+n⟩; the expansion slot lists them, `j`/`k` still walks them.
3. **Rows start folded** to a ledger line — distinct names with counts — and a row-level toggle
   (or the code lens) expands to the ordered markers. Today's business-lens count is this ledger
   with one number; the ledger keeps the names.

**What it fixes.** Cause 5 outright, cause 4 for helpers, and most of the raw chip count: the
reference segment goes from 39 chips to 14 folded ones without hiding a single fact.

**What changes.** Viewer only, plus `repeat` copied onto `SegmentMarker` (one line in core).
**Lens.** Business gets the ledger; code gets the ordered markers; hybrid gets the ledger with a
per-row expand. **Cost.** Small. **Risk.** A folded row hides *order*, which is the point of the
band in the code lens — hence folding is the hybrid/business default, never the code default.

### E · Outcomes hang off the call; records and messages become a ledger, not a timeline

**What it looks like** (API row card, expanded state)

```
⇄ POST  /invoices/:id/finalize  · Finalize invoice                       CONTRACT
   ← src/api/client.ts:29 ⧉    → src/server/routes.ts:27 ⧉
   reads invoices · writes invoices, ledger_entries · publishes invoice.finalized
```

The records / messages / third-party rows are still drawn, but as the deduped ledger of D.3
(what the *screen as a whole* touches), while the per-call detail lives on the call that caused
it. Causation is explicit in the data: a record/message marker's owning call is the nearest
ancestor step of `kind:'call'` on its path.

**What it fixes.** Cause 3 without a grid (an alternative to B for the alignment problem): the
reader never has to line up a records chip with the call above it, because it is *on* the call.

**What changes.** Core · `SegmentMarker.viaCall?: number` (the stepOrder of the owning call).
Viewer · call card footer; records / messages rows switch to ledger mode by default.
**Lens.** Business: the footer reads as a sentence ("records the invoice and the ledger entry,
tells the customer"). **Cost.** Small–medium. **Risk.** Steps *not* under any call (a page that
reads a table directly, a server-rendered app, a job entry) have no owner — they stay on the
ledger row as today. B and E compose: E's footer is what a B column shows when collapsed.

### F · Ladder view — the segment read top-to-bottom as a sequence

A toggle that turns one segment's system band on its side: systems as column headers, time
running down, one line per step, arrows across the seam. It is the sequence diagram every developer
draws on a whiteboard and the "stack trace with names" an onboarding developer asks for.

**What it fixes.** Depth and order completely, for one segment at a time. **What it costs.** A
second renderer for the same data and a mode switch to teach. **Why it is last.** B gives most of
the same reading inside the blueprint without leaving it, and the spliced expansion already shows
the vertical story for one path. Keep F as a code-lens option if B's grid proves too wide on real
apps; do not build it first.

## 4 · Recommendation and sequence

| idea | fixes causes | where the work is | size |
|------|--------------|-------------------|------|
| A · request-order rows, repo split at the seam | 1, 2 | core (`systemOf`, sort, `caller`/`handler`) + labels | S |
| C · seam card, both ends linked and spliced | 2 | viewer (`jrnMarkerHtml`, `jrnExpHtml`) | S |
| D · fold repeats / helpers / rows to a ledger | 4, 5 | viewer (+ `repeat` on the marker) | S |
| B · moments as sub-columns | 3, 4, 5 | core (`moments[]`) + layout | M |
| E · outcomes on the call | 3 | core (`viaCall`) + viewer | S–M |
| F · ladder view | 3, 4 | new renderer | M |

**Pass 1 — `feat/journey-system-band`: A + C + D.** Three small changes that share one core edit
and land the decided change completely. After it, the reference segment reads as six rows in
request order, the API row on the seam with a ⧉ at each end, and 14 chips instead of 39. The MCP
`journey` output improves in the same commit.

**Pass 2 — B (moments).** The structural fix for alignment, built on pass 1's rows. Pull the
manifest side (multiple visuals per screen, blueprint §7) into the same pass so a designed moment
and a built moment are the same column.

**Later — E**, once B shows whether the grid alone makes causation obvious; **F** only on evidence.

## 5 · Open questions

1. **Names for the two repo halves.** Working labels: *the screen asks* / *the service does*
   (business register) and *invoice-app · browser* / *invoice-app · server* (professional). A
   pure-API journey (a route entry, a queue consumer) has no *screen asks* row at all — is that
   right, or should the row exist and say *no screen — a system entry*?
2. **Business-lens default.** Today every system row is a count in the business lens. With A, the
   API row is the one a business reader can name. Should it be expanded by default there?
3. **Planned journeys (the reference app).** A declared-only route has an API side and no handler; the seam
   card shows *handled: not built yet*. Confirm that wording matches the *declared, not built*
   vocabulary rather than adding a new state.
4. **Boards.** The blueprint pass was decided against three HTML boards. If a board is wanted for
   this pass, A + C + D can be mocked on `a design reference`'s data
   in an hour; B needs its own.

## 6 · Decision (2026-09-06) and build plan

Reviewed on the boards in `a design reference`. **B (moments as
sub-columns) is the system band. F (ladder) is a toggle on it**, not a second surface. Time stays
horizontal in B — that reads best on the blueprint — and F is the way to read one segment as a
sequence when the moment grid is not enough. Two things from the boards come along because they
tested well: the **compact business band** (gates as one chip line, then the step, decisions folded
into it) and the **request-order rows split at the seam** from A, which B is drawn on. C's seam
card is how a call marker is drawn inside B; D's folds (↺ repeats, +n helpers) are marker rules
inside B. E and the rest of D (rows folded to ledgers) are not in this pass.

Answers to §5: the two repo halves are *The screen asks · `<repo>` · browser* and *The service does
· `<repo>` · server* (business register: *what the screen asks* / *what the service does*); a
route-entry or consumer-entry journey has no browser row at all. In the business lens the API row
stays expanded (summaries, not operationIds) and every other row is counts per moment. A planned
call's seam card says *handled: not built yet* — the existing *declared, not built* vocabulary, no
new state. No boards for the build; these are the acceptance spec.

### 6.1 · Core — `packages/core/src/query.ts` (one fold, HUD + MCP)

- **Rows in request order, split at the seam.** `SystemRow` gains `side?: 'ux' | 'server'` for
  `kind:'repo'`; keys become `repo:<name>:ux` / `repo:<name>:server`. A step is server-side when
  it, or any ancestor on its depth chain, was reached `via:'http'` or `via:'consumes'`, or is a
  route, or is the entry of a route/job/consumer journey. `systems[]` is ordered by rank
  (`ux → api → server → records → messages → external`) then first-seen. A route with no contract
  still lands on an API row: key `api:repo:<name>`, label `<name> · routes` (an implied API, the
  `apiSurface` term) — every HTTP call gets a seam card.
- **Both ends of the seam on a call marker.** `SegmentMarker` gains `caller?: {nodeId, path, line}`
  (step N's `callSite` + step N−1's node) and `handler?: {nodeId, path, line}` (step N+1 when it is
  `via:'calls'` at depth+1, else the route's own `loc`). Planned calls carry neither.
- **Fold flags on markers.** `repeat` (copied from the step), `helper` (a server-side step whose
  parent step is not the route — depth below the handler), and `moment` (index into the
  segment's moments).
- **`JourneySegment.moments[]`** — `{ index, label, from, to, actionStep, callStep?, component?:
  {id, name, label}, repeat, counts: {markers, calls, planned, records, messages} }`. Rule: every
  `via:'http'` step opens a moment at its nearest browser-side ancestor **function** (the client
  action); the moment runs to the next moment's start; steps before the first moment (the screen's
  component render) belong to moment 0. `component` is the nearest ancestor component of the action
  step — the HUD draws it as a span header and says *still open* when the next moment shares it.
  Planned journeys: one moment per planned call, in the design's operation order, labelled by the
  contract summary. A segment with no calls is one moment labelled by its screen. `label` =
  `businessSummary()` of the action step's node, else its humanized name. `repeat` = the call
  step repeats. `markers[]` stays flat and ordered (compatibility); each marker says its `moment`.
- **Tests** (`packages/core/test/journey-band.test.ts`, same fixture style as
  `ui-journeys.test.ts`): rows come out in rank order and the repo splits into two sides;
  a call marker carries `caller` + `handler` with real paths/lines; the invoice-app *Invoice list*
  journey yields 6 moments with the drawer component spanning four of them; a planned journey's
  moments are its declared operations; a route-entry journey has no `ux` row; `repeat`/`helper`
  flags land where the walk says.

### 6.2 · MCP — `packages/mcp/src/run.ts`

`journey` prints rows in the new order with their side (`the screen asks · invoice-app · browser`),
a `#### moment n · label` sub-heading per moment inside each segment, and on every call line
`← from path:line → handled path:line` (or `→ handled: not built yet`). Nothing else changes.

### 6.3 · Viewer — `packages/server/public/app/surfaces/journeys.js` + `viewer.html` CSS

1. **Compact business band** (`jrnBizCellHtml`, hybrid + code lenses): ▶ start · the gate chips
   (deduped, ×n, ⧉) on one line · the step box (verb + first sentence) with the segment's
   decisions folded into it as `⑂ label` chips that jump to their step and expand in place to show
   the arms · ■ end. The business lens keeps today's full flowchart (`jrnFlowDecision` diamonds).
2. **The moment grid** (replaces `jrnSystemRowsHtml`'s flat wrap). Band header cell per segment =
   the moment stops (ordinal · label · ↺). Every system row's segment cell is a grid whose column
   template comes from the segment (one CSS variable per segment, set on the segment's cells, so
   every row aligns); a moment's width is derived from its widest row (clamped), and the segment
   width in `jrnRowStyle` becomes the sum, never below today's `JRN_SEG_W`. Row order and labels
   from `systems[]` (`side` → *The screen asks* / *The service does*). Cells: browser row = the
   component span header (`jrnCompSpanHtml`: name, or *still open* continuation) + action markers;
   API row = the **seam card** (method · operationId or path · spec summary · contract status
   chip; line 2 `← from path:line ⧉` · `→ handled path:line ⧉` through `vsl()`; planned = *not
   built yet*); server row = handler + `▸ helper` markers; records / messages / external as today.
   ↺ repeats draw as ghosts, `+n` on a handler folds its helpers in the business lens only.
   Clicking a marker opens the expansion slot under its row as today; for a call the slot is the
   **seam splice**: caller slice (step N−1 around `callSite`) → the contract block (what
   `describe_node` prints: does · requires · returns · status · consumers) → handler slice (step
   N+1) → *continues ▸* the service function, all via the existing `jrnCodeSeg` / `jrnReqChips`
   pieces. `j`/`k`, Esc order, progress bars and the forks drawer keep working off `data-order`.
3. **The ladder toggle (F).** A `rows | ladder` control in the band header, key `l` while the
   overlay is open (keymap.js + the `?` panel), persisted as `fs-jrn-view`. Ladder mode redraws each
   segment's band as a vertical ladder inside that segment's column: header = the same system rows
   as columns; one line per marker in step order; step ordinal on the left with the moment label at
   each moment start; call lines show `path:line →` in the browser column and `→` after the seam
   card; helpers indented; records / messages drawn with `→` from the service column. Long
   segments cap at a line budget with *▾ n more steps* that expands. The expansion slot opens
   under the ladder; j/k walk the lines. Multi-segment journeys read left to right, one ladder per
   segment — time is still horizontal across segments.
4. **Lenses.** Business: rows are counts per moment except the API row (summaries, expanded);
   moment labels + gates + decisions are the story. Code: everything, operationIds, file lines on
   the seam card. Hybrid: the boards. Light theme checked.
5. **Strings + symbols.** Every new string through `t()` in both registers (`journey.row.ux`,
   `journey.row.server`, `journey.rowSub.ux/server`, `journey.moment`, `journey.stillOpen`,
   `journey.view.rows/ladder`, `journey.moreSteps`, `journey.seam.from/handled/notBuilt`,
   `journey.helperInside`, `key.l`, …); `pnpm lint:strings` passes; `#/grammar` shows them. No new
   emoji — glyphs from the sprite (`api`, `step`, `screen`, `record`, `message`, `open`, `fork`).
6. **Dogfood.** Every new function carries `@group Journey view` (+ `@business` where it is a
   user-facing behaviour). `designGuide()` in `design.ts` describes the band as rows × moments.

### 6.4 · Sequence, verification, hand-off

Branch `feat/journey-system-band`, one conventional commit per step, in this order: core rows +
seam ends + moments (+ tests) → MCP printer → viewer moment grid + seam card → compact business
band → ladder toggle + keymap → strings/grammar + CSS/lens/theme polish → docs (CLAUDE.md Journey
view paragraph, ROADMAP, `designGuide()` text) + refreshed `built-*.png` in the design references.

Verify with `pnpm build && pnpm -r typecheck && pnpm -r test && pnpm lint:strings`, then visually
on a scratch server (never 4477): ingest `examples/invoice-app` to a scratch graph, `serve` it on
a scratch port, headless-Chrome screenshots of `#/journeys/invoice-app::page::/invoices` in all
three lenses, rows and ladder — the boards are the acceptance spec. Also serve the reference app's
workspace graph read-only on another scratch port and check a planned journey (*Submit an
invoice*) draws moments from its declared operations with *not built yet* seam cards. Leave the
branch unmerged for lead review.
