# The swarm-fixes round — 2026-10-05, evening

The 2026-10-05 swarm (eight personas, cold, on the reference app's own server at `4a44f4c`, judging only from their
own screenshots; reports and `_synthesis.md` outside the repo) scored the product **8 × TRIAL, fit 6.4**. What it
credited: the storyline on the Map and the front door, the screen → call → handler → contract chain, the number
tips and the provenance stamps. What held every score down is the same short list, and this round works it in the
order the synthesis ranked it — the trust defects first, because a reviewer who meets two verdicts for one test
stops believing the rest.

This round is eight lanes, each a PR squash-merged into `main` in the order below. After the merges: the lead's
ritual (gates · pack · reinstall under both prefixes · restart 4477 and 4478 · `POST /api/sync`), a handoff prompt
to the reference app's own session (install the build, restart its MCP, re-run its unit and e2e suites with the
reporters so every *stale* that is only *no fresh run* becomes current), and then the next swarm — the same eight
personas, asked this time also *what would you want next*.

## The findings, in the round's order

| # | finding (roles) | lane | the one-line done-check |
|---|---|---|---|
| 1 | **One action, several test verdicts** (6) — *passed, by its own declaration · stale* beside *no test reaches this step*, *last run: skipped*, a tip saying *verdict unknown*; the Tests matrix printing PASSED beside *skipped*; one file:line with two verdicts on two surfaces | **V** verdict | for any step, screen, journey or test file, every surface prints the same evidence word, computed by one function in core |
| 2 | **Stale is saturated** (5) — every journey, Portfolio row and test level says *stale* / *no source digest* with no sentence saying against what; Settings *history 0 commits read* contradicts Changes *242 of 282 never ingested*; the e2e card badged VITEST and saying both *unknown* and *changed since the run* | **F** freshness | *stale* appears only where a run is older than the code it tested, always with the sentence (*ran on commit X · the code is at Y*); a current journey says it is current; Settings and Changes agree on the commits read |
| 3 | **One word per position** (6) — *step* means the storyline position, the drawer's walk index (*STEP 232*), the drill's *stop*, the code register's *983 steps*; action counts disagree with the Sheet's columns | **W** words | *step* names the storyline position only; every other position has its own word in both registers; the Sheet's columns and the action counts are one number |
| 4 | **A gate's click answers nothing** (6) — it turns amber or opens its service; the doors hide behind ▸; no gate → the call it guards → the tests that reach it; config checks listed as a screen's gates | **G** gate | clicking a gate anywhere opens one card: the sentence, the scope, the code lines, the call it guards, the tests that reach it, the doors on the row |
| 5 | **Chrome** (6–7) — Settings behind an unlabelled sun icon and absent from ⋯; read-only still offering *Sync*, *Save*, *Add source*; the Map legend opening over the board on every visit and clipped; the Sheet's *verified by* row overflowing; the Experiments row one word wide; the toolbar overflowing at 1440; `?` with four jobs; business opening on the Sheet | **H** chrome | each item in the list has a screenshot at 1280 and 1440 showing it fixed |
| 6 | **Storylines, second pass** — a branch kind for the correction journey; an unknown `?storyline=` says so; ⌘K finds storylines; thumbnails on the cards; test evidence on the storyline board | **S** storyline | the reference app's correction journey draws as a branch off review; `?storyline=nope` says so; ⌘K lands on a storyline; cards carry thumbnails and an evidence word |
| 7 | **Data holes** (BA) — the mark-paid and approval screens show *0 actions · 0 gates · calls: none indexed* while the street lists `POST …/mark-paid` under them; no status lifecycle for the storyline's record | **D** data | on the reference app's graph both screens carry their calls, gates and tests on every surface; the invoice's statuses, transitions and the call that performs each are read from the code |
| 8 | **Export** (3) — PNG/PDF of the storyline board, the storyboard and the Portfolio; a pinned, dated link | **E** export | each of the three downloads a PNG and a PDF with a provenance footer; a pinned link carries the as-of sync |
| 9 | **Business register, last ~30 words** (3) — gate names, commit subjects, HttpOnly, getSession, *Postgres · database record*; and ADR numbers dropped where they are the citation key | **W** words | the business register shows no identifier on the walked screens; ADR numbers print in every register |

## Decisions taken by the lead

- **One evidence function.** The word a test cell shows is computed once, in core (`coverage.ts`), from the same
  refs every surface already reads, and every surface prints that word and its tip. No surface derives its own.
  A declared e2e case that passed is *passed, by its own declaration* everywhere or nowhere.
- **Stale is a comparison, so it carries both sides.** The word is only printed with its sentence. A run that has
  no digest is *no source digest* (the absence word), not *stale*. A journey whose runs are current says *current
  as of sync N*.
- **The words for positions:** *step* = storyline position (journey n of m in business). The drawer's index becomes
  a *moment*; the drill's *stop* stays *stop* (it is a stop on a drill). The code register's "983 steps" uses the
  unit the count actually has. The lane may correct this if the catalog already reserves a word.
- **The gate card is the same card in both registers** with the business register dropping the code doors (the doors
  rule). The sentence is the missing half: *what it allows, where, and who should write it if nobody has*.
- **Read-only disables writes.** It does not hide them: a disabled control with a tip saying why is the honest state.
- **A branch is a storyline fact,** declared in the manifest (`branchOf` + `when` on a storyline entry), never guessed.
- **Export is client-side** (the DOM the reader sees, rendered to a canvas), with a provenance footer (source · sync ·
  commit · date), and a PDF is the same picture on a page. No server route.
- **The status lifecycle is read from the code** — an enum of statuses and the writes that move a record between
  them — and shown as a fact with a provenance, never drawn by hand.

## Lanes, worktrees, branches, ports

| lane | worktree `../farsight-wt/` | branch | e2e ports | viewer port |
|---|---|---|---|---|
| V | `verdict` | `fix/one-test-verdict` | 4631–4633 | 4541 |
| F | `freshness` | `fix/stale-said-once` | 4634–4636 | 4542 |
| W | `words` | `fix/one-word-per-position` | 4637–4639 | 4543 |
| G | `gate` | `feat/gate-answers-click` | 4641–4643 | 4544 |
| H | `chrome` | `fix/chrome-pass` | 4644–4646 | 4545 |
| S | `storyline-2` | `feat/storylines-2` | 4647–4649 | 4546 |
| D | `data-holes` | `fix/screen-calls-and-lifecycle` | 4651–4653 | 4547 |
| E | `export` | `feat/export` | 4654–4656 | 4548 |

Merge order: **V → F → D → W → G → S → H → E**. V and F share `core/coverage.ts` and the test chips; V owns the
evidence word and the chip, F owns freshness facts, the stale sentence and history. W owns `strings.ts` wording and
the drawer/drill position words; every other lane adds its own catalog keys at the end of the relevant strings file
and merges `main` before reporting. G owns `jrnGate*` in `surfaces/journeys.js` and `lib/detail-links.js`; S owns
the storyline parts of `surfaces/map.js` and `surfaces/journeys.js`; H owns `shell.js`, the legend and the toolbar in
`surfaces/map.js`, the Sheet's CSS; E adds `lib/export.js` and a button per surface; D works in `parsers/` and
`core/`.

Every lane measures on a read-only copy of the reference app's graph served by its own build, screenshots at 1280×800
and 1440×900, counts page errors, and says in its report what it measured and where this brief was wrong.
