# Farsight — Feedback response & V2 design plan (July 2026)

**Inputs:** `a review` (8-persona swarm on the four concept boards; 7× TRIAL, 1× HESITANT, mean 6.5/10) + two targeted research passes (trust/provenance UX; adoption/language UX).

**Read of the room:** every persona found real value, nobody found it ready, and the one HESITANT is the persona with budget authority. B (Blueprint Journeys) is the consensus star; D (Agent Ledger) is the cross-role sleeper; A splits by audience; C is simultaneously the best dev board and the business give-up screen. Nothing in the feedback attacks the core bet (one graph, many lenses, game-derived visual system) — it attacks **trust, language, exits, and missing states**. All fixable without a redesign.

---

## 1 · Feedback → feature/change breakdown

| # | Finding (voices) | What it becomes | Kind | Priority |
|---|---|---|---|---|
| F1 | No way out — no export/share/embed/API (6–7 voices; 3 BLOCKERs) | (a) Share menu on every view: living link + **pinned link** (`@sync:N`), PNG/PDF/Confluence embed, provenance footer burned into every export; (b) `farsight diff --format json\|sarif` + `/compare/base...head`; snapshot IDs | Feature (viewer + server + CLI) | **P0** |
| F2 | Game vocabulary needs a professional mode, not removal (8/8) | **Two-register string catalog** (Jira Flexible Terminology mechanism): `en-hud` / `en-professional` over one tokenized string table; per-workspace default, per-user override; **exports always professional by default**; errors/permissions register-invariant | Feature (viewer, cheap once strings centralize) | **P0** |
| F3 | No number has provenance (5 voices; Diane BLOCKER) | **Provenance popover** on every metric: formula, numerator/denominator counts + description, exclusions, as-of (sync/commit/digest), origin mix (static/annotation/human), uncertainty range, → "Open evidence list" (Looker explore-from-here). Metrics become versioned definition objects in the graph | Feature (core + viewer + MCP) | **P0** |
| F4 | No screen→code round trip (Sofia BLOCKER, Devon MAJOR) | file:line on every step/node in code+hybrid registers; ⧉ deep link already exists in the app (`vsl()`) — the *concepts* hid it. V2 boards show it; viewer keeps it everywhere incl. Journey steps and diff lines | Design fix + small viewer work | **P0** |
| F5 | Only happy states designed (Marcus BLOCKER, Rafael MAJOR) | **Honest-states set**: minute-one (machine-derived, pre-annotation — not an empty state), staged-progress ingest (fog lifts as stages complete), failed sync (last-good snapshot + banner, never a broken view), stale ≠ broken, unanswered ping (the 95% state), empty diff | Design (new boards) → viewer | **P0** |
| F6 | Visual grammar contradicts itself (Priya+Rafael, long itemized list) | **The Grammar Book**: one canonical rendering per concept (gate, screen, external, record, warning ≠ trend, fog = unindexed ONLY), one term per unit (**step**, not hop/phase), authorship ≠ fog (own shading + salience fixed: unreviewed = brightest warning, not dimmest), no color-only meanings, one legend all surfaces inherit; lens names unified (rail = full words) | Design system artifact | **P0** |
| F7 | Learning curve = training course; ~18 jargon tolls (4 voices) | Role-based landing (exec→Portfolio, analyst→Journeys, dev→Code map) as **default-not-cage** saved home views; first-use definition tooltips (Carbon pattern, no tours); jargon budget ≤5 unexplained terms/screen enforced as a lint over the string catalog | Feature + content pass | **P1** |
| F8 | Who feeds the machine? (Marcus, Sofia, Tom, Diane) | **Stewardship layer**: auto-drafted owners (CODEOWNERS/commit history) confirmed with one click; annotation debt = assignable aged items; completeness meters (LinkedIn pattern, private, next-best-action); weekly owner digest; **no public leaderboards** | Feature (later phase) | **P1** |
| F9 | Accuracy at the edges unstated (Sofia, Anna MAJORs) | **Per-edge resolution schema**: status resolved/heuristic/unresolved + technique + discrete confidence tier + origin + reviewed lifecycle; **unresolved renders as a first-class "?" stub edge** (we-don't-know ≠ no); CodeQL-style min-confidence view toggle serialized into permalinks; metrics show range when unknowns exist | Schema + viewer + MCP | **P1** |
| F10 | Function-level blast radius missing (Devon BLOCKER) | "About to edit `verifyInvoice`" panel: upstream/downstream, journeys crossed, guards involved, plain-sentence line ("Changing this affects: Checkout, Finalize invoice, Send reminder — and the customer email") — same data serves Tom's dream sentence | Feature (query exists — `impact_of`; needs UI) | **P1** |
| F11 | The word "test" appears nowhere (Anna BLOCKER ×2) | Test⇄journey linkage: `@covers journey:x` declared links + graph-inferred links (confidence-tiered); coverage matrix export with **orphan tests and uncovered journeys both surfaced**; Jama-style **suspect links** when a journey changes shape; "paths reaching table X not crossing gate Y" as a query = test-case generator | Feature (Phase 2 of plan) | **P2** |
| F12 | View vs action never signaled (Tom BLOCKER) | Persistent **"Explore mode — viewing changes nothing"** chip; consequence subtext on every action button ("creates a checklist · doesn't touch code"); product-level claim in first-run: "Farsight reads your code. It never writes to it." | Design convention | **P0** (convention), P1 (build) |
| F13 | Mock numbers contradict each other (Rafael gem) | **Derive all V2 board numbers from the real dogfood graph** (355 nodes/532 edges, journey `POST /invoices/:id/finalize` = 8 steps/2 forks, guard requireScope billing:admin…). Standing rule: a derived-truth product's mocks are derived | Process rule | **P0** |
| F14 | Surveillance risk on authorship overlay (Sofia gem) | Written policy, in-product: authorship aggregates **never** per person; overlay answers "has anyone walked this code," not "who is behind" | Policy + product copy | **P0** (write it now) |
| F15 | Salience inverted on D; CVD collisions (Rafael) | Grammar Book rules: risk gets the brightest ink; stale-red ≠ violation-red (stale = amber + clock icon + word, violation = red + octagon + word); freshness ramp gets icons+text, not chips alone | Design fix | **P0** |
| F16 | Which of the four is the product? (Marcus) | One product, one nav: A/B/C/D become **altitudes and lenses of one surface** in V2 framing; rollout story = "the map, the blueprint, the supply view, the ledger" of one graph | Narrative fix (V2 cover strip) | **P0** |

Tensions resolved deliberately (from the tension log): keep the game *visual* system + ship the professional *text* register (both sides accepted this); C is labeled the engineering lens and its data reaches business users as plain sentences (F10); A's labor economics answered by F8; density vs plainness = per-audience information diets (hide "6249 nodes" in business register); no single front door (F7).

---

## 2 · What the research adds (mechanisms we'll copy)

**Trust track:** SARIF's four orthogonal axes (severity / confidence / epistemic kind incl. `open`≠`pass` / baselineState) + content-hash fingerprints → adopt wholesale for edges and diff entries. GitHub dependency-review's split: server computes semantic diff, thin CI action applies repo-owned policy (`farsight-policy.yml`) and sets the exit code — facts in the diff, judgment in policy. dbt-style metric definition objects (numerator/denominator as schema, not prose) render the provenance popover. Snowflake-style `as_of` on every API call + SCD2 `first_seen/last_seen` intervals make snapshots views, not copies; ordinal `sync_id` for humans + Merkle `graph_digest` for audit. GitHub `y`-key canonicalization: copy-link defaults to pinned. CodeQL precision-per-technique + tiered consumption profiles. Jama suspect links for test traceability. OSCAL observation/finding split for GRC export (method enum maps 1:1 to our static/annotation/human origin triad). Uncertainty viz research: discrete tiers with redundant encoding (dash + desaturation + glyph), never an opacity gradient; unresolved dispatch = dangling "?" stub edge.

**Adoption track:** Jira Flexible Terminology = the professional-mode mechanism (i18n token substitution; lesson: audit for leakage — a rename that misses error toasts is worse than none). Tone map by surface: playful allowed in chrome, never in errors/permissions/exports. Carbon empty-state taxonomy + last-good fallback for failed sync. NN/g: >10s operations need percent+ETA+leave-and-notify; skeletons only for sub-10s; **fog-lifting-as-ingest-progress makes our metaphor and the loading pattern the same thing**. Figma-style persistent "view only" chip for the fear problem. Power BI audiences: role = default landing, never a capability fork; deep links override home. Grafana snapshot tiers (live link vs frozen stripped snapshot) + provenance-stamped exports (Grafana doesn't stamp; we beat them). NN/g anti-tour findings: one contextual hint, first-use-only definitions. LinkedIn-completeness (works) vs GitHub-badges (didn't): stewardship = private progress meters + next-best-action + auto-drafted-owner confirmation (Alation's human-approves-machine-draft flip). Both registers side by side in the `?` glossary = the Rosetta stone that teaches the toggle.

---

## 3 · The plan

### Phase 0 — Design iteration (now; Figma, no code)
1. **Grammar Book board** — the canonical vocabulary all future surfaces inherit (F6, F15, F2's register table, F12's button convention). Acceptance: every V1 contradiction Rafael/Priya listed has exactly one V2 answer.
2. **V2 Blueprint Journeys board** — B iterated: share/export affordance with pinned-link + provenance footer (F1), professional-register labels visible (F2), provenance popover open on a gate metric (F3), file:line + ⧉ on steps (F4), SIPOC↔map reconciled 1:1 with map-anchored phase chips (Priya), failure arm gets a terminal, explore-mode chip (F12), numbers from the dogfood graph (F13).
3. **Honest States board** — the four unhappy states as first-class mocks (F5): minute-one, ingest progress w/ fog lift, failed sync w/ last-good, unanswered ping + suspect answer.
4. **Developer Trust board** — function blast radius (F10) + per-edge confidence rendering incl. "?" stub (F9) + graph-diff JSON/CI gate + coverage matrix strip (F11, Anna's converter).
V1 boards stay untouched on page 03 as the record; V2 lives on a new page "04 · V2 — post-feedback".

### Phase 1 — Cheap, high-leverage build (viewer + strings + server, ~no schema change)
- Centralize strings → two registers; register toggle + per-export override (F2). Export/share: PNG/PDF per view, pinned links (`?as_of=sync:N`), provenance footer (F1a). Explore-mode chip + consequence subtexts (F12). Role-based default landing (F7). Provenance popovers reading from metric definition objects (F3). Grammar Book applied to the viewer (F6/F15). File:line everywhere the register allows (F4).

### Phase 2 — Schema & trust work (core + parsers + MCP)
- Edge `resolution` schema + technique-tiered confidence + "?" stubs + min-confidence toggle (F9). Snapshot storage (SCD2 intervals + graph_digest) → `as_of` on `/graph`, `/api/journey`, MCP tools; `/compare/a...b` + `farsight diff --format json|sarif` + `farsight-gate` policy action (F1b — flips Anna to ADOPT by her own statement). Function blast-radius panel over `impact_of` (F10). Honest states in the viewer incl. staged ingest progress (F5).

### Phase 3 — The loops (adoption compounding)
- Stewardship: suggested owners, assignable annotation debt, completeness meters, digests (F8). Test⇄journey links + suspect propagation + coverage matrix export (F11). Ping lifecycle: unanswered aging, answer-goes-suspect-on-code-change (Rafael/Tom). OSCAL/CSV evidence export (Diane's GRC ask). Glossary lint / jargon budget in CI (F7).

### Who each phase flips
Phase 1: Tom (language, fear, front door), Marcus (export/embed, first-hour story), Diane partially (professional register + provenance). Phase 2: Sofia (round trip, escape hatch, per-edge honesty), Anna (CI-consumable diff), Devon (blast radius, L2 designed next). Phase 3: Marcus fully (stewardship = day-2 ownership), Diane fully (evidence exports, cost-of-ownership story), Priya (suspect links + citable artifacts).

### Standing rules adopted (write into CLAUDE.md when implementation starts)
- No number without lineage: metrics render from definition objects; unsourced values get an `unsourced` badge, excluded from exports by default.
- "We don't know" ≠ "no": unknowns always render (stub edges, uncertainty ranges); absence must always mean absence.
- One symbol, one meaning, one word — the Grammar Book is the gate for any new surface.
- Exports are audit artifacts: professional register + provenance footer, always.
- Authorship data never aggregates per person.
- Mock data is derived from the dogfood graph — concepts obey the product's own core principle.

---

## 4 · V2 boards (built, page "04 · V2 — post-feedback")

1. **Grammar Book** — symbol table (one rendering each: STEP, GATE, DECISION, SCREEN, RECORD, MESSAGE, EXTERNAL, START/OUTCOME, INTERCHANGE), disambiguation row (trend = arrow chip / warning = triangle / violation = octagon / stale = clock — four distinct glyph+word chips), fog rule (fog = unindexed only; authorship gets its own hatch + the brightest warning ink for never-reviewed), the two-register vocabulary table, view-vs-action button conventions, edge-confidence line styles (solid/dashed+chip/"?" stub).
2. **Blueprint Journeys V2** — same Finalize-invoice journey, professional register, with: share menu open (pinned link + "export renders in professional register" note), provenance popover open on Guard-coverage chip, file:line + ⧉ under each step, reconciled phase chips, failure-arm terminal, explore chip, real dogfood numbers.
3. **Honest States** — 4 mini-mocks: minute-one ("Everything below was detected automatically — 12 journeys inferred; no human context yet" + confirm-owner CTA), ingest progress (staged narrative, fog lifting, notify-me), failed sync (last-good snapshot banner + red sync chip distinct from amber stale), ping waiting 6 days + answer-marked-suspect state.
4. **Developer Trust** — function blast-radius panel for `finalizeInvoice` (real graph: called by routes.ts:27, touches Invoices/Ledger entries, on 2 journeys), edge-confidence legend in situ (resolved solid, DI-heuristic dashed, unresolved "?" stub with candidates), `farsight diff` JSON snippet + policy gate verdict chip, coverage matrix strip (journeys × tests, one suspect link, one orphan test).

5. **One Product cover strip** *(added 2026-07-28)* — F16's narrative fix: one nav (Portfolio · Journeys · Dependencies · Changes) over one graph, role-based landing cards (F7), read-only chip in the chrome.

Figma: https://www.figma.com/design/VMHP6j8MpK9rVo3FJIL1bt — V1 preserved on page 03.

**2026-07-28 audit pass:** boards re-checked against F1–F16; F16 strip added, lens-naming rule added to the Grammar Book (F6 residual), and every F13 violation corrected against the real graph (guard coverage 7 of 11 = 64%, real commits/lines/journeys, real unknowns). Full change table + review-round-2 framing: `a review`. Shareable feature guide: `docs/FEATURES.md`.

---

# Round 2 response — V3 plan (2026-07-28)

**Input:** `a review` (same 8 personas, cold re-review of the V2 packet). Round 1 → 2: 7× TRIAL 1× HESITANT, 6.5/10 → **5× ADOPT 3× TRIAL, 8.3/10**. Arithmetic held 8-for-8; residual defects are labeling, mock hygiene, and **the boards the revision didn't re-show**. Every ADOPT is explicitly conditional on shipping what was drawn.

**Read of the room:** the swarm graded the *method* as fixed — "answered by name, on boards" is now the expectation. Three gates remain: (1) the unshown surfaces (Portfolio, Dependencies, Code map, light theme) — 7 voices; (2) design-vs-binary — everything that flipped verdicts is Phase 2+; (3) the revision violating its own Grammar Book four+ times in one packet. (1) and (3) are this pass; (2) is a build sequencing commitment, not a board.

## 1 · Round-2 findings → G-items

| # | Finding (voices) | What it becomes | Priority |
|---|---|---|---|
| G1 | Portfolio never re-shown — the exec's screen is the one screen not hardened (Diane MAJOR ×2, Marcus MAJOR, Priya, Tom, Rafael) | **V3 Portfolio board**: KPI row with provenance popover on every number, scope labels ("workspace · 4 sources" vs per-source), freshness legend re-drawn as glyph+word per Grammar Book, professional register, real numbers | **P0** |
| G2 | Dependencies never re-shown; "REACHABLE" false-positive semantics open (Sofia MAJOR, Rafael MAJOR, Diane) | **V3 supply view**: per-edge confidence on every REACHABLE (resolved/heuristic+tier/"?" stub), violet-on-violet lanes fixed, risk advisory attributed. Drawn as the supply view *of the Code map* (see G3 decision) | **P0** |
| G3 | "Code map" nav orphan — dev card lands on a surface that's not in the nav and on no board (Devon MAJOR ×2, Priya MAJOR ×2, Rafael) | **Decision: the nav becomes Portfolio · Journeys · Code map · Changes.** Dependencies is the Code map's supply view (a lens toggle, not a fifth tab) — Marcus already called it "the supply view." **V3 Code map board** designs the repo altitude (Devon's Tuesday) with the supply view in situ | **P0** |
| G4 | Line of visibility gone; SCREEN is a ghost; top band "went thin" (Priya MAJOR ×2, Rafael, Tom "keep it forever", Devon, 8/8 endorse derived links) | **Restore the three-band blueprint**: WHAT THE USER SEES / line of visibility / WHAT THE SYSTEM DOES / RECORDS & MESSAGES. SCREEN band = derived screen cards (real `page` nodes: `/invoices` → `InvoiceListPage.tsx:7` ⧉) with freshness — never hand-placed screenshots (8/8 guard). Jared's directive: keep the V1 lane idea explicitly | **P0** |
| G5 | The floor wearing point-value clothes: "64%" chip vs its own 64–100% popover (Sofia, Rafael, Marcus, Priya, Diane) | Chip renders **`≥ 64%`**; headline prose "at least 64%"; range stays in popover and **in exports**; "definition changed in v1 (was 71%, 29 of 41, all entry kinds)" note near any historical value (Tom) | **P0** |
| G6 | Unlabeled scope on counts: 13 journeys vs 5 journeys (6 voices); 64% workspace metric on a single journey's page (Priya MAJOR) | **Scope-label rule in the Grammar Book**: every count carries its scope chip ("workspace · 4 sources" / "invoice-app only"). Applied everywhere in V3 | **P0** |
| G7 | The revision violates its own grammar (Priya ×4 incl. 2 MAJOR, Devon ×2, Rafael): red hexagon = violation *and* broken pipeline; "absence ≠ no" caption vs "absence always means no"; GATE captioned shield, drawn padlock; "undocumented fork" vs DECISION; "phase chips" in prose | **Grammar Book v1.1**: BROKEN PIPELINE gets its own glyph+row (never the octagon/hexagon); stub caption unclipped and corrected ("the ? stub exists **so that** absence can safely mean no"); "amber padlock, always"; "undocumented **decision**"; prose lint. New standing rule: **the Grammar Book is the lint fixture — no board ships a string or glyph the book doesn't license, and the lint covers popovers, tooltips, and design annotations** (Priya, Rafael) | **P0** |
| G8 | Mock hygiene: Share menu occludes "Notify customer" + USED BY (6 voices); two clipped strings on 17:18; ingest bar ahead of its stages; "64%" means two things in one packet (Rafael) | V3 journeys board draws the share menu clear of the map; strings unclipped; ingest stage percentages ≠ the guard metric's 64; progress bar agrees with its stages | **P0** |
| G9 | "Send invoice" name collision: trigger of Finalize invoice vs a separate journey (Tom MAJOR) | Real resolution from the graph: the other journey is **spring-invoice-api's** `POST /api/invoices/:param/send`. **Journey-identity rule**: journey names carry a source qualifier whenever ambiguous ("Send invoice · spring-invoice-api"); trigger copy says "clicks **Send** on the Invoices screen" | **P0** |
| G10 | 1:1 header↔map claim overreaches — 5 header steps vs 3 boxes + gate + diamond + envelope (Rafael MAJOR) | Header STEPS row becomes truly 1:1: gate, decision, and message are first-class chips in the header, same names as the map | **P0** |
| G11 | Diff/CI contract seams (Anna: string-keyed journeys vs "stable IDs" caption; no truncation marker; the one falsification break — diff base 39→head 41 omits Send invoice while the matrix marks it suspect at sync 41; technique tiers unenumerated) | **V3 Developer Trust**: JSON keyed by stable id + display name alongside, `"truncated": false`, per-change `confidence` tier, and the diff now *contains* the Send-invoice change the matrix cites. Contract-first Phase 2 commitment (freeze JSON before UI) | **P0** |
| G12 | file:line anchoring rule unstated; :58 = `finalizeInvoice()` mapping implicit; no timezone (Priya, Sofia) | Anchoring rule stated on the board: **a step anchors to the first line of its work inside the entry function; a step that is one named call anchors to the callee's definition**. All timestamps carry TZ ("09:14 EDT") | **P0** |
| G13 | Guard-coverage v1 excludes scheduled/listener entries — "precisely where my incidents live" (Anna) | **Companion metric**, real: "Non-route entries: 0 of 2 gate-checked at entry (1 scheduled · 1 listener) · v1-companion" on Portfolio + popover | **P1** |
| G14 | Stewardship is Phase 3; "month 3 is when zombie tools are born" (Marcus MAJOR, Sofia) | **V3 Stewardship board**: assignable debt queue (the real 4 ungated endpoints, unconfirmed machine names, 1 suspect answer) with owner + age; private completeness meter; the no-OKR/no-per-person boundary written on the board (Sofia's guard, Diane's privacy edge). **Pulled into Phase 2** | **P1** |
| G15 | Cost-of-ownership absent two rounds running — "'Adopt' is a budget word" (Diane MAJOR) | **Cost panel on the Portfolio board**: deployment model, ingest owner, upkeep hours/team/month, the line items it retires. Same provenance discipline as the metrics | **P0** |
| G16 | Keyboard-first undiscoverable ("press b" is a secret; no keymap) (Tom MAJOR, Devon, Sofia) | Visible **"What does changing this affect?"** button on step cards + same item on the context menu; **published keymap panel** (b · j/k · ⌘K · f) on Developer Trust | **P1** |
| G17 | Hardcoded interruption policy: 6/10-day thresholds, Slack-only (Sofia, Priya, Marcus, Diane) | Escalation thresholds shown as **repo-owned config** (like the CI policy file); "Notify me" channel-agnostic (Slack · Teams · webhook) | **P1** |
| G18 | Light theme unseen after three asks (Diane ×3, Rafael) | **One full light-theme rendering** — the Portfolio board (the projector screen Diane will actually present) | **P0** |
| G19 | Amber carries eight jobs (Rafael); incomplete-arm terminal vs STALE clock identical at small size | Grammar Book amber policy: amber = lens tint + attention family; **stale always clock+word; incomplete terminal gets a distinct barred-ring glyph**; small-size distinctness rule | **P1** |
| G20 | Scale undemonstrated — everything ≤13 journeys / 22 files; layout determinism unstated (Anna MAJOR) | Round-3 material: scale exhibit against a real 100k-line codebase (a second real app: 6,249 nodes is the honest start) + layout-determinism statement. Not drawn this pass; committed in the handoff | **P2** |

Tensions resolved deliberately: provenance popover keeps all content, layered — plain sentence first, ORIGIN MIX gets a business-register rendering and sits below the fold, collapsed-to-chip by default (the §4 resolution "layering/register, not deletion"). Range honesty ships in both registers: chip `≥ 64%`, exec headline "at least 64%". Screen band links are derived cards/thumbnail chips with freshness — never hand-placed (unanimous guard). Chrome density (Marcus) answered with collapsed-by-default states, not removal.

## 2 · V3 boards (page "05 · V3 — the reprint", V2 preserved on page 04)

1. **V3 · ONE PRODUCT cover** — nav fixed to Portfolio · Journeys · Code map · Changes (G3); Dependencies named as the Code map's supply view; cover-name → board-name mapping line (Rafael); shorter paragraph (Sofia).
2. **V3 · Portfolio** (G1, G13, G15) — exec landing, real KPIs w/ popovers + scope chips, companion guard metric, freshness glyphs, cost-of-ownership panel.
3. **V3 · Portfolio — light theme** (G18) — same board, light tokens.
4. **V3 · Blueprint Journeys** (G4, G5, G6, G8, G9, G10, G12, G16) — three bands restored w/ labeled line of visibility; SCREEN cards from real page nodes; ≥64%; scope chips; 1:1 header; share menu unoccluded; anchoring rule + TZ; visible change-impact button.
5. **V3 · Code map + supply view** (G2, G3) — the repo altitude (Devon's Tuesday), per-edge confidence on every REACHABLE, the genuine cross-source truth (0 cross-source edges; `invoice.finalized` "?" stub).
6. **V3 · Grammar Book v1.1** (G6, G7, G19) — BROKEN PIPELINE glyph, padlock, decision, unclipped stub caption, amber policy, scope-label rule, journey-identity rule, book-as-lint-fixture rule.
7. **V3 · Honest States v1.1** (G8, G17) — bar/stage agreement, de-collided percentages, repo-owned thresholds, channel-agnostic notify, suspect-answers-in-exports toggle (Anna/Tom), + a fifth state: the viewer's own failure (Rafael).
8. **V3 · Developer Trust v1.1** (G11, G12, G16) — stable-ID diff JSON w/ truncation field, reconciled sync-41 story, technique-tier enumeration, unclipped strings, published keymap.
9. **V3 · Stewardship — the debt queue** (G14) — assignable queue w/ owner + age, completeness meter, the written boundary.

## 3 · Build sequencing commitment (the design-vs-binary gate)

Unchanged phases, two amendments the swarm demanded: **(a)** the diff JSON contract is frozen (versioned schema doc) *before* any Phase-2 UI — Anna's condition; **(b)** the minimal stewardship queue moves from Phase 3 → Phase 2 — Marcus's condition. Sofia's sentence goes on the wall: "No more boards until the boards are runnable" — after this reprint pass, the next artifact is a binary.
