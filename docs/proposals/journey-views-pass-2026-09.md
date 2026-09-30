# Journey views pass: honest defaults, a view axis, and the system sheet

Proposal + build contract · 2026-09-14 · branches `feat/journey-views` (journey) and `feat/tests-in-graph` (tests, parallel)

**What this pass does.** Three things, in this order, without losing the shipped journey view:

1. **Honest defaults in the fold** — the three backports the 2026-09-14 swarm §3-A ranked first: local cut points instead of a global truncation, business decisions filtered to what is actually a business decision, and helper plumbing folded under the call that used it. All three land in `journey()` / `journeySummary()` so every consumer (HUD, MCP, the new views) inherits them.
2. **A view axis** — `lens × view × band` become three independent controls. Today's overlay is `view=timeline` and keeps its `rows | ladder` band untouched. New visuals register as renderers over the same `summary` and get a header control, a key, a `?view=` deep link and per-browser persistence.
3. **The system sheet** — board 04 as the first new view: actions across, layers down, at most two chips per cell, drawn from the moments and system rows the summary already has. Honest labels: columns are *call groups* (one client-side action and what it caused) until the action-ownership pass lands.

In parallel, on its own branch, **tests Pass 1 + 2** from [tests-surface.md](tests-surface.md) §6 with the swarm's §3-C adjustments, so the sheet's *verified by* row and the coming code-view gutter read real `covers` edges. The reference app gets its two reporter lines. **Follow-up recorded:** `examples/invoice-app` needs a `test/` + `e2e/` fixture and a report so the fixture-backed parser test and the dogfood graph carry tests too.

Why this order: the reviewers scored the shipped view 3–4/10 on honesty, not on layout. A new visual over dishonest data would inherit the same complaints. The sheet is first because it is the most derivable board (segments → columns, system rows → layers, markers → chips) and because the dependency-impact proposal wants to draw its rings on it.

---

## 1. Data contract — `packages/core/src/query.ts`

Additive. Old fields keep their names; one semantic narrows and is documented.

### 1.1 Cut points

```ts
export interface JourneyCutPoint {
  reason: 'depth' | 'steps' | 'repeat';
  /** the step whose subtree was cut (its order) */
  parentStep: number;
  /** the child that was not walked (or, for 'steps', the child that did not fit) */
  nodeId: string;
  edgeId?: string;
  depth: number;           // the depth the child would have had
}
export interface Journey {
  …
  /** the walk ended early: maxSteps reached (global). Depth and repeat exhaustion are LOCAL — see cutPoints */
  truncated: boolean;
  cutPoints: JourneyCutPoint[];
}
```

- **Depth exhaustion is local.** In `walk()`, `depth + 1 > maxDepth` records a cut point for that child and `continue`s to the next sibling. It never sets `truncated` and never ends the walk. A deep first screen no longer hides the second and third screens.
- **Step exhaustion stays global.** `maxSteps` sets `truncated = true` and records one cut point with `reason: 'steps'` at the step where it happened.
- **Repeat exhaustion is visible.** A node past its re-visit budget is pushed as a `repeat: true` step **without recursing** (today it vanishes), and a cut point with `reason: 'repeat'` records the subtree that was not re-walked. Existing tests that assert step counts may change; update them with the reason in the assertion message.
- `JourneySummary.counts.cutPoints` (total) and `JourneySegment.counts.cutPoints` (cut points whose `parentStep` lies in `[from, to]`). `SegmentMarker.cut?: number` = how many cut points hang off that marker's step (the HUD draws ▸ *n not followed* on the chip).
- MCP `journey` prints `· n cut point(s): depth ×a · repeat ×b` on the header line and lists them under a `## cut points` section (parent name · reason · the child not walked) when `depth`/`forks` options are given; `⚠ truncated at cap` prints only for `reason: 'steps'`.

### 1.2 Decision classes

```ts
export type DecisionClass = 'business' | 'guard' | 'technical';
export interface PathCondition { …; class: DecisionClass }
export interface JourneySummary {
  business: {
    …
    /** translated decisions only: class business | guard */
    decisions: { nodeId: string; line: number; label: string; arm: string; class: DecisionClass; stepOrder: number }[];
    /** what was NOT translated, counted by branch category — never drawn as a diamond */
    untranslated: { count: number; byCategory: Partial<Record<BranchCategory, number>> };
  };
}
export interface JourneySegment { …; decisions: /* same shape */; untranslated: number }
```

- `class` is computed once, in `journey()`'s `conditionsAt()`: **business** when the arm or fork carries an authored `@business` label; **guard** when `categorizeBranch(bp)` is `access` or `guard` (an exit that refuses, an auth/session/scope check); **technical** otherwise (`error`, `flag`, `state`, `branch`). A `state` check with no `@business` label is technical — the review's `options.migrate ?? true`, `env.DATABASE_URL`, `exception thrown ×4` all fall here.
- `journeySummary()` puts only business + guard into `business.decisions` and each segment's `decisions`; everything else increments `untranslated`. `counts.decisions` counts translated ones. The `timeline[]` items of kind `decision` are emitted only for translated conditions; the step's own `conditions[]` array keeps every class so the forks drawer and the spliced code still show them.
- Each decision entry carries `stepOrder` so the HUD stops recomputing decisions from `steps[].conditions` client-side (`jrnSegDecisions` reads `sg.decisions`).

### 1.3 Helper fold

```ts
export interface SegmentMarker {
  …
  /** plumbing: a function called by another function on the same side of the seam, not by the action or the handler */
  helper?: boolean;
  /** the marker this one folds under (its nearest non-helper ancestor marker's stepOrder) */
  under?: number;
}
export interface JourneyMoment { counts: { …; helpers: number } }
```

- Today `helper` is set only server-side (`side === 'server' && parent.kind !== 'route'`). Extend it to both sides: a `step` marker is a helper when its parent step is a `function` on the **same side** and that parent is not the moment's `actionStep` (ux) or the route's handler (server, the step right under the route). So `apiBase · readJson · assertOk · toProblem · cx` under `listMyVendorAccounts` fold; `listMyVendorAccounts` itself stays an action chip.
- `under` points at the nearest ancestor marker that is not a helper (walk `parentOf` until a non-helper marker in the same segment). Helpers keep their `stepOrder`, so j/k, the forks drawer and the expansion slot still address them.
- **Not folded, ever:** calls, records, messages, externals, gates, decisions. A helper that writes a table still puts the record marker in the records row (the record marker's `under` is the helper's own `under`).

### 1.4 Labels in the hybrid register

The HUD's hybrid marker text becomes *identifier · label* when an authored label exists and *identifier* alone otherwise. `humanizeName()` output alone never becomes a marker name outside the business lens. (Viewer-only; `jrnMarkerText` + `jrnLabel`.)

### 1.5 Tests in core (`packages/core/test/`)

Extend `journey-band.test.ts` (or add `journey-honest.test.ts`) with an in-memory fixture that has: a deep first screen (depth > maxDepth) followed by a shallow second screen — assert both screens segment and the cut point names the deep parent; a true cycle; a shared helper called from two handlers (folds under each, `under` differs); a repeat past budget (visible as `repeat: true`, cut point `repeat`); step-budget exhaustion (`truncated: true`, one `steps` cut point); one `@business` arm, one `exits` guard arm, one `env.X` flag arm — assert classes and `untranslated.byCategory`.

---

## 2. Viewer contract — `packages/server/public/app/`

### 2.1 The view axis

- `S.jrnLayout`: `'timeline' | 'sheet'` (later `'rail'`, `'drill'`). Persisted `fs-jrn-layout`. *2026-09-16:* `'drill'` landed as board 02 behind the `flags.journeyDrill` workspace flag (`surfaces/journey-drill.js`); with the flag off it reads as `timeline`. Deep link `?view=timeline|sheet` on `#/journeys/<id>` (the shell already parses `view`; it must copy it onto `S.jrnLayout` when the surface is `journeys`, the way it copies `band`). Deep link wins over persistence.
- Header control in `.jrn-head`, right of the counts: a segmented switch `TIMELINE · SHEET` (strings `journey.layout.timeline` / `journey.layout.sheet`, with professional-register descriptions). Key **`v`** cycles layouts (add to `KEYS` and `key.v`; `l` keeps its band meaning and is inert in the sheet).
- `renderJourney()` dispatches by layout after the shared header work: `timeline` → today's `jrnTimelineHtml` unchanged; `sheet` → `jrnSheetHtml(sum)`. Selection (`S.journeyActive`), lens and scope survive a layout switch; the expansion slot re-opens under the selected marker in the new layout when it exists there.
- Share: journey URLs written by `y` / the Share menu carry `@sync:<n>` (from `S.META.sync` or wherever the sync chip reads it) plus `?lens=&view=&band=`. The shell already accepts `@sync:N`.

### 2.2 Honest chrome in the timeline (the existing view)

- Header: `TRUNCATED` chip only when `data.truncated` (`steps`); a new `n cut points` chip (`journey.cutPoints`, warn colour) when `summary.counts.cutPoints > 0`, tooltip listing by reason. The forks button reads `⑂ n forks` **only in the code lens**; hybrid and business hide it (the drawer stays reachable from a marker's expansion).
- Business band (`jrnBizCellHtml`): decisions come from `sg.decisions` (translated only). A trailing chip `n technical conditions not translated` (`journey.untranslated`) when `sg.untranslated > 0`; clicking opens the forks drawer filtered to that segment. In the business lens the chip is a sentence, not a count in a badge.
- **Landed differently (2026-09-15):** the fold became a drill tree. The core sets `under` (nearest non-helper ancestor marker) and `tier` on *every* marker; rows and sheet draw tiers 0–1 (the handler / the action and their direct parts) and fold the rest under their part as `▸ n inside` (`▸ n helpers` when all plumbing), nested one level per click. Jared's ask: group the high-level parts (controller, service calls) and keep the helper code as drill-down, since the spliced code view already shows the whole flow.
- Markers: helpers no longer draw as peer chips. Under each non-helper marker that has helpers, one fold chip `▸ n helpers` (`journey.helpersFolded`) toggles them in place (rows view) or indents them (ladder, already does). `S.JRN_ORDERS` excludes folded helpers while their fold is closed so j/k walks the real steps; a jump to a folded helper (`jrnScrollTo`) opens its fold first. `cut` draws as `▸ n not followed` (`journey.notFollowed`) on the marker.
- Segment header counts: `decisions` = translated; add `· n cut` when the segment has cut points.

### 2.3 The system sheet — `jrnSheetHtml(sum)`

One grid, `overflow:auto` inside `#jrn-tl`, no horizontal page scroll. Reuses `jrnMarkerHtml`, `jrnSeamCardHtml` (compact variant), `jrnGateCardHtml`, `jrnScreenCardHtml`, `jrnExpHtml`, `jrnSelect`, `vsl`, `sym`, `t`.

**Columns = actions in journey order** = every `moment` of every segment, flattened. Column header (the rail stop): ordinal · `moment.label` · a person glyph (the browser made the call) or a system glyph (no client-side action: a route or job entry, a server-rendered load) · outcome chips = the call's contract 2xx statuses in cyan and 4xx in amber, each tagged `spec` (they are contract-derived, never thrown statuses) · `↺` when `moment.repeat` · `·n cut` when cut points hang inside it. A **screens row** above the stops spans each segment's columns (`grid-column: span n`) with the compact screen card (name, route, design chip, thumbnail in the business lens).

**Rows = layers, in request order**, one row per entry of this list, derived from `sum.systems`:

| layer | label (hud / professional) | source | cell content |
|---|---|---|---|
| What the user sees | `journey.layer.user` | the moment's `component` + the segment screen | component span chip; screen name when the moment opens the segment |
| App parts · `<repo>` | one per `repo:*:ux` system row | ux markers with `!helper` | step chips; `+n helpers` fold |
| The API call · `<spec title>` | one per `api:*` row | call markers | the seam card, compact: `METHOD operationId` · status chip · `req → res` schema chips from `contract.requestBody.schema` and the first 2xx `responses[].schema` (`journey.schemaChip`, plain text, no tree yet) |
| Server parts · `<repo>` | one per `repo:*:server` row | server markers with `!helper` | step chips; `+n helpers` fold |
| Gates & business | `journey.layer.gates` (new, always present) | `sg.gates` whose `stepOrder` ∈ moment range + `sg.decisions` in range | gate cards (kind glyph, name, ×n) then decision chips; `n technical` chip when untranslated > 0 in range |
| Records | `records` row | record markers | `reads x` / `writes y` chips (op word from `journey.op.*`) |
| Messages | `messages` row | message markers | chips; absence state |
| Third party · `<host>` | one per `external:*` row | external markers | chips |
| Verified by | `journey.layer.verified` (always present) | `summary.coverage` when the tests branch has merged, else absent | test chips `e2e n · unit n` linking to `#/tests?flow=…`; until then the absence word *no tests indexed* |

**Cell rules.** At most two chips, then `+n` (`journey.moreChips`) that expands that cell in place (toggle, no re-render of the grid). Empty cells use the **absence taxonomy** — a glyph and a word, never a bare dash: `none indexed` (`journey.absent.noneIndexed`: we looked, nothing there — records/messages/third party with no markers), `not built` (`journey.absent.notBuilt`, dashed — a planned marker or a planned system row), `not involved` (`journey.absent.notInvolved` — a layer that does not apply to this action, e.g. no call in a local-only action). Clicking a chip calls `jrnSelect(stepOrder)`; the expansion slot opens as a full-width row directly under that layer (one `jrn-exp-<layerIndex>` per layer, same mechanism as the rows view). j/k walk chips in column-then-row order.

**Lens behaviour** (`body.lens-*` CSS plus register-aware text, same as the timeline):
- business: chips read words (`bizLabel` / contract summary / `journey.op.*` + humanized table name); no identifiers, no file paths outside ⧉; the API row shows the spec summary; gates read as checkpoints; the untranslated chip is a sentence.
- hybrid: identifier · label; helpers folded.
- code: identifiers; helpers folded but the fold opens on the selected marker; file:line under the chip on hover.

**Header line** for the sheet reuses the timeline's counts and adds `n actions` (`journey.countActions`, the column count) — and says *call groups* in the tooltip (`journey.actionsAreCallGroups`) until actions are first-class.

**Multi-repo journeys** (invoice-app → spring-invoice-api, or Farsight itself) simply get more layer rows, one per system row, in `systemRank` order. The layer label carries the repo name.

### 2.4 Strings and lint

Every new user-facing string is a `journey.*` key in `core/src/strings.ts` with both registers where the wording differs (business = professional register). `pnpm lint:strings` must pass; `#/grammar` renders the new keys. New symbols, if any, go in the SVG sprite through `sym()`.

### 2.5 Tests and checks

`pnpm build && pnpm -r typecheck && pnpm -r test && pnpm lint:strings`. Visual check on the reference app submission flow (`example-app::flow::invoice-submission` at the workspace graph) and on invoice-app *Invoice list*, in three lenses and both themes, in `view=timeline` (rows + ladder unchanged except the honest chrome) and `view=sheet`. Screenshots go to `the journey-timeline design reference current/` (replace the set) — the swarm re-runs on them.

---

## 3. Tests track — `feat/tests-in-graph` (parallel)

Build [tests-surface.md](tests-surface.md) §6 **Pass 1 + Pass 2** as written, with the swarm's §3-C adjustments:

1. `sourceDigest` recorded by the reporter is required for *unchanged since the run*; mtime alone yields `unknown`, never fresh.
2. Istanbul run-level edges render as *reached by the unit run*, never a per-test count on a section.
3. `farsight tests matrix --format csv` columns: `flow_id, screen_id, step_node_id, test_id, test_title, level, evidence, technique, confidence, run_id, run_at, status, stale, source_digest, sync`.
4. Gate kinds `coverage_lost` and `uncovered_change` (additive to `farsight-diff v1`, version note in the contract doc).

Keep the journey touch-points **additive and small** so the two branches merge cleanly: put the coverage fold in a new `core/src/coverage.ts` (`journeyCoverage(index, journey, segments)` → `summary.coverage` + per-segment `coverage`), called from one line at the end of `journeySummary()`; per-step `coverage` attached by the server's `enrichStep`. Do not restructure `journeySummary()`.

**The reference app reporter lines** (allowed by the owner for this pass): Vitest `reporters: ['default', 'json']` + `outputFile` and `coverage.reporter: ['json']` in each `vitest.config.mts` / `vite.config.mts` that declares coverage; Playwright `['json', { outputFile: 'test-results/results.json' }]` appended to `reporter`. Run the unit suite with coverage once if it completes inside the agent's budget; never run the e2e suite (it boots a server). The reference app has uncommitted edits — preserve them and touch only the config files. Record in the handoff that `examples/invoice-app` still needs its own `test/` + `e2e/` fixture and report.

---

## 4. File ownership

| agent | owns | must not touch |
|---|---|---|
| **core** (journey honesty) | `packages/core/src/query.ts`, `packages/core/test/journey-*.test.ts`, `packages/mcp/src/run.ts` (journey printer), `packages/server/src/index.ts` only if `/api/journey` needs a field passed through | `public/app/*`, `strings.ts` |
| **viewer** (view axis + sheet + honest chrome) | `packages/server/public/app/surfaces/journeys.js`, `keymap.js`, `shell.js` (view param), `share.js` (sync in journey links), `viewer.html` (CSS + header markup), `packages/core/src/strings.ts` | `query.ts`, `run.ts` |
| **tests** (parallel worktree) | everything in tests-surface.md §6 Pass 1–2 + `core/src/coverage.ts` + `core/src/metrics.ts` (new) + the reference app config files | `journeySummary()` internals, `public/app/*` |

The viewer agent codes against §1 with fail-soft fallbacks (missing `cutPoints`, `untranslated`, `under`, `class` → today's behaviour) so it can run before the core branch is merged; the lead merges core first, then viewer, and does the visual pass on the merged build.

## 5. Acceptance

- The reference app submission flow: three segments, no `TRUNCATED` chip at the default depth, a `n cut points` chip instead; business lens shows only `@business`/guard decisions and one *n technical conditions not translated* line per segment; hybrid moments read `listMyVendorAccounts · List my vendor accounts` with `▸ 5 helpers` folded, never `Api base · Assert ok`.
- `view=sheet` on the same flow: one column per call group in journey order, screens spanning their columns, layers in request order, at most two chips per cell, the absence words in empty cells, a chip click opening the seam splice under the API layer; `?view=sheet&lens=business` reads without an identifier in sight.
- `view=timeline` with `band=rows` and `band=ladder` render exactly as before apart from the honest chrome (compare against `current/` screenshots).
- MCP `journey` header line reports cut points by reason; `journey` output for the invoice-app fixture is stable in `pnpm -r test`.
- Tests branch: the acceptance lists of tests-surface.md Pass 1 and Pass 2; the reference app's reporter configs edited and named in the handoff.
