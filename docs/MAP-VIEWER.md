# Viewer map — modules, the journey's views, and the band mechanics

> Moved out of `AGENTS.md` so it is not read at the start of every session. Open it before editing
> `packages/server/public/`. The invariants that always apply — every string through the two-register catalog,
> every glyph through `sym()`, `pnpm lint:strings` gating both — stay in `AGENTS.md`.

Deliberately vanilla JS, no framework, no build step (Phase 1; replaced by the canvas `packages/app` in Phase 2) — don't over-invest, but keep it working. Since V3 P2 the old single `viewer.js` is split into ES modules under `public/app/`: `shell.js` (hash router — `#/portfolio · #/journeys/<entry> · #/codemap[?node=id] · #/apis[/<apiId>][?op=<routeId>|view=spec&line=N|view=compare] · #/changes/N...M · #/grammar`, all accept `@sync:N` + `?scope=` + `?lens=` + `?band=`; nav, chrome, role-based landing via `defaultSurface`, deep link wins), `store.js` (shared mutable state `S.*` + fetch layer + `expose()` for inline-onclick globals), `strings.js`/`sym.js` (two-register catalog client + SVG sprite accessors — every user-facing string goes through `t()`, every symbol through `sym()`; `pnpm lint:strings` enforces this and the `#/grammar` page renders the whole book), `keymap.js` (ALL key bindings central — `b · j/k · l · v · d · [ ] · f · ⌘K · y · ? (the keymap, its only job) · g (the Map legend) · esc`), ⌘K fast travel (`shell.js` `pick` → `travelTarget(n)`, 2026-09-25) arrives on the surface where the node can be seen — a flow as its journey, an API on APIs, a test on its Tests detail, a route/page as its journey in the business register, a gate as what it guards, anything else on the code map selected with no focus filter (`S.pendingFocus`, spent by `mountCodemap` → `arriveAt`); on the Map (the surface on screen) `mapTravel(n)` keeps the arrival on the Map — a flow its street, a page its journey's street with the screen open, a route a journey calls that street with the call's card open — and the palette row says *Map*; the palette row names the destination, and in the business register shows only the business name, `stories.js` (`@group Stories`, ADR 9 — the one place a story is drawn: `storiesSecHtml(n)` the inspector's Stories section for a component/page — story tabs by name, the picked story framed live (300 px, a click opens it large), *What it shows* from the story's JSDoc, the file line outside the business register, the Docs page when the running Storybook lists one, `not reached` + the start command + *Check again* when the Storybook does not answer, `none indexed` plus chips for the parts it renders that have stories; `openStoryLightbox` the large view, every story down the side, the frame at ~92vw × 88vh; `storyChipsHtml(screenStoryIds(n, components))` the chips on a journey screen card and storyboard scene — the screen, its components and what it renders within two hops, never a `plumbing` part; `storiesCatalogueHtml()` the *Components on show* catalogue under the Portfolio table, one row per Storybook then components grouped by title; one cached `/api/stories` answer per 15 s, *Check again* re-reads with `?refresh=1`; the journey's component span gains a story glyph), `share.js`/`impact.js`/`provenance.js` (stubs growing in P5/P6/P3), `surfaces/*.js` (journeys carries the Journey view; codemap hosts today's graph; `apis.js` is the APIs tab — cards with defined counts, operations by tag, contract panel with consumers + call sites, line-anchored spec view, READ-ONLY compare drawer, all facts from `/api/apis*`; portfolio/changes/stewardship are honest placeholders), `lib/graph-render.js` (node-card/lane/edge renderer). Key mechanics: `displayNodes()` builds the display list (guards→badges; grouping via `effectiveGroup()` — parser `group` field OR embedded-component detection `embeddedRootOf()`); groups render collapsed as nodes or expanded as in-place `.groupbox` containers with mini-card members; flowing variable-height column layout in `render()`; `positions{}` drives SVG edge routing; lens = body class + CSS; theme = `data-theme`. Scope = multi-select: `scope` is `'all'` or an array of source names (persisted `fs-scope-v2`), picked in a grouped dropdown where collections are checkable groups (`buildScope`/`toggleScopeSrc`/`toggleScopeColl`); filtering is by repo name. `vsl(repo,path,line)` appends a ⧉ `vscode://file` deep link wherever a file:line is shown (fail-soft off `GRAPH.roots`). Journey view (`@group Journey view` fns, `#journey` overlay) = the **blueprint timeline** (docs/proposals/blueprint-timeline.md option C, system band per docs/proposals/journey-system-band.md §6 = boards B + F + C): fetches `/api/journey` and draws `summary.segments` × `summary.systems` as one horizontally scrolling grid (`jrnTimelineHtml`) — a sticky header row of segment stops (ordinal, screen name, counts, progress bar), the *What the user sees* row (`jrnScreenCardHtml` with design thumbnails via `designThumbHtml` → `/api/design/image`, lightbox, ⧉ design / page / component / doc links; the entry card when a segment has no screen), a labelled line of visibility, the *Business* row (`jrnBizCellHtml`: ▶ start, gate checkpoints deduped with ×n, the first sentence of the screen's business text as the step — with the segment's decisions folded into it as ⑂ chips in hybrid/code, the full `jrnFlowDecision` flowchart in business — ■ end; docs dock on the lane label), then the system band as **rows × moments** (`jrnSystemRowsHtml`): rows in request order from `summary.systems` (*The screen asks* · `<repo>` · browser → *API* · spec title → *The service does* · `<repo>` · server → records → messages → third party), each segment cell a grid of that screen's `moments` (`jrnMomHeadHtml` stops; column widths measured once in `jrnMeasure` and shared through a per-segment template so every row aligns). A column reads down as one transaction. The browser row draws the moment's component once as a span header (`jrnCompSpanHtml`, *still open* when it carried over); the API row draws each call as the **seam card** (`jrnSeamCardHtml`: method · operationId · spec summary · contract-status chip, then `← from <fetch line>` ⧉ · `→ handled <handler>` ⧉, or *not built yet*); markers are ↺ ghosts when repeated and ▸ helpers under their handler. Clicking a marker (`jrnSelect`) opens the expansion slot under that row — for a call the **seam splice** (`jrnExpHtml`: caller code around the fetch · the contract block · the route and what it continues into, via `jrnCodeWindow`/`jrnCodeSeg`/`jrnReqChips`), otherwise the Wallaby-style spliced timeline (`jrnSectionHtml`, ⑂ fork markers + Forks drawer). A `rows | ladder` toggle in the band header (key `l`, persisted `fs-jrn-view`, `?band=` deep link) redraws each segment as a **ladder** (`jrnLadderHtml`, board F): the same systems as columns, time running down, one line per marker, the call crossing the seam left to right, helpers indented, records/messages arrowed out of the service column, capped at a line budget with *▾ n more steps*. **Per screen the ladder draws only the systems it uses (2026-09-25, `jrnLadderModel`):** a system skipped before or between used ones keeps its place as a 34 px dimmed column with its name and *not involved* running down it; the systems after the last one used fold into one end column — *Stops here* (business: *Goes no further*) — listing each with its absence word (*not reached* when the walk was cut on that screen), tip `jrnLadderCol`; a used column is ≥ 344 px up to 520 px by its content, the segment is never wider than the old `150 + systems × 172`, and a screen reaching every system with no gap is drawn exactly as before (`e2e/tests/journey-ladder.pw.spec.ts`). `j`/`k` walk markers, Esc closes the expansion, then the forks drawer, then the overlay. **Code pane dock (2026-09-15):** `S.jrnDock` `inline | bottom | right` (`IN PLACE · BOTTOM · RIGHT` in the header, key `d`, `?dock=`, `fs-jrn-dock`, default `bottom`) says where a marker's expansion opens — under its row as before, or in the `#jrn-dock` pane pinned to the bottom or the right of the overlay (`jrnSelect` routes to `jrnDockRender`; the pane keeps the *click a marker* hint when nothing is selected, its grip drags a size remembered per dock in `fs-jrn-dock-<dock>`, the seam splice stacks its three sides when docked right); both layouts and every lens share it. Linked journeys (`summary.links`: ◀ requires · leads to ▶ as slim end columns, *part of* chips in the header) run the other flow on click. Lens CSS on `body.lens-*`: business = big thumbnails, full flowchart, rows as counts per moment except the API row (summaries, expanded), no code; code = screen chips, gates only, rows + code open. **View axis (2026-09-14):** `S.jrnLayout` `timeline | sheet` (`?view=`, key `v`, remembered per register in `fs-jrn-layout.<lens>` since 2026-10-05) is independent of lens and band; `renderJourney` dispatches to `jrnTimelineHtml` (unchanged) or `jrnSheetHtml` (board 04: `jrnSheetModel` builds columns = every moment of every segment and layers = `sum.systems` in rank order plus *Gates & business* and *Verified by*; `jrnSheetCellHtml` caps a cell at two chips + `+n`, folds helpers, and draws the absence words). **Drill tree (2026-09-15):** every marker carries `under` + `tier` from the core; `jrnCellTree()` picks what a cell draws by default (its roots plus tiers 0–1 that are not helpers) and `jrnFoldHtml()` folds the rest under their part as `▸ n inside` / `▸ n helpers`, nested one level at a time (rows and sheet; the ladder indents by tier); folds register on `S.JRN_FOLDS`/`S.JRN_FOLD_OF` so `jrnOrdersNow()` (j/k) skips what is folded and `jrnRevealFold()` opens every fold above a jump target. Honest chrome reads the core's `cutPoints`/`untranslated`/`helper`/`under`/`cut` fail-soft (an older server falls back to the shipped behaviour); the business register draws only `class:'business'` decisions and folds unlabelled guards into the *not translated* sentence. **Action drill (2026-09-16, behind a flag):** `surfaces/journey-drill.js` (`@group Journey drill`) draws board 02 (`the journey-timeline design reference 02-action-drill.html`) from the same summary — the third value of the view axis, `S.jrnLayout = 'drill'` (`DRILL` in the `TIMELINE · SHEET · DRILL` switch, `?view=drill`, key `v` cycles through it), shown only when the workspace flag `flags.journeyDrill` in `.farsight/settings.json` is true (Settings → *Experiments* checkbox; `jrnDrillEnabled()`; with the flag off a remembered or deep-linked `drill` reads as the timeline and the switch has two buttons). Three parts: the **action rail** (every moment of every segment as arrowed stops, screens spanning them, `jrnDrillGo(ci)` / keys `[` `]`), the **lanes** of the open action (`jrnDrillBeats()`: rows = the sheet's layers minus *Verified by* plus always-present records · messages · third party rows that say *none indexed* when absent; columns = **beats** in causal order — every tier 0–1 marker of the drill tree in step order, a minor part with no drill, no data under it and no authored label folded into the previous beat's box as an *also* chip, the **answer** beat from the contract's responses after the last server beat and tagged *spec*, records/messages/externals in the column of the part that reached them, gates and translated decisions in the column of their step; one box per cell (`jrnDrillBoxHtml`: kind · name ⧉ · authored sentence · `▸ n inside`; the seam card for a call, wider column) and elbow **wires** drawn from the DOM into an SVG overlay (`jrnDrillWires`, redrawn by a ResizeObserver when a fold opens) — fixed column widths, nothing overlaps) and the **inspector** on the right (`jrnDrillInspect`: DOCS · REQUEST / RESPONSE (calls) · CODE (not in business) · FORKS · TESTS; `jrnExpBodyHtml` is the expansion body split out of `jrnExpHtml` so the CODE tab reuses the seam splice / spliced timeline). `jrnSelect` routes to the inspector when `S.JRN_DRILL` is set (opening the action a step lives in first); the dock switch hides in the drill. The Journeys picker mounts the **organised journeys** (persona → group → journeys, below) above a **Designs** section (`jrnMountDesigns` from `/api/design`: one card per manifest with its counts and its designed-not-built / built screens; the flows moved up into the organised section).

### Projects and packages — `surfaces/codemap-projects.js`, `lib/codemap-model.js` (2026-10-04)

The code map reads the projects and packages lanes X and D put in the graph (docs/proposals/dependencies-and-nx.md
§2.3). **State** is one bag, `S.cmap` (made by `cmap()`): `group` (`none · project · <dimension key>`, `?group=`,
`fs-cmap-group`), the filters (`projects` — `repo::name` keys, `values` — dimension → set of tag values, `dep` — a
package id), `hidePackages`, `showModules`, and the open `view`. `lib/codemap-model.js` is pure and unit-tested
(`packages/server/test/codemap-model.test.ts`): `projectOfItem` (the node's `project`; a workspace package's
`package.project`; a file group's first member's), `projectFacets` (tags split by the source's `tagDimensions`, words from
`tagValues`), `groupChoices` (offers a dimension only when some project in scope has a value in it — an untagged source
gets *none · project*), `groupOf` / `foldGroups` (project · tag value · *no tag* · *no project* · *third-party
packages*, the catch-alls last; parts by kind sum to the box's count), `dependsOnIds`, `closureColumns`, `versionFor`,
`journeyDomain` / `canBandByDomain`.

**The index** (2026-10-04, after the code map grouped by project hung a 21k-node graph for minutes: `cmapHide` folded
every node per node). `buildCodemapIndex(nodes, edges, metas)` makes one pass over the nodes and one over the edges:
`projectKeyOf` (node id → `repo::name`, through `projectOfItem`, so a workspace package stands in its project),
`projects` (`repo::name` → `{ repo, name, type, tags, facets, parts }`, the facets computed once per project),
`partOrder`, `nodesByProject`, `projectsByValue` (dimension → value → project keys), `packageIds`, `importersOf`
(package → its `imports` sources), `validatesTo`, `testFiles` (the `TEST_FILE` pattern, by path) and `byRepo`.
`codemap-projects.js` holds one (`CMAP_INDEX`), rebuilt only when `S.GRAPH` is a different object (a sync reload);
the GROUP choices (`groupChoicesFor(index, repos)`, O(projects), the same list as `groupChoices`) are cached per graph
and scope. **Filters are set algebra** (`passFor(index, { projects, values, closure, dep, nodeIds })`): the projects
that pass are the picked keys ∩, per tag dimension, the union of the projects carrying a picked value ∩ the app
view's closure; the kept nodes are the union of their `nodesByProject`, plus each package a kept node imports
(packages × their importers); `dep` intersects with `importersOf[dep] ∪ {dep}`. The app view narrows by its closure
alone — the filter chips are not shown in a view, so a kept filter does not empty it. `groupKeyOf(item, by, index)`
answers a card's group in O(1), and `foldGroups(items, by, index)` uses it. `codemap-perf.test.ts` holds the set
algebra to the old per-node predicate on the NX example + invoice app, and a ≈20k-node synthetic graph to under two
seconds (it takes ~0.1 s). `store.js indexGuards()` also builds `S.validatesByTarget` (rule badges, card heights) and
`S.EDGES_OF` (node → its edges in graph order, the inspector's relations), and `render()` keeps `S.displayById`, so no
card and no `select()` scans every edge. `displayNodes()` and `statsBreakdown()` are each one pass with O(1) per node.

**The windowed stage and the folds kept once** (2026-10-05, the thousand-project perf round, `e2e/perf/`). Both
layouts (lanes in `render()`, boxes in `renderGrouped()`) compute every card's place, then hand the stage a list of
drawables (`stageItems(items, memberToGroup, display, onPaint)`, boxes before their cards); at 1,500 drawables or more
the stage is cut into 1,024 px cells and `paintStage()` makes only the cards and boxes within one viewport of the
view, on scroll (one rAF), letting go of the rest. `drawEdges()` then draws the arrows of the cards on the stage (a
card's `S.EDGES_OF`, a folded group's members'), every height read before the one `innerHTML` write into
`g.edge-layer`. `revealCard(id)` / `revealOnStage(key, domId)` scroll to and paint a card or box that is not drawn
(fast travel, `?node=`, `?box=`). The grouped layout measures painted cards and relays out once if one is taller. Below
the threshold everything is drawn as before. Kept once per graph: `effectiveGroup` (a WeakMap per node), the status
bar's fold (`refreshStats`, keyed by scope, focus and the code map's filters), the tag chips' counts (`buildChips`),
and fast travel's index (`lib/search-model.js`: strings folded once, in idle time after boot by `warmSearch()`, a
query that only grew its last word re-ranks the last matches, the best twelve kept as it scans). The Tests page asks
`/api/tests?lean=1` (counts instead of per-node lists), the Portfolio `?flow=…&lean=1` and `/api/journey?…&steps=0`,
the Map `steps=0`; the Map's `routeLinks` closes lane crossings per district.

graph-render.js asks two questions. `cmapHide(n)` returns `files` (a `module` card, drawn only with *show files* — or in
the package view), `packages` (*hide packages*) or `filtered` (outside the cached `passSet()` of the filters / view), and
`statsBreakdown` counts each as its own reason, so the status bar's tip still adds up. `cmapGrouping()` is `project` in a
view, else the reader's choice when the graph offers it; anything but `none` hands the drawing to `renderGrouped()`:
one `.groupbox.cm-box` per group (title in words, a sub line with type and tag words, `codemap.group.parts` with a
kind breakdown), members as `.node.mini.cm-m` cards (a left stripe in the kind colour) in columns of ten, boxes packed
into the stage's columns where they end highest. The lanes gained *Files* (`module`) and *Dependencies* (`package`);
package cards are `.nk-package.pkg-ws|pkg-tp` (copper `--pkg`, solid or hatched stripe, `sym('package')`, the scope word
on the kind line, the range as the sub line outside business).

**Views.** *App and its related* (`?view=app&project=<name>[&repo=]`) draws at once from the graph the page holds —
`projectClosure(metas, repo, name)` reads `meta.projects` imports, `implicitDependencies` and NX graph `dependencies` the way core
`appClosure` does — then fetches `/api/projects/<name>` (the closure) and `/api/projects?repo=` (the dependencies
between its projects, with their `Counted`s, which label the arrows when they arrive); the boxes stand in `closureColumns` columns with
`.cm-pedge` arrows labelled `.cm-elabel` by `ProjectDependency.count` (*declared only* when 0), third-party packages a
column of their own; the inspector is the application's project. *Where is <package> included*
(`?view=package&package=<id|name>`) keeps `dependsOnIds` (files shown), the package card on the left, importers'
projects as boxes on the right with the version each declares; the inspector lists `/api/deps/where` groups, each
importer and the code in it that uses the package a button to its card. Both open from the toolbar's **Views** menu (two
clicks), from a project's inspector (*Show app and its related*) and a package's (*Where is it included*); the
`#cmapctl` chip names the view and closes it.

**Controls and inspector.** `#cmapctl` in the toolbar (hidden off the code map): GROUP `<select>`, *hide packages*,
*show files*, **Projects** (`#cm-projbtn`, `Projects · n` when n projects are picked; shown when the sources in scope
have two projects or more), Views, a *filtered ✕* chip. The Projects menu (`#cm-projmenu`, `S.cmap.projMenu`) holds
kind chips (`.cm-type`: Applications · Libraries · End-to-end tests · Other projects, `S.cmap.barTypes`, none on = every
kind) that narrow the options of the multi-select `cm-pick-proj-bar` — the same `cmap().projects` filter as the scope
menu's `cm-pick-proj`, through the same `filtered()` path (chips, `?project=`, localStorage) — and *Focus on an
application* (`cm-pick-app-bar`, single, applications first), which opens *App and its related*. A pick redraws the
toolbar and the menu stays open with its pickers' words; a click outside or Esc (window, capture phase, after a
picker's own Esc clears its words) closes it; opening the Views menu closes it and the reverse. e2e:
`e2e/tests/codemap-toolbar.pw.spec.ts`. `cmapScopeHtml()` adds *On the code map* to the scope menu — projects, one list
per dimension, *Depends on* — acting on the code map only. Inspector: `projectSecHtml(n)` (project button, type, tag
words; raw tags outside business), `packageActionsHtml` + `packageSecHtml(n)` (kind, `DepsRow.importers` /
`journeys` Counteds, versions by project, the library it resolves to, the external it also is, journeys reached),
`inspectProject(repo,name)` (box title / project button: tags, *Show app and its related*, parts by kind, depends on /
used by with import-statement Counteds), `inspectValue(g)` (a tag box: its projects). The Map's *Band by: source ·
domain* (`map.js` `bandToolHtml`, `fs-map-band`) passes `journeyDomain` to `layoutDistricts({ bandKey })`; shown only
when `canBandByDomain`. e2e: `e2e/tests/codemap-projects.pw.spec.ts` (its second half serves invoice-app + the NX
example itself, `fixture/workspace.mjs` `makeProjectsWorkspace`).

#### The project picker — `lib/multi-pick.js`, `lib/multi-pick-model.js` (2026-10-04)

One picker wherever a project, a tag value or a package is picked. A host writes `pickerHtml(id, spec)` into whatever
it draws (`spec`: `options` `[{ id, word, group, sub?, countHtml?, match? }]`, `groups` `[{ key, word }]` in their
fixed order, `selected`, `multi`, `chips` for a single pick shown as a droppable chip, `label`, `placeholder`,
`countKey` — a catalog key with `{n} of {m}` — `onChange(ids, id, on)`, `onClose()`); every event is handled by
delegation on the document in the capture phase (the menus stop clicks bubbling; the keymap listens on the document),
so a host that rebuilds itself with innerHTML keeps the picker's query, active option and chip fold (kept by id), and
the field gets its focus back. `multi-pick-model.js` is pure and unit-tested: `fold` (lower case, accents dropped),
`matchScore` (every term inside a word the option lists — its name, its words, its tags; a prefix of the whole query
outranks a word start outranks a substring), `shownOptions` (groups in order, better matches first inside each).
The list is a listbox (`aria-multiselectable` in multi mode) driven from the field with `aria-activedescendant`: ↑/↓
move (the first lands on the first match), Enter toggles or picks, Space toggles once the arrows moved (before that it
types a space), ⌘A selects every option shown, Esc clears the words, then closes (the scope menu's capture-phase Esc
handler yields while a picker has words — `pickerHasQuery`). Chips fold into `+n` past six (`FOLD_AT`). The match
count is plain words (`codemap.pick.count*`) with its define as the tip; an option's number carries a number tip
but no tab stop of its own (the field holds the keyboard). Classes are `mpk-*` — `mp-*` is the Map's property.

Uses: the scope menu's **Projects** (`cm-pick-proj`, multi; Applications → Libraries → End-to-end tests → Other
projects; the type and tag words as the sub line, the project's parts of the code — `ProjectRow.nodes` folded on the
page — as the number), **Tags** (`cm-pick-tags`, multi, grouped by dimension, ids `dim=value`) and **Depends on**
(`cm-pick-dep`, single with a chip); the Views menu's *App and its related* (`cm-pick-app`, single, its field focused
when the menu opens) and *Where is a package included* (`cm-pick-pkg`, single; From this workspace → Third-party).
The project and tag filters are kept in `fs-cmap-filters` beside `fs-cmap-group` and written to the link outside a
view — `project=a,b` (a name, or `repo::name` when two sources have a project of that name) and
`tag=domain:billing,type:ui`; a link that names them wins, one that does not keeps the kept ones and is rewritten with
them, a kept key the graph no longer has is dropped, and a link to a card (`node=`) or a box (`box=`) that the kept
filters hide drops them. Selected projects and tag values are also chips in `#cmapctl` beside *filtered* (three,
then `+n filters`, which opens the scope menu). **Fast travel** lists projects (`projectTravelItems()`, kind word
*project*, an application above a library above a test project at equal score) and lands on
`#/codemap?group=project&box=<name>`: the map grouped by project, the box marked `.cm-arrived` and scrolled into view,
its inspector open. e2e: `e2e/tests/codemap-picker.pw.spec.ts`.

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

**The chrome after the 2026-10-05 swarm (lane H).**
- **Settings** is a cog *and the word* in the top bar (`renderChrome`); the cog drops its word before it folds
  (`fitTopbar`'s `compact` rung), and whenever the ⋯ menu is shown it lists Settings — the folded gear itself, or a
  `.more-settings` row of its own (not counted in `⋯ N`). The old rayed `sym-gear` read as a theme toggle.
- **READ-ONLY is a server fact.** `farsight serve --read-only` (and every `--as-of` serve) refuses the write routes
  (`guard.ts` `isWriteRoute` / `refuseWrite`: `PUT /api/settings`, `POST /api/sync`, `POST /api/work/*`; the two diff
  routes persist nothing and stay open) and says so on `/api/version` as `session: { readOnly, why: 'flag' | 'as-of' }`.
  The viewer reads it (`readOnlyWhy`): the READ-ONLY chip is drawn only then, and `applyReadOnly` greys every
  `[data-write]` control on Settings (buttons `aria-disabled` with the `sys.readonly.control` tip, their handlers
  returning early; fields `disabled`) plus the scope menu's *save group*, under a `#set-ro` banner. Disabled, never
  hidden. A writable server draws no chip.
- **`?` has one job: the keymap.** A focused tip trigger opens on Enter / Space (or click, or hover); the Map's
  legend is `g`.
- **Esc on a journey** with nothing inside it open asks first: *Esc again closes this journey* (`#esc-toast`, 2.5 s);
  the second Esc closes it (`keymap.js` `escCloseJourney`). Cuts, forks and an open expansion still close first.
- **The landing view is the register's.** `jrnLayout` remembers the reader's choice per register
  (`fs-jrn-layout.<lens>`); a register with no choice lands on its default — business on the Storyboard, hybrid on
  the Sheet, code on the timeline. A `?view=` link wins for the register it opened in.
- **The Map toolbar folds by measurement** (`fitChrome` in `surfaces/map.js`, classes on `.map-chrome`): `f-story`
  → `f-band` (the two pickers to their current value and a menu) → `f-asof` → `f-lvl` (short level names) → `f-wrap`,
  measured as one row with the crumb at its own width, rerun on resize, a chrome redraw, a crumb or as-of change. The
  breakpoints it replaced let the toolbar run off the right edge at 1440 while 1280 fitted.
- **The Sheet** keeps its Verified-by foot inside the column (the evidence chip wraps) and draws a gate's name over
  the column's whole width with its count and doors under it, so identifiers break only between words.
- **Settings → Experiments**: one flag per line, its sentence under it (`.set-flags`).

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

## Journeys organised — `lib/journeys-model.js`, `lib/journeys-tree.js` (2026-10-04)

The journeys a design manifest declares, organised **persona → group → journeys** in the order the manifests and
the config declare (proposal `docs/proposals/journey-organisation-and-config-files.md` §4). One shape, the
`JourneyTree` — `personas[] { id, name, description?, declared, groups[] { id, name, description?, declared,
journeys: JourneyRow[], counts { journeys, built } }, counts }`, tree `counts { journeys, personas, groups }`,
`derived`, `notes[]`; every count a `Counted` — and every surface reads it through **`loadJourneyTree(designs?)`**
(`lib/journeys-tree.js`): `GET /api/journeys?scope=` first; when that answers anything but a tree (404 — no route; 400
— an older server reads the path as `/api/journey` and asks for an entry) the same tree is folded on the page by
**`treeFrom(designs, metas, { nodeOf, ordinal })`** (`lib/journeys-model.js`, pure, `packages/server/test/
journeys-model.test.ts`) from `/api/design`, the graph's `meta.journeys` when present, each flow's node (`requires`,
`leadsTo`, `group`, `order`, a persona list the older row leaves out) and its position in the graph (the manifest's
order — an older `/api/design` sorts flows by name). The fold is core `journeyTree()` (`packages/core/src/journeys.ts`)
rule for rule — same ids (`_none` / `_other` for the trailing persona and group, carrying `key` — the catalog key the
surface prints the bucket's words from), same row fields (`personaIds`, `personaNames`, `groupId`, `designId`,
`statusKey`, `placedBy`, `pinned`), same `Counted`s (with `bizUnit`) — and `journeys-model.test.ts` holds it to
`journeyTree()` on the ingested invoice-app fixture, with today's `/api/design` rows and with an older server's. One
promise per scope and sync, shared by the front door, the Portfolio, the Map and the journey header, so the four
cannot disagree; the graph is folded once per graph object (flow ordinals), never per node. `filterTree(tree,
persona, group)` (keeps the tree's counts), `placesOf(tree, nodeId)`, `journeysInOrder(tree)` are its views.
Words: `jrnPersonaName` / `jrnGroupName` print a bucket from its `key` in the register on screen, else the declared
name; `jrnOrgCountsHtml` prints `n journeys · n of m journeys built` with tips.

- **Front door** (`surfaces/journeys.js` `jrnOrganisedHtml`): *Journeys by who uses them* (`journeys.persona.title`)
  with the tree's three counts, then per persona a `hud-label` heading (a link to `#/journeys?persona=<id>`, an
  *named only by its journeys* chip when undeclared, its description and counts), its groups in order — each a
  collapsible `.jrn-group` with a CSS chevron (`jrnToggleGroup`, folds remembered in `fs-jrn-groups` by
  `persona/group` id); a persona with one group draws no group heading — then the journey cards (`jrnFlowCardHtml`,
  plus *also for …* on a journey for several people). `?persona=` and `?group=` filter (`parseRoute` `persona`; the
  `group` key is shared with the code map's grouping), with *show everyone*. The design answer and the tree are read
  before either is painted (`jrnFrontDoorData`, one promise per scope and sync), so nothing moves under the pointer.
- **Journey header**: `#jrn-orgline` beside the title — `For <persona> · <group>` and *also for …* (`jrnFillOrg`),
  for a flow only.
- **Portfolio** (`surfaces/portfolio.js`): one `.pf-persona` section per persona with its counts, an `h3.pf-group`
  per group when there are several, one table per group in tree order with the tree's pin; the per-flow facts fill
  in tree order (each journey once).
- **Map**: *Band by: persona* and the *Storyline* picker — below.

**Storylines** (round 2026-10-05 §2): `JourneyTree.storylines[] { id, name, description?, repo, from, journeys:
StorylineStep[] (a JourneyRow + stepIndex, 0-based, in order), counts { journeys, built } (scope
count.scope.storyline), notes }`, tree `counts.storylines`, and every `JourneyRow.storylines: string[]` (the ids it
is a step of). `treeFrom()` folds the same from `meta.journeys[repo].storylines` (`storylinesFold`, O(journeys +
steps)); `storylineOf(tree, flowId) → [{ storyline, step, of, prev, next }]` (1-based, `prev` / `next` the neighbouring
rows or null) is what the explore card, the property head and the journey header print *in storyline: <name> · step
n of m* from; `findStoryline(tree, id)` matches by id, then by id or name case-insensitively.
- **Front door** (`jrnStorylinesHtml`, `#jrn-storylines` above `#jrn-organised`): *Storylines* (hud *Questlines*)
  with the tree's count, one `.jrn-story` card per storyline — name, its two counts, description, the steps as
  numbered `.jrn-story-step` chips (`ok` built · `warn` partly · `stub` not built; each a link to the journey, its tip
  *step n of m · name · status*), *open on the Map* (`#/map?storyline=<id>`, only with `flags.map`) and *open the
  first journey*.
- **Journey header** (`jrnFillStoryline`, `#jrn-storyline` after `#jrn-orgline`): ‹ *Storyline* · name · *step n of
  m* (business: *journey n of m*) › — the arrows open the journey before / after it in its first storyline (the
  others are in the name's tip).

e2e: `e2e/tests/journeys-organised.pw.spec.ts` (structure and the order rule against the manifest on disk; the
fixture's personas *Billing* and *Operations*, its two groups and the shared, config-placed *Draft and send* on the
front door, the header, the Portfolio and the Map; and the front door drawn identically with `/api/journeys` answering 404).

## MAP — `surfaces/map.js`, `lib/map-canvas.js`, `lib/map-model.js` (2026-10-03)

Every journey on one zoomable board, the way Miro or Figma draw one (brief: `docs/proposals/map-view.md`; the agreed
look: `prototypes/map-view/property-street-neighbourhood.html`; ADR 10). Behind the workspace flag `flags.map`
(Settings → Experiments, `set-flag-map`): off, `navTabs()` leaves the tab out, the Portfolio draws no switch, and
`applyRoute` reads a `#/map…` link as `#/portfolio`. Strings `nav.map`, `map.*`, `set.flagMap`, `key.map*` in
`core/src/strings-map.ts` (lane A's block, then lane B's), spread into the catalog.

**Routes.** `#/map` (neighbourhood) · `#/map/<flowNodeId>` (street) · `#/map/<flowNodeId>?node=<pageNodeId>`
(property) · `?plumb=1` (the street with its calls and data). The flow id is encoded in the path. The board writes
where it is into the link with `history.replaceState` (no navigation, no history entries): after a gesture the
journey the street is on, nothing at the neighbourhood, `?node=` while a screen is open.

**The link is the picture** (§K, 2026-10-03). Outside a property the link also carries `z=<scale>` (4 decimals),
`x=<wx>&y=<wy>` — the world point at the middle of the stage, rounded; on a street measured from the journey's own
district corner, so the link survives the board re-laying for another window's shape — and `card=<kind>:<nodeId>`
(`call:` · `record:` · `message:` · `external:`) while an explore card is open. Written by `writeHash` at gesture
end (the canvas's `onGestureEnd`, 160 ms after the last wheel event), 250 ms after the last arrow key, and when a
card opens or closes; never a history entry. `parseRoute` reads `z x y card`; `applyRouteTarget` puts the board there
(`applyView`, no refit when the walk lands) and reopens the card on the first node of that street that is that node
(`restoreCard`: plumbing on, the folds that hold it opened). `?node=` drops the view (the property is the picture).
The **Copy link** tool and `y` (`mapCopyLink`) bring the address up to date, add `lens=`, and copy it
(clipboard, then `execCommand('copy')`, then a selected field beside the tools). An **as-of stamp** beside the crumb
(`drawAsOf`, `map.asOf`): `as of sync N · <source commit> · <day>` — the commit is `.map-code`, so not in business —
from `/api/version`'s graph sync (else the graph meta) and the graph's `generatedAt`. A hash change from outside
(a link, the back button, the nav tab) goes through the surface's `update(route)` — `applyRoute` calls it instead of
re-mounting when the surface on screen is the one routed to — so the board keeps its place.

**Levels and stops** (map pass 2, lane Z). One continuous scale; below **0.5** (`LEVEL_NB`) the board draws
covers (the neighbourhood), from 0.5 the street. Along it the board has four **stops** (`mapStops(anchor)` in
`surfaces/map.js`, computed every time they are asked, never hardcoded):

| stop | scale | frame when reached |
|---|---|---|
| `board` | every journey fitted, never above 0.45 (`boardScale`) | `fitAll` |
| `journey` | the journey under the zoom (or the one the street is on) fitted to its width, and its height with plumbing; clamped to **[0.52, 0.95]** (`journeyScale`) | `enterJourney` — the head at the top of the board, nothing above it, centred across when it fits, else from its first screen |
| `calls` | the smallest scale at which a data node's name reads at **11 px** (`callsScale` = 11 ÷ the computed font size of `.map-pd .nm`, else a call's, else a screen's name); dropped when not 4 % above the journey stop (a short journey reads fitted) | by `+`: the world point at the centre stays across, the head at the top (`frameCalls`); by a gesture: none |
| `enter` | a screen **64 %** of the board's height (`enterScale`, so the engine's 60 % rule arms) | the screen nearest the zoom's point centred (`frameEnter`), ringed `.near`, and the hint says *Zoom in again to enter …* in the accent |

A wheel, pinch or Safari gesture zooms continuously between stops, but the first stop it crosses holds it for the rest
of that gesture (160 ms after its last wheel event, or the pointers lifting; reversing releases it), and the stop's
frame runs when the gesture ends. `+` / `−` and the ± tools (`mapZoom` → `zoomStep(±1)`) jump stop to stop; past
the last stop `+` zooms by 1.25. So from a journey `−` goes calls → journey → board and never leaves the journey
before its fitted stop. **Zoom-to-enter is earned:** a screen opens (`onSnap`) only when a zoom-in gesture ends
with the same screen armed as when it began — the hint was on screen first — or on `+` while one is armed; it arms
only from the calls stop on, on the journey the street is on. **Fit / `0`** (`mapFit`) fits the journey in view
(the one the street is on, or the open screen's) with plumbing when on; only from the board does it fit every
journey; the crumb keeps the journey until the reader leaves it (the board, or another journey). Esc from the
street is the board. Programmatic moves animate 450 ms (`.anim`, off under `prefers-reduced-motion`); gestures never
do. Leaving a screen lands on the street at scale **1.0** centred on it; a ⌘/Ctrl scroll out past a small budget,
or a two-finger pinch out, over the open screen leaves it (the rest of that scroll is swallowed for 400 ms).

**The opening frame and the edge cues.** `#/map/<flow>` opens at the journey stop (refitted once its walk lands,
unless the link names `z/x/y`). When screens run past an edge, `.map-edgecue.l` / `.r` (on the stage, in the gap
under the screens' row so it never sits on a name) prints *◂ n more* / *n more ▸* (`map.edge.more`, the number a
`plainTip` over `map.edge.scope`): n is the screens of the journey whose middle is past that edge
(`edgeCounts`). A click slides the board about one board's width toward that side, never past the journey's end, and
the link follows.

**The chrome.** `.map-chrome` is an opaque band (`--panel`, a bottom rule); the board starts under it
(`top: var(--map-chrome-h)`, measured by a ResizeObserver), so nothing on the board draws under the toolbar and
the frames need no chrome offset. Tips inside `.map-surface` (`data-tip-mode="hover"`, `lib/tooltip.js`) open on
hover after `TIP_QUICK_MS` (450 ms), stand `TIP_HOVER_GAP` (14 px) clear of their trigger, and a click does what the
trigger sits on (a chip on a screen opens the screen); `?` on a focused trigger still opens its tip. Elsewhere in the
viewer tips are unchanged.

**The engine — `lib/map-canvas.js`.** `attachCanvas(stage, world, opts)` (alias `createCanvas`) knows no map data.
It moves `world` under `translate(tx,ty) scale(s)` inside `stage`, sets `--map-inv` (`min(1/s, 4)`), and asks its
owner for: `stops(anchor)` → `[{ id, s, frame?(anchor, via) }]`, `min` / `max` (numbers or functions), `level(s)`
(default `levelOf`), `snapTargets()` + `armFrom()` + `snapCover` (0.6); it tells `onChange`, `onLevel`,
`onStop(stop, via)`, `onArm(el|null)`, `onSnap(el)`, `onGestureEnd`; `holdWheel()` swallows wheels while the owner
finishes a gesture of its own. Its handle: `state`, `level`, `armed`, `stops`, `stopAt`, `inGesture`, `set`, `shift`,
`rearm`, `zoomAt`, `zoomTo`, `zoomBy` (no stops), `zoomStep(±1)` (stops), `centerOn`, `fit`, `viewCenter`, `toWorld`,
`worldCenter`, `destroy`. **Input normalisation:** `normaliseWheel` turns `deltaMode` 1 into 16 px a line and 2 into
the stage's height, and reads shift + a vertical wheel as sideways; a ⌘/Ctrl wheel event zooms by
`wheelFactor(dy)` = exp(−dy × 0.012), clamped to one 1.25× notch — so a mouse notch (100 px, or 3 lines) is one
1.25× step and a trackpad keeps the rate per pixel it had (18.6 px of travel is one notch); a plain wheel pans.
`settle(stops, from, to, skip)` and `nextStop(stops, s, dir)` are the pure detent rules
(`packages/server/test/map-canvas.test.ts`). **Adopting it on the code map:** give the graph's pan/zoom layer a
stage and a world element, pass `stops` for its own altitudes (say, every file fitted, one module fitted, the
names readable — computed from its own stylesheet the way `callsScale` is), `level` for its classes, and
`snapTargets` / `onSnap` only if a zoom should open something; replace its wheel and pinch handlers with the
engine's, and its `+ − 0` with `zoomStep` and its own fit.

**The neighbourhood.** One `.map-district` per flow. The layout rule is `layoutDistricts(items, { aspect })` in
`lib/map-model.js` (pure; tested on 1, 3, 8, 21 and 40 synthetic journeys for no overlap and the board's shape):
- **bands by source** (`repo`), stacked top to bottom in the order the design answer names the sources; each band is
  a **panel** (`.map-band`, clarity pass 2026-10-04): a faint wash with a 1-px border at any zoom (`--map-s`), as wide
  as the board's widest row so the bands line up (`band.w`, `pad` either side of its districts, `pad` below), headed
  in its `labelH` strip by `bandHeadHtml()` — the band's word, *n journeys* (`map.band.journeys`, a number with its
  tip, `b.n` slots) and, banded by persona, the persona's `description` from the tree — drawn under the links layer;
- inside a band, `neighbourhoodModel` orders the journeys that contain another (every screen of a smaller one is
  theirs) first, then by name, and they are packed left to right in **rows** that wrap at one maximum row width;
- the board is laid out **twice** (`MAP.lay = { nb, st }`; clarity pass 2026-10-04): **a cover is a card, a street is
  a street — the two no longer share a width.** The board (`nb`) is drawn in *board px* × `BOARD_K` (5) world units:
  a card is `CARD_BASE + CARD_SCREEN × screens` wide with its screens clamped to 2–4 (`boardWidth()`, so a 14-screen
  journey is at most twice a 1-screen one, where their streets differ 6×) and `CARD_H` tall; its gaps, header strip
  and panel inset are board px too (`BAND_GEOM.nb`). The streets (`st`) keep their own width and height. `geom`,
  `bands`, `size` and `echoes` are the layout of `MAP.alt`; `ensureAlt(alt, keepId)` swaps them where the level
  changes, shifting the canvas so the kept journey's corner stays where it was on the stage — a gesture keeps the
  journey under the pointer (`altKeep()`, `MAP.ptr`) and opens it; a programmatic move (`enterJourney`, `fitAll`,
  `centreScreen`, `applyView`, `fitAffected`) swaps first under `holdingAlt()` and computes its target in the new
  layout, so the animation starts from the card. Stops and frames are measured on the street rect (`stRect()`), the
  board stop on the board's size;
- every district takes its band's tallest height, so rows line up;
- the row width is the one, among the widths a row could break at, that brings the board's aspect nearest the
  stage's (width ÷ height under the chrome), so a fit uses the screen. Re-run on resize, on plumbing, and as each walk
  lands (the re-layout shifts the board so the journey in view stays put).
- **Band by: source · domain · persona** (`MAP.band`, `fs-map-band`; `bandToolHtml` draws the picker when the graph
  has domains or the tree has personas). `neighbourhoodModel(designs, work, tree)` puts on each district its
  `personaIds`, `groupId`, `order` and `places` (`[{ persona, group, order, rank }]`, `placesFromTree`), and hands on
  `personaOrder` and the persona names. `layoutDistricts(items, { bandKey: 'persona', personaOrder, echoW })` bands
  by the tree's persona order and orders a band by `rank` (group, then journey order); a journey for two people is
  laid out in each band — its first place keeps its id, every other is an **echo** slot `<id>\u0001<persona>` listed
  in `L.echoes`. The surface draws the street once and, in the other bands, a dashed `.map-echo` card (`drawEchoes`,
  `map.band.echo` *walk it under <persona>*, click / Enter enters the journey), narrowed to `DMIN`. Districts — and
  every count the board prints — stay one per journey.
  With `groupRows: true` (the surface passes it, `GROUP_W` per altitude) a persona band reads as its groups: each
  group's run starts on a row of its own after a gutter of `subW`, and `L.subs` (`{ band, key, x, y, w, h, n }`)
  places each run's word — `.map-band-grp` (`groupWordHtml`: the tree's group name, *Other journeys* for the trailing
  bucket, counter-scaled like the band header). A band of one group keeps no gutter.
- **Storyline** (`MAP.storyline`, `?storyline=<id>` in the hash beside the other view params; `storylineToolHtml`
  draws the picker when the tree declares a storyline — a segmented *All journeys · <name> · …* that folds to its
  current value under 1800 px, and with it *Band by* folds there too). `applyStoryline(id)` sets `MAP.nb` to
  `storylineModel(MAP.nbAll, story)` (`lib/map-model.js`: only the storyline's districts, in its order, each with
  `step` / `steps`, and `then` — `{ from, to, kind: 'then', fromSides: ['e','s'], toSides: ['w','n'] }`), lays them
  out as **one band** named by the storyline (`.map-band.story`, its description in the header), puts the step number
  on each card and street head (`.map-step`, tip *step n of m*), and `drawLinks` adds the `then` lines — routed by
  `routeLinks` out east or south and in west or north, so the chain reads on — which `linkVisibility` shows at every
  altitude, the one line the board draws unhovered. *Band by* is hidden while a storyline is drawn; *All* restores
  the bands. The Affected mode paints whatever is drawn. Every other journey is not drawn (h / l walk the storyline).

Each district has a **cover** (`.map-dcover`) drawn **by altitude** (clarity pass 2026-10-04). At the **board**
(below `LEVEL_NB`) a cover is a card: the name (two lines, its tip the whole name and sentence), **one status chip**
— *built*, *partly built · n of m* or *designed, not built*, the summary's own `counted.built` with its number tip —
its marks: **stale** (muted) and **not built** (amber), one or both (round 2026-10-05 §3.3, below; they replaced
the single *at risk* mark — the same facts the risk headline sums) and **→ n**, how many journeys it
leads to (`fillLeadMarks`, from the lines `drawLinks` routes; its tip names them). Everything else — the sentence,
screens, tests with their evidence word, ERP, owner, actions, gates, stores, declared-not-called, the work chip — is
in the journey's **head** (`.map-dhead`, `aggHtml`), drawn from the journey-fitted stop up; nothing is dropped from the
data, only from what is drawn below the stop. The street under a card is hidden at the board. A cover's inside is
scaled by `--map-cs` (`coverScale(s)` = min(`BOARD_K`, min(`BOARD_K` × fit, 1.25) ÷ s)): at the fit its board px are
as large as the board fits them (a chip ≈ 10 px, a name ≈ 13 px on a laptop, never more than 1.25× when few
journeys fit large), and zoomed in past the fit they keep that size on screen while the card grows — counter-scaled.
Band headers and echo cards use the same scale at the board and `--map-inv` on the street. `foldCoverChips` still
folds a row that would overflow into `+n`. The district under the pointer or the focus rises above its neighbours.

**Links** come from each journey's own `summary.links` as it lands, never inferred by the viewer. **At the board**
(clarity pass 2026-10-04) no line is drawn but those of the journey under the pointer or holding the focus
(`MAP.hot`) — both ends lit (`.link-end`), every other district dimmed (`.links-lit`, as the Affected mode dims) — and
no label at all; the cover's *→ n* says the lines exist, and the board's routes use 40-unit lanes without labels.
**From the journey-fitted stop up**: *leads to* (and its mirror *requires*, drawn once; two journeys that lead to each
other are one line with an arrowhead at each end and the one label *lead to each other*) always, dimmed; *part of*
(dashed) only for the district under the pointer or the focus, or when both its ends are in view (`linkVisibility()`,
run on every move). **Routes** (lane L, 2026-10-03) are `routeLinks(rects, links)` in `lib/map-model.js`, pure and unit-tested on 3
to 40 journeys: a shortest path over the grid of lanes 70 world units outside every district's edges, charging a bend
600 and a lane another line already uses a little, from the middle of one side to the middle of a side — so a line is
square, runs in the gutters and never crosses a district; lines sharing a lane are spread 14 apart. A line whose
straight runs are all too short for its word (two journeys side by side) goes over the top by the row gutter instead.
**Labels** are placed once per line, on its longest straight run where the box clears every district and every label
before it, at the largest counter-scale it fits at (4, 3, 2, 1.5, 1 — `label.scale`); a label is drawn only while
`--map-inv` is at most its scale, so a short run's word appears as you zoom in and never lands on a cover. Strokes are
`vector-effect: non-scaling-stroke` (1.6 px at any zoom); arrowheads and labels are counter-scaled by `--map-inv` with
a CSS transform. The words are measured once per word on the links layer (`labelWidth`).

The journeys are read one at a time, the one the route names first, under a generation counter; answers are cached per
entry per sync (`JOURNEY_CACHE`, the `FLOW_CACHE` pattern), so a register flip never refetches.

**The street.** Screens in step order (`.map-scr`: `designThumbHtml(node, 'map')` with the lightbox click switched
off — a click opens the screen — or a placeholder with the absence word; the ordinal; the name; the route as
`.map-code`; *designed, not built* on a planned screen, whose stripe is warm; the screen's Counteds), joined by
*then*. **Plumbing** (`p`, the *Plumbing* / *Calls and data* tool, `?plumb=1`, remembered per reader in
`localStorage` `fs-map-plumb`): each screen owns the pathway straight below it — a trunk, its calls stacked in
order (`.map-pl`, a top bar in the service's colour `svc-<index % 6>` from `summary.systems` api rows, the
evidence word when not spec-backed, *again* when the journey made the call on an earlier screen, the call's words,
method and path as `.map-code`), and beside each call its records, messages and third parties (`.map-pd`, *reads*
cool, *writes* warm, *reads · writes* both, arrowheads by direction; *reached* — the walk recorded no direction —
a plain dim dotted line with no arrowhead, never a write by default). Planned and declared calls are dashed and
carry nothing beside them. Nothing crosses; the legend lane names the services, the two colours, *reached* only when
a node on the street uses it, and the **stores** the journey touches (`storesOf(model)`), each with its swatch.

**Data stores** (`docs/proposals/data-stores.md`, 2026-10-03). A data node whose node or marker carries a `store`
names it on its kind line in words — `Invoice DB · record` for a record, `Example ERP · ERP` for a third party used
as a store (kind words `map.store.kind.*`: sql *database* · document *document store* · files *file store* · erp
*ERP* · other *store*) — and its left bar takes the store kind's colour (`.st-<kind>` sets `--stc`: sql and document
the record's violet `--tbl`, erp amber, files a cyan-grey, other dim). A store-like third party is drawn in the
record anatomy (`.map-pd.rec`, `data-store`, `data-store-kind`) with its *reads* / *writes* from the marker's `op`, or
*reached*; a third party that is not a store keeps the warm `.ext` bar. A store's name is a product name or a
settings word, so every register prints it. The cover and head carry *n data stores* — the summary's own `counted.stores`, not drawn at 0.

**The folds** keep a long pathway short (the journey view's `▸ n inside` is the precedent for the words; the map keeps
its own state, `MAP.open`, for as long as the board is mounted). Beside a call the first **3** data nodes are drawn —
writes and *reads · writes* before reads, so the warm lines are never the folded ones — and the rest fold into one
`▸ n more` row; under a screen the first **4** calls, the rest in one `▸ n more calls` row. A fold only appears when it
saves a row (a call with 4 data nodes and a screen with 5 calls draw whole). Clicking a fold opens it in place (`▾
fewer` / `▾ fewer calls` folds it back); the district redraws, and its height follows the pathway **as drawn** — the
folded height by default, so the neighbourhood packing stays tight, growing downward when a fold opens (the band
re-lays, the journey in view stays put). The fold's number is that call's or screen's own markers beyond those drawn,
with a `plainTip` (`map.fold.scopeCall` · `map.fold.scopeScreen`); no count of the journey moves. Lane L widened the column (`COL` 480 → 600, `SH` 214 → 236): a call node is
**250** wide and as tall as its words need — its name and its method and path wrap whole (`callTextH`, a safe estimate
of characters per line), never an ellipsis; a screen's name wraps to three lines and its route shows whole; a data
node is **280** wide (`DW`): its name and its kind words (store · kind, then *reads* / *writes* / *reached*) show
whole, and only the hybrid identifier at the end of the kind line may give way (the card prints it whole). The data order is writes, *reads · writes*, reads, then *reached*
(`MODE_ORDER`).

**The model** (`lib/map-model.js`, pure, `packages/server/test/map-model.test.ts` over a captured answer in
`test/fixtures/map-billing-cycle.json`). `streetModel(data, graphById)` → `{ journey, services, screens, links }`;
a `MapScreen` is `{ index, ordinal, node, id, name, business, designId, route, state, chips: { calls, gates, tests,
work: null }, calls, gates, decisions, absent, segment }`; a `MapCall` is `{ nodeId, marker, moment, service,
method, path, operationId, summary, label, business, evidence, repeat, data[] }`, data `{ kind, nodeId, name, node,
mode, store }` — `mode` one of `read` · `write` · `both` · `reached`, `store` the node's `StoreRef` (name, kind,
engine, via, ref) else the marker's `{ name, kind }` else null. `mergeMode(a, b)`: the same node met twice on one
call — a known direction wins over `reached`, and `both` comes only from a read and a write. `streetModel(...).stores`
(read through `storesOf(model)`) is `summary.system.stores` in its order, then any store a drawn data node names that
the summary does not, in the order the street meets them — so the legend explains every swatch: `{ name, kind, ops }`. Measured on the fixture and different from the proposal's first draft: a call's data is what the call
reached, found up the markers' `under` chain (falling back to its moment's call); a planned screen's calls are its
**planned call markers** (`via: 'planned'`), not `segment.declaredOnly` — that field lists operations a *built*
screen's design names and no code on it calls, kept as `evidence: 'declared'` rows. Evidence: `spec-backed`
(contract `both`) · `implied` (in the code, not in the spec) · `not built` (planned, or spec-only) · `declared`.
`screensUsing(model, kind, nodeId)` answers the card's *on* row.

**The explore card** (`.map-xcard`, §5): kind and direction (the service and what the call reads or writes; a data
node's store and kind and what this call does to it), the evidence word, the name in the register, for a data node
with a store its swatch, name and kind and — `.map-code`, so hybrid and code only — *known from* and the `via` in
words (`map.store.via.*`) with the `ref`, the identifier line
(`.map-code`: method path · operationId · handled by …; a data node's name and file), *on* — the screens of this
journey it is drawn under, each opening that screen — and its doors from `detailLinks` (the contract, the spec line, the handler, the code map — see *every detail is a
door* below) with *open the journey here* under them. `b` on the map asks *what uses
this?* about the card's node (`mapSelected()`). No number is printed on it in v1: nothing per call is typed yet.

**The property hook** (lane B fills it). Opening a screen — a click, Enter, a snap, `?node=` — makes the stage's
`.map-prop-host` overlay visible and calls `openMapProperty(host, ctx)`, which imports
`surfaces/map-property.js` and calls its `mountMapProperty(host, ctx) → { update(ctx), destroy() }`; until that
module exists a minimal stand-in (name, route, sentence, picture, Back, previous / next) answers. `ctx` is
`{ data /* the /api/journey answer */, model /* streetModel */, screenIndex, screen /* model.screens[screenIndex] */,
flow, lens, onClose(), onStep(delta), onOpenScreen(index) }`. Stepping calls `update(ctx)` on the same handle; a
lens or register change calls `update(ctx)` with the new `lens`; closing calls `destroy()`. `[` `]` call
`onStep`, Esc `onClose`; the street underneath stays centred on the open screen.

**Keys** (`keymap.js` asks `mapKey(e)` first, only while the map is mounted):

| key | where | does |
|---|---|---|
| Tab / Shift-Tab | everywhere | the board holds the focus when the Map opens (`focusBoardOnOpen`, only when nothing else has it), so the first Tab lands on a journey; Shift-Tab reaches the level pills → crumb's as-of → tools. On the board: at the neighbourhood one stop per journey (its cover); on the street each screen (and its number chips), then each screen's calls with their data, journey after journey. A stop off the stage pans into view (`onBoardFocus` → `revealEl`) |
| Enter / Space | the board | a cover walks into the street (the keyboard lands on its first screen); a screen opens its property (focus on Back); a call or data node opens the explore card; with nothing on the board focused, the cover the keys last walked to (round 2) |
| Esc | | card → screen (focus back on it) → street → neighbourhood (focus on the journey's cover) |
| `j` / `k` | street · board | on the street the next / previous screen of the current journey, slid to the middle across at the reader's zoom (the board keeps its height); on the board the next / previous cover, like `l` / `h` (round 2) |
| `h` / `l` | both | previous / next journey: the cover takes the focus on the neighbourhood, the board walks to its street on the street |
| arrows | outside the property and card | pan 80 px (Shift: 240) |
| `[` / `]` | property | previous / next screen |
| `p` · `+ − 0` · `b` · `y` | | plumbing · the next stop in or out, fit what is in view · what uses the card's node · copy the link |
| `g` | | opens and closes the legend (`mapToggleLegend` → `toggleLegend`) whatever has the focus; over an open screen it does nothing. `?` is the keymap here as everywhere (2026-10-05: it had four jobs) |

What a level does not show is `inert` (`applyTabbing`, redone when the level or the property changes): the ghosted
streets and heads at the neighbourhood, the board under an open property; covers are `visibility:hidden` on the
street, and a cover's own chips are not stops. A walk landing redraws a district without losing the focus
(`focusKey`). The ring is the accent outline counter-scaled by `--map-inv` with an accent-dim glow.
`e2e/tests/map-keys.pw.spec.ts` holds all of it.

**What the business lens hides.** Every `.map-code` element (routes, method and path, operation ids, handler
names, a data node's identifier and file) is not drawn, the accent warms, and names are words: a call reads the
sentence written for it (`plainWords`), a record or message its label or its name said as words (`ledger_entries`
→ *Ledger entries*, `invoice.finalized` → *Invoice finalized*), a flow name that is code goes through `unCode`.
Service names are the spec titles (`SystemRow.label`) in every lens. Lane L finished the job: a data node's kind line
is the store and a plain word (`map.biz.kind.*`: *Invoice DB · database record*, *Example ERP · ERP record*, *notice*,
*outside system*); a call prints *declared, not called* and *not built* but never *spec-backed* or *implied* (the card
and the property's chips too, `evShown` / `evChip`); a checkpoint is a *check* or a *rule* (`map.biz.check` ·
`map.biz.rule`) named in words — a permission name said through `humanize()` — and checkpoints said in the same words
are one row with their times added (`dedupeGates`, `map.prop.timesSame`); the property's Changes leave out the
index's own facts (`edge_confidence_changed`); a test's name drops document references (`caseWords`). The e2e specs
hold the board, the legend, the street with plumbing, the card and all eight property tabs to the journey-numbers
identifier check and to none of *spec-backed · implied · guard · edge confidence · MEDIUM*.

**The legend** (lane L; its own glyph `sym('legend')` on the toolbar and the `g` key; `.map-legend`, strings
`map.legend.*`). **Closed until asked for** (2026-10-05: opened by itself it covered a third of the board on every
first visit — the `fs-map-legend-seen` key and the `mapLegendSeen` e2e fixture are historic), closes with its ✕, Esc or
`g`; it sits under the toolbar and ends inside the stage, scrolling inside itself. It lists only what the board has drawn
(`legendFacts`): between journeys *leads to* and its *requires* reading, *lead to each other*, *part of*; under each
screen *reads*, *writes*, *reads and writes*, *reached* and the stores by kind; on a screen the built and designed
stripes, *again*, the call evidence words, the ×n mark when a checkpoint repeats; and the evidence words the journeys
earned (the cover's own evidence chip as the swatch). Each swatch is drawn with the board's own classes (the drill
legend's rule), so a swatch cannot describe a line the board does not draw; each word carries its define.

**Toolbar and crumb.** The Map's own lens switch is gone (the header's lens is global). The whole toolbar needs about
1490 px, so it folds in steps and keeps one row down to 1024 px (clarity pass 2026-10-04): under **1500 px** *Band by*
(one segmented control, `.map-segs`) folds to its current value (`.map-band-cur`) with the choices in a menu under it
(`MAP.bandMenu`; a click outside or Esc closes it); under **1360 px** the as-of stamp leaves the toolbar (sync, day and
commit stay in the header's sync-chip tip) and the level buttons shrink to a glyph and one word
(`map.level.*.short`, the whole name their label and tip). The crumb shrinks and ellipsizes rather than take a row;
the trail is whole in its tip at any width. The Portfolio's switch reads *Table · Board* (`map.portfolio.board`); the nav tab stays
*Map*.

**e2e.** `e2e/tests/map-street.pw.spec.ts`: flag off → no tab and `#/map` lands on the Portfolio; flag on → the
Portfolio switch, three districts, the links, entering Billing cycle → three screens in order; plumbing (service
bar, a *writes* node, Discard draft's dashed *not built* call, `p`); the property through the hook, `[` `]`, Esc, a
`?node=` deep link; `+` stop to stop, entering only after the hint, leaving by ⌘-scroll out, `0` fitting the journey
and Esc the board; the explore card; the business lens; data stores
(the store on a data node and its bar colour, the ERP *writes* from `op` and *reached* with no method, the legend's
stores, the card's *known from* in hybrid and hidden in business, the business street with stores) over
`e2e/tests/map-stores-stub.ts`, a `page.route` stub that adds stores in the proposal's shapes and skips what the real
answer already carries. `e2e/tests/map-zoom.pw.spec.ts` (over a `page.route` stub repeating Billing cycle's screens
twelve-journey board stubbed over the fixture (`/api/design` and `/api/journey` through `page.route`) where every line

#### The Map and the journey open each other; every detail is a door — `lib/route-url.js`, `lib/detail-links.js`, `lib/detail-doors.js` (round 2026-10-05 §3)

**The two addresses.** Both pictures of a journey share one unit of place, the **step**: the 1-based ordinal of a
screen's segment in `summary.segments` (the journey calls it `step`, the street `screen` — one number). Pure, in
`lib/route-url.js` and `packages/server/test/route-url.test.ts`:

| function | address | opens |
|---|---|---|
| `journeyStepHash(flowId, n, { node?, lens?, view? })` | `#/journeys/<flow>?view=timeline&step=n[&node=<id>]` | the blueprint timeline (a link that names no `view` of its own opens the timeline — `applyRoute`), step n's first marker selected, or the marker (else gate) of `node`, the screen's head scrolled to the timeline's left edge past the sticky row labels (`jrnApplyStep`, spent once from `S.jrnPendingStep`) |
| `mapScreenHash(flowId, n, { node?, kind? })` | `#/map/<flow>?screen=n[&plumb=1&card=<kind>:<id>]` | the street with step n's screen framed and focused (`screenAtStep`: a step the street folds into the next screen lands there); a node opens its explore card with plumbing on, through the Map's own `card` grammar. `?j=<flow>` names the street for a link written without the path |

The journey keeps the address on the step on screen (`jrnWriteStepHash` on every `jrnSelect`: `step` and `node`, a
replace), so the bar and `y` name the part selected. Doors between them: the header's **see it on the Map**
(`#jrn-tomap`, flows only, with the Map flag on; a selected call or data node opens its card), the street's screen
card and the property head's **open the journey here**, and the explore card's (at the step whose markers include
the node, `stepOfNode`, the node selected). On the Map, `writeHash` drops `screen` and `j` once the board writes its
own picture (`z x y`). Storylines (lane S) open their journeys at step 1 — the front door's chips and *open the first
journey*, the header's ‹ › (`gotoJourney(id, 1)`, in the view the reader has); the explore card and the property head
print *in storyline: <name> · step n of m* (`storylineLineHtml`, over `storylineOf`).

**The doors rule.** A detail that names something in the graph is a link to where that thing is best read. One pure
builder, `detailLinks(kind, node, ctx) → [{ word, href, external?, code?, editor? }]` (`lib/detail-links.js`,
`packages/server/test/detail-links.test.ts`): `word` is a catalog key (`door.*`), a lookup over `ctx.byId` and the
edge index `ctx.edgesOf` (`S.EDGES_OF`) — never a scan of the graph's edges. The table:

| detail | doors, in order |
|---|---|
| gate / rule (`gate` · `guard` · `rule`) | *open in the editor* (its line) · *see it on the code map* |
| call (`call` · `route`) | *read the contract* (`#/apis/<apiId>?op=<routeId>`) · *read the spec file* (`?view=spec&line=`) · *open the handler in the editor* (the marker's handler, else the route's first `calls` edge) · *see it on the code map* |
| record / store / third party / message | *see it on the code map* · *open the schema in the editor* |
| test | *see the cases* (`#/tests?flow=`) · *open the test file in the editor* |
| work | *see it on the work board* (`#/work/<id>`) · *open in the tracker* (its link, new tab) |
| screen / page / component | *see the page on the code map* · *open the design file in the editor* · *open in Figma* |
| package | *see where it is included* (`#/codemap?view=package&package=`) |
| anything else | *open in the editor* · *see it on the code map* |

A door the graph cannot name (no root, no `loc`, no spec line, no tracker link, not in the graph) is not returned, and
the surface's absence word stays. Doors into code (`code: true` — the editor, the code map, the spec file) are left
out in the business register, so a gate there is its words. `lib/detail-doors.js` draws them (`doorsHtml`, the
`.dd-door` chips with their define as the tip) and answers the keys from `keymap.js` (asked before the Map's):
**Enter** on a focused detail (`[data-doors]`) opens its first door, **o** its editor door (also with the Map's
explore card open). Where they are drawn: the journey's gate and rule rows open in place (`jrnGateExpand`, the ▸ in
`.jrn-gl-go`) to their doors, their first sentence and — not in business — their own lines from
**`GET /api/source?node=<id>`** (the node's span from disk inside its source's root, or 12 lines from its line when it
has none; `codeSlotHtml` + `fillCode`, one answer per node per sync; `packages/server/test/source-api.test.ts`); the
marker inspector's head (`jrnInspDoorsHtml`); the explore card (its `.acts`, contract first); every property row the
graph names (`.mp-row[data-doors]`: a click opens `.mp-exp` — a gate's lines or a call's contract, then the doors).

**The board's marks and reading floor (§3.3).** A cover carries *stale* (`.map-mark.stale`, muted, the sync glyph —
the code moved under the tests) and *not built* (`.map-mark.notbuilt`, amber — a screen is only designed), one or
both, each with its own define (`map.cover.mark.*`); the single *at risk* mark is gone (the risk headline above the
board still counts). No word on a cover draws under **8 px** on screen (`FLOOR_PX`; a cover's chips, 10 board px, are
its smallest words): `coverScale` stops shrinking there, the card clips, the world wears `.floor`, and the hint says
*n journeys · zoom in to read* (`map.floor.read`, the number with its tip). e2e: `e2e/tests/map-journey-links.pw.spec.ts`.

#### Affected — `surfaces/map-affected.js`, `lib/map-affected-model.js` (map pass 2, lane I, 2026-10-03)

Blast radius as a mode of the Map, not a tab (`docs/proposals/map-pass-2026-10-03.md` §4). Pick a thing and the
whole board dims to what reaches it, at every altitude; Esc or *clear* lights it again.

**Seeds and the link.** `?affected=<nodeId>` (a screen's page, a call's route, a record, message or third party) ·
`package:<nodeId>` · `work:<KEY or item id>` · `commit:<sha prefix>`, with `ahops=<1–5>` when the distance is not
the default 2 (`ahops`, so it never collides with the impact drawer's `hops`). `parseRoute` reads both;
`writeHash` writes `affectedParams()` with every other picture parameter, so the mode survives zoom, level
changes and a copied link, and `applyRouteTarget` → `routeAffected` sets or clears it from the link. A work item
resolves through `GET /api/work?q=KEY` → `/api/work/item/<id>`: the parts its commits touched (`commits[].nodes`),
else the parts it links; a commit through `GET /api/history/commit?sha=` (its resolved hunks, else every part
defined in a file it changed). At most 8 parts are asked about (`pickSeeds`: screens, calls, components first);
the rest are named on the bar as *n more parts not asked*.

**The answer.** One `/api/impact?node=<seed>&direction=upstream&hops=H&tests=1&reach=1` per seed, cached per seed,
distance and sync. `reach` is core `affectedReach(index, report)` (`packages/core/src/affected.ts`): journeys and
screens whose walk meets the seed (`hop: 0`, said *its path meets it* — not a distance) or a listed node (the
fewest hop), the routes and data nodes in the hop sets, and four `Counted`s partitioned by distance (docs/COUNTS.md
§Map → Affected). `flows=1` is not asked: the walk sets supersede the per-node flows, and they are what lets a
package reach its journeys (through the rule a journey's gate is). Several seeds: `combineReaches` keeps every seed
that reaches a place with its own distance; the badge shows the nearest, its tip names each part — never a count
across them.

**Drawing** (`paintDistrict(el, flow, model)`, called at the end of `renderDistrict` and on every change of the
mode): classes `aff-hit` / `aff-dim` / `aff-seed` and `.map-affb` badges only — nothing hidden. The neighbourhood
dims districts not reached (`.lvl-nb .aff-dim`), badges the rest in the cover's and head's chip row, and rings the
journey the seed was picked on or shows as a screen. The street dims screens, calls and data nodes not reached and
badges the rest (screen: under its title; call: in its service row; data node: above its corner); the seed is
ringed (double outline, *the thing picked*). Words: *its path meets it* · *reached at hop n* (hybrid, code) ·
*through what uses it directly / through what uses those / further out* (business) · *not reached*.

**The mode bar** (`affectedBarHtml`, a second row of `.map-chrome`, so the board starts under it): the seed's name
(the business name in business; a work item's key and title; a commit's subject), its journeys and screens when
one seed was asked about, *n more parts not asked*, the distance stepper 1–5 (`impact.hops.*` words, the current
one `aria-pressed`), the state (*reading…*, failed, unknown link, no parts), *clear*.

**Entry points.** *What's affected* on the explore card (a call or a data node, `origin` = its journey) and on the
property's head (the screen's page); *Affected* on each row of the property's Work tab (`work:<key>`) and Changes
commit rows (`commit:<sha>`), which also open the Affected tab; a link from the Portfolio, the code map or anywhere
that writes `?affected=`.

**The Affected tab** (the property's ninth tab, present only while the mode is on; its number is the picked seed's
`counted.screens`): a seed chooser when several parts were asked about; the scope label and the seed; the four
Counteds (calls not in business); the bound (`impact.bound.floor` with the report's note, or `impact.biz.floor` with
its reasons in business); then one section per distance — *its path meets it*, *uses it directly*, *reaches it
through those*, *reaches it through n others* (the impact panel's words) — each with its journeys, screens (links
that open them, the mode carried), calls and the tests first met there (names and evidence class; business: the
count with its levels); then *not walked* — the report's stops with *n behind it* (business: *not followed past
…*). While the mode is on the explore card's *on* chips and the property's *also in* chips carry how each screen or
journey is reached.

Esc closes the list, then clears the mode, before anything else (`mapEscape`). e2e: `e2e/tests/map-affected.pw.spec.ts`; the pure parts:
`packages/server/test/map-affected-model.test.ts`; the fold over HTTP: `impact-api.test.ts` (`?reach=1`) and
`history-api.test.ts` (`/api/history/commit`).

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
| APIs | `MapScreen.calls`: service (`SystemRow.label`, colour `svc-<index>`), what it is for, method + path outside business, the evidence chip (*spec-backed* · *implied* · *declared, never called* · *not built*), what it reads, writes or reaches; then *Data this screen reaches*: every record, message and third party reached, once, with its modes (*reached* only while nothing known says which way), grouped by store (`dataByStore`: named stores first in the order the screen meets them, headed by the store's name and kind word; what no store names last under its plain kind word, records · third parties · messages) | `counted.actions`; a screen not built: `counted.actionStops` |
| UX | the page node, the components the walk met (`screenComponents`), story chips (`storyChipsHtml(screenStoryIds(…))`) | none |
| Tests | `summary.coverage.segments[i]` through `jrnFoldFacts`: the evidence chip, the run behind it, the counts sentence, their own last run; the cases (not run-level) with how each is evidenced and its status; coverage runs that name no case apart | `coverage.segments[i].counted.tests` |
| Route | the page name, built or planned, the design manifest that declares it, where the code routes it; the journey's `summary.links`; *other ways in* = edges into the page that are not `contains`, `covers`, `tracks` or a flow's `renders`; the design and `@see` links (`jrnRefAnchors`) | none |
| Work | lazy, cached per sync: `GET /api/work/links?node=<page>` and the flow's `findings` (`flowWork`) kept to those items. With no work source configured nothing is asked and the tab says so | `counts.items` of the links answer, once it arrives |
| Changes | lazy, cached per sync, two groups (lane N, 2026-10-03). **Commits that touched this screen's parts** first: `GET /api/history/touching?repo=&nodes=<changeIds>` — the application's commits, newest first, each with its subject (business: the sentence without its conventional type and scope, through `unCode`), day, author, the first three parts it touched (*n more parts*), short sha and work keys (not in business), and *these lines* / *its file* for how it was matched; the group's head prints `counted.commits`. `read: 0` → *no commit history has been read for this source*; none matched → *no commit read touched these parts*; 503 → *history is not kept on this server*. Then **What the index changed**, labelled as such: `/api/history?repo=` for the spine, `/api/changes?from=sync:<previous>&to=sync:<latest>` kept to `changeIds` (one sync → *no earlier sync to compare against*; nothing matched → *nothing on this screen changed between these syncs*). Never blank | none |

**One number, one word (lane N, 2026-10-03; `lib/map-chips.js`).** The swarm read 14, 10 and 23 for one journey's
screens with nothing naming the unit. Now: the cover and street head print `counted.screens` (*14 screens*, its tip
split *reached by the walk* / *not reached*) and, only when the walk reached fewer, `counted.screensReached` (*10
reached*) beside it (`mapScreensChips`); the footer says *screen 4 of 10 reached · journey* — its 10 the summary's
`screensReached` with its tip (`placeOf()` hands the same object on, only when it counts the street's rows) — and,
when the design names more, *14 declared, 4 not reached*, the 4's tip naming each screen with its absence word
(*not reached*, or *not built* for a design-only screen). The drill keeps *stop n of t*, whose define says it counts
stops. Every count of tests carries its evidence word right after it (`mapTestsChips` → `mapEvidenceChip`: the
fold's `evidenceWord`, *not built* on `sharedEvidence` — the Portfolio's word for the same fold) on the cover, the
head, each screen card (`MapScreen.chips.evidence`) and the property's Overview (`tabs.overview.evidence`). The cover
also prints `reaches the ERP · <system>` (Portfolio's rule over `summary.systems`, else *ERP hand-off declared, not
built*) and `owner · <name>` from the manifest. Head order: screens, reached, built, tests + evidence, ERP, owner,
then actions, gates, stores, declared-not-called — wrapping as the head needs. Since the clarity pass the board's
card prints only the status chip and its two marks; the evidence word and *stale* stay one chip in the head.
e2e: `e2e/tests/map-numbers.pw.spec.ts`.

**The hero.** A design image (`designThumbHtml(node, 'mp-shot')`, the lightbox on click) sized to the stage, kept in
the code lens too. A screen with no image declared gets the placeholder with `journey.absent.notIndexed`; a
declared image that does not resolve (a Figma frame with no token — Discard draft in the fixture) swaps to the
same placeholder with `design.noImage`. The placeholder: the design glyph, the screen's name, its route (not in
business), its sentence, *designed, not built* when it is, the parts found (or *no components found*), the design
link. No paste or upload control is drawn (proposal §9).

**A real screen (2026-10-03, second pass).** The dogfood graph showed three things the fixture hid. *The picture is
whole*: each `.mp-frame` is a size container and the shot takes the image's own aspect (`--ar`, set from
`naturalWidth / naturalHeight` when it loads and remembered per screen) up to the frame's box, with
`object-fit: contain` — a 1:3 export is letterboxed, never cropped. *Free text is clamped*: `clampHtml(key, text)`
prints the first two sentences (at most about 280 characters) and a catalog *more* / *less* that opens the rest in
place — the Overview sentence, the placeholder's sentence, decisions, work findings and change sentences.
*Lists are capped*: `capRows(key, rows, counted, api)` shows `MAP_PROP_CAP` (10) rows and a *show all n* row; n is
the list's own `Counted` when it counts exactly those rows, else the rows on screen with a `plainTip`. The story
chips above the hero fold past three parts into *n stories on m parts* (n's tip is the per-part breakdown), and the
step bar's *also in* shows three journeys and *n more*. What the reader opened is kept per screen and forgotten on a
step. Under 860px the step bar puts *screen n of N* on its own row and the chips truncate.

**The lens.** The business register drops the route from the crumb and the placeholder, method + path, file
lines, test runners and levels, change kinds, work keys and ids; it names components and records with `bizName()`
and calls with `plainWords()`; the accent warms with the lens. Every row naming a call, record, gate, component,
test or decision carries `data-map-card="<kind>" data-id="<nodeId>"` for the map's explore card.

**e2e.** `e2e/tests/map-property.pw.spec.ts` deep-links through the map: the Invoice list hero and its counts, the
APIs rows by service, New invoice's case verified by declaration, Discard draft's placeholder, the step bar, and no
identifier-shaped word on any tab of any screen in the business lens.

#### Round 2 of the map pass (2026-10-04) — what the second swarm found

- **The current journey is the one the reader opened** (`MAP.journey`, `openedJourney()`): a click on a cover,
  Enter, a deep link, ⌘K, `h` / `l`, a snap, an open screen or an explore card. It holds the crumb, the ring, the
  link (`writeHash`), Fit, plumbing, the edge cues and the Affected ring until the reader leaves it — Esc, another
  journey, the board (level `nb`), or a pan that takes all of it off the stage (`journeyInView`), which leaves a
  **back to <journey>** chip (`.map-backto`) beside the hint. Only while nothing is open does the journey nearest the
  stage's middle stand in. Before: a fourteen-screen journey opened at its fitted floor had its middle off the stage
  and its neighbour took the crumb, `j` and the plumbing.
- **Plumbing** brings the open journey's head back to the top when the pathways grow; **`j` / `k`** slide across
  only. The open journey's **name rides the stage's edges** (`stickHead`: `--head-x` / `--head-y`), so a zoom at
  its far end still says whose screens these are.
- **Zoom**: hover tips hold while a wheel or drag is in flight and 300 ms after (`quietHoverTips` in
  `lib/tooltip.js`); a gesture that settles on the journey stop makes the least move that frames it
  (`settleJourney`) — `+` / `−` still frame it as it opens; a link with only `z` is honoured at that scale. The
  engine's `bounds()` option keeps at least 120 px of the board on the stage (`clampPan`, unit-tested).
- **The legend** (round 2 opened it by itself as a strip; since 2026-10-05 it stays closed until asked). Implied, declared-not-called
  and not built calls differ by stroke (solid · dashed · dotted and hatched) on the board and in the legend. While
  the Affected mode is on the legend lists its badges.
- **The Affected mode at board altitude**: Fit and the bar's **fit these** frame the reached districts
  (`fitAffected`); lit districts get a counter-scaled frame and a corner badge (`.map-affb.corner`), dimmed ones a
  dashed stroke; **list these** opens `.map-afflist` — per distance the journeys with owners, each screen once with
  its journeys, the owners, the tests, the floor line — with **copy as CSV / JSON** (`affectedRows` ·
  `affectedCsv` · `affectedJson`, `farsight-affected v0`, not frozen). The bar reads screens first, each page once
  (core `affectedReach` counts distinct pages), then *in N journeys*; a longer reach that finds nothing says
  *nothing more past N*. The property's head shows the seed and its counts, and its *What's affected* opens the tab.
  Every copy (the link, the rows) confirms with a toast by the tools (`.map-toast`, 2 s).
- **Scope words**: a screen's numbers say *on this journey*; the property's Tests heading is *Cases that run over this
  screen*; the tab's tests carry *within how far N*; a **risk headline** over the board counts journeys stale, not
  fully built and reaching the ERP (`riskCounteds`, docs/COUNTS.md). The call card names the handler's file and line.
- **The property's rail** (`data-tip-place="left"`) opens its tips to the left of the rail, never over its rows.
- **The code map grouped**: a folded group spanning projects is drawn once per project; parts are counted under their
  own kind; test files are file cards; card rows follow measured heights; the GROUP choices share one casing; the
  Views menu's headings stay in place.

e2e: `e2e/tests/map-round2.pw.spec.ts` (a twelve-journey board whose first journey is fourteen screens wide).

