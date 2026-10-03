# Viewer map — modules, the journey's views, and the band mechanics

> Moved out of `AGENTS.md` so it is not read at the start of every session. Open it before editing
> `packages/server/public/`. The invariants that always apply — every string through the two-register catalog,
> every glyph through `sym()`, `pnpm lint:strings` gating both — stay in `AGENTS.md`.

Deliberately vanilla JS, no framework, no build step (Phase 1; replaced by the canvas `packages/app` in Phase 2) — don't over-invest, but keep it working. Since V3 P2 the old single `viewer.js` is split into ES modules under `public/app/`: `shell.js` (hash router — `#/portfolio · #/journeys/<entry> · #/codemap[?node=id] · #/apis[/<apiId>][?op=<routeId>|view=spec&line=N|view=compare] · #/changes/N...M · #/grammar`, all accept `@sync:N` + `?scope=` + `?lens=` + `?band=`; nav, chrome, role-based landing via `defaultSurface`, deep link wins), `store.js` (shared mutable state `S.*` + fetch layer + `expose()` for inline-onclick globals), `strings.js`/`sym.js` (two-register catalog client + SVG sprite accessors — every user-facing string goes through `t()`, every symbol through `sym()`; `pnpm lint:strings` enforces this and the `#/grammar` page renders the whole book), `keymap.js` (ALL key bindings central — `b · j/k · l · v · d · [ ] · f · ⌘K · y · ? · esc`), ⌘K fast travel (`shell.js` `pick` → `travelTarget(n)`, 2026-09-25) arrives on the surface where the node can be seen — a flow as its journey, an API on APIs, a test on its Tests detail, a route/page as its journey in the business register, a gate as what it guards, anything else on the code map selected with no focus filter (`S.pendingFocus`, spent by `mountCodemap` → `arriveAt`); the palette row names the destination, and in the business register shows only the business name, `stories.js` (`@group Stories`, ADR 9 — the one place a story is drawn: `storiesSecHtml(n)` the inspector's Stories section for a component/page — story tabs by name, the picked story framed live (300 px, a click opens it large), *What it shows* from the story's JSDoc, the file line outside the business register, the Docs page when the running Storybook lists one, `not reached` + the start command + *Check again* when the Storybook does not answer, `none indexed` plus chips for the parts it renders that have stories; `openStoryLightbox` the large view, every story down the side, the frame at ~92vw × 88vh; `storyChipsHtml(screenStoryIds(n, components))` the chips on a journey screen card and storyboard scene — the screen, its components and what it renders within two hops, never a `plumbing` part; `storiesCatalogueHtml()` the *Components on show* catalogue under the Portfolio table, one row per Storybook then components grouped by title; one cached `/api/stories` answer per 15 s, *Check again* re-reads with `?refresh=1`; the journey's component span gains a story glyph), `share.js`/`impact.js`/`provenance.js` (stubs growing in P5/P6/P3), `surfaces/*.js` (journeys carries the Journey view; codemap hosts today's graph; `apis.js` is the APIs tab — cards with defined counts, operations by tag, contract panel with consumers + call sites, line-anchored spec view, READ-ONLY compare drawer, all facts from `/api/apis*`; portfolio/changes/stewardship are honest placeholders), `lib/graph-render.js` (node-card/lane/edge renderer). Key mechanics: `displayNodes()` builds the display list (guards→badges; grouping via `effectiveGroup()` — parser `group` field OR embedded-component detection `embeddedRootOf()`); groups render collapsed as nodes or expanded as in-place `.groupbox` containers with mini-card members; flowing variable-height column layout in `render()`; `positions{}` drives SVG edge routing; lens = body class + CSS; theme = `data-theme`. Scope = multi-select: `scope` is `'all'` or an array of source names (persisted `fs-scope-v2`), picked in a grouped dropdown where collections are checkable groups (`buildScope`/`toggleScopeSrc`/`toggleScopeColl`); filtering is by repo name. `vsl(repo,path,line)` appends a ⧉ `vscode://file` deep link wherever a file:line is shown (fail-soft off `GRAPH.roots`). Journey view (`@group Journey view` fns, `#journey` overlay) = the **blueprint timeline** (docs/proposals/blueprint-timeline.md option C, system band per docs/proposals/journey-system-band.md §6 = boards B + F + C): fetches `/api/journey` and draws `summary.segments` × `summary.systems` as one horizontally scrolling grid (`jrnTimelineHtml`) — a sticky header row of segment stops (ordinal, screen name, counts, progress bar), the *What the user sees* row (`jrnScreenCardHtml` with design thumbnails via `designThumbHtml` → `/api/design/image`, lightbox, ⧉ design / page / component / doc links; the entry card when a segment has no screen), a labelled line of visibility, the *Business* row (`jrnBizCellHtml`: ▶ start, gate checkpoints deduped with ×n, the first sentence of the screen's business text as the step — with the segment's decisions folded into it as ⑂ chips in hybrid/code, the full `jrnFlowDecision` flowchart in business — ■ end; docs dock on the lane label), then the system band as **rows × moments** (`jrnSystemRowsHtml`): rows in request order from `summary.systems` (*The screen asks* · `<repo>` · browser → *API* · spec title → *The service does* · `<repo>` · server → records → messages → third party), each segment cell a grid of that screen's `moments` (`jrnMomHeadHtml` stops; column widths measured once in `jrnMeasure` and shared through a per-segment template so every row aligns). A column reads down as one transaction. The browser row draws the moment's component once as a span header (`jrnCompSpanHtml`, *still open* when it carried over); the API row draws each call as the **seam card** (`jrnSeamCardHtml`: method · operationId · spec summary · contract-status chip, then `← from <fetch line>` ⧉ · `→ handled <handler>` ⧉, or *not built yet*); markers are ↺ ghosts when repeated and ▸ helpers under their handler. Clicking a marker (`jrnSelect`) opens the expansion slot under that row — for a call the **seam splice** (`jrnExpHtml`: caller code around the fetch · the contract block · the route and what it continues into, via `jrnCodeWindow`/`jrnCodeSeg`/`jrnReqChips`), otherwise the Wallaby-style spliced timeline (`jrnSectionHtml`, ⑂ fork markers + Forks drawer). A `rows | ladder` toggle in the band header (key `l`, persisted `fs-jrn-view`, `?band=` deep link) redraws each segment as a **ladder** (`jrnLadderHtml`, board F): the same systems as columns, time running down, one line per marker, the call crossing the seam left to right, helpers indented, records/messages arrowed out of the service column, capped at a line budget with *▾ n more steps*. **Per screen the ladder draws only the systems it uses (2026-09-25, `jrnLadderModel`):** a system skipped before or between used ones keeps its place as a 34 px dimmed column with its name and *not involved* running down it; the systems after the last one used fold into one end column — *Stops here* (business: *Goes no further*) — listing each with its absence word (*not reached* when the walk was cut on that screen), tip `jrnLadderCol`; a used column is ≥ 344 px up to 520 px by its content, the segment is never wider than the old `150 + systems × 172`, and a screen reaching every system with no gap is drawn exactly as before (`e2e/tests/journey-ladder.pw.spec.ts`). `j`/`k` walk markers, Esc closes the expansion, then the forks drawer, then the overlay. **Code pane dock (2026-09-15):** `S.jrnDock` `inline | bottom | right` (`IN PLACE · BOTTOM · RIGHT` in the header, key `d`, `?dock=`, `fs-jrn-dock`, default `bottom`) says where a marker's expansion opens — under its row as before, or in the `#jrn-dock` pane pinned to the bottom or the right of the overlay (`jrnSelect` routes to `jrnDockRender`; the pane keeps the *click a marker* hint when nothing is selected, its grip drags a size remembered per dock in `fs-jrn-dock-<dock>`, the seam splice stacks its three sides when docked right); both layouts and every lens share it. Linked journeys (`summary.links`: ◀ requires · leads to ▶ as slim end columns, *part of* chips in the header) run the other flow on click. Lens CSS on `body.lens-*`: business = big thumbnails, full flowchart, rows as counts per moment except the API row (summaries, expanded), no code; code = screen chips, gates only, rows + code open. **View axis (2026-09-14):** `S.jrnLayout` `timeline | sheet` (`?view=`, key `v`, `fs-jrn-layout`) is independent of lens and band; `renderJourney` dispatches to `jrnTimelineHtml` (unchanged) or `jrnSheetHtml` (board 04: `jrnSheetModel` builds columns = every moment of every segment and layers = `sum.systems` in rank order plus *Gates & business* and *Verified by*; `jrnSheetCellHtml` caps a cell at two chips + `+n`, folds helpers, and draws the absence words). **Drill tree (2026-09-15):** every marker carries `under` + `tier` from the core; `jrnCellTree()` picks what a cell draws by default (its roots plus tiers 0–1 that are not helpers) and `jrnFoldHtml()` folds the rest under their part as `▸ n inside` / `▸ n helpers`, nested one level at a time (rows and sheet; the ladder indents by tier); folds register on `S.JRN_FOLDS`/`S.JRN_FOLD_OF` so `jrnOrdersNow()` (j/k) skips what is folded and `jrnRevealFold()` opens every fold above a jump target. Honest chrome reads the core's `cutPoints`/`untranslated`/`helper`/`under`/`cut` fail-soft (an older server falls back to the shipped behaviour); the business register draws only `class:'business'` decisions and folds unlabelled guards into the *not translated* sentence. **Action drill (2026-09-16, behind a flag):** `surfaces/journey-drill.js` (`@group Journey drill`) draws board 02 (`the journey-timeline design reference 02-action-drill.html`) from the same summary — the third value of the view axis, `S.jrnLayout = 'drill'` (`DRILL` in the `TIMELINE · SHEET · DRILL` switch, `?view=drill`, key `v` cycles through it), shown only when the workspace flag `flags.journeyDrill` in `.farsight/settings.json` is true (Settings → *Experiments* checkbox; `jrnDrillEnabled()`; with the flag off a remembered or deep-linked `drill` reads as the timeline and the switch has two buttons). Three parts: the **action rail** (every moment of every segment as arrowed stops, screens spanning them, `jrnDrillGo(ci)` / keys `[` `]`), the **lanes** of the open action (`jrnDrillBeats()`: rows = the sheet's layers minus *Verified by* plus always-present records · messages · third party rows that say *none indexed* when absent; columns = **beats** in causal order — every tier 0–1 marker of the drill tree in step order, a minor part with no drill, no data under it and no authored label folded into the previous beat's box as an *also* chip, the **answer** beat from the contract's responses after the last server beat and tagged *spec*, records/messages/externals in the column of the part that reached them, gates and translated decisions in the column of their step; one box per cell (`jrnDrillBoxHtml`: kind · name ⧉ · authored sentence · `▸ n inside`; the seam card for a call, wider column) and elbow **wires** drawn from the DOM into an SVG overlay (`jrnDrillWires`, redrawn by a ResizeObserver when a fold opens) — fixed column widths, nothing overlaps) and the **inspector** on the right (`jrnDrillInspect`: DOCS · REQUEST / RESPONSE (calls) · CODE (not in business) · FORKS · TESTS; `jrnExpBodyHtml` is the expansion body split out of `jrnExpHtml` so the CODE tab reuses the seam splice / spliced timeline). `jrnSelect` routes to the inspector when `S.JRN_DRILL` is set (opening the action a step lives in first); the dock switch hides in the drill. The Journeys picker mounts a **Designs** section (`jrnMountDesigns` from `/api/design`: flows first with Run journey, then designed-not-built / built screens).

## Tooltips — `lib/tooltip.js` (2026-09-25)

**The rule** (AGENTS.md invariants): every number and every detail carries a tip built from the catalog's
`define` and its scope. A number's tip says three things before anything else — *what it counts* (the define of
the catalog key that prints it), *the scope it counts over*, and *where it came from* (`/api/journey · sync 64`;
the business lens reads `sync 64` and never the endpoint) — then, optionally, a breakdown that adds up to it and
a link to the Grammar Book entry (`#/grammar?key=<key>` scrolls to and marks the row).

**Triggers.** Hover opens after `TIP_HOVER_MS` (one exported constant, default 2000 — the e2e spec reads it from
the module); once a hover tip is open the next trigger opens after `TIP_WARM_MS`. A click opens at once and pins
(Esc, the ✕, or an outside click closes it). Keyboard: every trigger is a tab stop (`tipAttrs` writes
`tabindex="0"`; a MutationObserver adds it to any trigger missing one); `?` opens the focused trigger's tip, and
Enter / Space do too where the trigger is not itself a button or link. `keymap.js` asks `tipKeydown(e)` **first**,
so Esc closes a tip before the palette, a menu or the journey. Tab from a trigger walks into its rich tip's links;
Tab off the last stop leaves through the trigger. One tip at a time; it closes on a scroll of what holds its
trigger, a resize, or its trigger leaving the page — unless a redraw put an equivalent trigger back (same `id`,
same `data-tip-key`, or the same tip attributes), in which case it moves onto it and rebuilds in the current
register. A button whose own menu is open (`aria-expanded="true"`) does not open a hover tip.

**Layer.** One `#fs-tip` element portalled to `<body>` (`position: fixed`, z-index 1000): never clipped by an
`overflow:hidden` panel, never inside a `focus-trap.js` BEHIND layer, above the ⌘K palette, the journey overlay,
the inspector and the lightboxes. Simple tips are `role="tooltip"` and set `aria-describedby` on the trigger;
rich tips are `role="dialog"`, named by their first heading, with a ✕. Placement (`placeTip`, pure) prefers
below, flips above, clamps to the viewport, points its arrow at the trigger's centre, and gives a tall tip a
scrolling body. Fade-in is off under `prefers-reduced-motion`. Tokens only, so both themes hold.

**The marker.** A dotted underline in `--dim` and a help cursor; it warms to the lens accent while the pointer
rests (`.tip-pending`) and while the tip is open (`.tip-on`). A button keeps its own cursor and puts the marker
on its number only (`.morebtn .cnt`, the sync chip's `.ct`).

**Defines are plain text — no markdown, no subset** (2026-09-27). Every tip escapes the catalog's words and
its `define` (`esc()`); nothing renders `*emphasis*`, backticks or links out of a define, so any of them would
reach the reader literally (the story swarm read `journey.untranslated` and `*actions*` in business popovers).
`defineProblems()` in `packages/core/test/counts.test.ts` fails the build on a backticked span, `*…*` / `**…**`,
an unfilled `{placeholder}`, or any dotted identifier — a catalog key, a file name, `it.each` — in a define.
Name another number by its words (*the checks*), never by its key. A singular entry (`journey.countScreensOne`) is
built with `one(word, pluralKey)` and carries its plural's define word for word, copied in at construction.

**The not-in-plain-language list** (2026-09-27). The number of conditions nobody put in plain language — the
header's `g-words` count, a screen's sentence, an action's cell and the drill's rail — passes `list: { t, g }` to
the `jrnCounted` tip: the step ranges its technical conditions (`summary.business.untranslated.items`) and its
unlabelled gate conditions (the guard-class `business.decisions`) cover (`true` = the whole journey;
`jrnActionUntrList(sg, mo)` for an action). `jrnUntrListTip` draws them under *The conditions, and where each one
sits*: one row each in hybrid and code (where · kind · the condition), and in business folded by place and kind
with a count, the condition left out and the place said in words somebody wrote or *nobody wrote words for this*.
It is drawn only when its rows add up to the number.

### Numbers and words on the surfaces — `lib/counted.js`, `bizName()`, `unCode()` (2026-09-25)

The Portfolio, APIs, Tests, Changes, the code map and its inspector, the stories, the impact drawer and the chrome
print their numbers through `lib/counted.js`: `countedHtml(c, api)` prints a core `Counted` (docs/COUNTS.md §1) in
the lens's words — `bizUnit` in the business lens, and nothing where it has none — with its tip (what it counts ·
the scope · the endpoint and sync, plus the field in the code lens · the breakdown as `[words, n]` rows that add up
to it). `plainTip(n, of, scope, api, rows, grammarKey, vars)` does the same for a number that is not typed yet;
`defAttrs(key)` is the rich tip for a detail (evidence chips, absence words, kind badges, freshness), and replaces
every `title` those surfaces had. Their scopes and units are the catalog's `surf.*` block.

The business lens names things with `bizName(n)` (store.js): the words a person wrote, or `humanize()` — a route
reads its spec's summary (`plainClause`), a gate the label after its identifier, and never the identifier.
`unCode(text)` says a fold's sentence with its code in words (files, paths, `camelCase`, `SNAKE_CASE`, methods and
paths, hashes, bracketed document ids). `e2e/tests/surfaces.pw.spec.ts` counts identifier-shaped tokens on every
business surface and expects none.

⌘K matches identifiers (gates included) in every register and shows `bizName` in the business one. Each row carries
its node's full id (`data-id`; a click and Enter take the row on screen, `S.palResults`, never a second lookup by
name), and results that share a name get a second line (`ownerLines`: the owning class, else the shortest end of the
path no other same-named result shares — `auth/session/route.ts`). A gate travels as itself (2026-09-27): the URL
names the gate, `cardOf(id)` (`lib/graph-render.js`) is the card it sits on — opened, scrolled to and marked `.sel` —
and the inspector and `b` answer for the gate, whose inspector lists what it *protects*; it used to arrive on the
guarded card and answer for that. The code map is arrived at with `arriveAt(id)` — selected, group opened, in view, **no focus
filter** — and a focus left behind is dropped by `applyRoute` on any other surface. The nav keeps one order in
every register. The scope menu's Esc is caught on the window in the capture phase (`scopeMenuKey`), ahead of the
keymap. The theme previews on choose (`previewTheme`) and is written only by *Save settings*; `system` (and a
settings file with no theme) follows `prefers-color-scheme`.

### Change impact — `impact.js` (distance control, tests per distance, 2026-09-27)

The drawer (`openImpact`, `b`) and the journey's IMPACT tab draw one body, `impactBodyHtml(entry, redraw)`. In the
hybrid and code registers it carries a **HOW FAR** control (`impHopCtlHtml`: buttons 1–5, the current one
`aria-pressed`) that sets `S.impactHops`, writes `?impact=<id>&hops=N` into the hash (`impactHash`, so `y` and
Share copy a link that opens on the same distance) and redraws whichever surface drew the body last, once the new
answer lands (`impactSetHops`; the redraw is remembered from the last `impactBodyHtml` call). The business register
has no control: it counts no distances. Under each hop the line *tests reaching hops 1–N, each test once* is
`impTestsReaching(report, N)` — the union of the covering tests from hop 1 to N, the browser's copy of core
`impactTestsReaching`, held to it by `packages/server/test/impact-view.test.ts`; it can stay level or grow and never
goes down (it used to print only the tests new at each distance). The CLI and the MCP print the same union from core.
The body opens with its scope label, *on what uses this part* (`impScopeHtml`, `impact.scope`, every register) — the
same manner as a tests foot's *in this action* / *for this part alone*, so the three test numbers one step can show
(verified-by, the foot, impact) each name what they count over. `e2e/tests/impact.pw.spec.ts` drives the control,
the link and the label.

### API

| export | what |
|---|---|
| `tipAttrs({ key \| text \| number \| id, args?, tipKey?, noFocus? })` | attribute string for HTML-string surfaces |
| `setTip(el, sameOptions)` | the same onto an existing element (chrome drawn by hand) |
| `registerTip(name, (el, args) => html \| Node)` | a rich tip resolved when it opens — reads live state |
| `showTip(el, content, { rich, pinned, label })` / `hideTip()` / `tipOpen()` | imperative, for dynamic cases (also on `window`) |
| `numberTip({ count, of, vars?, scope, source, breakdown?, grammarKey? })` | the standard number tip |
| `tableTip({ columns?, rows, caption? })` | columns `'key'` or `{ label, code, num }`; rows arrays or `{ cells, code }`; no columns → first cell is the row heading |
| `defTip(key)` · `linksTip([{ label, href, code?, note? }])` | a catalog word; links (`#/…`, `vscode://`, http(s) only) |
| `tipSource(api)` | `{ api, sync }` for `source` |
| `placeTip(rect, size, viewport)` · `TIP_HOVER_MS` · `tipKeydown(e)` · `initTips()` | internals the shell, keymap and tests use |

Any label, heading or cell that is a catalog key is translated **when the tip opens**, so a tip built before a
register flip speaks the register on screen. Anything marked `code` (a column, a row, a link) is dropped in the
business lens, and `body.lens-business .fs-tip .tip-code{display:none}` backs that up.

### Adoption recipe — to give a number a tip

1. Find the catalog key that prints the number (`journey.countGates`). If it has no `define`, write one — it is
   the tip's *what it counts*. If there is no scope word for what it counts over, add one (`tip.*` or the
   surface's own namespace), both registers.
2. Wrap the number: `'<span' + tipAttrs({ number: { count: n, of: 'journey.countGates', scope: 'journey.scopeAll',
   source: tipSource('/api/journey') } }) + '>' + esc(text) + '</span>'`. Args are JSON in the attribute, so pass
   keys and numbers, not HTML.
3. If the tip needs live state (a list of the things counted), register a builder in the surface module and use
   `tipAttrs({ id: 'myTip' })` — `jrnScreensTip` in `surfaces/journeys.js` is the exemplar.
4. Remove the element's `title` — a native tooltip opens over the tip.
5. `pnpm lint:strings`, and open it once in each lens.

**The sync chip's RESTART (2026-09-27)** comes from `/api/version`'s `install` (`restartNeeded` in `shell.js`): the
server decides it build to build — core `installState()` reads the identity of the build on disk (the workspace
dist's mtime + `build-stamp.json`, or the `build-stamp.json` pack.mjs writes beside the bundle) and compares it with
the running build by `sameBuild()` (`install.basis: 'build'`), the rule `farsight status` uses. A rebuild of the same
clean commit is not a restart; only an install with no stamp falls back to the old file-date rule
(`basis: 'mtime'`). The chip's tip names both: *running build* and *installed build*.

**Exemplars:** the sync chip (`syncChipTip` in `shell.js` — a table with code rows), the status bar's
`N shown of M · K hidden` (`updateStats` + `statsBreakdown` in `lib/graph-render.js` — a breakdown whose parts add
up to the total), the top bar's `⋯ N` (`fitTopbar` — the folded controls by name), and the journey header's
`N screens` (`jrnScreensTip` — the screens in order, built or not). Tests: `packages/server/test/tooltip.test.ts`
(placement, builders in both lenses and registers), `e2e/tests/tooltips.pw.spec.ts`.

## Journey numbers and business words (2026-09-25)

**Numbers.** A journey prints a number one of two ways, both in `surfaces/journeys.js`: `jrnCountedHtml(c, { rel,
unit, num })` for a typed count from the core (`summary.counted`, `segments[i].counted`, `coverage.*.counted` —
docs/COUNTS.md), whose tip (`jrnCountedTip`) gives what it counts, the scope, the source (the core function in the
code lens), the breakdown as a table whose `td.n` add up to it, and — under *Beside it* — the related counts named in
`rel`; and `jrnNumHtml(n, key, scope)` for a number only the viewer counts (the markers in one cell, a fold's size).
The header (`jrnHeaderHtml`) is five groups — screens, actions, gates & rules, conditions not in plain language,
tests with the evidence chip and the run behind it (`jrnObsText`) — and the walk in the code lens. The tests foot
reads the core's fold (`jrnFoldFacts`: `evidenceWord`, `counted`, `observation`), never a viewer rule.

**Business words.** `plainWords(text)` (`strings.js`) is the business lens's reading of any sentence somebody
wrote: document ids and references out, a trailing clause or a sentence carrying a path or backticked code out,
identifiers left in prose humanized; `''` when nothing is left, so the caller prints an absence word or the name.
The journey reaches it through `jrnWords`, `jrnMoLabel`, `jrnDeclLabel`, `jrnCallWords`, `jrnGateLabel`. The
business lens also drops design ids (`jrnDesignIdHtml`), routes, HTTP verbs, contract chips and code links, folds
parts the code tags `plumbing` (`jrnHelperTest`), and names the drill's places as *the request* / *the service*.
`e2e/tests/journey-numbers.pw.spec.ts` holds the business views to zero identifier-shaped tokens.

**Absence words — one per fact (2026-09-27).** An empty (action, layer) cell's word is decided once, in core
`journeyAbsence()` (`core/journey-counted.ts`), and shipped on the summary: `segments[i].absent.moments[mo.index][key]`
(key = a `summary.systems` row key, or `user` for *what the user sees*), `.kinds[mo.index][records|messages|external|afterwards]`
(the storyboard's ledger rows), `.screen[key]` (a system the whole screen leaves empty — the ladder's skipped and
folded columns), and `summary.absentKinds` (a kind the journey has none of — the drill's always-present rows). The rule
(`absenceWord`): *none indexed* only when the journey has no system of that kind; *not reached* when a cut inside the
action sits on a system earlier in request order; otherwise *not involved*. A planned row is not a reason — its
planned calls are drawn as planned where they are. Every view asks `jrnAbsentWord(sg, mo, key)` /
`jrnAbsentKindWord(sg, mo, kind)` (fallback for an older server: the rows view's old cut rule) and draws it with
`jrnAbsentHtml(word)`, which prints the business sibling (`journey.biz.absent.*`) in the business register exactly as
the ladder does; never a word of a view's own. Absent cells carry `data-absent`/`data-sys`/`data-mo` so
`e2e/tests/journey-numbers.pw.spec.ts` can hold the Timeline and the Sheet to the same word per cell. The tests foot
names its scope the same way: `jrnFootScopeHtml` prints the `Counted`'s scope above the counts (*in this action*,
*for this part alone*, *on this screen*), and a step no test reaches inside an action tests do reach prints the
action's number beside its absence (`jrnStepActionFacts` → `journey.tests.widerScope`).

**Keyboard.** The journey's first stop is `#jrn-skip` (*Skip to the top bar*); the forks drawer and the cut list are
`inert` and hidden while parked off the edge (`jrnDrawerInert`); Esc closes the toolbar's scope menu before the
journey (`keymap.js`); closing a journey sets the walk as the code map's focus only when it lands on the code map.

## WORK — `surfaces/work.js`, `work-chips.js` (2026-09-30)

The trackers this workspace reads (Jira, Azure DevOps, the recorded fixture) and their items, over `/api/work*`
(contract: `docs/proposals/work-items-sync.md` §2, §7, §9, §10; the route shapes the server lane serves). NAV tab
`nav.work` (*Bounty Board* / *Work*), glyph `sym('work')`, strings `work.hud.*` in `core/src/strings-work-hud.ts`
(spread into the catalog) beside Lane A's `work.*` state, freshness, mode and label words, which it reuses.

**Routes.** `#/work[?source=&state=&assignee=&q=&flow=&view=list|board|sources]` and `#/work/<itemId>`
(`work::<source>::<key>`, encoded). `parseRoute` carries `source · state · assignee · q · flow`. Each filter writes
the link and the list asks `/api/work` again with the same query, so every count follows the filter; the search box
rewrites the link in place (`history.replaceState`, no remount, focus kept) and asks after 220 ms. `refresh('sync')`
asks again; lens and register redraw from the answer in hand; the source scope (code repositories) moves nothing.

**The list page.** A strip (title, standfirst, the items and trackers `Counted`s, LIST · BOARD · SOURCES, *sync
now* → `POST /api/work/sync`), one card per source (`cardTitle`: the tracker named once — the provider word, then the workspace's name for
it unless that name already starts with the word — the mode chip, then host · source id (not in business), *as
<user>*, the freshness sentence — `synced 3 minutes ago` · `source unreachable since 09:14 — showing the cache` ·
`credential expired — showing the cache` · `never synced` — with the tracker's error outside the business lens, the
items count with its by-state breakdown, what the tracker lets Farsight do in words from its declared
`capabilities`, and its own *sync now*), the filters, then the table (item · state · assignee · type · labels ·
linked · commits · updated) or the board (four columns by state category). **State** is always a dot in the
category's colour, the category word (tip) and the tracker's own state name beside it (`stateHtml`); a state the
type does not define (`fields.stateUndefinedByType`, Azure DevOps) adds *not a state of its type* with a tip. The
SOURCES view lists the outbox's waiting writes (queued → *waiting for your confirmation*, conflict) with their
controls. A failed load prints `sys.workFailed`, the status and the server's words, and *ask again*.

**The item pane.** Left: the head (key outside business, title, *edit title*; state + *move to*; assignee +
*assign*; type, labels, iteration, part of, area, reported by; freshness, mode, *open in <tracker>*, the id in the
code lens), the answers to writes, description (a small safe markdown, `mdLite`: escaped first, then paragraphs,
lists, fenced code, `code`, bold, http(s) links — no library; the business lens reads `plainWords(body.text)`),
comments (an agent's comment carries *written by an agent through Farsight*, the MCP tool outside business), the
comment box, history, and the raw record in the code lens. Right: **What this work changed** — the touched count,
the touched parts as chips that fast-travel (`workTravel` → `pick()`), *see what uses these* (the impact panel takes
one seed, so it opens on the part picked), each commit with author, when, how it names the item (*named in the
subject · on its branch · in a merge · by its link*), sha and branch outside business, its files and, on
*show the change*, `GET /api/work/item/<id>/diff?sha=` as a unified patch (added/removed/hunk lines in the HUD
palette, SF Mono) with each file's touched parts as chips; the business lens draws no patch. Then **findings**
(both provenances, *the tracker says · the code says*) and **linked parts** (how found, *certain · detected · a
name match*, the provenance outside business).

**Edits.** Drawn only in edit mode and only for actions whose `allowed[action].policy` is true; a read-only source
says *read-only* once and draws no control; actions the policy does not grant are named in one line. Each posts one
intent to `POST /api/work/intent` (`{item, action, payload, requestedBy: {kind:'human', id}, baseRevision}`;
comment `{body}` · assign `{assignee}` · transition `{to: <state name>}` · edit `{title}` / `{description}`) and
draws the answer: **applied** (the item replaced by the tracker's copy), **pending** (*waiting for your
confirmation*, confirm / drop → `/intent/<id>/confirm|drop`), **conflict** (the tracker's version beside what you
asked; re-base / drop), **denied** (three lines: *your policy says … · Jira says … · the credential can …*),
**failed**. *Preview* (a dry run, `dryRun: true`) is drawn only where the source declares `capabilities.dryRun`
**and** the item answer says `previewable: true` — never a button that would write for real. Any answer that
carries the gate's own dry run (`preview: {ok, reason}`) prints it beside the verdicts (`work.preview.ok` ·
`work.preview.refused`); a state its type does not define reads `work.state.undefinedByType`.

**Chips elsewhere** (`work-chips.js`). Only when the settings name an enabled `type: 'work'` source — otherwise no
request is made. Portfolio rows and the journey header (`#jrn-work`) read `/api/work/flow/<id>` (cached per sync):
*3 work items · 1 in progress · 2 done*, the total a `Counted` whose breakdown is the parts, the parts a link to
`#/work?flow=`; nothing at zero. The inspector's *Tracked work* section (`nodeWorkSecHtml`, filled after
`/api/work/links?node=` answers) reads *tracked by INV-6 Tax rounds … (done, Invoice tracker)* — the title alone in
business. ⌘K: `travelTarget` sends a `work` node (or a `work::` id) to its pane.

**e2e.** `e2e/tests/work-surface|work-item|work-chips.pw.spec.ts` over `e2e/tests/work-stub.ts`, a stand-in for
the routes built from `e2e/fixture/work/*.json` (regenerate with `node e2e/fixture/work/make.mjs` from the recorded
invoice-app tracker); `routeWorkSettings()` adds the two work sources to `/api/settings`.

## MAP — `surfaces/map.js`, `lib/map-canvas.js`, `lib/map-model.js` (2026-10-03)

Every journey on one zoomable board, the way Miro or Figma draw one (brief: `docs/proposals/map-view.md`; the agreed
look: `prototypes/map-view/property-street-neighbourhood.html`; ADR 10). Behind the workspace flag `flags.map`
(Settings → Experiments, `set-flag-map`): off, `navTabs()` leaves the tab out, the Portfolio draws no switch, and
`applyRoute` reads a `#/map…` link as `#/portfolio`. Strings `nav.map`, `map.*`, `set.flagMap`, `key.map*` in
`core/src/strings-map.ts` (lane A's block, then lane B's), spread into the catalog.

**Routes.** `#/map` (neighbourhood) · `#/map/<flowNodeId>` (street) · `#/map/<flowNodeId>?node=<pageNodeId>`
(property) · `?plumb=1` (the street with its calls and data). The flow id is encoded in the path. The board writes
where it is into the link with `history.replaceState` (no navigation, no history entries): after a gesture the
journey the street is on, nothing at the neighbourhood, `?node=` while a screen is open. A hash change from outside
(a link, the back button, the nav tab) goes through the surface's `update(route)` — `applyRoute` calls it instead of
re-mounting when the surface on screen is the one routed to — so the board keeps its place.

**Levels.** One continuous scale (`lib/map-canvas.js`): below **0.5** the neighbourhood, from 0.5 the street; a
gesture that **ends** (pointer up, or 160 ms after the last wheel event) above **1.6** with a screen within **320**
world units of the viewport's centre opens that screen (`snapTargets` → `onSnap`); the screen that would open is
ringed (`.near`) from 1.1. Pan: drag, plain wheel. Zoom: pinch, ⌘/Ctrl + wheel, Safari's gesture events, `+` `-`,
the ± tools; `0` and *Fit* fit every journey (never above 0.45, so it stays the neighbourhood). Programmatic moves
animate 450 ms (`.anim`, off under `prefers-reduced-motion`); gestures never do. Leaving a screen lands on the street
at scale **1.0** centred on it; a ⌘/Ctrl scroll out past a small budget, or a two-finger pinch out, over the open
screen leaves it (the rest of that scroll is swallowed for 400 ms so the street does not keep zooming).

**The neighbourhood.** One `.map-district` per flow, laid out in rows: the journeys that contain another (every
screen of a smaller one is theirs) on rows of their own, then the rest in the order the design's `leadsTo` walks
them (`neighbourhoodModel(designs, workByFlow, graphById)`), rows about as wide as the stage's shape asks. Each has a
poster cover (`.map-dcover`: name, sentence, the journey's Counteds at poster size, *Open this journey*) over its
ghosted street (opacity .18). Links between districts are drawn from each journey's own `summary.links` as it lands
(*leads to*, its mirror *requires* drawn once, *part of* dashed) — never inferred by the viewer. The journeys are
read one at a time, the one the route names first, under a generation counter; answers are cached per entry per
sync (`JOURNEY_CACHE`, the `FLOW_CACHE` pattern), so a register flip never refetches. A district grows when its
walk lands or plumbing is switched; the re-layout shifts the board so the journey in view stays where it was.

**The street.** Screens in step order (`.map-scr`: `designThumbHtml(node, 'map')` with the lightbox click switched
off — a click opens the screen — or a placeholder with the absence word; the ordinal; the name; the route as
`.map-code`; *designed, not built* on a planned screen, whose stripe is warm; the screen's Counteds), joined by
*then*. **Plumbing** (`p`, the *Plumbing* / *Calls and data* tool, `?plumb=1`, remembered per reader in
`localStorage` `fs-map-plumb`): each screen owns the pathway straight below it — a trunk, its calls stacked in
order (`.map-pl`, a top bar in the service's colour `svc-<index % 6>` from `summary.systems` api rows, the
evidence word when not spec-backed, *again* when the journey made the call on an earlier screen, the call's words,
method and path as `.map-code`), and beside each call its records, messages and third parties (`.map-pd`, *reads*
cool, *writes* warm, *reads · writes* both, arrowheads by direction). Planned and declared calls are dashed and
carry nothing beside them. Nothing crosses; the legend lane names the services and the two colours.

**The model** (`lib/map-model.js`, pure, `packages/server/test/map-model.test.ts` over a captured answer in
`test/fixtures/map-billing-cycle.json`). `streetModel(data, graphById)` → `{ journey, services, screens, links }`;
a `MapScreen` is `{ index, ordinal, node, id, name, business, designId, route, state, chips: { calls, gates, tests,
work: null }, calls, gates, decisions, absent, segment }`; a `MapCall` is `{ nodeId, marker, moment, service,
method, path, operationId, summary, label, business, evidence, repeat, data[] }`, data `{ kind, nodeId, name, node,
mode }`. Measured on the fixture and different from the proposal's first draft: a call's data is what the call
reached, found up the markers' `under` chain (falling back to its moment's call); a planned screen's calls are its
**planned call markers** (`via: 'planned'`), not `segment.declaredOnly` — that field lists operations a *built*
screen's design names and no code on it calls, kept as `evidence: 'declared'` rows. Evidence: `spec-backed`
(contract `both`) · `implied` (in the code, not in the spec) · `not built` (planned, or spec-only) · `declared`.
`screensUsing(model, kind, nodeId)` answers the card's *on* row.

**The explore card** (`.map-xcard`, §5): kind and direction (the service and what the call reads or writes; a data
node's kind and what this call does to it), the evidence word, the name in the register, the identifier line
(`.map-code`: method path · operationId · handled by …; a data node's name and file), *on* — the screens of this
journey it is drawn under, each opening that screen — and at most two doors: *Open on APIs*
(`#/apis/<apiId>?op=<routeId>`) and *Open on the code map* (`#/codemap?node=`). `b` on the map asks *what uses
this?* about the card's node (`mapSelected()`). No number is printed on it in v1: nothing per call is typed yet.

**The property hook** (lane B fills it). Opening a screen — a click, Enter, a snap, `?node=` — makes the stage's
`.map-prop-host` overlay visible and calls `openMapProperty(host, ctx)`, which imports
`surfaces/map-property.js` and calls its `mountMapProperty(host, ctx) → { update(ctx), destroy() }`; until that
module exists a minimal stand-in (name, route, sentence, picture, Back, previous / next) answers. `ctx` is
`{ data /* the /api/journey answer */, model /* streetModel */, screenIndex, screen /* model.screens[screenIndex] */,
flow, lens, onClose(), onStep(delta), onOpenScreen(index) }`. Stepping calls `update(ctx)` on the same handle; a
lens or register change calls `update(ctx)` with the new `lens`; closing calls `destroy()`. `[` `]` call
`onStep`, Esc `onClose`; the street underneath stays centred on the open screen.

**Keys** (`keymap.js`, only while the map is mounted): `p` plumbing · `+` `-` zoom · `0` fit · `[` `]` previous /
next screen while one is open · Esc backs out one level (card → screen → street; the neighbourhood lets it fall
through) · `b` what uses the card's node.

**What the business lens hides.** Every `.map-code` element (routes, method and path, operation ids, handler
names, a data node's identifier and file) is not drawn, the accent warms, and names are words: a call reads the
sentence written for it (`plainWords`), a record or message its label or its name said as words (`ledger_entries`
→ *Ledger entries*, `invoice.finalized` → *Invoice finalized*), a flow name that is code goes through `unCode`.
Service names are the spec titles (`SystemRow.label`) in every lens. The e2e spec holds the street and the card to
the journey-numbers identifier check.

**e2e.** `e2e/tests/map-street.pw.spec.ts`: flag off → no tab and `#/map` lands on the Portfolio; flag on → the
Portfolio switch, three districts, the links, entering Billing cycle → three screens in order; plumbing (service
bar, a *writes* node, Discard draft's dashed *not built* call, `p`); the property through the hook, `[` `]`, Esc, a
`?node=` deep link; snap by zooming in and leaving by ⌘-scroll out; the explore card; the business lens.

#### Property — `surfaces/map-property.js`, `lib/map-property-model.js` (lane B, 2026-10-03)

One screen up close (proposal §1, §3.2): the picture is the hero on the left, a 352px rail of eight tabs on the
right (two rows of tabs), the step bar below; under 860px the rail goes under the hero. CSS: the
`/* ── MAP property */` block at the end of `viewer.html`'s `<style>`. Strings: `map.prop.*`, §B of
`core/src/strings-map.ts`.

**The hook.** `mountMapProperty(host, ctx) → { update(ctx), tab(name?), destroy() }`. `host` is the full-stage
overlay the map surface creates; `ctx = { data, model, screenIndex, flow, lens, onClose(), onStep(delta),
onOpenScreen(index) }` — `data` the `/api/journey` answer, `model` `streetModel(data, S.BYID)`, `screenIndex` an
index into `model.screens`. Back calls `onClose()`, the step bar `onStep(±1)`, a dot `onOpenScreen(i)`; an
*also in* chip is a link to `#/map/<otherFlow>?node=<pageId>`. `update(ctx)` redraws in place (new screen, lens,
answer) and keeps the open tab. The map surface owns the keys (`[` `]` `Esc`) and the zoom-out gesture. The module
never writes `S.JOURNEY` — the journey overlay's — and reads the journey's helpers only where they are pure:
`jrnGateLabel`, `jrnGatesShown`, `jrnAbsentHtml`, `jrnWords`, `jrnRefAnchors`, and the tests foot's parts
(`jrnFoldFacts`, `jrnEvChipHtml`, `jrnObsText`, `jrnRunLineHtml`, `jrnFootScopeHtml`, exported for it).
`jrnTestsFootHtml` itself checks `S.JOURNEY` and so is not called.

**The model.** `propertyModel(data, screenIndex, graphById, model, { edges })` is pure (no DOM, no catalog, no
lens): the street's `MapScreen`, `prev`/`next`, `alsoIn` (other flows whose `renders` edges reach the page), the
hero kind (`image` · `figma` · `none`), each tab's facts, `changeIds` (the page, its components, the routes and
handlers its calls reach) and `counts` — the tab strip's numbers, each the summary's own `Counted` object or
`null`. `packages/server/test/map-property-model.test.ts` holds it to a captured answer
(`test/fixtures/map-property-billing-cycle.json`).

| tab | reads | number on the tab |
|---|---|---|
| Overview | the screen's sentence (`MapScreen.business`) in a quest-amber rule; at-a-glance chips; the calls (brief); the gates; the work rows | none |
| Gates | `segment.gates` split guard / rule in walk order, named with `jrnGateLabel` (business: the words after the `@guard` colon, the rest counted as *N more that nobody put in plain words*); `segment.decisions`, `class: 'business'` only in the business register | `segment.counted.gates` |
| APIs | `MapScreen.calls`: service (`SystemRow.label`, colour `svc-<index>`), what it is for, method + path outside business, the evidence chip (*spec-backed* · *implied* · *declared, never called* · *not built*), what it reads and writes; then every record, message and third party reached, once, with its modes | `counted.actions`; a screen not built: `counted.actionStops` |
| UX | the page node, the components the walk met (`screenComponents`), story chips (`storyChipsHtml(screenStoryIds(…))`) | none |
| Tests | `summary.coverage.segments[i]` through `jrnFoldFacts`: the evidence chip, the run behind it, the counts sentence, their own last run; the cases (not run-level) with how each is evidenced and its status; coverage runs that name no case apart | `coverage.segments[i].counted.tests` |
| Route | the page name, built or planned, the design manifest that declares it, where the code routes it; the journey's `summary.links`; *other ways in* = edges into the page that are not `contains`, `covers`, `tracks` or a flow's `renders`; the design and `@see` links (`jrnRefAnchors`) | none |
| Work | lazy, cached per sync: `GET /api/work/links?node=<page>` and the flow's `findings` (`flowWork`) kept to those items. With no work source configured nothing is asked and the tab says so | `counts.items` of the links answer, once it arrives |
| Changes | lazy, cached per sync: `/api/history?repo=` for the spine, then `/api/changes?from=sync:<previous>&to=sync:<latest>`, kept to `changeIds`. 503 → *history is not kept on this server*; one sync → *no earlier sync to compare against*; nothing matched → *nothing on this screen changed between these syncs*; never blank | none |

**The hero.** A design image (`designThumbHtml(node, 'mp-shot')`, the lightbox on click) sized to the stage, kept in
the code lens too. A screen with no image declared gets the placeholder with `journey.absent.notIndexed`; a
declared image that does not resolve (a Figma frame with no token — Discard draft in the fixture) swaps to the
same placeholder with `design.noImage`. The placeholder: the design glyph, the screen's name, its route (not in
business), its sentence, *designed, not built* when it is, the parts found (or *no components found*), the design
link. No paste or upload control is drawn (proposal §9).

**The lens.** The business register drops the route from the crumb and the placeholder, method + path, file
lines, test runners and levels, change kinds, work keys and ids; it names components and records with `bizName()`
and calls with `plainWords()`; the accent warms with the lens. Every row naming a call, record, gate, component,
test or decision carries `data-map-card="<kind>" data-id="<nodeId>"` for the map's explore card.

**e2e.** `e2e/tests/map-property.pw.spec.ts` deep-links through the map: the Invoice list hero and its counts, the
APIs rows by service, New invoice's case verified by declaration, Discard draft's placeholder, the step bar, and no
identifier-shaped word on any tab of any screen in the business lens.
