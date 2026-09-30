# Change history — git as a lens on the snapshot spine

2026-09-23 · branch `feat/change-history`, cut from `main` `f95a03c` · parallel with lane B2 (`feat/front-door`) · spine: [`snapshots.ts`](../../packages/core/src/snapshots.ts) · contract: [`farsight-diff v1`](../contracts/farsight-diff-v1.md) · surface: v3 plan P6 · vocabulary: the clarity phase README

Jared's ask: read git history into the graph, relate it to the releases/changes tab, get point-in-time screenshots and better change management. Line numbers are today's on `main`; the reference app facts at `0a88031`.

**In short:** history becomes four tables beside the snapshot spine, not graph content; releases are declared and tags proposed; point-in-time is the HUD re-rendered at `--as-of sync:N`, which already works, plus design images per sync. Farsight does not grow a browser.

## 1 · What a commit is in the graph — nothing

**Decision: history tables beside the snapshot tables in the same `.farsight/farsight.db`, plus derived provenance served on demand. No new nodes, no new edges, no new `NodeKind`, no change to `digestOf()`.**

A commit is not something the parser found in the code — it is a fact about the *repository*, at **file** granularity. Principle 1 says every consumer is a lens over one graph; a `commit` kind would be a lens over something else wearing the graph's clothes. Ruled out, with the cost:

- **Commit nodes + `changed` edges.** They enter `stats().byKind` (`store.ts:114-118`), `search_graph`'s kind filter, `graph_overview`'s counts, the code map and the coverable denominator lane A2 just unified — 66 the reference app nodes with no `loc`, journey, test or register-appropriate name. Worse, an edge from a commit to a node *asserts* the node existed at that commit: the one thing that is unknowable (§2).
- **Provenance on the node** (`node.lastCommit`). The store is SCD2: a row closes and reopens when its JSON hash changes (`snapshots.ts:224-248`). A sha on every node rewrites all 1,505 the reference app rows per commit and moves `digestOf()` (`:123-135`) — the graph would report itself changed when only the history moved, while `farsight diff` reported nothing. A measurable lie, not a style preference.

What ships instead, in `SCHEMA` (`snapshots.ts:139-149`, additive `CREATE TABLE IF NOT EXISTS`):

| table | columns |
|---|---|
| `commit` | `repo, sha, at, author, email, subject, parents, merge` |
| `commit_file` | `repo, sha, path, status, old_path, added, deleted, similarity` — one row per file per commit, the last two from `-M` |
| `commit_sync` | `repo, sha, sync` — the join: this commit is what a sync recorded |
| `release` | `repo, name, sha, at, declared_by` (§3) |

Provenance is then a query, never a field: "what touched the file this node lives in since sync N" is one `commit_file` select on `loc.repo` + `loc.path` — **file-level, and the words say so**: *the file this lives in changed in 3 commits since sync 46*, never *this function changed in commit X*. `core/src/history.ts` holds the pure folds; the `git` invocation lives in `parsers/src/shared/git.ts`, which is what `shared/` is for (`files.ts:54-82` is its sibling).

## 2 · Commit ↔ sync: what is knowable

Measured on the reference app's own store (its `.farsight/farsight.db`, read-only):

| fact | number |
|---|---|
| commits in the repository | 66 |
| syncs recorded | 48 |
| **distinct commits those syncs recorded** | **15** |
| commits no sync ever ingested | **51** |
| commits older than sync 1's commit | 10 |
| largest blind gap (`0052772` → `9ded681`) | **18** |
| syncs repeating a commit already recorded | 33 of 48 |

So two thirds of the syncs looked at code already seen, and three quarters of the reference app's commits were never seen at all. Neither fact is visible today: `farsight snapshots` prints the sha (`cli.ts:362-390`), and nobody reads the repeats.

**Knowable for an un-ingested commit:** sha, author, time, subject, parents; the files it touched with add/delete counts; which of those hold graph nodes; and via `-M`, that a file is the same one under a new path. **Not knowable:** whether a node existed at it, what a journey looked like, whether a route was added or a gate removed — graph facts, and the graph was never built there.

The rule: **a commit with no `commit_sync` row renders as *not indexed*** — one of the six absence words the brief fixed, its `define` extended from "outside Farsight" to "inside a Farsight source, outside its history". A range containing unindexed commits says so first. The measured diff and the git narrative are drawn **side by side, never merged**.

Attribution reaches the contract as one optional field — `attribution?: { commits: string[]; level: 'file'; unindexed: number }` — which the freeze permits ("v1 may **gain optional fields**"). `diff.ts` never reads git: `history.ts` adds it on the way out, so core stays pure and the golden fixture keeps passing.

## 3 · What a release is — declared, with tags proposed

| source | commits | tags |
|---|---|---|
| reference app | 66 | **0** |
| farsight (this repo) | 251 | **0** |
| a second app | 59 | 23 — and mixed: `1.0.0`, `1.1.0`, `v1.1.0` … `v1.16.0` |

Two of three code sources here have no tags, and the one that does carries two schemes — `1.1.0` and `v1.1.0` both present. A release therefore **cannot** be defined as a tag.

**Decision: a release is declared in `.farsight/settings.json` (`releases: [{ name, commit | tag, at? }]`); `farsight history --releases` *proposes* the tags it found, with the scheme it saw, for a human to accept.** The codebase uses that pattern twice already: guards and entrypoints are detected *or* declared in `farsight.config.json`, and a design source is a manifest a person writes. Where a workspace declares nothing, Changes groups by **sync** — what the route and the frozen permalink already do. Farsight never invents a release from "the last N commits".

## 4 · The Changes tab, three registers

One surface, three sections, one route: `#/changes/<base>...<head>` as `changes.js:15` parses it, the grammar growing to accept `sync:N...sync:M`, `rel:<a>...rel:<b>` and `commit:<sha>...<sha>` — the last honest, because a commit range no sync bracketed can only show the narrative.

**A · The spine.** Syncs newest-first from `SnapshotDb.list()` (`:291-309`), each carrying its commit *and the commits it swept up* since the previous sync's. A sync whose commit equals its predecessor's reads **re-indexed on a newer build — no new commits** (33 of the reference app's 48); unindexed commits are dotted stops. The gap becomes a thing on screen.

**B · What changed.** *Business* — `changeSentence()` (`diff.ts:454-478`) in the professional register, by severity, subject from `DiffChange.journey.name`, and **only the kinds a person outside the code can act on**: routes, records, columns, gates, journeys, coverage. *Hybrid* — every kind with complete `counts`, plus confidence and `technique` chips. *Code* — adds `loc`, the `vsl()` ⧉ link and the attributing commits. `edge_confidence_changed` and `node_renamed` never reach the business register.

**C · Who and when.** Business: *Since 6 Sep, 7 changes by 1 person; 3 touched what the user sees.* Code: the `--numstat` rows.

Thirteen entries under `changes.*` in `strings.ts`'s shape (`hud` · `professional` · `define`) replace `ph.changes.*` (`:183-185`). Two carry the honesty: `unindexed` — *"a commit no sync ever ingested; Farsight can name the files it touched, not what it did to the graph"*; `attribution` — *"the commits in this range that touched the file this change's subject lives in — file-level, not proof of cause"*. **Attribution does not join the evidence chips**: evidence says whether something runs, attribution says who touched a file. Every count carries its interval label, as one-denominator makes it carry its scope label.

## 5 · Point in time: what is actually feasible

**Feasible today, free.** `--as-of sync:N` materializes any retained snapshot (`cli.ts:223-232`), `serve`/`mcp` take it (`:350-360`), and the shell parses `@sync:N` on every route (`shell.js:52-54`). A spine row's "see it as it was" is therefore a real link — `#/journeys/<entry>@sync:N` — better than a stored picture because it is queryable.

**Feasible, opt-in, bounded.** A screen's design image is a repo-relative file or a cached Figma render (`server/src/index.ts:415-433`). A `sync_shot` table recording each screen node's **image content digest** per sync, with a content-addressed copy under `.farsight/cache/shots/<digest>.<ext>`, makes a point-in-time *design* diff a fact: two syncs, two digests, both images on disk; an unchanged image costs one row. `.farsight/cache/` and the db are gitignored (`.gitignore:9-11`), so no bytes enter git. Behind `Settings.flags` (`:43`) because it writes files.

**Not feasible, not proposed: Farsight rendering and storing a screenshot of the HUD or of the running app per sync.** No package ships a browser; every screenshot in the design references was taken with *the reference app's* Playwright through a scratchpad script (`PW_ROOT`). Playwright in the install path contradicts the two decisions defining this install posture — tree-sitter as prebuilt WASM, "no native deps" (ADR 6), and `node:sqlite`, "no native module in the install path" (`snapshots.ts:16`). If HUD shots per sync are ever wanted they belong in a dev-only `scripts/shots.mjs` driven by an existing checkout's Playwright, as the boards are today.

## 6 · Three questions someone could finally answer

1. **"The journey walks a gate called `submitDraftInvoice` — when did it appear, and did Farsight see the commit that added it?"** `git log -S'submitDraftInvoice' --reverse` → `1581741` (2026-09-06, *"refactor."*), which `git merge-base --is-ancestor` places inside the 18-commit gap between `0052772` and `9ded681` — **a commit no sync ingested**. Answered, labelled *not indexed*, offering the file list rather than a graph diff.
2. **"Why did that sync report hundreds of removals and additions when nothing was deleted?"** `0052772` (*"tiered Nx layout"*): 308 files, +19,288/−15,073, **87 renames of which 56 score R100** (byte-identical). Node ids embed the path and rename pairing only matches same `repo/path:line` (`diff.ts:219-227`). `commit_file.old_path` lets the surface state *56 of these are the same file under a new path* without touching the frozen contract or pretending to fingerprints.
3. **"We re-synced 48 times — which looked at new code?"** 15 distinct commits across 48 syncs; **33 re-indexed code already seen**. The spine labels and collapses them, so "the graph changed" stops being read as "the software changed".

## 7 · The work, in chunks

**Before chunk 1:** B2 (`feat/front-door`) merged to `main` — it owns `shell.js`, `surfaces/*` and `strings.ts`, which H6/H7 touch; rebase onto it. No live lane touches `snapshots.ts`. One commit per chunk; done means the four gates green **and** its own check.

| # | commit | files · functions | check | h |
|---|---|---|---|---|
| H1 | `feat(core): history tables beside the snapshot spine` | `snapshots.ts` `SCHEMA` 139-149 (+4 tables, 2 indexes) and `writeCommits`/`commitsBetween`/`commitSpine`/`unindexed` after 360-367; new pure `core/src/history.ts` (`CommitRow`, `FileChange`, `spineOf`, `attributeChanges`) | new `history.test.ts`: 20 commits × 3 syncs → the gap comes back `indexed:false`; `snapshots.test.ts` green | 6 |
| H2 | `feat(parsers): git history reader in shared/` | new `parsers/src/shared/git.ts` — `gitLog(root,{since,max})` (`--numstat -M`, NUL-delimited), `gitTags`, `gitShallow`, `gitHeadRef`; `gitHead` moves here from `cli.ts:110-118` | new `git.test.ts` on a `tempRepo` with a rename and a delete; a non-repo dir returns `{available:false, reason}`, never throws | 6 |
| H3 | `feat(cli): farsight history` | `cli.ts` USAGE 40 and `case 'history'` after 362-391 (`--repo · --since · --max 2000 · --releases · --json`), rows per source via `workspaceSource` 116-130 | `--repo example-app --json` → `commits` 66, `unindexed` 51, `releases` 0; the second app proposes 23 tags | 5 |
| H4 | `feat(core,cli): attribution on the diff without unfreezing it` | `history.ts` `attributeChanges(diff, rows)` → a copy with the optional field; the contract doc + its schema; `cli.ts` 392-399 `--attribute` | `validate.ts` accepts a diff with and without it; `diff.test.ts` byte-identical; on the reference app 25→26 it names `0052772` | 5 |
| H5 | `feat(server): /api/history, /api/diff, the frozen permalink` | `server/src/index.ts` before 593 — `/api/history?repo=&from=&to=`, `/api/diff?from=&to=&attribute=1`, `GET /compare/<a>...<b>` → 302 | 48 spine rows for the reference app; `curl -i /compare/47...48` → 302 | 5 |
| H6 | `feat(strings): the changes words` | `strings.ts` 183-185 — retire `ph.changes.*`, add the 13 `changes.*` entries (`lint-strings.mjs:60` already lists the module) | `lint:strings` green (RULE 2 forces each retired key's call site); `#/grammar` renders the group | 3 |
| H7 | `feat(viewer): the Changes surface` | `surfaces/changes.js` replacing `mountChanges` 14-21 (three sections, register-aware); `shell.js` `parseRoute` 45-71 (`rel:`/`commit:`) | the reference app 47…48: the spine reads *re-indexed on a newer build*; business shows no `edge_confidence_changed`/`node_renamed`; zero page errors | 8 |
| H8 | `feat(core,server): design shots per sync` | `snapshots.ts` `sync_shot` + `writeShots`; `/api/design/image` 415-433 takes `&sync=N` from `.farsight/cache/shots/`; `Settings.flags` 43 | two syncs, a changed screen PNG → two digests, both served; flag off → zero bytes written | 6 |
| H9 | `chore: pack, restart, sync, record` | re-pack, `npm install -g ./build/farsight-cli-0.1.0.tgz`, restart both servers, `farsight history` on both, handoff | `farsight status` clean on both ports; §2 and §6's numbers reproduced from the shipped build | 3 |

**≈ 47 h.** H1 ‖ H2; H3 needs both; H6 follows B2's merge.

## 8 · Risks

**Performance.** Measured: `git log --numstat -M` is **0.09 s / 1,690 lines** on the reference app (66 commits, 10.74 MiB pack) and **0.31 s / 2,493 lines** on a second app (59 commits, 6.42 MiB). Nothing here exercises a large history, so the design must not claim it scales. Mitigations are part of the contract: `--max` defaults to 2,000 commits, `--since` is honoured, and **`farsight history` is a separate command — never part of `ingest` or `POST /api/sync`** — so a slow history can never slow a sync. The growth term is `commit_file` (`0052772` alone is 308 rows): 10,000 commits × 20 files ≈ 200k rows, the order the interval tables already hold.

**The repository's edge cases**, each with the words it renders rather than a silent zero:

| case | what it renders |
|---|---|
| no git (`{available:false, reason}`) | syncs only, every commit column *not indexed* — ingest already prints this diagnostic |
| shallow clone (`--is-shallow-repository`) — normal for cloned git sources | the oldest commit is a boundary, so "first seen in" is a **floor**: *at or before `<sha>`*, reusing `computeMetric`'s `floor\|exact` bound |
| detached HEAD (no symbolic ref) | `gitHead` still gives the sync's sha (`cli.ts:110-118`), but `git log` walks one ancestry: titled *ancestry of `<sha>`* |
| rewritten history — a recorded `commit_sha` unreachable | *commit no longer in the repository*, kept and labelled, the posture `snapshotRow` takes on a pruned sync (`snapshots.ts:417-427`) |

**Monorepo attribution.** `commit_file` paths are repo-root-relative, node `loc.path` source-root-relative: the join must normalise through the source's `path` or attribution silently returns nothing — and an empty list looks like "no commits touched this". Assert it in H4's test.

## 9 · Where I disagree with the brief

**One thing is worth reopening, and it is small.** `farsight-diff v1` froze `permalink` as `/compare/<base>...<head>#<id>` (`diff.ts:350`), but the viewer routes `#/changes/<base>...<head>` (`changes.js:15`) and the server has no `/compare` handler — so on the day the Changes surface ships, every permalink the contract has minted since July is a 404. The freeze forbids changing the field and it should not be changed: **H5 serves `/compare/*` as a 302 into the hash route**, honouring the freeze and making the promise true. Flagging it now rather than discovering it in P6 is the only reopening this proposal asks for.

Otherwise the brief is binding: the six absence words carry the unindexed commit rather than a seventh; *action · beat · step* are untouched, history having no beats; the evidence chips stay reserved for tests; honesty before beauty means H1–H5 land before H7.
