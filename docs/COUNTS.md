# The counts ledger

> Every number Farsight prints, where it comes from, what it counts and what it counts over. Open it before you
> print a number, change one, or answer a reader who says two numbers disagree. Source of truth for the rule
> *"no number moves without evidence, and every number names what it counts and the scope it counts over"*.

**The rule.** One concept → one number everywhere. Two numbers → two names and a printed scope.

**How it is enforced.** The folds hand out each number as a `Counted` (`packages/core/src/counts.ts`), beside the
plain numeric field it always had. A `Counted` carries its words, its scope and the field it was read from, so a
surface never chooses them. `packages/core/test/counts.test.ts` pins the decisions below;
`countedProblems()` rejects a count whose keys are missing or undefined, whose scope is not in `COUNT_SCOPES`, or
whose breakdown does not sum to it. Lint RULE 5 covers every `count.*` key, so a scope or a part can be printed
in the business lens.

Measured on the reference app's graph (its `graph.json`, sync 64, source `0a88031`) and the dogfood graph (sync 45),
2026-09-25, against the core on branch `fix/counts-ledger`. The journey used throughout is the reference app's
**POC — vendor invoice, end to end** (`example-app::flow::poc-vendor-invoice`).

---

## 1. The `Counted` contract — how a surface wires it

```ts
interface CountPart { key: string; n: number; label?: string }   // key: catalog key with {n}; label: a name out of the graph
interface Counted {
  n: number;
  of?: number;         // "6 of 11": the unit prints {m}
  unit: string;        // catalog key the hybrid and code lenses print, with {n} (and {m}); its define = WHAT IT COUNTS
  bizUnit?: string;    // key the business lens prints. ABSENT = the business lens does not print this number
  scope: string;       // one of COUNT_SCOPES; its words + define = WHAT IT COUNTS OVER
  source: string;      // the core function and field it came from, e.g. "journeySummary().counts.called"
  breakdown?: CountPart[];   // a partition: the parts always sum to n
}
```

**Scopes** (`COUNT_SCOPES`, closed): `journey.scopeAll` *across this journey* · `journey.scopeHere` *on this
screen* · `count.scope.action` *in this action* · `count.scope.node` *for this part alone* · `count.scope.source`
*in this source* · `count.scope.selection` *in the sources and level selected* · `count.scope.workspace` *across
every source in scope* · `count.scope.component` *this component's own* · `count.scope.parts` *on the parts it
renders* · `count.scope.storybook` *in this Storybook* · `count.scope.workSource` *in this work source* ·
`count.scope.workSources` *across the work sources listed* · `count.scope.workSync` *in this sync* ·
`count.scope.workItem` *on this item* (the four work scopes joined 2026-09-30 with `packages/work`).

**Printing it** (what `numberTip()` needs, nothing more):

```js
const key = lens === 'business' ? c.bizUnit : c.unit;            // no bizUnit in business → do not print the number
const one = c.n === 1 && STRINGS[key + 'One'] ? key + 'One' : key;  // core: countKey(key, n)
const words = t(one).replace('{n}', c.n).replace('{m}', c.of);    // "13 actions"
// the tip: what it counts · the scope · the split · where it came from
tip = [def(c.unit), t(c.scope) + ' — ' + def(c.scope),
       (c.breakdown || []).map((p) => (p.label ? p.label + ' · ' : '') + t(p.n === 1 && STRINGS[p.key + 'One'] ? p.key + 'One' : p.key).replace('{n}', p.n)).join(' · '),
       c.source /* code lens */];
```

The CLI and MCP use the core's own printers: `countedText(c, { lens })` → `13 actions across this journey`;
`countedLine([...], { lens })` → `across this journey: 11 screens · 34 gates & rules (25 gates · 9 validation
rules) · …` (the scope said once per run of counts that share it); `breakdownText(c)`.

**Where the typed counts are** (all additive — every existing field is unchanged):

| endpoint / fold | typed counts |
|---|---|
| `GET /api/journey?entry=` · `journeySummary()` | `summary.counted.{screens, screensReached, built, steps, planned, gates, checks, decisions, notInWords, inWords, actions, again, declaredNotCalled, actionStops, systems, setup, deferred, repeats, cutPoints, choices}` |
| | `summary.segments[i].counted.{actionStops, actions, gates, checks, decisions, notInWords, inWords}` (scope *on this screen*) |
| | `summary.coverage.journey` and `summary.coverage.segments[i]`: `.counted.{tests, e2e, unit, integration, observed, runReports}`, `.observation`, `.evidenceWord.{cls, key, biz}` |
| | `summary.coverage.moments[i][k]` — **new**, one slim entry per action (`segments[i].moments[k]`): `{chip, observedBy?, evidenceWord, counted, observation?, run?}`, scope *in this action* |
| | `steps[n].coverage` (a node): `.chip`, `.evidenceWord`, and when a test reaches it `.counted`, `.observation` (scope *for this part alone*) |
| `GET /api/tests[?scope=&level=]` · `testsSurface(index, scope, meta, { level })` | `counted.{cases, files, sources, reached}` (scope *in the sources and level selected*, or *across every source in scope* unfiltered); `counts` now follows `?level=`; `countsAll` = the unfiltered counts, present only under a level; `level` |
| | `sources[].runs.{passed, failed, skipped, flaky, unknown, noRun}` (sums to `cases`) and `sources[].counted.{cases, files}` (scope *in this source*; cases broken down by verdict) |
| | `sources[].counted.passedByDeclaration` (e2e cards with a passed case, scope *in this source*): `runs.passed`, broken down by what each passed case declares (§2 #13) · `sources[].lastRun.changedBy` · `counts.declaredPassed` (covers edges) |
| | `journeys[].coverage` and `?flow=` → `coverage`: the same `counted` / `observation` as the journey fold |
| `GET /api/tests?node=` · `stepCoverage()` | `coverage.{chip, evidenceWord, counted, observation}` |
| `GET /api/stories?node=` · `storyCounts(index, id, byNode)` | `counts.{own, docs, parts}` + `parts: [node ids]` (the chips to draw, in order) |
| `GET /api/stories` · `storybookLive()` | `storybooks[].counted.matched` (n of entries, breakdown stories · docs pages) |
| `coverage.evidenceWord(chip, observedBy)` | now also returns `biz` — the `journey.biz.testsRun.*` sentence for the business foot; `observedBy: 'declaration'` → `tests.evidence.declaredPassed(Stale)` (§2 #13) |
| every coverage fold (`coverage.counted`) | `.e2e` / `.unit` / `.integration` breakdowns gain a fourth part **only when non-zero**, `count.part.declaredPassed`; `.observed` gains a breakdown `count.part.observed` · `count.part.declaredPassed`; `counts.tests.declaredPassed`; `observation.{by: 'declaration', declared, changedBy}`; `run.changedBy` |

---

## 2. The contradictions the 2026-09-25 swarm met, and the decision each got

| # | printed, and where | measured on the reference app | what each counts | decision |
|---|---|---|---|---|
| 1 | `13 actions` / `13 things the user can do` (header) vs `ACTION 1 OF 31 IN THIS JOURNEY` (Drill) vs `13 called · 14 declared, not called` (Portfolio) | called 13 · again 2 · declared-not-called 14 · drill columns 31 = **15** calls the code makes (13 + 2 again) + **14** calls only declared (planned continuations) + **2** screens with nothing to call | header & Portfolio: distinct operations code calls (`counts.called`); Drill: every moment on the rail (`segments[].moments`), occurrences | **Two concepts → two names.** `counted.actions` (13, *actions*) and `counted.actionStops` (31, **stops**, breakdown 15 · 14 · 2). `journey.drill.actionOf` now reads *stop {n} of {t} on this journey*. Pinned: `stopsCalled = actions + again` (holds on all 10 the reference app's flows). Same on a page entry: *Invoice submittal (OCR confirm)* is 9 actions, 10 stops — the storyboard card's *actions 1–10* is stops |
| 2 | `118 checks in the code were not written in plain language` (business) vs `90 technical conditions not translated` (hybrid/code); per screen 8 vs 5, 3 vs 2 | technical 90 + conditions on a gate nobody labelled 28 = 118; screen 2: 5 + 3 = 8 | business folded the 28 guard-class decisions in; hybrid drew them as decisions and left them out | **One concept → one number.** `counted.notInWords` = 118 in every register (unit *conditions not in plain language*, biz *conditions in the code were not written in plain language*), breakdown `journey.untranslated` 90 · `count.part.gateConditions` 28. Segments partition it (Σ = 118). Business sentence no longer says *checks* (that is the header's word for meetings of a gate) and has a singular |
| 3 | `34 gates` (header) vs `GATES & RULES 34` (lane tab) | 25 gates + 9 validation rules, distinct by name | the same number, always gates **and** rules | **One concept, one name.** `journey.countGates` now reads *{n} gates & rules* (singular *1 gate or rule*); `counted.gates` breaks down 25 · 9 |
| 4 | `146 checks` beside `118 checks … not in plain language` | 146 = meetings of the 34 gates & rules; 118 = conditions | two concepts sharing one word | the condition sentence says *conditions*; *checks* is only the meetings |
| 5 | e2e `80` (Portfolio) vs `91 cases` (Tests) vs `13 e2e` (screen 1) | 80 = distinct e2e cases reaching the POC journey scope (39 declared only · 41 reached · **0 seen in a run**); 91 = every e2e case in the reference app's e2e source (15 files, **91 with no run recorded**); 13 = e2e cases reaching screen 1, all 13 declared only | three scopes | **Three numbers, three printed scopes.** `coverage.journey.counted.e2e` (*across this journey*), `coverage.segments[i].counted.e2e` (*on this screen*), `sources[].counted.cases` (*in this source*). Every level count breaks down by the three evidence classes, so `80 e2e` travels with `0 seen in a run` |
| 6 | `VERIFIED · STALE` above `0 observed · LAST RUN skipped/unknown`; business *"A run reached this code"*; Tests: *no reference-app e2e run observed* | the chip came from 13 **coverage reports** of 2026-09-22 (status unknown, digest changed); the run line from the covering **cases'** 2026-09-25 results (633 unit passed, 6 integration skipped, no digest) | *verified* was printed for a run-level coverage report | ***Verified* has one meaning: a results report named a test case that ran over this code.** A coverage report alone is *seen by a coverage run* (`tests.evidence.runSeen`) and, stale, **`tests.evidence.runSeenStale` *seen by a coverage run · stale*** — never *verified*. `evidenceWord.biz` gives the business sentence (`journey.biz.testsRun.runOnlyStale`: *A coverage run reached this code before its latest change, and it does not say which test did*). New `coverage.observation` = the run that earned the word (`by: runs, 13 reports, 2026-09-22, unknown, changed`); `run` / `lastRun` stay, and are *the covering tests' own last run*. The three evidence classes are unchanged — no fourth |
| 7 | `IN WORDS · 0` above visible words | the tab draws 11 lines (each screen's sentence) and 0 decisions in words | the count was decisions of class *business* only | **The count is what the tab draws.** `counted.inWords` = 11 (11 screens described in words · 0 named only · 0 decisions in words), per screen too |
| 8 | Tests, E2E filter: header `5825 · 0 unit · 0 integration · 368 e2e / 431 spec files in 4 sources` | dogfood: all levels 5825 cases / 431 files / 10 cards over 4 repos; e2e 368 / **45** files / 4 repos; scope=farsight + e2e: 37 cases, **37 passed** | `counts` ignored `?level=`; `sources` counted cards, printed as *sources* | **The API returns the header for the filtered set.** `testsSurface(…, { level })`: `counts` follows the level, `countsAll` keeps the rest, `counted.sources` counts repos. Cards carry `runs` (the missing *did it pass*) |
| 9 | Inspector: `STORIES · NONE INDEXED — No story renders this component` then twelve chips; `STORIES · 3` over four tabs | Submit-confirmed page: own 0, parts 21 (5 parts); Reassurance strip: 3 stories + 1 docs page | own stories vs the parts' stories; stories vs docs pages | **Three numbers, three names.** `storyCounts()`: `own` (*this component's own*), `docs` (*docs pages*, tabs not stories), `parts` (*on the parts it renders*, broken down by part) |
| 10 | Portfolio catalogue `379 of 379 listed stories matched` | 320 stories + 59 docs pages | entries, called stories | `stories.catalogue.matched` reads *stories and docs pages*; `storybooks[].counted.matched` breaks it down |
| 11 | `6 of 11 built` (hybrid) vs `6 built` (business) | same number | one concept, two forms | `counted.built` carries `of`; `journey.biz.countBuilt` is *{n} of {m} built* |
| 12 | `1 checks …`, `1 screens · 1 things the user can do`, `1 sources` | — | plurals built by `.replace('{n}')` | every new unit has a `…One`; `journey.biz.untranslatedOne`, `journey.biz.countScreensOne`, `journey.biz.countActionsOne`, `count.unit.sourcesOne` exist. The viewer prints through `countKey()` |

**The story swarm (2026-09-25, `the 2026-09-25 story-swarm review`) met two more; decided on `fix/e2e-evidence-agrees`, 2026-09-27, measured on the reference app's sync 71 (source `4bd6244`).**

| # | printed, and where | measured on the reference app | what each counts | decision |
|---|---|---|---|---|
| 13 | Tests card `example-app · e2e … 89 passed` vs every Portfolio row, the journey header's tests tip and every matrix row `0 seen in a run` (8 of 8 reviewers) | the e2e source: 91 cases, `runs` 89 passed · 2 no run; 324 declared covers edges, **320** of them from a case that passed; 0 observed edges. POC flow before: `80 e2e (39 declared only · 41 reached by tests · 0 seen in a run)`, word *seen by a coverage run · stale* (13 coverage reports) | the card: cases by their report's verdict; the flow: cases by evidence class — and the fold credited an e2e case as observed **only through coverage data**, which a Playwright run never produces | **The ledger's one meaning of *verified* applies to a declaration.** A declared e2e case whose results-report verdict is `passed` is observed **for what it declares** (`testsCovering()` → `observedVia: 'declaration'`; `observedBy: 'declaration'`; word `tests.evidence.declaredPassed` *passed, by its own declaration*). Failed, flaky, skipped, unrun and inactive cases stay declared. The class set stays three: it is a way of earning *observed*, never a fourth class; the frozen matrix rows keep the edge's stored class (`declared`) beside its `status: passed`. POC after: `80 e2e (0 declared only · 5 reached by tests · 0 seen in a run · 75 passed, by their own declaration)`, word *passed, by its own declaration*. Where the numbers still differ the card says why: `89 passed in the report: 89 declare something this workspace knows · 0 declare only what nothing here matches · 0 declare nothing` (`sources[].counted.passedByDeclaration`); a flow counts only the cases whose declaration lands in its scope (*across this journey*). A pass by declaration measures no line, so it never makes the metric exact |
| 14 | Tests freshness *the code changed after this run* beside a Changes spine at `0a88031` for 27 syncs (3 reviewers) | 14 coverage reports stamped 2026-09-22 (`digest-changed`); HEAD then `0a88031`, committed 2026-09-20 — so the files differed from HEAD (uncommitted config edits), not by a commit. Today HEAD is `4bd6244` (committed 2026-09-25), so the same reports now read *commit* | the report's recorded content digest against the source's; the spine: the commit each sync recorded | **Say what moved.** `TestRun.changedBy` (`commit` · `working-tree`), from the stamp's new `farsight.commit` when it has one, else HEAD's commit time against the run's (a HEAD committed before the run was already checked out). `working-tree` prints `tests.freshness.changedTree` *working tree differs from HEAD* on every Tests card, run chip and report row, the journey evidence tip, MCP `test_coverage` and `farsight tests list`/`import`. The snapshot store now records each source's content digest (`snapshot_source.source_digest`), and a sync on the same commit whose digest moved is a spine row of its own, note `tree-changed` *same commit — the working tree differs from HEAD*, not *re-indexed … no new commits*. Syncs from before this column cannot tell the two apart and say nothing new |

---

## 3. The ledger — every number, by surface

Columns: **printed** (the reference app's POC unless noted) · **source** (core fold → field; `C:` = the typed count) · **counts**
· **scope** · **siblings** (what looks like the same concept, and why it is or is not).

### Journey header — hybrid / code (`jrnHeaderHtml`)

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| `11 screens` | `summary.counts.screens` · C:`counted.screens` | screens the journey runs through (a screen met twice is one) | journey | business `11 screens`: same number |
| `6 of 11 built` | viewer rule over `summary.user` · C:`counted.built` (`of`) | screens whose design reconciled to code (else: a source location) | journey | Journeys list `11 built` = the **manifest's** 18 screens, not this flow's; business `6 built` = same number (now same form) |
| `943 steps` (code) | `counts.steps` · C:`counted.steps` (no `bizUnit`) | walk nodes, re-visits included, planned excluded | journey | never printed in business |
| `30 planned` | `counts.planned` · C:`counted.planned` | walk steps from the contract, not code | journey | not the 14 *declared, not called* (operations) nor the 14 declared stops (moments) |
| `34 gates` → **`34 gates & rules`** | `counts.gates` · C:`counted.gates` | distinct guards + rules by name (25 · 9) | journey | lane tab *Gates & rules 34*: same number |
| `146 checks` | `counts.checks` · C:`counted.checks` | meetings of those 34 (Σ per-screen counts) | journey | not the 118 conditions |
| `28 decisions` | `counts.decisions` · C:`counted.decisions` | decisions drawn in hybrid/code: 0 in words + 28 gate conditions nobody labelled | journey | lane tab *Decisions 28*: same; the 28 are also a part of `notInWords` (same population, same key) |
| `1 start-up` · `6 afterwards` | `counts.setup` / `counts.deferred` · C:`counted.setup` / `.deferred` | boot steps named once; deferred work registered here | journey | — |
| `7 systems` | `summary.systems.length` · C:`counted.systems` | system rows of the band | journey | business prints their names (*touches …*) |
| `90 technical conditions not translated` → **`118 conditions not in plain language`** | `business.untranslated.count` + `.guardsUnlabelled` · C:`counted.notInWords` | see §2 #2 | journey | business: same number |
| `2 places where one of several runs` | `counts.choices` · C:`counted.choices` | call sites with several implementations | journey | — |
| `357 repeats` (code) | `counts.repeats` · C:`counted.repeats` | walk re-visits not re-walked | journey | not `again` (calls made again: 2) |
| `311 forks` chip | `forkCount` (walk) | branch points met by the walk | journey | not decisions (28) nor conditions (118): the forks drawer's list, every class |
| `13 actions` | `counts.called` · C:`counted.actions` | distinct operations code calls | journey | Drill `31` = stops (§2 #1); Portfolio `13 called`: same |
| `2 of them run again later` | `counts.again` · C:`counted.again` | those calls made again on a later screen | journey | `actions + again = 15` = the stops' *calls the code makes* |
| `14 declared, not called` | `counts.declaredNotCalled` · C:`counted.declaredNotCalled` | operations only the contract/design names, once each | journey | the 14 *calls only declared* stops happen to be 14 too on this flow; they count occurrences |
| `seen by a coverage run · stale` (was `verified · stale`) | `coverage.journey.evidenceWord` | the evidence class and its attribution | journey | §2 #6 |
| `e2e reached` | `coverage.journey.e2e` | the strongest e2e rung | journey | not a run |

### Journey header — business (`journey.biz.header` + clauses)

`11 screens · 6 built · 13 things the user can do · touches …` then `2 of them run again later`, `14 declared, not
called`, the evidence word, `118 checks … not written in plain language`. Same sources as above; the viewer lane
should print `counted.{screens, built, actions}` with their `bizUnit` (fixes `6 built` → `6 of 11 built` and
`1 screens · 1 things`) and `counted.notInWords` with `journey.biz.untranslated(One)`.

### The business lane (tabs, per-screen headings)

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| `IN WORDS 0` → **`11`** | viewer `jrnBizCounts().words` → C:`counted.inWords` | lines the view draws | journey | per screen C:`segments[i].counted.inWords` |
| `GATES & RULES 34` | `counts.gates` | = header | journey | per-screen list heading: `segments[i].counted.gates` (*on this screen*; a gate met on 3 screens counts on each) |
| `DECISIONS 28` | `counts.decisions` | = header | journey | per screen `segments[i].counted.decisions` |
| `8 conditions … not in plain language` (screen 2) | viewer `sg.untranslated + unlabelled` (lens-dependent) → C:`segments[i].counted.notInWords` | §2 #2 | screen | hybrid printed 5: now 8 in both |

### Timeline / Sheet / Storyboard / Drill

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| column head `1 call · 4 gates · 3 decisions · 3 repeats` | `segments[i].counts.{calls, gates, decisions, repeats}` | this screen's | screen | business prints `calls`/`repeats` (developer units) — viewer lane |
| tests foot `tests: 13 e2e · 22 unit · 0 integration · 0 observed` | `coverage.segments[i].counts.tests` · C:`coverage.segments[i].counted` | distinct cases reaching the screen, per level, any evidence class | screen | Portfolio's 80 is the journey's; Tests' 91 the source's |
| `LAST RUN skipped / unknown` | `coverage.segments[i].run` | weakest verdict over the covering cases' own runs | screen | **not** the run behind the chip: that is `observation` |
| business `Checked by tests — 35 tests reach this, 13 of them from end to end. A run reached this code…` | `counts.tests` + viewer `runKey` → `evidenceWord.biz` | cases (every level), e2e cases | screen | the run clause now comes from `evidenceWord.biz` |
| Sheet *Verified by* cell `IN THIS ACTION` + `tests: 3 e2e · 69 unit …` / business `Checked by tests — 72 tests reach this…` | `coverage.moments[i][k]` · C:`counted.tests` (scope `count.scope.action`) | every case reaching **any** step of the action | action — printed as the label above the counts (`jrnFootScopeHtml`, from the `Counted`'s own scope) | the step's own foot below; the viewer's copy of the evidence rule (`strings.js evidenceWord`) should go |
| step foot (drill inspector head, TESTS tab) `FOR THIS PART ALONE` + counts, or `no test reaches this step` | `steps[i].coverage` (`stepCoverage()`) · C:`counted.tests` (scope `count.scope.node`) | cases reaching this one node | node | **2026-09-27:** when it is `0` and the action's is not, the foot prints `journey.tests.widerScope` — *72 test cases reach the action it belongs to — none of them reaches this part itself* (`jrnStepActionFacts`, the action's `Counted` with its tip). The reference app's submit handler read *no test reaches this step* beside the action's *72* with neither scope named (story swarm finding 4). Impact's *1 tests reach them* is a third scope — the things that use this part, hop 1 — worded by `impact.js` (another lane) |
| Storyboard `Actions 1–9` / `1–10` | `segments[i].moments.length` | stops on the screen | screen | C:`segments[i].counted.actionStops`; `.actions` is the distinct ones |
| Drill `action 1 of 31` → **`stop 1 of 31 on this journey`** | `jrnDrillActions(sum).length` = Σ moments · C:`counted.actionStops` | §2 #1 | journey | — |
| absence word in an empty cell — `not involved` / `not reached` / `none indexed` (business: `takes no part in this` / `the walk did not get there` / `nothing of this kind was found here`) | `segments[i].absent.moments[mo][systemKey]`, `.kinds[mo][kind]`, `.screen[systemKey]`, `summary.absentKinds` — core `journeyAbsence()` | a word, not a number: one per (action, layer) fact | action · screen (ladder folds) · journey (drill's always-present rows) | **2026-09-27, one word per fact:** the reference app's submission flow printed *not involved* (Timeline) and *none indexed* (Sheet) on 43 of the 60 cells both draw. The rule now lives once in core `absenceWord()`: `none indexed` only for a kind the whole journey has none of; `not reached` when a cut inside the action sits on an earlier system; else `not involved`. Rows, sheet, ladder, drill lanes and storyboard ledger all print `jrnAbsentWord()` / `jrnAbsentKindWord()` |
| `n cut` / `n cut points` | `counts.cutPoints`, `segments[i].counts.cutPoints`, `marker.cut` | subtrees not followed (depth/steps) | journey / screen / marker | repeats counted apart |
| `n of m built` on linked journeys | `summary.links.*.{built, screens}` | the linked flow's screens with a source location | that flow | same rule as `counted.built` bar the design-status branch |

### Journeys list (`/api/design`)

`10 flows, 18 screens, 18 designed, 11 built, 7 not built, 0 not designed, 18 drift` — `designSurface().counts`,
scope **the manifest** (every screen it names). A flow's `6 of 11 built` is that flow's screens. No contradiction;
not yet typed. Every count on the Designs card carries a tip (`plainTip`, 2026-09-27): its define (the
`design.count.*` entry), the scope *across this design manifest* (`design.scope.manifest`), `/api/design · sync N`.
**Drift** is one per difference found over every screen **and flow** the manifest names, and a screen not built yet
is one of them — so it is not a defect count. Its tip splits it by kind (`screens[].drift[].kind` +
`flows[].drift[].kind`, words `design.drift.<kind>`), and the rows sum to it: the reference app's sync 71 `26 drift` = 15
*designed, not built* + 8 *operation never reached from this screen* + 3 *screen calls an operation the design does
not list*. A screen row's `⚠ n drift` has the same tip over that screen (`design.scope.screen`).

### Portfolio (`portfolio.js`, per row: `/api/design`, `/api/journey`, `/api/tests?flow=`)

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| `partly built · 6 of 11` | `/api/design` flow `built/total` | manifest-resolved screens | flow | header `6 of 11 built`: same |
| `13 called · 14 declared, not called` | `summary.counts.{called, declaredNotCalled}` | = header | journey | = header |
| `passed, by its own declaration` (was `seen by a coverage run · stale`) + `80 e2e · 354 unit · 5 integration` | `/api/tests?flow=` → `coverage.{evidenceWord, counts.tests}` · C:`coverage.counted.{e2e, unit, integration}` | distinct cases reaching the flow | journey | Tests card 91 = source; print the scope and the class split |
| `75 of the end-to-end tests passed, by their own declaration` (then `n … seen in a run` only when non-zero, or when nothing passed by declaration) | C:`coverage.counted.e2e` parts `count.part.declaredPassed` / `count.part.observed` | e2e cases reaching the flow, by how *observed* was earned | journey | Tests card `89 passed in the report` = the source's; §2 #13 |
| `Components on show · 379 of 379 …` | `storybooks[].counts.resolved` of stories+docs · C:`storybooks[].counted.matched` | index entries matched | one Storybook | §2 #10 |
| catalogue card `n stories` | viewer: live list filtered to `type: story` | the component's own stories | component | `storyCounts().own` |

### Inspector

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| `STORIES · 3` | viewer `list.filter(type story).length` · C:`/api/stories?node=` → `counts.own` | own stories | component | tabs = `own + docs` (4); `counts.docs` |
| `NONE INDEXED` + chips `Submission wizard · 12 stories` | `n.stories` of `screenStoryIds()` · C:`counts.parts` (+ `parts` ids) | the parts' stories | parts | must be labelled as the parts', not the node's |
| tests foot on a node | `steps[n].coverage` / `/api/tests?node=` | cases reaching this node | node | `StepCoverage.unit` counts **every non-e2e ref, integration cases and coverage reports included** — kept for compatibility, flagged here; `counted.unit` is the unit cases |

### APIs (`/api/apis` → `apiSurface().counts`)

`35 operations · 27 implemented · 8 not implemented · what differs 19` — scope one API (its spec + the code).
`consumers 25`, `gated 25`. The page says *these counts overlap* where they do. No contradiction found; not typed yet.

### Change impact (`/api/impact` → `impactOf()`; drawer, journey IMPACT tab, CLI `impact`, MCP `impact_of`)

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| `5 use it directly · 14 more reach it through those · 24 more at 3 hops` | `hops[i].found` | dependents first met at that distance | one distance | **never summed** — the report carries no total |
| hop head `14 · 8 function · 4 guard …` | `hops[i].found`, `hops[i].byKind` | the same, by kind | one distance | `nodes.length` is *listed*; a capped hop prints both |
| label *on what uses this part* (`impact.scope`) | — | names the panel's scope, printed first in every register | the parts that use this one, and their tests | the foot's *for this part alone* and the verified-by's *in this action* are other scopes |
| `tests reaching what uses it directly: 1 e2e` | `impactTestsReaching(report, 1)` · viewer `impTestsReaching` | distinct tests covering hop-1 nodes | hop 1 | — |
| `tests reaching hops 1–N, each test once: …` | `impactTestsReaching(report, N)` (core; the viewer's copy is tested against it) | **the union** of tests covering anything listed at hops 1..N, each once | hops 1..N | used to print only the tests *new* at hop N under a *so far* label (the reference app's submit `POST` at 4 hops: 1 · 8 · 42 · 22 printed, union 1 · 9 · 51 · 73) — fixed 2026-09-27 |
| business `1 thing uses … in 1 action across 1 of 10 journeys` | `hops[0].found`, `flows` of hop-1 nodes | direct users, distinct actions, flows | hop 1 | each part has its singular (`impact.biz.*One`) |
| *not walked* `n more one hop further out, behind k stops` | a second `impactOf` at `hops + 1` | the next ring, as a set | the next distance | cut points' `behind` overlap and are never added |

### Changes (`/api/changes`, `/api/history` → `history.ts`)

The **sync status line** a source carries in Settings (`settings.sources[].status`, written by `POST /api/sync`) says
`history N commits indexed · k new this sync` — N is `SnapshotDb.commitCount(repo)`, the same rows the Changes notes
count over (*242 of 282 never ingested*: 282 is N), k what this sync's incremental read added. Until 2026-10-05 it
said `history 0 commits read` (k alone) beside a Changes page of 282 commits (swarm 2026-10-05, four roles).

`51 of 66 commits were never ingested by any sync` (`spine.unindexed` of `spine.commits`, scope: the commit range
read), `n files touched`, `n renamed`, `n of them byte-identical`, `n shown of t` (`chrome.shownOf`, the table's
fold). Not typed yet. A spine row on the same commit as the sync before it whose recorded content digest differs
reads `tree-changed` (*same commit — the working tree differs from HEAD*) and is never folded into a run of
re-indexes; the notes' `n re-indexed on a newer build` adds `(k of them read a working tree that differs from HEAD)`
(§2 #14).

`GET /api/history/touching?repo=&nodes=` (the Map's Changes tab) answers the commits that changed a set of parts with
`counted.commits` — scope *on this screen*, split by how each was matched (lines · file) — and `read`, the commits the
history holds for the repository (see `### Map`, Property).

### Tests (`/api/tests`)

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| strip `5825 cases · 431 spec files · 10 journeys · 10 sources` (dogfood) | `counts.cases/files`, `journeys.length`, **`sources.length`** | cases, files, flows; *sources* was **source × level cards** (10 cards, 4 repos) | selection | C:`counted.{cases, files, sources}` — `sources` counts repos |
| KPI *Tests indexed* `5825 · 0 unit · 0 integration · 368 e2e` under E2E | `counts.cases` (unfiltered) over card sums (filtered) | §2 #8 | selection | now both follow the level |
| KPI `… spec files in 4 sources` | `counts.files` + `sources.length` | as above | selection | C:`counted.files`, `counted.sources` |
| KPI *Reached by tests* `≥ 49%` | `metric` | coverable nodes any test reaches | selection | under a level, C:`counted.reached` is that level's part (`metric.parts[level]`): e2e reaches 38 of 791 on the reference app |
| KPI *Journeys with e2e* `9 · reached 9 · observed 0 · declared 0 · none 1` (the reference app) | `journeys[].e2e` tallied in the viewer | flows by e2e rung | selection | — |
| card `example-app · e2e · 15 spec files · 91 cases` | `sources[]` · C:`sources[].counted.cases` | cases in one source at one level | source | now with verdicts: `91 with no run recorded`; farsight e2e `37 passed` |
| card `89 passed in the report · 89 declare something this workspace knows` (e2e only) | C:`sources[].counted.passedByDeclaration` | passed cases by what they declare (known · only unmatched · nothing) | source | a flow's `n passed, by their own declaration` counts the part of *declare something known* that lands in its scope (§2 #13) |
| card freshness sentence | `sources[].fresh` (core `freshness.ts` `freshnessFact()`) → `fresh.sentence.*`; `sources[].freshness` is the same answer as one line | the card's cases' own runs, one state: *current as of sync N* · *stale — ran on commit X; the code is at Y* · *no source digest* + the stamp recipe | source | **one card per source × level × runner** since 2026-10-05 (an e2e level of Playwright runs was badged VITEST by 21 vitest specs under `e2e/`, and said *no source digest* and *changed since the run* at once); a run-level report joins its runner's card or its level's biggest; the card's blind spots are its level's minus the freshness findings of results reports whose runs sit on another card; `counts.sources` counts these cards |
| KPI *Last runs* per level | each card's `fresh` | one date + one freshness word per card | source × level | a level with two runners prints both, the runner named (code lenses) |
| matrix *Observed* `0 tests · 75 passed, by their own declaration · 13 run reports` | `coverage.counts.tests.{observed, declaredPassed, runLevel}` | observed cases split by how, and reports | journey | `tests.observedSplitDecl`; `tests.observedSplit` when nothing passed by declaration |
| suites row `3 passed · date · digest matches` | `suites[].counts` | one spec file's cases by verdict | file | — |
| *Orphans · n* | `counts.orphans` | tests covering nothing + unresolved claims | selection | follows the level now |
| blind spots `6 kinds · 38 findings` | `gaps[]` folded in the viewer | recorded gaps | selection | — |

### Chrome

`122 shown of 1678` (`chrome.shownOf`, `graph-render.js`: the Code map's filtered node count over the scoped
graph), `sync 64` (`meta.sync`), `type to search n nodes…` (`palette.hint`: every node loaded), `synced: n
nodes, e edges` (settings, the last sync's totals). Not contradictory; not typed.

**Tag chips** (`buildChips()` in `shell.js`): `test · 1439` counts the **nodes tagged** `test` in scope, and every
test node is tagged — the cases *and* the run-level coverage reports (`test.runLevel`). The Tests page's
*tests indexed* `1429` counts **cases** (`counts.cases`, coverage reports apart). On the reference app the 10 between
them are its 10 coverage reports. Both now say their unit: the chip's tip splits it `1429 test cases · 10 coverage
reports` (only when every tagged node is a test, so the split adds up), and the *tests indexed* define says a report
is not a case (lane N, 2026-10-03).

### MCP and CLI

| tool / command | prints | from |
|---|---|---|
| MCP `journey` header | `across this journey: 11 screens · 6 of 11 built · 34 gates & rules (25 gates · 9 validation rules) · 146 checks · 28 decisions · 118 conditions not in plain language (90 technical conditions not translated · 28 gate conditions nobody labelled) · 13 actions · 2 of them run again later · 14 declared, not called · 31 stops (15 calls the code makes · 14 calls only declared · 2 screens with nothing to call) · 15 record(s) · 0 message(s)` | `countedLine(summary.counted…)`; under `view:"business"` the business words (*118 conditions in the code were not written in plain language*, *13 things the user can do*) |
| MCP `journey view:"business"` per screen | `n conditions in the code were not written in plain language (…)` | `segments[i].counted.notInWords` |
| MCP `test_coverage flow:` | `tests: across this journey: 439 test cases (354 unit · 5 integration · 80 e2e) · 75 observed · 13 coverage reports` (the `75 observed` tip/`raw` breakdown: 0 seen in a run · 75 passed, by their own declaration) · `e2e: 80 e2e across this journey (0 declared only · 5 reached by tests · 0 seen in a run · 75 passed, by their own declaration)` · `observed by: 75 end-to-end case(s) a results report says passed, by their own declaration (@covers) …` · `the covering tests' own last run: …` (a `changed` run on its own commit: *the working tree differs from HEAD*) | `coverage.counted`, `coverage.observation`, `coverage.run` |
| MCP `test_coverage` (catalogue), `graph_overview` tests line | cases/files/sources with scope; each source with its verdict split | `testsSurface(…, { level })`; `level:` now filters the header too |
| MCP evidence per test | a run-level report reads *seen by a coverage run*, a named case *verified by a run*, a declared e2e case that passed *passed, by its own declaration* | `test_coverage` `evWord` |
| `farsight tests list [--level]` | header with scope, filtered by `--level`, and `covers edge(s): declared 324 (320 by an end-to-end case that passed — observed, by its own declaration) · …`; each source with its verdict split; an e2e source adds `89 passed in the report: …` | same fold; `counts.declaredPassed`, `sources[].counted.passedByDeclaration` |
| `farsight stories --node <id>` | `this component's own: n stories · n docs pages — on the parts it renders: n stories on its parts (…)` | `storyCounts()`; `--json` adds `counts` + `parts` |

### Work items (`packages/work` `words.ts`; CLI `farsight work`)

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| items | `count.unit.workItems` *n work items* (both) | `count.scope.workSource` when one source is listed, else `count.scope.workSources` | `workItemsCounted()` over `WorkCache.listItems()` | every cached item not deleted by the tracker, once; breakdown by the tracker's own state category (`count.part.workTodo · workInProgress · workDone · workRemoved`) — a partition |
| sent | `count.unit.workPulled` *n items the tracker sent* (both) | `count.scope.workSync` | `syncCounted(SyncReport).pulled` | distinct items on the pages one sync received, changed or not |
| changed | `count.unit.workChanged` *n items changed* (both) | `count.scope.workSync` | `syncCounted().changed` | items whose cached record differs after the sync (a new `item_rev` interval), new ones included |
| gone | `count.unit.workGone` *n items gone from the tracker* (both) | `count.scope.workSync` | `syncCounted().gone` | items the tracker reported deleted that the cache still listed |
| comments | `count.unit.workComments` (both) | `count.scope.workItem` | `itemCounted().comments` | `WorkItem.comments` as last synced |
| field changes | `count.unit.workChanges` (hybrid/code only) | `count.scope.workItem` | `itemCounted().changes` | `WorkItem.history` entries |
| writes waiting for a person | `count.unit.workQueued` (both) | `count.scope.workSource` | `outboxCounted().queued` over `WorkCache.listOutbox()` | outbox intents in `queued` — asked for, held for a person's confirmation, never sent |
| writes in conflict | `count.unit.workConflicts` (both) | `count.scope.workSource` | `outboxCounted().conflicts` | outbox intents in `conflict` — not sent because the item moved on the tracker |
| links to the graph | `count.unit.workLinks` (both) | `count.scope.workItem` | `itemCounted().links` over `WorkCache.linksFor()` | work ↔ graph links with provenance; work ↔ work links (`WorkItem.links`) are listed, not counted |

**MCP (`packages/mcp/src/work.ts`).** `work_sync` prints what `farsight work sync` prints, per source. `work_items`
prints the items line (scope *in this work source* / *across the work sources listed*, then the filters in words)
and per row *n links to the graph · n commits* (`countedText` without scope; *commits not indexed* when the spine
cannot say). `work_item` prints *on this item: n comments*, *n field changes*, *n links to the graph* — the links
count here is **graph `tracks` edges out of the work node plus `WorkCache.linksFor`, one per node** (the CLI's
`work show` counts the cache's links alone) — and, when the build's catalog has `work.count.commits` /
`work.count.touched`, *on this item: n commits · n nodes touched* (distinct commits naming the key on the spine;
distinct graph nodes their hunks touched, recorded or computed now with `nodesInHunks`). `work_links` prints the
items tracking a node *for this part alone* (`count.scope.node`) or a flow and its screens *across this journey*
(`journey.scopeAll`), each with the state-category partition. `work_changes` prints, per commit, the touched nodes
by kind and **impact per hop**: each dependent once at its nearest hop over every touched node, hop by hop, never
summed, *a floor* when any seed's report was — a plain number per hop, not yet a `Counted` (no unit for
*dependents at hop n* exists in the catalog; see §4). `graph_overview` prints the items line per source.

`farsight work sync` prints *in this sync: sent · changed · gone* and *in this work source: n work items (…)*;
`work status` per source *in this work source: n work items (…) · n writes waiting for a person · n writes in conflict*;
`work list` the items line; `work show` *on this item: comments · field changes · links to the graph*; `work links`
the links count. Freshness is a sentence, never a number: *synced 3 minutes ago* · *source unreachable since …
— showing the cache* · *credential expired — showing the cache* · *never synced* (`freshnessText()`).

### Work items in the graph (`/api/work*`; core `work-graph.ts`, server `work.ts`)

The item counts and their state parts are the same Counted as `farsight work` (`count.unit.workItems`,
`count.part.work*`): one concept, one number. What the graph side adds is how an item reaches the code.

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| items (`/api/work`) | `count.unit.workItems` (both) | `count.scope.workSources` | `itemsByState()` over the filtered `WorkCache.listItems()` of the configured sources | the items the filter lets through, each once; breakdown by state category — a partition |
| items per source card | `count.unit.workItems` (both) | `count.scope.workSource` | `itemsByState()` in `sourceCard()` | every cached item of that source, unfiltered |
| sources (`/api/work`) | `work.count.sources` *n tracker sources* (both) | `count.scope.workspace` | settings `sources[type=work]`, enabled | configured work sources, whether or not they synced |
| items on a node (`/api/work/links`) | `count.unit.workItems` (both) | `count.scope.node` | `itemsByState()` over items with a `tracks` edge into the node | items tracking this one node — not its callers, not its file |
| items on a flow (`/api/work/flow/<id>`) | `count.unit.workItems` (both); `byState` the same number | `journey.scopeAll` | `itemsByState()` over items tracking the flow node or a screen it `renders` | each item once however many of the flow's screens it tracks; a commit link to code under a screen does not count here (that is the journey's code, not the flow's declaration) |
| links (ItemSummary) | `count.unit.workLinks` (both) | `count.scope.workItem` | `itemSummaryOf()` over `strongestLinks()` of the graph's `tracks` edges | nodes this item tracks, each once (the strongest link per node); breakdown by how it is known: `work.count.via.declared · commit · branch · url` — a partition |
| commits (ItemSummary, item detail) | `work.count.commits` *n commits name it* (both) | `count.scope.workItem` | `SnapshotDb.keyCommitCounts()` over `commit_key` | distinct (repo, sha) naming the key by subject, body, branch, merge or tracker URL — only commits the spine read (a sync reads at most 500 per repository) |
| touched (item detail) | `work.count.touched` *n parts its commits changed* (both) | `count.scope.workItem` | `touchedCount()` over `commit_node` | distinct nodes the naming commits' hunks changed, credited to the definition a changed line starts in or sits under (the graph has no end lines, so the nearest definition above the hunk); breakdown by node kind (`work.count.touchedKind`, labelled parts) — a partition. File-granular (all nodes of the file) only when no hunk could be read; each commit says `resolved: hunk | file` |

The two findings (`work.finding.doneNotBuilt`, `work.finding.todoButCommitted[One]`) carry their number inside
the sentence (*INV-5 is to do; 1 commit names it*) — the same `commits` number above, never a second count.

### WORK surface and work chips (`surfaces/work.js`, `work-chips.js`)

The HUD prints the Counted of the table above as it arrives — `countedHtml()`, the tip being the count's own define,
scope, endpoint and breakdown — and computes none of its own: a filter asks `/api/work` again, so the counts follow it.

| number | printed as | where |
|---|---|---|
| items, sources (`/api/work`) | `count.unit.workItems` · `work.count.sources` | the strip's counts line |
| items per source card | `count.unit.workItems` with its state breakdown | each source card |
| links, commits (ItemSummary) | the bare number with its Counted tip; the business lens heads the column *code changes* (`work.hud.col.commitsBiz`) | the list's LINKED and COMMITS cells |
| touched (item detail) | `work.count.touched` with its by-kind breakdown | *What this work changed* heading on the item pane |
| items on a flow | `count.unit.workItems`, then the breakdown's own part words (*1 in progress · 2 done*) — they add up to it | the chip on a Portfolio row and in the journey header; not drawn at 0 |
| items on a node | the bare number with its Counted tip | the inspector's *Tracked work* heading; not drawn at 0 |

The e2e stub (`e2e/tests/work-stub.ts`) builds the same shapes with the same keys where they exist, and
`work.hud.count.*` / `work.hud.scope.flow|node` stand-ins where it predates them.

### Map (`surfaces/map.js`, `lib/map-model.js`: `/api/design` flows, one `/api/journey` per journey)

The map computes no number of its own: every chip is a `Counted` the journey summary typed, printed with
`countedHtml(c, '/api/journey')` and its tip. Before a journey's walk lands, its cover says *reading this journey…*
(`map.cover.loading`) — the design rows' `built/total` are not typed and are not printed here. Since the clarity pass
(2026-10-04) the board's card prints only the `built` status chip, the *at risk* mark and *→ n*; every other journey
number below is in the street head, from the journey-fitted stop up — no count changed meaning.

| printed | source | counts | scope | where |
|---|---|---|---|---|
| `3 screens` | C:`summary.counted.screens` (breakdown `count.part.screensReached` · `count.part.screensNotReached`) | screens the journey names — its design's, else the walk's — in order, each once | journey | street head; the tip splits it into reached by the walk / not reached |
| `10 reached` | C:`summary.counted.screensReached` | named screens a segment of the walk opens on, each once — the street's screens | journey | head beside `14 screens`, drawn only when fewer than the screens named (lane N, 2026-10-03; on the reference app's POC journey 14 named · 10 reached · 23 stops, the drill's unit) |
| `2 of 3 built` | C:`summary.counted.built` | named screens a page in the code serves, of how many | journey | street head; warm when not all are built. On the board's card (clarity pass 2026-10-04) the same Counted, same tip, in words: *built* · *partly built · 2 of 3* · *designed, not built* (`map.cover.status.*`) |
| `→ 2` | `plainTip(n, 'map.cover.leadsOf', 'map.fold.scopeJourney', '/api/journey')` ← the *leads to* lines `drawLinks` draws from each journey's `summary.links` (`fillLeadMarks`; a pair that lead to each other counts at both ends) | journeys this one leads to, each once; the tip names them | journey | the board's card; not drawn at 0 |
| `3 journeys` | `plainTip(n, 'map.band.journeys', 'map.band.scope', '/api/design' or '/api/journeys')` ← `layoutDistricts` band `n` | journeys drawn in the band — banded by persona a journey for two people is in both bands (its card and an echo), so the bands can sum past the board's journeys | one band | each band panel's header |
| `5 actions` | C:`summary.counted.actions` | distinct operations the code calls | journey | street head |
| `6 gates & rules` | C:`summary.counted.gates` (breakdown guards · rules) | checkpoints on the walk | journey | street head |
| `7 test cases` + its evidence word | C:`summary.coverage.journey.counted.tests` (breakdown unit · integration · e2e) beside `summary.coverage.journey.evidenceWord` (`lib/map-chips.js` `mapTestsChips`) | distinct cases reaching the journey, and the class of the strongest evidence | journey | street head; the word is the Portfolio's for the same fold (`/api/tests?flow=` and `/api/journey` agree on all 18 of the reference app's journeys), *not built* on `sharedEvidence`; never a count of tests without its class |
| `owner · Billing team` · `reaches the ERP · Example ERP` | `/api/design` flow `owner`; `summary.systems[].externalKind === 'erp'` (else a declared approve/post/sync operation: *ERP hand-off declared, not built*) | not counts — the Portfolio's Owner and Reaches-the-ERP columns, same rule | journey | street head; absent when the manifest names nobody or nothing reaches an ERP |
| `1 declared, not called` | C:`summary.counted.declaredNotCalled` | operations named and not called | journey | street head; not drawn at 0 |
| `1 data store` | C:`summary.counted.stores` (breakdown holding records · outside systems) | data stores the journey touches, each once by name — a database its records live in (named by the code or the settings), an outside system it uses as a store; a record whose store nobody named is not counted | journey | street head; not drawn at 0 |
| work chip | C:`/api/work/flow/<id>` `counts.items` | as the Portfolio's | flow | street head; not drawn at 0 or without a work source |
| `1 action` · `2 gates & rules` · `4 test cases` + evidence word on a screen | C:`segment.counted.actions` · C:`segment.counted.gates` · C:`summary.coverage.segments[i].counted.tests` beside `coverage.segments[i].evidenceWord` (`MapScreen.chips.evidence`) | as the journey's, over one screen | screen (`journey.scopeHere`) | screen card; the business lens leaves out a zero; a non-zero tests count always carries its word |
| ordinal `1` `2` `3` | the screen's place in `summary.segments` | a position, not a count (`map.screen.ordinal`) | journey | screen card |
| `×0.95` | the board's scale | not a count — the zoom (`map.zoom`) | the board | bottom right |
| `▸ 5 more` beside a call | `plainTip(n, 'map.fold.data', 'map.fold.scopeCall', '/api/journey')`: the call's own data markers (`MapCall.data`, from the segment's record · message · external markers) beyond the 3 drawn | records, messages and third parties this call reaches that are folded | one call on one screen | the street's plumbing; drawn only when 2 or more are folded |
| `▸ 2 more calls` under a screen | `plainTip(n, 'map.fold.calls', 'map.fold.scopeScreen', '/api/journey')`: the screen's own call rows (`MapScreen.calls`, the segment's call markers once each, plus declared rows) beyond the 4 drawn | calls this screen makes that are folded | one screen | the street's plumbing; drawn only when 2 or more are folded |

The plumbing prints no other number: a call, a record, a message and a third party are drawn once per screen that reaches
them, so the same record appears under two screens while the journey's own counts still count it once.

The stores (docs/proposals/data-stores.md) print one number on the map, *n data stores* in the street head
(`summary.counted.stores`, above, with its tip); the legend lists the stores by name (`summary.system.stores`, else
the street's own data) and the property groups its data rows by store, neither with a count — the map does not count
stores itself.


#### Property (`surfaces/map-property.js`, `lib/map-property-model.js` → `counts`)

Every number the property prints is a `Counted` the `/api/journey` answer (or `/api/work/links`) already carries,
handed on as the same object — `packages/server/test/map-property-model.test.ts` asserts identity, not equality. A
tab whose subject nothing types prints **no number**: Overview, UX, Route and Changes (the Changes tab's commit group prints its own `Counted` on its head once it has loaded, never on the tab).

| printed | source | counts | scope | siblings |
|---|---|---|---|---|
| Gates tab `5` · Gates head · Overview chip `5 gates & rules` | `summary.segments[i].counted.gates` | distinct guards + rules by name on this screen (3 · 2 on Invoice list) | screen | the journey header's `gates & rules` is the journey's; the rows under the head are the same list (`jrnGatesShown`), so rows and number agree |
| APIs tab `5` · APIs head · Overview chip `5 actions` | `segments[i].counted.actions` | distinct operations code calls on this screen | screen | the street's call chip (same object); New invoice prints `1` above **two** rows — the second is a *declared, never called* row (`MapCall.evidence: 'declared'`), which the number does not count, and its chip says so |
| APIs tab `1` on a screen not built · Overview chip `1 stop` | `segments[i].counted.actionStops` | the stops the design declares (breakdown: 0 called · 1 declared · 0 no call) | screen | Discard draft; never `actions`, which is 0 there |
| Gates · Decisions head `3` · Overview chip `3 decisions` | `segments[i].counted.decisions` | decisions drawn on this screen | screen | not printed in the business register when some decisions are guard-class (the rows then are fewer than the number) |
| Tests tab `5` · Cases head · Overview chip `5 test cases` | `coverage.segments[i].counted.tests` | cases (unit + integration + e2e) whose walk reaches the screen | screen | the case rows listed are the cases counted; coverage runs that name no case are listed apart under `counted.runReports` |
| Coverage runs head `1` | `coverage.segments[i].counted.runReports` | coverage reports that touched the screen's code and name no case | screen | not a case; never in the tab's number |
| the tests foot (`… e2e · … unit · … integration · … observed`, the evidence chip, *their own last run*) | `coverage.segments[i]` through `jrnFoldFacts` | as the journey's tests foot | screen (`journey.scopeHere`, printed above the counts) | the same fold the journey's foot reads; never recomputed |
| Work tab `N` · Work head | `/api/work/links?node=<page>` → `counts.items` | work items linked to the screen's page node, by state | node (`count.scope.node`) | the journey header's work chip counts the whole flow (`/api/work/flow`); asked only when a work source is configured |
| `×2` beside a gate | `segments[i].gates[].count` (viewer, `plainTip` → `map.prop.times`) | times the walk of this screen met that checkpoint | screen | Σ over the rows is the screen's `counted.checks` |
| `2 more that nobody put in plain words` (business) | `jrnGatesShown(rows).mute` (viewer, `plainTip` → `map.prop.gates.mute`) | gates on the screen whose only name is the code's | screen | drawn + mute = `counted.gates` |
| `screen 2 of 3 reached · Billing cycle` | the position in `model.screens`; the `3` is C:`summary.counted.screensReached` (same object, `placeOf()`) when it counts the street's rows, else the rows with a plain tip | a position among the screens the walk reached | journey | the cover's `screens` counts the named ones; the drill's `stop n of t` counts stops — three units, three names |
| `14 declared, 4 not reached` (only when the design names screens the walk missed) | C:`summary.counted.screens` · `summary.user` minus the segments' screens (`placeOf().notReached`, `plainTip` → `count.part.screensNotReached`, rows: each screen with `journey.absent.notReached` or `.notBuilt`) | named screens; named screens no segment opens on | journey | the second number's rows are the not-reached part of the screens breakdown |
| Changes · *Commits that touched this screen's parts* head `12` | C:`/api/history/touching` `counted.commits` (breakdown `count.part.commitLines` · `count.part.commitFile`) | distinct commits that changed the page, a component it draws or a handler its calls reach, among the commits read for the source (`read`) | screen (`journey.scopeHere`) | matched by lines where a keyed commit's hunks were resolved (`commit_node`), else by file (`commit_file`, whole-path suffix); `read: 0` prints *no commit history has been read*, not *none* |
| `3 more parts` on a commit row | viewer: the commit's `parts` beyond the three named (`plainTip` → `map.prop.changes.partsMore`) | parts of this screen the commit changed | screen | — |
| `show all 273` under a capped list | the list's own `Counted` (`counted.tests`, `counted.gates`, `counted.decisions`, `counted.runReports`, `counts.items`) when it counts exactly the rows; else the rows on screen (viewer, `plainTip` → `map.prop.listRows`) | the rows the list holds | screen | the tab's number when the list is the tab's subject; never a number of its own |
| `19 stories on 5 parts` (more than three parts with stories) | viewer over `node.stories` of `screenStoryIds()` (`plainTip` → `map.prop.storiesN` with the per-part breakdown; `map.prop.storyParts`) | stories on the parts of the screen that have any · those parts | screen | opened, each part's chip prints its own `n stories` |
| `3 more` in *also in* | viewer: other flows rendering the page beyond the three shown (`plainTip` → `map.prop.alsoN`) | journeys | the graph | — |

---

#### Affected (`surfaces/map-affected.js`: `/api/impact?direction=upstream&tests=1&reach=1` → core `affected.ts` `affectedReach()`)

The Affected mode (map pass 2, lane I) prints only the reach's own `Counted`s, one answer per seed. With several
seeds (a work item or commit touching several parts) each answer is kept apart: the bar prints no count, a badge's
tip names each part and how it reaches the place, and the tab reads one seed at a time. Nothing is added across
seeds or across hops. Scope `count.scope.affected` (*on what reaches it*) is new with this table: the thing
picked, what uses it as far out as the distance chosen, and the journeys and screens whose own path meets either.

| printed | source | counts | scope | where |
|---|---|---|---|---|
| `in 3 journeys` (was *3 journeys reach it*; round 2 reads it after the screens) | C:`reach.counted.journeys` (breakdown by distance first met: `count.part.reachSelf` · `reachDirect` · `reachThrough` · `reachFar`) | journeys whose walk (steps, their gates, the screens) meets the seed — *its path meets it*, not a distance — or meets a node the report lists, at the fewest hop; each once. The same journey set `journeysReaching()` (deps) reads | affected | the mode bar (one seed only), the Affected tab |
| `2 screens reach it (reached by walks)` · the tab's number | C:`reach.counted.screens` (same breakdown, each page at the fewest hop any of its journeys meets it) | **distinct pages** whose own segment of a walk meets the seed or a listed node; a page four journeys share is one screen (round 2 — it counted four, and could exceed the screens the manifest declares). `reach.screens` keeps one row per journey, which the tab and the list group by page | affected | the mode bar (one seed only), the property's head, the Affected tab and its tab count |
| `6 calls reach it` | C:`reach.counted.calls` (same breakdown); **no `bizUnit`** | routes in the report's hop sets, and the seed when it is one | affected | the Affected tab, hybrid and code only |
| `5 tests reach what uses it` + `within how far N` | C:`reach.counted.tests` = `impactTestsReaching(report, budget).total` (breakdown by the distance each test is first met) | the union the impact panel, the CLI and the MCP print for hops 1..budget, each test once | affected | the Affected tab; per distance the tab lists the tests first met there (business: `n tests first met here`, a `plainTip` with the levels) |
| `2 more parts not asked` | viewer: a change's touched parts beyond the 8 asked about (`plainTip` → `map.affected.partsMore`) | parts of the indexed code the change touched and the board did not ask about | the change | the mode bar; the picture is then a floor |
| `≥ a floor: …` | `report.bound` + `uncertainty.note` (business: `impact.biz.floor` with its reasons) | not a count — the bound, as the impact panel prints it | — | the Affected tab |
| *nothing more past N* | viewer: `furthestHop(entries)` < the distance asked (`lib/map-affected-model.js`) | not a count — says a longer reach adds nothing, so the stepper's identical numbers are not silent | — | the mode bar |
| list rows (`list these`, CSV, JSON `farsight-affected v0`) | viewer `affectedRows(entries)` over the same answers | per seed and distance: journeys (owner from the design manifest), screens once each with their journeys, the owners, the tests first met there — the same rows in the panel and in both copies; `copied N rows` counts them | affected | the list panel; JSON v0 is **not frozen** |
| `n behind it` on a stop | `report.cutPoints[].behind` | as the impact panel's | one stop | the tab's *not walked*, hybrid and code; business names each stop without a number |

#### Risk headline and scope words (round 2, `surfaces/map.js` `riskCounteds()`)

| printed | source | counts | scope | where |
|---|---|---|---|---|
| `2 journeys stale` | viewer Counted `count.unit.riskStale` ← each journey's `summary.coverage.journey.evidenceWord.cls === 'stale'` | journeys whose evidence word is *stale* (the card's at-risk mark); each once | `count.scope.workspace` | the risk line over the board, once every walk has landed; not drawn at 0 |
| `1 not fully built` | viewer Counted `count.unit.riskNotBuilt` ← `summary.counted.built` with `n < of` | journeys with at least one screen designed and not built | `count.scope.workspace` | the same line |
| `1 reaches the ERP` | viewer Counted `count.unit.riskErp` ← `erpReached(summary)` (the head's ERP chip) | journeys whose calls reach the ERP | `count.scope.workspace` | the same line |
| *on this journey* | `map.screen.onJourney` (words + tip, no number) | names the scope of the screen card's and the property's numbers: this screen's part of this journey's walk — the same screen on another journey prints its own | — | the screen card's chips, the property's head |

### Projects (`/api/projects` → core `projects.ts` `projectGraph()` / `appClosure()`; MCP `graph_overview`)

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| projects | `count.unit.projects` *n projects* (both) | `count.scope.workspace` | `projectGraph().counts.projects` over `meta.projects[repo].projects` | each project of every source listed (or the one `?repo=` names), once; breakdown by type — `count.part.projectsApp · projectsLib · projectsE2e · projectsUntyped`, a partition |
| projects per dimension | `count.unit.projects` (both) | `count.scope.workspace` | `projectGraph().counts.byDimension[key]` | the same projects, split by the values they carry under one tag dimension (`count.part.withTag` labelled with the value's word; two values in one dimension join into one label) plus `count.part.noTag` — a partition |
| project dependencies | `count.unit.projectDeps` *n project dependencies* (both) | `count.scope.workspace` | `projectGraph().counts.dependencies` over `meta.projects.imports` + `implicitDependencies` + `meta.projects.dependencies` (NX's project graph) | ordered project pairs, each once; breakdown `count.part.depsImported` (an import shows it) · `count.part.depsDeclared` (only `implicitDependencies` says it) · `count.part.depsNxGraph` (only NX's project-graph file records it) — a partition |
| parts of a project | `count.unit.parts` *n parts of the code* (both) | `count.scope.project` | `ProjectRow.nodes` — nodes whose `project` names it | graph nodes stamped with the project, once each; breakdown by node kind (`count.part.ofKind`, labelled with the kind) |
| import statements of a dependency | `count.unit.importStatements` (hybrid/code only) | `count.scope.project` | `ProjectDependency.count` = `meta.projects.imports[].imports` | import lines in the importing project's files that resolve to a file of the other project (0 for a dependency only declared) |
| projects it depends on | `count.unit.projectsDependedOn` (both) | `count.scope.project` | `appClosure().count` | projects reached from this one over dependencies, directly or through another, each once; the project itself not counted |

`count.scope.project` is new with this table: one workspace project — its own files, and for its dependencies the
projects they import or it declares. `graph_overview` prints the projects line only when a source has a workspace
tool (`nx` or `workspaces`): *nx · 8 projects (2 applications · 5 libraries · 1 e2e) · 10 project dependencies —
Domain: Billing 5 · Shared 2 · Operations 1 — Type: …* (the `examples/nx-workspace` graph).

### Dependencies (`/api/deps` → core `deps.ts` `packagesOf()` / `importersOf()`; CLI `farsight deps`; MCP `describe_node`, `graph_overview`)

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| packages | `count.unit.packages` *n packages* (hybrid/code only) | `count.scope.workspace` | `packagesOf().packages` over the `package` nodes the filters let through (`/api/deps` recounts after `?scope=`; `graph_overview` counts every package node) | each package node once — one package per source that imports it, so `react` in two sources is two; breakdown `count.part.packagesThirdParty` · `count.part.packagesWorkspace` — a partition. Node built-ins are never counted (`meta.packages[repo].builtins` lists them apart) |
| files that import it | `count.unit.importers` *n files import it* (hybrid/code only) | `count.scope.package` | `DepsRow.importers` / `importersOf().importers` — `module` nodes with an `imports` edge to the package | source files of that source that import the package, each once however many times they name it; on `where` the breakdown is by project (when the graph carries projects) else by source, labelled — a partition. Test and story files are not read for this |
| journeys it reaches | `count.unit.journeysReached` *n journeys reach it* (both) | `count.scope.package` | `DepsRow.journeys` = `journeysReaching()`: `impactOf(package, 2 hops)` and every flow whose `journey()` walk (steps, their gates, its screens) meets a listed node | journeys, each once. A floor: plumbing and rendered primitives are listed by the walk and not opened, so a package only plumbing uses (the invoice example's `date-fns` in its formatter) reaches 0 |

`count.scope.package` is new with this table (*for this package*): one package as one source imports it — every
file of that source that imports it, wherever it sits. The ranges (`DepsRow.versions`: where · range · declaring
package.json) are facts, not counts, and print beside the row.

### Journeys (`/api/journeys` → core `journeys.ts` `journeyTree()`; MCP `journeys`, `graph_overview`; CLI `farsight journeys`)

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| journeys in the tree | `count.unit.journeys` *n journeys* (both) | `count.scope.workspace` | `journeyTree().counts.journeys` — distinct flow node ids over `designSurface()` in scope | each flow once, however many personas show it |
| personas | `count.unit.personas` *n personas* (both) | `count.scope.workspace` | `journeyTree().counts.personas` | persona headings shown: declared ones with a journey, undeclared values, derived prefixes, and the trailing *Not grouped* when something sits there |
| groups | `count.unit.groups` *n groups* (both) | `count.scope.workspace` | `journeyTree().counts.groups` | group sections shown, one per persona a group appears under (*Access* under two personas is two), *Other journeys* included |
| journeys under a persona | `count.unit.journeys` (both) | `count.scope.persona` | `JourneyPersona.counts.journeys` | the journeys listed under that persona; equals the sum of its groups' counts. A journey for two personas is counted in each, once in the tree |
| journeys in a group | `count.unit.journeys` (both) | `count.scope.group` | `JourneyGroup.counts.journeys` | the journeys listed in that group under that persona |
| built journeys | `count.unit.journeysBuilt` *n of m journeys built* (both) | `count.scope.persona` / `count.scope.group` | `counts.built` on a persona or a group | journeys whose every screen exists in code (`status: both`), of the journeys beside it; a partly built journey is not built |
| storylines | `count.unit.storylines` *n storylines* (hud *n questlines*) | `count.scope.workspace` | `journeyTree().counts.storylines` | storylines declared by the sources in scope, one per id (a second source's same id is a note) |
| journeys in a storyline | `count.unit.journeys` (both) | `count.scope.storyline` | `JourneyStoryline.counts.journeys` | the storyline's steps: journeys it names that a manifest declares and the tree draws in scope, each once, in its order |
| built journeys in a storyline | `count.unit.journeysBuilt` (both) | `count.scope.storyline` | `JourneyStoryline.counts.built` | its steps whose every screen exists in code, of its steps |
| *step n of m* (journey header, Map card tip) · *journey n of m* (business lens) | `journeys.storyline.stepOf` / `bizStepOf`, `map.storyline.step` | one storyline | `stepIndex + 1` of `storyline.journeys.length` (`storylineOf()` in the viewer, `storylinePlacements()` in core) | a position, not a count — no `Counted`; its tip says what it is |
| a storyline band's *n journeys* (Map) | `map.band.journeys` | `count.scope.storyline` | `layoutDistricts().bands[0].n` over `storylineModel()` | the steps the board draws (a step out of scope is skipped) |

`count.scope.persona` (*for this persona*) and `count.scope.group` (*in this group*) are new with this table;
`count.scope.storyline` (*in this storyline*, hud *in this questline*) came with storylines (round 2026-10-05 §2). The
example graphs: `examples/invoice-app` — *3 journeys · 1 storyline · 2 personas · 3 groups* (Billing 3, Operations 1:
*Draft and send* is under both; the storyline *An invoice, end to end* chains all three); `examples/nx-workspace` — *4
journeys · 1 storyline · 2 personas · 4 groups* (*A billing day* chains the four across both apps' manifests).
`pickJourneys()` (the `persona` / `group` / `storyline` filters) recounts the tree-level numbers over what it keeps;
a storyline is kept whole when a persona or group filter keeps one of its steps. The summary line prints the
storylines only when there is one.

### Code map by project and package (`surfaces/codemap-projects.js`, `lib/codemap-model.js`; lane C)

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| parts in a box | `codemap.group.parts` *n parts shown* (both) | `codemap.group.scope` *in this box, as filtered* | `foldGroups()` over `displayNodes()` | the cards one box of the grouped map draws after scope, filters and focus; a folded file group counts each part it folds **under that part's own kind and only in its own project's box** (round 2: a group spanning projects is drawn once per project — a box used to count another project's parts); test files are file cards (drawn with *show files*), so the inspector's *parts of the code*, which counts tests and checks, is larger. Breakdown by kind (`kindWord`) — a partition (the unit test pins it). Not the project's own size: that is *parts of a project* above, on the project's inspector |
| import statements on an arrow (App and its related) | `count.unit.importStatements` (hybrid/code only) | `count.scope.project` | `/api/projects` `dependencies[].count` | the same `ProjectDependency.count` as the Projects table; an arrow with 0 says *declared only* (`codemap.view.declared`) instead of a number |
| projects in a tag box | `count.unit.projects` (both) | `count.scope.workspace` | `meta.projects[repo].projects` filtered by the box's value | the projects carrying the value in that dimension, each once (the tag box's inspector) |
| projects that use this one | `count.unit.projects` (both) | `count.scope.project` | `/api/projects/<name>` `dependents.length` | the projects depending on it, each once (the project inspector's *Used by*) |
| shown / hidden (status bar) | `chrome.shownOf` | `tip.stats.scope` | `statsBreakdown()` | gains three reasons: `tip.stats.files` (file cards, drawn only with *show files*), `tip.stats.packages` (*hide packages*), `tip.stats.filtered` (a code map filter or view). Still a partition of the graph's total |

The project picker (`lib/multi-pick.js`) prints three numbers. Its match count, *n of m projects* (also *tag values*,
*packages*: `codemap.pick.countProjects` · `countTags` · `countPackages`), is plain words with its define as the tip:
the options the words typed leave, out of every option the list holds over the sources in scope — not a `Counted`. A
project option's number is *parts of a project* above (`count.unit.parts`, `count.scope.project`), folded on the page
from `GraphNode.project` the way `projectGraph()` folds `ProjectRow.nodes` (module nodes not counted; breakdown by
kind). A tag value's number is *projects in a tag box* (`count.unit.projects`, `count.scope.workspace`) over the
projects in scope.

The package inspector prints `DepsRow.importers` and `DepsRow.journeys` as they arrive from `/api/deps/where`
(the Dependencies table); the project inspector prints `ProjectRow.nodes` and `appClosure().count` (the Projects
table). Nothing on the code map counts packages or projects a second way.

### Config files (`/api/config`, MCP `config_files` + `graph_overview`, CLI `farsight config list` → core `config-files.ts` `configCounts()`)

| number | unit / bizUnit | scope | source | counts |
|---|---|---|---|---|
| config files per source | `count.unit.configFiles` *n config files* (both) | `count.scope.source` | `configCounts().files` over `meta.config[repo].files`, written by parsers `loadWorkspaceConfig` | every `farsight.config.json` of one source that could be read, each once; breakdown `count.part.configRoot` *for the whole source* (0 or 1) · `count.part.configScoped` *for one folder* — a partition. A file that is not valid JSON is not counted; it is a note |
| conflicts per source | `count.unit.configConflicts` *n conflicts* (both) | `count.scope.source` | `configCounts().conflicts` over `meta.config[repo].conflicts` | one per (kind, key): a glossary key two nesting files word differently, a function one file already made a guard that a later guard rule names, a second declaration of an external import, a store name declared again as another kind or engine, a table two files list under different stores — however many files take part |

`graph_overview` prints the line only for a source that holds more than its root file (or has a conflict or a note):
*config: nx-workspace — 3 config files (1 for the whole source · 2 for one folder) · 1 conflict · 1 note(s)* (the
`examples/nx-workspace` graph). `count.scope.source` was the tests' scope (*at one test level*); its define now says
what a source holds in general, with the test level as the tests' case.

### Freshness — *stale* is a comparison (core `freshness.ts`; swarm-fixes 2026-10-05, finding 2)

Freshness is a sentence with two sides, never a bare word and never a number of its own. `freshnessFact(runs, code)`
decides one state for any list of runs: **current** (some run's recorded digest is still the code's) · **stale**
(every run is older than the code — the same rule as the chip's `observed-stale`) · **no source digest** (no run
compared; *not* stale) · **none**. The fact carries the run's side (`ranAt`, `ranOn.commit` from the report stamp's
`farsight.commit`) and the code's (`codeAt.commit` = `meta.tests[repo].head`, else a one-source graph's
`meta.commit`; `codeAt.sync` = `meta.sync`), and the catalog keys of its word, its sentence (`fresh.sentence.*`), its
business sentence (`journey.biz.fresh.*`) and its recipe (`fresh.recipe.rerun` · `fresh.recipe.stamp`). The code side is
registered per index (`setFreshnessMeta`) by the server, MCP and the CLI.

| printed | source | compares | scope | where |
|---|---|---|---|---|
| `stale — the tests ran on commit ffe2759 (2026-10-04); the code is at commit 4632734 now` | `coverage.freshness` | the runs that observed the scope (else the covering tests' own runs) vs the code read | journey · segment · action · step | journey header (`.jrn-fresh`), the evidence chip's tip (journey, Map, Portfolio row, Tests matrix) |
| `current as of sync 106 — the tests ran on the code as it is now` | `coverage.freshness` | as above | as above | as above — a current journey says so instead of saying nothing |
| `no source digest was recorded — the tests ran on …` + the stamp recipe | `sources[].fresh` / `coverage.freshness` | runs with no recorded digest | source card · scope | Tests cards |
| `runs read: n current · n older than the code · n with no source digest` | `fresh.runs` | the runs the answer is computed over; sums to them | the fact's scope | the freshness tip (`count.part.fresh*`) |
| Map *at risk* `18 journeys stale` + `against the code at commit X (sync N) — every one of these runs is from D or before` | each journey's `coverage.journey.freshness` | printed once when every stale journey compares with one commit | board | `riskCounteds()`; each card's *stale* mark carries its own journey's fact as its tip |

## 4. Open — found, not changed here

- **The journey prints the typed counts** (`fix/journey-numbers-and-words`, 2026-09-25). The header
  is five groups — `counted.screens` + `.built`, `.actions` (tip: `.again`, `.declaredNotCalled`, `.actionStops`,
  `.planned`, `.setup`, `.deferred`, `.choices`, `.systems`), `.gates` (tip: `.checks`, `.decisions`),
  `.notInWords` (short words `count.unit.notInWords` in every lens; the tip heads with the business sentence),
  and `coverage.journey.counted.tests` with the evidence chip and `observation` beside it — plus `.steps` in the
  code lens. The lane tabs read `counted.inWords / .gates / .decisions`; the column heads `segments[i].counted`;
  the Sheet's *Verified by* cell `coverage.moments[i][k]`; the Drill's `stop n of t` `counted.actionStops`; every
  one carries its tip (`jrnCountedTip` in `surfaces/journeys.js`).
- **The other surfaces print the typed counts** (`fix/surfaces-numbers-and-words`, same day): Tests (`counted`,
  `countsAll`, `sources[].runs`, #8), the inspector's stories (own · docs · parts, #9), the catalogue (#10) and the
  Portfolio's flow rows (`summary.counted.{actions, declaredNotCalled, built}`, `coverage.counted`, #5 and #6) —
  through `lib/counted.js` (docs/MAP-VIEWER.md). The catalog word changes (*gates & rules*, *stop n of t*,
  *seen by a coverage run · stale*, *conditions … not written in plain language*, *stories and docs pages*) reach
  every surface on their own.
- `packages/server/public/app/strings.js` `evidenceWord()` no longer derives anything: it returns the core's
  `evidenceWord` or the absence word. A table reached only through its accessors gets no class word (the core
  gives none) — the foot counts what reaches it and says so.
- `StepCoverage.unit` is not a unit count (see Inspector). `verifiedBy()` in `tests.ts` returns every covering
  ref, declared ones included — its name claims more than it returns. Both kept for compatibility.
- Journeys list, APIs, Changes and chrome counts are recorded but not yet typed.
- `/api/journey` for the POC flow grew from 5.0 MB to 5.8 MB (+15%): 426 steps carry a typed `counted`
  (~1.3 KB each) and 31 actions a slim coverage entry (54 KB together).
- **MCP `work_changes` impact per hop is a plain number** (2026-09-30). Each dependent once at its nearest hop over
  every touched node, never summed — but the catalog has no unit for *dependents at hop n*, so it is not a
  `Counted` yet. It needs a core unit (and a scope for *what a work item's commits touched*) before it can be one.
