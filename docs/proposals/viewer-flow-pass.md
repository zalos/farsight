# Viewer flow pass — business flowchart journeys, VS Code everywhere, grouped multi-scope

Status: **implemented** (2026-07). Third usability pass on the Phase-1 viewer, driven by
three requests: the business lens needed a real flow-chart reading of a journey (not a
card list with the code pane switched off), every code reference should deep-link into
the editor, and the source scope selector needed multi-select with grouping (all invoice
apps/APIs together; farsight and the reference app on their own).

## 1. Journey business flow map

In the **business lens** the journey map is now a top-to-bottom flowchart built from the
same data the code timeline uses (`steps[].gates`, `steps[].conditions`, parent
`node.branches`) — nothing new is computed server-side:

- **Start / end terminators** — pill with the entry's business label; "end of tracked flow".
- **Verb connectors** — each hop renders as a vertical connector with the arrow verb
  (calls / shows / saves to / emits …) on the line.
- **Gates as checkpoints** — a step's guards/rules render *before* its card as 🔒 Gate /
  ⛨ Rule check bars (amber, dashed), phrased from the guard name (`requireScope:` → "scope …").
- **Decisions as diamonds with pathways** — when a hop is inside a fork arm, a diamond
  block shows the fork's `@business` label (raw condition as fallback), the ✓ pathway
  taken (continues below), and every *other* arm as a labeled alternate pathway: short
  arm chip + its `@business` sentence + where it leads — a clickable "→ step" link when a
  tracked call sits in that arm's span, "⊘ flow ends here" for exit arms. Consecutive
  hops inside the same arm share one diamond.
- **Sync preserved** — flow cards are the same `.jrn-mapnode` cards (shared
  `nodeCardHtml`), keep `data-order`, so click-to-sync, active highlight, j/k nav, and
  the forks drawer's business-lens jump all still work. Hybrid/code lenses keep the
  compact card list + SVG connectors; lens switch re-renders in place.

New viewer fns (all `@group Journey view`): `jrnFlowHtml`, `jrnFlowDecision`, `jrnGateText`.

## 2. VS Code deep links on every code reference

`vsl(repo,path,line)` renders an inline ⧉ anchor to `vscode://file/<root>/<path>:<line>`
using the graph's `roots` (fail-soft: no root recorded → no link). Applied everywhere a
file:line appears: node-card `.sub` paths (main graph + journey maps), inspector header
path + guard/rule cards, journey section headers, call-site notes, gate banners (link to
the guard's own source), inline fork cards, and forks-drawer entries. The context-menu /
inspector "Open in VS Code" actions remain. Business lens hides code paths as before, so
the links only appear where code is shown.

## 3. Grouped multi-select scope

The scope `<select>` is replaced by a dropdown panel (`buildScope` + `sc-*` markup):

- **Model** — `scope` is `'all'` or an array of source names (union), persisted as
  `fs-scope-v2` (old `fs-scope` `src:`/`coll:` values migrate on load).
- **Groups** — collections render as checkable groups with their members nested;
  checking a group toggles all members, partial selection shows indeterminate. Sources
  in no collection list under "Ungrouped". Selecting exactly one collection's members
  labels the button with the collection name.
- **＋ group from selection** — saves the current multi-selection as a collection
  straight to workspace settings, so ad-hoc unions become durable groups.
- The menu stays open while picking; outside click closes it. `addCollection` on the
  settings page still snapshots the current scope (now possibly multi).

## Non-goals

No schema or server changes (pure viewer pass; core principle 1 untouched). No editor
abstraction beyond `vscode://` (JetBrains/others can come via a settings-chosen URL
template later). The Phase-2 canvas app supersedes this viewer; this pass keeps the
interim GUI honest, not permanent.
