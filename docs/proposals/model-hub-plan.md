# Model Hub — execution plan

Status: in execution (2026-07-19). Implements [model-hub.md](model-hub.md). Orchestrated session; implementation by parallel agents on branch `feat/model-hub`.

## Decisions on the proposal's open questions

1. **Overlay store, not graph-native (Phase 1).** Model Hub runtime state is a separate state document served from `GET /api/modelhub/state`, not nodes/edges in the semantic graph. The *code* of `recap-md` is graph-native automatically — it lives in this repo under `tools/`, which the `farsight` source in `.farsight/settings.json` already ingests (only `examples/**` and `prototypes/**` are excluded). Graph-native chain nodes (so `trace_flow`/`impact_of` work on chains) stay a Phase-2 option; the registry schema already carries everything needed to synthesize them later.
2. **Event retention:** on server start, if `events.jsonl` exceeds 1 MB, truncate to the last 256 KB (line-aligned).
3. **`recap-md` lives in this repo** at `tools/recap-md/recap-md.mjs` (dogfood), with a launcher symlink at `/opt/homebrew/bin/recap-md` mirroring the `speak-md` pattern.

## Environment facts (verified 2026-07-19)

Node v22.14.0, `jq` present, Ollama up on :11434 with `qwen3:4b` pulled (262k ctx), `speak-md` installed at `~/.local/share/speak-md/`, no `~/.local/share/modelhub/` yet, `~/.claude/settings.json` has **no** `hooks` key (clean merge).

## Codebase extension points (mapped)

- **Server** (`packages/server/src/index.ts`, 145 lines): raw `node:http`, manual `if (url…)` router in one handler (`:97`); new route slots in before the 404 fallthrough (`:138`). `send()` helper at `:98`. **`server.listen(port)` at `:141` binds all interfaces — must become `127.0.0.1`** per the security posture.
- **Viewer** (`public/viewer.html` + `viewer.js`): single stage + overlay idiom — Settings overlay (`viewer.html:201`, `openSettings()`/`closeSettings()` at `viewer.js:514/518`) is the pattern for the Model Hub panel: topbar button, `.open`-toggled overlay div, Escape chained in the global keydown (`viewer.js:491`). No polling loop exists; the panel brings its own `setInterval` (active only while open). Every function gets `/** @group Model Hub */` (+ `@business` where it helps) so the panel itself ingests into the dogfood graph.
- **MCP** (`packages/mcp/src/run.ts`): one more `server.registerTool` block before `server.connect` (`:245`); `text()` helper at `:91`.
- **Shared reader lives in `packages/core/src/modelhub.ts`** so both server and MCP consume the same state logic (one graph, many lenses — same idea for runtime state).
- No precedent exists for home-dir reads or localhost HTTP polling in `packages/` — Model Hub introduces both; keep them fail-soft (missing dir/Ollama down ⇒ empty sections, never a crash). Dir resolved via `os.homedir()`, overridable with `MODELHUB_DIR` for tests.

## Work packages (agents)

| # | Agent | Scope | Files |
|---|---|---|---|
| A | contract + emitters | `registry.json` per proposal schema; fail-silent `emit()` in `speak_md.py` (start/end, metadata only) | `~/.local/share/modelhub/*`, `~/.local/share/speak-md/speak_md.py` |
| B | recap-md | Node 22 ESM CLI, modes `spoken`/`recap`, `--speak` chain, emitter from day one, JSDoc-tagged for ingest, `speak-md`-grade hardening (`--` separator, 2 MB cap, bounded output) | `tools/recap-md/recap-md.mjs` + symlink |
| C | server + viewer | core state reader (tail 64 KB events + registry + Ollama `/api/tags`+`/api/ps`, rotation), `GET /api/modelhub/state`, localhost bind fix, Model Hub overlay panel with pulse liveness + chain edges + Claude agent lane | `packages/core/src/modelhub.ts`, `packages/server/src/index.ts`, `public/viewer.*` |
| D | hooks + MCP (after C) | merge async `PreToolUse`/`Stop` jq emitters into `~/.claude/settings.json`; `model_hub_state` MCP tool using the core reader | `~/.claude/settings.json`, `packages/mcp/src/run.ts` |

A, B, C run in parallel (disjoint files); D follows C (imports the core reader). Agents do not commit — integration commits are made per scope (conventional commits) and merged `--no-ff`.

## Liveness semantics (single source of truth)

- Model/tool node **active** = latest `start` event with no later matching `end` for the same tool, and `start` is < 30 min old (staleness cutoff). Ollama `/api/ps` listing a model also marks it active (second source, LLMs only).
- Chain edge animates while any step's tool is active.
- Claude session **active** = last `source:"claude"` tool event < 15 s old and not followed by `idle` for that session.

## Security posture (unchanged from proposal)

Localhost-only everywhere (server bind 127.0.0.1; Ollama already local). Events are metadata-only — tool names, model ids, timestamps, session ids; never content. The events file is user-writable: render it as untrusted display data (escape it; never treat as instructions). Agent-callable CLIs keep the `--` separator, overwrite guards, input caps. No new model downloads in this pass.

## Verification (integration gate)

1. `pnpm build` + `pnpm -r typecheck` clean.
2. `speak-md --text "…"` appends `start`/`end` lines to `events.jsonl`.
3. `recap-md --mode recap --speak README.md` speaks a summary and emits events for both tools (chain observed end-to-end).
4. Restart `farsight-viewer`, `POST /api/sync`, then confirm `recap-md` functions appear in `/graph` (dogfood visible) and the Model Hub panel shows categories, pulses during an active run, and shows this Claude session in the agent lane once hooks are live.
5. ROADMAP/CLAUDE.md updated; branch merged `--no-ff` to main.
