# Map view — Neighbourhood · Street · Property (proposal, 2026-10-03)

**Status:** agreed on a rapid prototype on 2026-10-03; implementation in two lanes (§8). Flag-gated; nothing existing
is replaced.

## 1. What it is

A new viewer surface, `#/map`, that draws the application's journeys as **one continuous whiteboard with three
altitudes**, in the way Miro or Figma draw a board:

| level | what the reader sees | what a click or a zoom does |
|---|---|---|
| **Neighbourhood** (zoomed out) | every journey as a *district*: its name, its sentence and its aggregate counts at poster size; the street underneath ghosted so the shape of the journey shows through; `leads to` / `requires` / `part of` as links between districts | click or zoom into a district → its street |
| **Street** (one journey) | its screens in step order along a path, each with a lean chip row; with **plumbing** on, each screen owns a straight pathway down: the API calls it makes, stacked in order, each with a **service colour bar**; beside each call the records, messages and third parties it reaches, with **reads** in cool lines and **writes** in warm. The same record is drawn under every screen that uses it. Nothing crosses. | click a screen, or zoom past it near the centre → its property. Click a call or a data node → the explore card |
| **Property** (one screen) | the screenshot or design frame is the hero and owns most of the stage; a **tabbed rail** beside it (Overview · Gates · APIs · UX · Tests · Route · Work · Changes) with counts on the tabs; a **step bar** below: the screen before, where you are, the screen after, the other journeys this screen is part of | pinch out / ⌘-scroll out / `Esc` → back on the street, centred on this screen |

The prototype that was agreed is `prototypes/map-view/property-street-neighbourhood.html` (self-contained, example
data from `examples/invoice-app`). Its interaction model, thresholds and the pathway-per-screen plumbing are the
reference; the alternatives it lists (shared lanes, subway, satellites, icon rail, bottom drawer, cards grid, linked
graph) were reviewed and set aside.

**Why a new surface, not a fourth journey view.** The neighbourhood level spans all journeys, and the journey view axis
(timeline · sheet · drill) is scoped to one. The Portfolio is the natural door: it already lists the journeys, so it gains
a *Map* button beside its heading, and the surface gets a nav tab — both only when the flag is on.

**Principles it must keep** (`AGENTS.md`): one graph, many lenses — the map reads the existing `/api/journey` summary
and `/api/design` flows, never a model of its own on the server; every number is a `Counted` with a tip and a line in
`docs/COUNTS.md`; the six absence words and three evidence classes are closed sets; the business register shows words a
person wrote or `humanize()`, never an identifier; every string goes through the catalog, every glyph through `sym()`.

## 2. Where it lives

- **Route:** `#/map` (neighbourhood) · `#/map/<flowNodeId>` (street) · `#/map/<flowNodeId>?node=<pageNodeId>`
  (property). Accepts `?lens=` and `?scope=` like every surface. `?plumb=1` opens the street with plumbing on.
- **Flag:** `flags.map` in `.farsight/settings.json` (Settings → Experiments, like `journeyDrill`). Off: no nav tab, no
  Portfolio button, and a `#/map…` deep link reads as `#/portfolio`. The e2e specs turn the flag on in the page the way
  `journey-numbers.pw.spec.ts` turns on `journeyDrill`.
- **Portfolio:** a `Map` button beside the `<h1>` (pattern: `jrnLayoutSwitchHtml`) → `#/map`. A journey row keeps its
  link to the journey view; the map is the second way in.
- **Modules:** `surfaces/map.js` (the surface: canvas, neighbourhood, street, chrome), `lib/map-canvas.js` (pan ·
  zoom · pinch · levels · snap, no data knowledge), `lib/map-model.js` (pure: summary → street model, design flows →
  neighbourhood model), `surfaces/map-property.js` (the property: hero, rail, step bar), `lib/map-property-model.js`
  (pure: summary + graph → the eight tabs' facts). Strings in `packages/core/src/strings-map.ts`, spread into the
  catalog like `strings-work-hud.ts`. All five modules go into the string lint's `CHROME_FILES`.

## 3. Data — everything is already served

| level | reads | notes |
|---|---|---|
| neighbourhood | `GET /api/design?scope=` → `designs[].flows[]` (`FlowRow`: `nodeId, name, description, screens[], built, total, status, persona, owner, leadsTo?/requires? on the design ref`) · `flowWork(nodeId)` (work chips) · then, lazily and one at a time with a generation counter as Portfolio does, `GET /api/journey?entry=` per flow for the aggregate chips (`summary.counted.{screens, built, gates, actions, declaredNotCalled}`, `summary.coverage.journey.counted.tests`, `summary.links`) | the cover shows what `/api/design` knows at once and fills the rest in; cache per entry per sync (`FLOW_CACHE` pattern in `work-chips.js`) |
| street | `GET /api/journey?entry=<flow>` → `summary.segments[]` (`screen`, `moments`, `markers`, `gates`, `decisions`, `declaredOnly`, `counted`, `absent`), `summary.systems[]`, `summary.links`, `data.screens[]` (full `design` for thumbnails) | one fetch per journey, cached; the overlay's `S.JOURNEY` is **not** written — the map keeps its own `MAP.journey` |
| property | the same response, plus per tab: `S.BYID` for page and component nodes (stories, design), `summary.coverage.segments[i]` for Tests, `GET /api/work/links?node=<pageId>` and `GET /api/work/flow/<flow>` for Work, `GET /api/changes` filtered by `diff.changes[].subject.id` ∈ the screen's node ids for Changes (503/400 → the absence word, never a blank) | no new endpoint; a fetch happens when a tab opens, cached per sync |

### 3.1 Street model (`lib/map-model.js`, pure, unit-tested)

```ts
streetModel(data /* the /api/journey response */, graphById) → {
  journey: { id, name, business },                      // summary.entry
  services: { key, label, index }[],                    // summary.systems rows with kind 'api', in order; index → colour class svc-<index>
  screens: MapScreen[],                                 // one per segment with a screen; the entry segment without a screen is folded into the first
  links: summary.links,                                 // requires · leadsTo · partOf
}
MapScreen = {
  index, ordinal,                                       // position in the journey, 1-based
  node,                                                 // the page node (data.screens / graphById / stub) — design, stories, components come from it
  name, business, route,                                // route = page node name; business = bizDescription || docs || screen.business
  state: 'built' | 'planned',                           // planned = designStatus 'design-only' or no page node
  chips: { calls: Counted, gates: Counted, tests: Counted|null, work: null /* filled by the surface */ },
  calls: MapCall[],                                     // in moment order
  gates, decisions, absent,                             // straight from the segment
  segment,                                              // the JourneySegment itself, for the property
}
MapCall = {
  marker,                                               // the SegmentMarker of kind 'call'
  moment,                                               // its JourneyMoment (label, business)
  service,                                              // the services[] row for marker.system, or null → 'svc-none'
  method, path, operationId, summary,                   // from the marker (method/path/title) and the route node's contract
  evidence: 'spec-backed' | 'implied' | 'not built',    // contract.status when the route exists; planned marker → 'not built'
  data: { kind: 'record'|'message'|'external', nodeId, name, mode: 'read'|'write'|'both' }[],   // markers of those kinds in the same moment; op reads/writes → mode; the same record read and written → 'both'
}
```

Rules: a moment with no call draws nothing in the plumbing (the chip row already counts it); a repeated call (`repeat`)
draws once per screen with the ↺ glyph; helpers (`helper`) never appear; a planned screen's calls come from
`segment.declaredOnly` with `evidence: 'not built'` and no data.

### 3.2 Property model (`lib/map-property-model.js`, pure, unit-tested)

```ts
propertyModel(data, screenIndex, graphById) → {
  screen: MapScreen,                                    // from streetModel
  prev, next,                                           // MapScreen | null, in this journey
  alsoIn: { id, name }[],                               // other flows that list this screen (design refs: data.screens[].design.flows / summary.links)
  hero: { kind: 'image'|'figma'|'none', node, chips },  // designThumbHtml(node, 'lg') draws it; 'none' → the placeholder (glyph, name, route, components, the absence word)
  tabs: {
    overview: { business, glance: Counted[], calls: MapCall[], gates, work: 'lazy' },
    gates:    { guards, rules, decisions },             // segment.gates split by kind; decisions filtered to class 'business' in the business register
    apis:     { calls: MapCall[], records: {nodeId,name,modes}[] },
    ux:       { page, components: node[], stories },    // stories via storiesSecHtml / storyChipsHtml
    tests:    { facts: CoverageFacts /* summary.coverage.segments[i] */, cases },
    route:    { route, status, declaredIn, links },     // linksSecHtml(node); 'other ways in' = edges into the page from data.edges
    work:     'lazy',                                   // /api/work/links?node= + /api/work/flow/<flow> findings for this screen
    changes:  'lazy',                                   // /api/changes filtered to the screen's node ids (page, components, call handlers)
  },
  counts: { gates, apis, ux, tests, work, changes },    // the numbers on the tab strip, Counted or null (null → no number on the tab)
}
```

## 4. Interaction contract (`lib/map-canvas.js`)

- One `.map-world` element under a CSS `translate(tx,ty) scale(s)`; DOM nodes in the world (screens, calls, data
  nodes) and one SVG layer per district for edges, as the code map and the drill already do. Programmatic moves animate
  (`.anim`, 450 ms, off under `prefers-reduced-motion`); gestures do not.
- **Pan:** one pointer drag; plain wheel. **Zoom:** pinch (two pointers), `⌘`/`Ctrl` + wheel, `+` / `-` keys and
  buttons, `0` = fit all. Touch works through pointer events with `touch-action: none` on the stage.
- **Levels** by scale: `< 0.5` neighbourhood · `0.5 – 1.6` street · snap above `1.6`. **Snap** fires only when a gesture
  ends (pointer up, or 160 ms after the last wheel event) with a screen within 320 world units of the viewport centre.
  Leaving the property lands on the street at scale `1.0` centred on that screen.
- **Keys** (in `keymap.js`, active only on `#/map`): `p` plumbing · `+` `-` `0` zoom · `Esc` back one level (card →
  property → street → neighbourhood) · `[` `]` previous / next screen in the property · `b` lens as everywhere.
- **Full stage:** the surface may request fullscreen on the stage (`⤢`); the chrome stays.

## 5. The explore card (one anatomy, every kind)

Clicking a call, record, message, third party or gate opens one card: kind and direction · evidence class · name in the
current register · identifier line (hidden in the business register) · `Counted` chips · *on* → the screens it appears on
· at most two actions (open on the owning surface — APIs, code map, Tests — and Impact via `impactBodyHtml`). The card is
a doorway, not an inspector. v1 implements it for calls and data nodes; the rest is one function.

## 6. Numbers and words

Every chip is a `Counted` from the summary (`segment.counted`, `summary.counted`, `coverage.*.counted`,
`/api/work/*.counts`) wired through `countedHtml` / `countedAttrs` with its tip; a number the summary does not type
is not printed. New rows go into `docs/COUNTS.md` under a `### Map` heading. Service names are the spec titles
(`SystemRow.label`); the business register prints them as they are (a spec title is a person's words). Level names
(*Neighbourhood · Street · Property*) are HUD words with a `define` each; the professional register says *All journeys ·
One journey · One screen*.

## 7. ADR 10 (to add to `docs/ARCHITECTURE.md` when it ships)

**The map is DOM in a transformed world, not a `<canvas>`.** The street draws tens of screens and a few hundred nodes at
most, each of which must carry a tooltip, a focus ring, a lens-aware label and a click target that the e2e suite can
address by selector. A `<canvas>` would re-implement all four for no measurable gain at this size; the code map and the
drill already draw DOM cards over an SVG edge layer. The one cost is text at small scales, which semantic zoom removes:
the neighbourhood level shows poster-size covers and ghosts the street. ADR 2 (canvas/WebGL for the graph) still applies
to the full code graph at 100k nodes; this surface is bounded by journeys.

## 8. Lanes

| lane | branch | owns | done when |
|---|---|---|---|
| **A — canvas, neighbourhood, street** | `feat/map-street` | `surfaces/map.js`, `lib/map-canvas.js`, `lib/map-model.js` + its test, the map CSS block in `viewer.html`, `shell.js` (route · NAV · flag · settings row · Portfolio button), `keymap.js`, `strings-map.ts` §A, `lint-strings.mjs` CHROME_FILES, `e2e/tests/map-street.pw.spec.ts`, `docs/MAP-VIEWER.md` `## MAP` section, `docs/COUNTS.md` `### Map` | the three levels work on the fixture graph with zero page errors; plumbing on shows the pathway per screen with service colours and read/write; the property opens through a hook (`openMapProperty(host, ctx)`) that lane B fills |
| **B — property** | `feat/map-property` | `surfaces/map-property.js`, `lib/map-property-model.js` + its test, the property CSS block in `viewer.html` (its own `/* ── MAP property */` block), `strings-map.ts` §B, exports-only edits to `journeys.js` (e.g. `jrnFoldFacts`), `e2e/tests/map-property.pw.spec.ts`, its subsection in `MAP-VIEWER.md` and rows in `COUNTS.md` | every tab renders from the fixture's Billing cycle with the right counts; the placeholder shows for Discard draft; the step bar walks the journey; business register prints no identifier (the `journey-numbers` check) |

Both lanes start from this proposal's branch, commit in conventional form with `Co-Authored-By` only (no session
link), push and open a PR; the lead merges A first, B merges `main` and wires `openMapProperty`, then B merges.
After both: the lead's ritual (build · tests · lint · e2e · pack · reinstall both prefixes · restart 4478 · sync), then
the pass swarm on the dogfood graph.

## 9. Bonus streams (not in this pass)

Paste or upload a screenshot from the property placeholder, written into the source's design manifest; a per-screen
fold of the pathway after the first few calls when a screen makes many; export of the street as PNG; the explore card
for gates and tests; `⌘K` arriving on the map.
