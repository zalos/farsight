# Journey view — e2e timeline of code and business flow

Status: accepted, in progress (2026-07-19)

## Problem

Farsight can show *what connects to what* (trace_flow, viewer focus mode), but not
*what runs in what order*. Two personas want the same answer in two shapes:

- **Developer:** "Show me every line of code that runs, in order, when the Send
  button is clicked — including the code of the functions it calls (validate,
  save, tax), across the HTTP boundary into the server, across repos — as one
  readable, scrollable document with visual sections per file/function/system."
- **Business user:** "Show me the transaction end to end as a flow diagram with
  arrows: button → client function → HTTP call → server route → permission gate →
  validation → save → ledger → email event."

And a third requirement that marries them: **scrolling the code timeline should
light up the corresponding step in the flow diagram** (and clicking a diagram
step scrolls the code), with behavior following the existing lens system
(business / hybrid / code).

## Concept

A **journey** is a linearized, depth-first execution walk of the semantic graph
starting from one entry node (a handler, component, route, or page). It is a
*view* over the one graph (core principle #1) — a new pure query function plus
one server endpoint and one viewer surface. Nothing forks the schema.

Game vocabulary: the quest log holds saved flows; **running a journey is playing
one through**. UI label: "Journey".

## Data changes (packages/core + packages/parsers)

Backward-compatible, all optional:

1. `Loc.endLine?: number` — functions/components/rules record their full span
   (`line(node.end)`), so consumers can slice whole bodies, not 14-line snippets.
2. Call-site ordering: `calls`, `renders`, `http`, and db `reads`/`writes` edges
   gain `meta.line` = the 1-based line of the call site / JSX usage / query in
   the *caller's* file. This is what makes "the order the code runs" computable:
   a function's callees sort by call-site line.
3. `query.ts` gains `journey(index, entryId, opts) : Journey` — pure, engine-portable:

```ts
interface JourneyStep {
  order: number;            // 0..n position in the timeline
  depth: number;            // call-nesting level (indent)
  via: 'entry'|'calls'|'http'|'renders'|'publishes'|'consumes'|'reads'|'writes';
  edgeId?: string;
  callSite?: { path: string; line: number };  // where the parent invoked this
  nodeId: string;
  crossRepo: boolean;       // repo changed vs parent step
  gates: { id: string; kind: 'guard'|'rule'; name: string }[]; // guards/validates on this node
  repeat: boolean;          // node already appeared earlier in this journey
  cycle: boolean;           // back-reference; traversal did not recurse
}
interface Journey {
  entryId: string;
  steps: JourneyStep[];
  edges: GraphEdge[];       // deduped edges among visited nodes (for the flow map)
  truncated: boolean;       // hit maxSteps/maxDepth
}
```

Traversal semantics:
- Downstream DFS from the entry. At each node, out-edges of kinds
  `calls | http | renders | publishes | reads | writes` are followed, **sorted by
  `meta.line` ascending (edges without meta.line keep insertion order, after
  lined ones)**.
- `reads`/`writes` produce leaf data steps (table nodes; the db edge's
  `meta.code` is the "code" of that step).
- `publishes` → queue step; the walk continues through the queue's `consumes`
  in-edges to consumer functions (the async hop, e.g. invoice.finalized → notifier).
- `renders` edges are followed only while depth < renderDepth (default 2) when the
  entry is a page/component — otherwise a page journey would inline every
  descendant component's tree. For function/route entries, `renders` is skipped.
- Guards/rules never become timeline steps; they attach to their target step as
  `gates` (rendered as chips/gate banners in both views).
- Cycle guard: a node already on the current DFS stack yields one `cycle:true`
  step and does not recurse. A node visited in an earlier branch is walked again
  only if it hasn't exceeded `maxRepeats` (default 1 re-visit), marked `repeat:true`
  (UI collapses repeated code by default).
- Caps: `maxDepth` default 10, `maxSteps` default 300, `truncated` flag when hit.

4. MCP (packages/mcp): new tool `journey` — `entry` (query or node id, resolved
   like trace_flow), optional `depth`. Output: compact indented timeline (one
   line per step: via-arrow, name, file:line, gate chips), token-conscious, no
   code bodies by default; `code:true` includes capped slices. Dogfoods the same
   query fn.

## Server (packages/server)

`GET /api/journey?entry=<node id>&depth=<n>` →

```jsonc
{
  "entry": { /* GraphNode */ },
  "generatedAt": "...",            // graph freshness passthrough
  "truncated": false,
  "steps": [ {
    // JourneyStep fields, plus server enrichment:
    "node": { "id", "kind", "name", "repo", "group", "tags", "docs", "bizLabel", "loc", "signature" },
    "code": "…full body…",         // sliced from disk: roots[repo]/loc.path lines loc.line..endLine
    "codeStartLine": 39,           // for line-number gutters
    "codeTruncated": false         // capped at 160 lines/step
  } ],
  "edges": [ { "from", "to", "kind" } ]
}
```

- Graph loaded via `GraphStore.load(graphPath)`, memoized by file mtime.
- Code slicing is fail-soft: missing root/file/endLine → fall back to the node's
  stored `snippet`, else omit code. **Path safety:** the resolved file must stay
  inside the repo root; only nodes present in the graph are readable (no
  arbitrary-path reads). Server stays loopback-only.
- Table/queue steps: `code` = the db edge's `meta.code` (the query text) if present.

## Viewer (packages/server/public — vanilla JS, Phase-1 rules apply)

Entry points: node context menu **"▶ Run journey"** (functions, components,
routes, pages) and an inspector button. Opens a full-stage overlay; Esc closes.

Layout: two panes.
- **Left — flow map.** Vertical SVG flowchart of the steps: one card per step
  (indent by depth), arrows between consecutive/parent steps labeled by verb
  (calls → "calls", http → "HTTP POST /invoices/:id/finalize", publishes →
  "emits event", reads/writes → "reads/saves", renders → "shows"). Gate chips
  (🔒 guard amber-border, ⛨ rule) attach to their step. Node kind colors from the
  existing tokens; **left border / stroke color keyed per repo** (stable palette
  cycle) so systems read as bands. Cross-boundary arrows (http, cross-repo,
  queue) render as a full-width divider banner: `⇄ HTTP POST /invoices/:id/finalize → invoice-app`.
- **Right — code timeline.** One section per step in journey order: sticky
  header (function name · file path · repo · group), line-numbered `<pre>` of the
  full body, left border in the repo color, indented by call depth, call-site
  caption ("← called from EditInvoiceDrawer.tsx:18"). Data steps show the query
  code. `repeat` steps render collapsed ("already shown — expand"). Gates render
  as thin banners above the section ("🔒 requires billing:admin").

**Scroll-sync (the marriage):** an IntersectionObserver on code sections marks
the active step; the flow map highlights that card, dims non-active bands, and
auto-scrolls it into view. Clicking a map card scrolls the code pane. j/k step
navigation. A thin progress rail shows position in the journey.

**Lenses** (same body-class mechanism):
- `business`: code pane hidden; flow map goes full width, cards show
  `bizLabel` + business description, verbs dominate ("Send invoice" → "must have
  billing:admin" → "checks the invoice is complete" → "saves to Invoices").
- `code`: map collapses to the thin rail + mini-map; code timeline dominates,
  real symbol names.
- `hybrid`: both panes (~38/62), business names above code names.

All new viewer functions carry JSDoc `@group Journey view` so the dogfood graph
picks them up.

## Out of scope (this pass)

Branch/condition awareness (we linearize call order, not control flow — **landed
in pass 2, see [journey-forks-splice.md](journey-forks-splice.md)**), runtime
tracing, saving journeys into the quest log (follow-up), canvas renderer
(Phase 2 reuses `journey()` unchanged), Python/Rust adapters.

## Verification

Dogfood + fixture: rebuild, re-ingest, then
`/api/journey?entry=invoice-app::src/ui/EditInvoiceDrawer.tsx::onSend` must walk
onSend → finalizeInvoice(client) → **HTTP** → POST /invoices/:id/finalize
(gate billing:admin) → finalizeInvoice(service) → nextInvoiceNumber →
invoices/ledger_entries writes → invoice.finalized publish — with real code in
every function step and correct call-site ordering.
