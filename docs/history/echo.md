# Echo — memory companion rounds

Archived from `docs/AI-HANDOFF.md` on 2026-10-28 (2026-10-13 → 10-17). Dated records, verbatim apart from
re-pointed relative links; read on demand, never loaded at session start. Index: [README.md](README.md).

## PR #104 review and main refresh — 2026-10-17

PR #104 remains open on `codex/echo-live-model`. The review branch `codex/pr-104-review` merged main
at `4bb662a` in `8eea360`; the only conflict was this handoff, resolved by retaining both sets of notes.
Review covered the model setup routes, saved/running selection, hook session and workspace isolation,
cancellation, retention limits, and model ownership through cancellation. No blocking code findings remained.

Local validation on the merged runtime: `pnpm build`, `pnpm typecheck`, `FARSIGHT_LIVE=0 pnpm test`
(1,539 unit tests and 19 script tests passed; two opt-in tracker tests skipped), `pnpm lint:strings`, and
`pnpm e2e --workers=2` (345 passed). Desktop and narrow Settings screenshots were inspected. The subsequent
changes only document required checks and this review; `actionlint`, title lint and `git diff --check` passed.
The final pushed tip must pass GitHub checks before merge. Live model acceptance below is earlier evidence,
not a rerun during this review. No deployed services, global installations or dogfood graphs were changed.

Main already required validate, e2e, secrets and commits, an up-to-date branch, and admin enforcement.
The review added affected checks and echo-package to branch protection and pinned all six checks to GitHub
Actions. `docs/CI.md` describes the resulting requirements; unaffected runtime jobs still skip explicitly.

## Echo model setup and configurable prompt research — 2026-10-13

- Work remains on `codex/echo-live-model`, PR #104, building on merged PRs #102 and #103.
- Model discovery/testing, running-versus-saved status, native Ollama context/retention controls and remote model configuration are wired into the real settings view. Setup checks and research share one process-level generation owner.
- `submind.hookResearch` defaults to `manual`; `background` explicitly enables prompt research and `wait` includes a compact sourced brief when ready within `hookWaitMs` (default 20000, bounded 100–60000). Settings and `configure --hook-research ... --hook-wait-ms ...` expose the choice. Timeout or insufficient context allowance returns a bounded session/workspace-bound handle instead of raw records. Refresh older workspace hooks once with `connect` for the longer timeout capacity; legacy definitions retain a short deadline. `brief` polls without inference; `cancel-brief` cancels; checked `memory.expand` actions read exact evidence. Jobs expire after five minutes and have bounded retention, no unbounded queue, retry deduplication and cancellation that retains model ownership until settlement.
- Repeated or exhausted searches now leave a permitted model decision for final synthesis, with an answer-only schema, checked citations and the original input/time limits. A hook whose handle cannot fit skips research before spending model work.
- Verified: workspace build/typecheck, `pnpm test` (including 234 Echo cases, plus the added legacy-hook deadline regression; live tracker cases remain opt-in), catalog lint, standalone package check, and 340 browser/MCP cases. Review covered stale settings cancellation, cross-session isolation, cached A/active B/repeated A supersession and tiny hook allowances.
- Live native Ollama acceptance: a prompt hook returned a 635-character handle in 64 ms; the configured model produced a cited brief in two model calls, one search and about sixteen seconds. Polling did not regenerate; the follow-up opened the exact saved evidence. The installed waiting hook also returned a sourced finding in about sixteen seconds within its 1200-character allowance; follow-up reads did not regenerate. Existing stored records remained unchanged.
- Memory capture, model-assisted writes/edits/deletes and shared-team authentication remain separate work. This iteration adds the intelligent search intermediary; it does not grant the research model write authority. Local private import receipts and live evidence stay outside tracked files.

## Echo sub-mind development round — 2026-10-13

Branch `codex/echo-submind`, based on `d6ff0c6`, implements the first bounded, read-only research path. This is
worktree validation, not a deployed runtime update. Existing live services and global installations were left alone.

- `packages/echo/src/submind.ts` researches the selected profile with off/mock/model modes, bounded searches,
  evidence, cumulative serialized model input, response size, age window and deadline. The optional configuration
  defaults to off. `ask` returns `echo-memory/v1` problem/fix/why findings with validated citations and typed
  `memory.expand` actions; `expand` rechecks scope and content revision without inference.
- `research-store.ts` reads the pinned agentmemory API and reports non-exhaustive coverage. `models.ts` supports
  native Ollama and a hosted/custom OpenAI-compatible gateway. HTTPS or an SSH loopback tunnel is preferred;
  literal RFC1918 HTTP requires explicit opt-in and refuses remote plaintext credentials. Configuration, CLI,
  private bridge, settings view, catalog strings, package map, security notes and setup docs were updated together.
- `submind-demo` uses a synthetic in-memory store without configuration, service, network or model. Mock research
  against a real store still requires that store. No real model, inference endpoint or memory engine was started
  during this round; model protocol checks used synthetic HTTP fixtures.
- Checks: `pnpm build`, `pnpm -r typecheck`, `FARSIGHT_LIVE=0 pnpm -r test` (1,395 passed; two live tracker tests
  skipped; Echo 145 passed), `pnpm test:scripts` (14 passed), `pnpm lint:strings` (3,137 entries), and `pnpm e2e
  --workers=1` (324 passed, isolated fixture ports). The Echo settings view was also checked at desktop and narrow
  widths against a synthetic fixture with no page or console errors. `pnpm pack:echo` and the bundled
  `submind-demo` passed with zero model calls and a successful evidence expansion.
- Left open: acceptance against a real configured model when compute is available; proactive curated hooks,
  capture and edits, the memory exploration portal, skills, caching, session/day quotas, team authentication and
  shared-service hosting. Installed hooks retain raw recall. Remote model support does not expose Echo itself as
  a remote service. Revisions detect content changes; they are not a durable history ledger. Full package runtime
  smoke was deliberately not run locally because it starts the memory engine.
