# UX Prototypes

Self-contained HTML — open any file directly in a browser. All fake data, real interactions. They share one design language ("Farsight HUD"): blue-black ground, condensed uppercase HUD labels, and two accents that carry meaning — **quest-amber for the business lens, signal-cyan for the code lens** — so switching audience literally warms or cools the interface.

| File | Concept | Try this |
|---|---|---|
| `01-flow-explorer.html` | **Flow Explorer** — "show me the invoice process" as a swimlaned graph (Frontend → API → Services → Data) | Toggle **Business / Hybrid / Code** (keys 1/2/3) — selection and viewport survive. Click `finalizeInvoice()` for rules + auth in the inspector. `⌘K` for the palette. "Open in VS Code" on any node. |
| `02-system-atlas.html` | **System Atlas** — the multi-repo world map | Scroll to zoom WORLD → REGION → DISTRICT (modules stream in), drag to pan, filter chips (`invoice` lights the matching path amber), hover `legacy-billing` — fog of war for unindexed repos. |
| `03-trace-view.html` | **Trace View / Quest Log** — one feature followed vertically across every layer | Toggle **Developer / Business** — code blocks and IDE links appear/disappear, step names re-language. Expand step 3 for validation rules; note the failure branch under it. Quest log at left shows per-flow index coverage. |
| `map-view/property-street-neighbourhood.html` | **Map view** — one whiteboard, three altitudes: all journeys as *neighbourhoods*, one journey's screens along a *street* with a pathway per screen (calls with a service colour bar, what each reads and writes), one screen as a *property* with the screenshot as hero and a tabbed rail. Agreed 2026-10-03; proposal `docs/proposals/map-view.md`. | Drag, pinch or ⌘-scroll between the levels; zoom past a screen to snap into it; `p` toggles plumbing; `b` switches the lens. The alternatives per level are drawn below the canvas. |

## Open questions to settle in review

1. Is the lens toggle (proto 1) the hero interaction, or is the vertical trace (proto 3) actually the more useful mental model for business users?
2. Atlas zoom levels: is repo → module → symbol the right LOD ladder, or should districts be *domains* (billing, identity) rather than repos?
3. How loud should rule/auth callouts be by default — always-on badges (current) or an overlay you switch on?
4. Game-HUD skin intensity: keep the corner-bracket/scanline vibe, or offer it as one theme with a quieter "enterprise" default?
