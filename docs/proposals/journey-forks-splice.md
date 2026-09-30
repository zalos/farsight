# Journey view pass 2 — forks, spliced code, one visual language

Status: accepted, in progress (2026-07-20)
Builds on: [journey-view.md](journey-view.md) (pass 1, shipped). This pass lifts the
"branch/condition awareness" item out of pass 1's out-of-scope list.

## Problems (from using the tool)

1. **The journey is fork-blind.** The walk linearizes call order but says nothing
   about the `if`/`switch`/`catch` decisions that decide *which* calls actually
   run. Users want to see every conditional along a pathway, categorized, and to
   answer: *what values (or mock state) make this path resolve?*
2. **The code timeline reads as stacked bodies, not one execution.** Each step is
   a separate whole-body section. Wallaby test stories (see
   `Screenshot 2026-07-20 at 7.06.59 PM.png`) show the target: the caller's code
   *splits at the call site* and the callee's lines splice in, gutters stay true
   per file, then the caller resumes — one readable execution story.
3. **The journey map and the main graph speak different visual languages.**
   Jumping from the e2e graph into a journey is jarring — different card markup,
   different connectors — which makes it harder to follow a flow across systems.

## Design in one line

Branch points become first-class *graph facts* on function nodes (code is the
source of truth); `journey()` attaches the conditions that gate each hop; the
viewer splices callee code into the caller at the call site with fork markers and
a categorized Forks panel; and the journey map reuses the exact node-card visual
language of the main graph, with graph-focus continuity on close.

Nothing forks the schema per consumer — branches are one new optional node field
read by viewer, MCP, and server alike (core principle #1).

## Data contract (packages/core/src/graph.ts) — all optional, backward-compatible

```ts
export interface BranchArm {
  label: string;      // 'then' | 'else' | "case 'x'" | 'default' | 'try' | 'catch' | 'taken'
  requires: string;   // condition that selects this arm: "speed >= 98", "!(speed >= 98)", "no exception thrown"
  line: number;       // first line of the arm's span (1-based, inclusive)
  endLine: number;    // last line of the arm's span
}
export interface BranchPoint {
  kind: 'if' | 'switch' | 'ternary' | 'logical' | 'catch';
  line: number;       // line of the test / discriminant / `try`
  condition: string;  // source text of the test, whitespace-collapsed, ≤120 chars
  exits?: true;       // some arm ends in return/throw — guard-clause shape
  arms: BranchArm[];
}
// GraphNode gains:
branches?: BranchPoint[]; // decision points inside a function/component/route body
```

## Parser (packages/parsers/src/tsjs.ts)

New `extractBranches(body, source, line)` run for every declared
function/component (and for inline Express route-handler bodies, attached to the
route node). Rules:

- `IfStatement` → kind `if`. Arms: `then` (consequent span, requires = test
  source) and, when an alternate exists, `else` (alternate span, requires =
  `negate(test)`). **Else-if chains:** the nested `IfStatement` emits its own
  BranchPoint; because the outer `else` arm spans the whole alternate, a call
  site inside an else-if consequent is contained by *both* arms — accumulation by
  line containment yields the correct conjunction (`!(c1)` ∧ `c2`). Do not
  special-case chains.
- `SwitchStatement` → kind `switch`, condition = discriminant source. One arm per
  `SwitchCase`: label `case <src>` (requires `<disc> === <src>`) or `default`
  (requires `no case matched`).
- `ConditionalExpression` → kind `ternary`, **only when an arm contains a
  CallExpression or JSXElement** (it gates flow; bare value ternaries are noise).
  Arms `then`/`else`.
- `LogicalExpression` (`&&`/`||`/`??`) → kind `logical`, **only when the RHS
  contains a CallExpression or JSXElement**. Single arm `taken`; requires = LHS
  source for `&&`, `!(lhs)` for `||`, `lhs == null` for `??`.
- `TryStatement` → kind `catch`, condition `exception in try`. Arms: `try`
  (requires `no exception thrown`), `catch` (requires `exception thrown`).
- `negate()`: AST-aware — BinaryExpression flips (`===`↔`!==`, `==`↔`!=`,
  `<`↔`>=`, `>`↔`<=`) rebuilt from operand source slices; `!x` → `x`; anything
  else → `!(<src>)`.
- `exits`: an arm's last top-level statement is `return`/`throw`.
- Walk the whole body including nested arrows/callbacks (line containment
  attributes them correctly). Caps: ≤24 BranchPoints per node, condition ≤120
  chars. No new nodes, no new edges — zero graph bloat beyond the field.

## Core query (packages/core/src/query.ts)

```ts
export interface PathCondition {
  nodeId: string; name: string;  // the caller whose fork gates this hop
  path: string; line: number;    // fork location (caller's file)
  kind: BranchPoint['kind'];
  arm: string;                   // arm label the call site sits in
  requires: string;              // condition that must hold to reach the call
}
// JourneyStep gains:
conditions?: PathCondition[];  // forks enclosing THIS hop's call site (this hop only)
// Journey gains:
forkCount: number;             // Σ branches.length over unique step nodes
```

In `journey()`: when a child step has a `callSite` in the parent's own file and
the parent node has `branches`, every arm whose span contains the call-site line
contributes one PathCondition (sorted by fork line, cap 8 per step). Consumers
accumulate along the depth stack to get the full "state needed to reach here"
recipe — per-hop storage keeps the payload lean.

Also exported from core (shared heuristic, used by server + MCP):

```ts
export type BranchCategory = 'error' | 'flag' | 'access' | 'guard' | 'state' | 'branch';
export function categorizeBranch(bp: BranchPoint): BranchCategory;
// error: kind catch · flag: /flag|feature|toggle|enabl/i · access: /auth|session|role|scope|perm|token|admin|tenant/i
// guard: exits (early return/throw) · state: kind switch or /status|state|kind|type|mode|phase/i · else branch
// precedence in that order
```

## Server (packages/server/src/index.ts)

- `enrichNode()` passes `branches` through, adding `category` to each BranchPoint
  (viewer stays heuristic-free).
- `enrichStep()` already spreads the step, so `conditions` flows through; add
  top-level `forkCount` to the `/api/journey` response.

## MCP (packages/mcp/src/run.ts) — token-conscious

- Per-step line: append `[when <requires>]` for the first condition (`+n` if
  more).
- Tail summary: `⑂ 7 forks along this journey (guard 3 · error 2 · branch 2) — rerun with forks:true for the list`.
- New optional input `forks: boolean` → appends the categorized fork list: one
  line per fork, `⑂ [guard] invoiceService.ts:42 if (invoice.lines.length < 1) → then: throws · else: continues`,
  capped at 40 lines.

## Viewer (packages/server/public) — the heart of the pass

### 1. Spliced code timeline (Wallaby-style)

Build the step tree from the depth sequence (DFS pre-order is already the wire
order). A step's section renders its code **split at each child's call site**:

```
finalizeInvoice        invoiceService.ts · invoice-app          ← sticky header
  40  export async function finalizeInvoice(id) {
  41    const invoice = await db.invoices.findOne({ id });
  42 ⑂  if (invoice.lines.length < 1) {                          ← fork marker
  43      throw …
  44    }
  45 ↳  const number = await nextInvoiceNumber();                ← call line, highlighted
      ┌ nextInvoiceNumber   invoiceService.ts:53 ────────────────  spliced callee block,
      │ 53  async function nextInvoiceNumber() { …                indented, own gutter,
      └─────────────────────────────────────────────────────────  repo-colored border
  46    const finalized = await db.invoices.update(…)            ← caller resumes; gutter
  ...                                                              numbers stay true
```

- Children sort by call-site line; each splice point cuts *after* the call line.
- HTTP/async banners render at their splice point, full width, as today.
- Children whose call site isn't in the parent's file (queue consumers, missing
  meta.line) append after the parent's last segment, banner first.
- `repeat` steps render as a one-line collapsed row at their call site
  (`↻ nextInvoiceNumber — already shown · expand`); `cycle` rows similar.
- **Scroll-sync fix required:** with nested sections a parent intersects whenever
  its child does — observe the section *headers* (`.jrn-sec-head`), not the
  sections, to keep the active-step tracking correct.

### 2. Forks in the timeline

- Gutter `⑂` marker on every branch line of a block (from `node.branches`);
  click toggles an inline fork card: condition, category chip, each arm with its
  `requires` and outcome — "→ step 5 (nextInvoiceNumber)" when a journey child's
  call site sits in that arm, "exits (throw)" for exit arms, "no tracked calls"
  otherwise.
- Step headers gain **requires-chips**: the accumulated conditions to reach the
  step (cap 3 shown, `+n`), amber-bordered like gate chips.

### 3. Forks panel — "what state gets me down which path"

`⑂ N forks` button in the journey header opens a drawer (right side, above the
code pane) listing every fork along the journey **grouped by category** (access,
guard, validation-ish state, error, flag, branch). Each entry: condition +
location, its arms with requires + outcome step links, and a copyable
**mock-state recipe**: the conjunction of accumulated `requires` to reach that
fork plus the arm's own condition (`invoice.status === 'draft' && invoice.lines.length < 1 → throws 409`).
Clicking scrolls to the fork line (code/hybrid) or the owning card (business).

### 4. One visual language with the graph

- Extract the main graph's node-card innerHTML into a shared `nodeCardHtml(n)`
  used by both `renderNode()` and the journey map card — kind color bar, biz
  name, codename, path, gate badges — plus a journey-only step-number badge and
  verb label. Journey context overrides `position:absolute` → static flow.
- Connectors become the same bezier `.edge` stroke as the graph (not elbow
  lines), with the existing repo-band left borders kept.
- **Decision diamonds:** when a parent's forks gate its children, a small
  `⑂ <condition>?` diamond chip renders between the parent card and the gated
  child on the map (business lens: "Decision: …" card with plain framing).
- **Continuity:** closing a journey sets the graph's focus to the journey's
  nodes (entry selected), so you land on the same neighborhood you just walked —
  and opening from a focused graph feels like zooming in, not teleporting.

### 5. Lenses

- business: map full width, decision diamonds prominent, requires-chips shown in
  plain form, code hidden (as today).
- hybrid: both panes; spliced timeline with fork markers; diamonds on map.
- code: map collapses to rail; timeline dominates; fork cards inline.

All new viewer functions carry `@group Journey view` (dogfood).

## Out of scope (unchanged from pass 1 + new)

Runtime tracing / actual branch coverage (static conditions only — we report
*what must hold*, not *what happened*), loop analysis, symbolic evaluation of
compound conditions, saving journeys to the quest log, canvas renderer.

## Verification (dogfood + fixture)

1. Rebuild all packages, restart server, re-ingest (`POST /api/sync`).
2. `/api/journey?entry=invoice-app::src/server/invoiceService.ts::finalizeInvoice`:
   node carries `branches` with the `invoice.lines.length < 1` guard
   (`exits`, category `guard`); step for `nextInvoiceNumber` has no gating
   conditions (call site outside the if); `forkCount` > 0.
3. Journey from `EditInvoiceDrawer.tsx::onSend` still walks the full e2e chain
   (pass-1 verification) with spliced code and correct gutters at every hop.
4. MCP `journey` tool shows `[when …]` markers and the forks summary;
   `forks:true` lists them categorized.
5. Viewer: spliced sections, fork gutter markers + panel, map cards identical in
   language to graph nodes, close-→-focus continuity, all three lenses.
