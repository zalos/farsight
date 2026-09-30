# Farsight — Design research & concepts (July 2026)

**Goal:** a cleaner, leadership-ready surface that starts high-level and drills deep; package/dependency weaving made visible through journeys; business flows in universal symbolism; a scalable model for many repos ingested deterministically + wired to business info over MCP; and a developer surface for auditing agent-generated code.

**Inputs:** current viewer review (16 captures, `a design reference`), and three research passes: game UI/systems (strategy zoom, overlays, quest/HUD grammar), architecture & dependency tooling (C4, Datadog, CodeScene, Sourcegraph, SBOM/Socket, comprehension-debt discourse), and business notation (BPMN research, service blueprints, transit maps, ISO symbolism, exec communication).

---

## 1. What the research says (condensed)

### 1.1 Critique of the current design

The current viewer is strong at the node/journey level but has no true top: the landing view is a 99-card wall; the business lens is "hybrid minus code," not a designed-for-business surface; packages/dependencies are not first-class anywhere; meaning is carried by emoji (🔒 ⑂ ⧉) and color alone in places; and there is no executive summary, trend, or health framing at all.

### 1.2 The eight load-bearing findings

1. **Zoom must change representation, not size** (Supreme Commander strategic icons; C4; CodeCity research). Each zoom band gets its own representation — glyph → card → code — at constant on-screen legibility, with count-collapsing ("12 routes") and **edge lifting** (LikeC4): collapsed groups aggregate member edges into weighted group-level edges.
2. **The far view should be a different visual register** (Crusader Kings III paper map). Leadership altitude = amber, humanized names, zero code identifiers; crossing the threshold cross-fades into the cyan HUD register. The register itself signals audience.
3. **One color-bearing overlay at a time over a desaturated base** (Cities: Skylines info views; Civ VI lenses). Micro-lenses (auth coverage, freshness, deps, agent-authorship) each answer one question, with a legend chip, and replace rather than stack.
4. **Words carry semantics; symbols reinforce** (BPMN comprehension studies — untrained users read text as well as diagrams; NN/g — icons need labels). Verb-object labels everywhere; every symbol gets a permanent caption; ≤12 drawn-SVG symbols, no emoji; shape-first so it survives color-blindness.
5. **The service blueprint is the business frame** (NN/g). Frontstage (screens) / LINE OF VISIBILITY / system steps / records & messages maps 1:1 onto Farsight's page→route→function→table graph, and the theater metaphor is proven with executives.
6. **Journeys are strip maps; dependencies are supply lines** (Beck's Underground map; Factorio/Anno flows; Sankey; npm-why). A journey is one transit line with stations; interchange rings mark nodes shared with other journeys; packages render as lanes woven under the line with width = symbols used; Farsight's graph gives **reachability by construction** — the answer Dependabot can't give ("this CVE sits on the login journey, hop 3").
7. **Attach to events, or die** (CodeSee post-mortem; Backstage plateau; Dependabot fatigue). A destination map nobody must visit gets abandoned. The sticky surface is the **graph diff per agent PR / per sync** — new nodes, edges, packages, guards crossed, journeys touched. This is also the direct answer to comprehension debt (AI code outpacing human understanding; devs score ~17% lower on comprehension of AI-assisted code).
8. **Status must be derived, never self-reported** (watermelon-report failure mode; Frostpunk's 2-3 giant bars). RAG chips computed from graph facts (freshness, guard coverage, undocumented forks, agent-authored-unreviewed), always icon + word, never a bare dot. Keep executive KPIs to 2–3.

**Standing prohibitions:** no 3D graph ever (EVE Online's 20-year failure); no full-graph hairball as a landing page; no hand-maintained metadata (it rots — derive everything, let doc-tags only augment).

---

## 2. The four concepts

The four concepts are one coherent system: **A** is the altitude ladder (where you land), **B** is the business flow language (how a journey reads), **C** is the dependency layer (what's woven in), **D** is the change/audit surface (why you come back daily). Each is independently shippable; A + B are the highest-leverage pair.

---

### Concept A — "Command Deck" (leadership altitude ladder)

*The paper-map register: where leadership lands.*

- **Altitude ladder** (named, C4-derived, auto-generated so it can never stale):
  `L0 Portfolio → L1 System (collection) → L2 Repo/Module → L3 Group → L4 Node → L5 Code`.
  Leadership lands at L0; every deeper level is one click/scroll. Vocabulary containment: no file paths or code identifiers above L3 in business register.
- **L0 Portfolio**: amber "paper map" register. Each collection/system is a **territory card** with humanized name, 2–3 derived status bars (Freshness, Guard coverage, Business-doc coverage — Frostpunk rule: never twenty numbers), counts (journeys, external services, open hotspots ▲), and a weighted link band to other systems (edge lifting). Trend arrows vs last ingest.
- **L1 System**: territories explode into repo glyphs — compositional, Supreme-Commander-style: frame shape = family (surface/logic/data/guard), interior glyph = role, criticality on the learned rarity ramp (gray→green→blue→purple→orange border treatment). Count badges collapse siblings ("14 routes").
- **Register cross-fade**: zooming past L2 warms→cools the chrome (amber paper map → cyan HUD), the same trick the lens toggle already does — extended to zoom, so anyone can *feel* which audience mode they're in.
- **Micro-lens rail** (hotkeys 1–5): Auth coverage, Freshness, External deps, Agent-authored, Hotspots. Activating one desaturates everything and tints only that dimension + legend chip. One at a time, by design.
- **Minimap** with viewport rectangle, click-to-jump; search hits and sync events pulse at their map position; fog-of-war for unindexed sources, partial re-fog hatching for stale-since-last-ingest regions.

### Concept B — "Blueprint Journeys" (business flow, universal symbolism)

*The theater metaphor: what the user sees / what the system does / what gets recorded.*

- Re-lay the business-lens journey as a **3-band service blueprint**:
  **SCREEN** band (frontstage: pages/forms the user touches) / labeled **LINE OF VISIBILITY** / **SYSTEM** band (verb-labeled steps, gates, decisions) / **RECORDS & MESSAGES** band (cylinders, envelopes, external-service chips).
- **SIPOC header card** per journey (the elevator version): Trigger → 5–7 named phases → Produces (writes + events) → Consumed by. This is also the right MCP `journey` summary shape.
- **The 12-symbol vocabulary** (drawn SVG, permanent ALL-CAPS captions, silhouette-first + color-second, CVD-safe — full table in §3): START, STEP, DECISION, GATE (padlock-shield), RECORD SAVED/READ (cylinder), MESSAGE SENT (envelope), EXTERNAL SERVICE (dashed cloud-corner), SCREEN (browser frame), HUMAN STEP (person), AUTOMATION (clock), INTERCHANGE (double-ring), HOTSPOT (▲ + word).
- **Strip-map treatment**: even station spacing, 45°/90° orthogonal routing, fork arms labeled in plain English with fork+rejoin visually paired (the one intervention proven to help novices), outcomes phrased past-tense ("Invoice saved", "Customer notified" — event-storming grammar).
- **De-emoji**: 🔒→drawn padlock, ⑂→drawn branch glyph, ⧉→drawn deep-link icon; matched stroke style, amber/cyan aware. Cheapest credibility gain with leadership.
- **Question-driven traversal**: from any step, "Why does this happen?" / "What happens next?" walks one hop — the 5-Whys ritual as interaction, mirrored as MCP phrasing for exec Q&A through agents.

### Concept C — "Supply Lines" (dependency weaving)

*Packages as freight lines running under the journey.*

- **Dep lanes under the strip map**: each third-party package a journey touches renders as a colored lane beneath the line, rising to "dock" at the station(s) where its symbols are actually used. Lane width = symbols crossing (one uniform coupling unit, Factorio-style). Congestion = many lanes converging = god-object/coupling hotspot, readable by a non-engineer as a traffic jam.
- **Package blast radius** panel: pick a package → which repos, journeys, guard-protected regions touch it; plain-language risk phrasing ("Payment flow depends on 3 external services and 4 open-source packages; 1 changed this week").
- **"Why this dependency?"**: npm-why as UI — breadcrumb call-chain from journey entry to the import site.
- **Journeys ⇄ packages Sankey** (the one Sankey worth building — bipartite, acyclic, exec-legible): ribbon width = steps touched. Not the whole graph, ever.
- **Reachability as the differentiator**: vulnerability/risk badges only where a vulnerable path is actually on a journey — the context Dependabot lacks, phrased at decision time.
- Graph work implied: package/module nodes + `uses` edges from import resolution (aliases.ts already resolves specifiers; promote to first-class nodes), edge weights = call sites/journey traversals.

### Concept D — "Agent Ledger" (change & comprehension audit)

*The daily-trigger surface: what changed, what do we no longer understand.*

- **Graph diff per sync / per agent PR**: semantic changelog — nodes/edges added, packages woven in ("this PR wove `lodash` into checkout at hops 3–5"), guards crossed or bypassed, journeys affected, forbidden-edge rule violations (dependency-cruiser-style architecture rules as ingest gates).
- **Authorship overlay** (CodeScene-inspired, micro-lens): human-authored / agent-authored-human-reviewed / **agent-authored-never-reviewed** = darkest fog. Comprehension debt made spatial.
- **Review quests**: a diff becomes a quest chain — hops to review with progress pips ("4/9 hops reviewed"), one-active-quest map markers, difficulty = fork×hop complexity. Onboarding = handing someone a quest chain.
- **Pings** (Apex-style, two-way): context-aware one-gesture annotations on any node/edge — business pings "what is this?" on a diamond; dev answers; the answer lands as a `@business` label in the code. The cross-audience channel the two-personas principle needs.

---

## 3. The minimal business symbol vocabulary

| Symbol | Form | Graph mapping |
|---|---|---|
| START | thin-ring circle + trigger phrase ("Whenever…") | entrypoint (route/scheduled/listener) |
| STEP | rounded rectangle, verb-object label | function/hop |
| DECISION | diamond, plain-English arm labels, fork paired with rejoin | branches/forks |
| GATE | padlock-in-shield, amber | guard/auth |
| RECORD SAVED / READ | violet cylinder, arrow in/out + SAVES TO / LOOKS UP | db write/read |
| MESSAGE SENT | envelope leaving on dashed edge | event/queue/email |
| EXTERNAL SERVICE | dashed border, cloud-corner badge | third-party API |
| SCREEN | browser-frame silhouette (frontstage band) | page/component |
| HUMAN STEP | ISO-style person pictogram | manual action/approval |
| AUTOMATION | clock badge | scheduled/recurring |
| INTERCHANGE | double-ring station circle | node on ≥2 journeys |
| HOTSPOT | warning triangle + word (UNDOCUMENTED/STALE) | low-confidence, undocumented fork, stale |

Rules: every symbol always captioned; color never the only channel; no BPMN event subtypes, no fork/join bars, no bare status dots, no emoji in system chrome.

---

## 4. Sequencing recommendation

1. **B first** (blueprint journey + symbol set) — pure viewer work on the existing `jrnFlowHtml`, immediate credibility gain, no graph-schema change.
2. **A's L0/L1** next — needs edge lifting + per-collection rollups (derivable from today's graph) and becomes the new landing page.
3. **C** — needs package nodes + weighted `uses` edges in the schema (one graph, many lenses still holds).
4. **D** — needs graph snapshots per ingest (diffing) + git/authorship harvest; the stickiest long-term surface and the agent-era differentiator.

Figma boards for all four concepts: **Farsight — Design → page "03 Research & iteration"** — https://www.figma.com/design/VMHP6j8MpK9rVo3FJIL1bt

---

## 5. Research shortlists (for the record)

**Game patterns (top 8):** Supreme Commander semantic zoom · Skylines/Civ single-overlay lenses · Factorio/Anno flow lanes & chain cards · CK3 paper-map register · quest chains w/ one-active-quest markers · rarity ramp for criticality · Apex contextual ping · fog-of-war with staleness re-fog. *Prohibition: EVE's 3D map.*

**Tooling mechanisms (top 8):** views-as-predicates + edge lifting (LikeC4) · journey-scoped subgraph filtering (Datadog flow map) · waterfall management toolkit (Honeycomb: collapse-by-group, jump-to-next-guard/fork, minimap rail, deep-linkable subranges) · graph-diff attached to PRs (CodeSee's stickiest feature) · reachability-grounded dep answers (npm-why + Socket) · weighted health-bearing edges · behavioral heat + authorship overlay (CodeScene) · fixed altitude vocabulary + stable layout seeds. *Anti-patterns: destination map with no trigger; full-graph hairball; hand-fed metadata.*

**Business notation (top 6):** service-blueprint banding · words-carry-semantics (labels on everything) · altitude ladder (SIPOC card → flowchart → code) · strip-map journeys with interchange marks · derived RAG + hotspots (watermelon-proof) · de-emoji into drawn HUD icon set.

Full agent reports with sources are archived in the session; key sources: c4model.com, LikeC4 docs, Datadog service-map posts, Honeycomb trace docs, CodeScene behavioral analysis, Sourcegraph agent-era posts, Addy Osmani "comprehension debt", NN/g (service blueprints, icon usability, progressive disclosure), BPMN comprehension studies (Springer/SBQS), Beck/SEI transit-map whitepaper, ISO 7001, Supreme Commander/Civ VI/Skylines/Factorio UI references.
