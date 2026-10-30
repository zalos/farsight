# Farsight — current state (shared Codex / Claude handoff)

Imported by `CLAUDE.md` and read by Codex at session start, so it holds **only the work in flight**: where `main`
is, what is open, what is next and what bites this week. Keep it under about 80 lines. When work lands, replace its
entry with one line (or drop it) and move the dated detail — checks run, measurements, review findings — to the
matching file in [history/](history/README.md). Durable rules go in `AGENTS.md`; runtime, provider access and live
tracker setup are in [AI-SETUP.md](AI-SETUP.md).

## Where things stand — 2026-10-30

- **`main` is `e3bf7c38`.** Published Farsight is **0.3.0**; Sentinel is `0.0.0-draft.1` and unreleased. The
  targets 0.4.0 and Sentinel 0.1.0-beta.1 still need the release workflow ([RELEASING.md](RELEASING.md)).
- **Deployed build `e3bf7c38`:** the global `farsight` under all three Node prefixes and the dogfood server on 4478
  (sync 86). 4477 serves the reference app read-only on the same build; its graph is still written by the
  2026-10-24 build and its session owns the re-stamp, so `farsight status --port 4477` exits 1 until it does.
- **The Settings page and custom node patterns plan is merged, all seven lanes (#255 → #262, 2026-10-30):** #256
  the workspace overlay in `.farsight/settings.json → sources[].config`, `POST /api/settings/check` and the OpenAPI
  registration routes (S1); #257 OpenAPI candidates and `farsight api candidates|register|dismiss` (D); #258
  `frameworks` aliases and the delegate join (A); #259 the sectioned Settings page with the server as the one
  validator (S2); #260 `patterns[]`, `farsight patterns test` and ADR 49 (B); #261 hand-made `nodes[]` (C); #262
  the overlay forms, pattern Test, JSON and Export (S3). The §7 done walk ran on the dogfood server from Settings
  alone: a work source with a keychain reference saved; `@SomeAnnotationPolicy` declared as a gate from the overlay
  and listed by `farsight roles`; a document registered on a source and its operations on the APIs page after a
  sync; a regex pattern written, tested (11 matches), saved, and its routes on the code map with `config-pattern`
  evidence. The walk's declarations were reverted afterwards. Plan: [proposals/settings-page.md](proposals/settings-page.md),
  [proposals/custom-node-patterns.md](proposals/custom-node-patterns.md); the dated detail is at the top of
  [history/viewer-passes.md](history/viewer-passes.md) and [history/parsers-and-cli.md](history/parsers-and-cli.md).
- **Sentinel v2's thin slice is merged** (#227 → #253) with the no-Docker `review` profile, [DEMO.md](DEMO.md) and
  retained native failures; phase 0 (Prettier, ESLint, lefthook) is complete. The demo is the CLI and the no-Docker
  review path on another Mac (DEMO.md §4b); the Docker agentic route (V-3) is paused by the owner. Plan and lanes:
  [sentinel-v2/tasks.md](proposals/sentinel-v2/tasks.md).

## Open work, in order

1. **ADR and package-map entry for `sentinel-attempt-retained/draft-1`**, the public draft contract #247 added in
   `packages/sentinel/src/contracts/review.ts`; AGENTS.md asks for both with the contract.
2. **PA's second PR** — local and unopened: `feat/sentinel-p4b-rerun` in `../farsight-wt/pipeline-a2` (`run.rerun`,
   the option-A flip, explicit `init` grant effects, the local `ollama` runner, `adoptPipeline` refusing non-CLI receipts).
3. **Left open by the Settings and patterns waves** (each named in its PR body): per-source sync (`POST /api/sync`
   is workspace-wide; the card's *Sync now* says so); one shared helper for the three registration writers (CLI,
   route, viewer); the multi-spec contract re-stamp in `core/openapi.ts` (a second spec in one repo re-stamps the
   other's routes `code-only` — the Spring example's new spec exposed it); `frameworks` is root-only (a nested
   file's block gets the ignored note); the pattern dry run holds the event loop on a large source (409 to a
   second caller); `implemented` now reads *supplied* with a found-in-code · declared-by-a-person breakdown, but
   the *not implemented* tip in `strings.ts` still reads code-only; a route a pattern rule mints is named `:param`
   while a hand-made route keeps the path as written; the audit still calls an allowed file with an unsupported
   extension "unsupported" although the node keeps it.
4. **Still open in the v2 plan:** `capabilities --models` for Copilot CLI 1.0.105 and Claude native; the declared
   host-script stage through `scan` with `<output>.schema.json` in its pack; P-3b reuse of retained checks on rerun;
   a durable pre-attempt refusal reason from a closed structured set at the store boundary.
5. **Owner calls:** #121 (App Router delegates) must be reapplied onto the formatted `main` with `prettier --write`,
   not merged as is; dependabot #236/#195 (zod 3 → 4); delete the stale, untracked `.agents/skills/msw/` in the
   primary checkout (it fails `pnpm test:scripts`'s mirror test there); whether to file an issue for the multi-spec
   re-stamp above.
6. **Farsight beyond Sentinel:** after the reference app's evidence is re-stamped, re-run the outsider demo (bar:
   confidence ≥ 8, no wrong answer on who approves or what makes an invoice Paid). The open viewer list is at the end
   of [history/viewer-passes.md](history/viewer-passes.md).

## Traps this week

- **Check `gh pr view <n> --json baseRefName` is `main` before every merge.** #239 squashed into #237's branch by
  mistake and had to be reverted there and re-landed as #245.
- **Known intermittent tests** — the Map pinch zoom (`map-zoom.pw.spec.ts:149`) and the ⌘K Map case
  (`map-keys.pw.spec.ts:222`) both reproduce on an unchanged `main`; CI's e2e on the same commit is the tie-breaker.
  Also the preparation-clock race (fixed at the boundary in #243), the owner-UI `/confirm` gate timeout, the
  `sentinel-isolation` OOM witness (#184) and the `preparation-publication-crash` readiness retry limit.
  Full list: [history/sentinel-v2.md](history/sentinel-v2.md).
- **Sentinel's npm source tests still hit #200** (the ESLint/uri-js closure refusal); #203 (test-file detection
  misses an import sharing a line with other code) is open beside it.
- **Bridge lanes (Sol):** a Codex session reads the lead's plain reply text at once, but a queued `send_message`
  only when its current turn ends — put rulings in the reply text; a turn can end with *model at capacity* mid-pass —
  resume it with "`git status` first"; `npm install -g build/x.tgz` without `./` is read as a GitHub shorthand.

## Before you switch providers

Rewrite the entries above rather than appending: branch, what changed, the checks you ran and their results, what
is unresolved. A dated record of the work goes to the top of its `history/` file.
