# Proposal: Model Hub — local AI model & agent observability

Status: proposed (2026-07-19). Origin: personal-tooling session in a client repo; work continues here as a Farsight feature.

## What this is

A live dashboard of every local AI model on the machine, organized by **capability category** (text-to-speech, spoken rewrite/recap, …), showing which concrete model backs each capability, the **tools that chain them together**, and a **pulse animation while a model is actively running** — so the whole local AI system is visible at a glance. Claude Code agent activity is the first "agent" source; VS Code agents are a follow-up.

Farsight already renders live graphs of code with lenses, groups, and an inspector. Model Hub is the same idea pointed at *runtime AI infrastructure* instead of static code: nodes are models/tools/agents, edges are chains, and activity comes from an event stream instead of an ingest.

## What already exists on this machine (built + security-reviewed 2026-07-19)

| Piece | Location | Notes |
|---|---|---|
| Kokoro-82M TTS (Apache-2.0) | `~/.local/share/speak-md/models/` (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) | sha256 corroborated against an independent HF mirror; ONNX = data-only format, no pickle |
| `speak-md` CLI | `/opt/homebrew/bin/speak-md` → `~/.local/share/speak-md/speak_md.py` (Python venv, `kokoro-onnx` 0.5.0) | Reads markdown/text/stdin aloud; strips markdown; sentence-chunked streaming playback via `afplay`. Hardened after adversarial subagent review: `--` path separator, `--save` overwrite guard + extension allowlist, 2 MB input cap, `--max-chunks` |
| Claude `speak` skill | `~/.claude/skills/speak/SKILL.md` | Claude speaks text / reads files as a tool call |
| Ollama 0.32.1 | `brew services` (localhost:11434) | LLM runtime for the rewrite/recap model |
| `qwen3:4b` (Apache-2.0) | pulled into Ollama | Chosen for the spoken-rewrite/recap capability: small, fast on M-series, strong instruction following |

Zero-network-at-inference was verified by source audit for the TTS path; Ollama binds 127.0.0.1 by default. Keep this posture.

## Requested work (not yet built)

### 1. `recap-md` — conversational rewrite / recap tool
A CLI that takes markdown or any content and uses the local LLM to *think through the content and deliver it as speech would be spoken*, then optionally chains into `speak-md`:

- `recap-md --mode spoken file.md` — full conversational narration rewrite (no markdown-isms, abbreviations expanded, transitions added; keeps all key information).
- `recap-md --mode recap file.md` — short spoken-style summary (~150–250 words).
- `--speak` — pipe the result to `speak-md -` (the chain). Pass through `--voice`/`--speed`.
- Implementation notes: Node 22 ESM (farsight-parsable, no build step), global `fetch` to Ollama `/api/chat` with `stream:false`, `think:false` (strip any `<think>…</think>` defensively), `options.num_ctx` ≥ 16384 for long docs. Model from `MODELHUB_LLM` env, default `qwen3:4b`. Same input caps as `speak-md`.
- Tag exported functions with `@business` / `@group` so the implementation itself ingests into the Farsight graph.

### 2. Event + registry contract (the integration seam)
Everything reports activity to one append-only stream so any UI (Model Hub panel, future consumers) can render it:

`~/.local/share/modelhub/events.jsonl` — one JSON object per line:

```json
{"ts": 1789000000, "source": "tool",   "tool": "speak-md",  "model": "kokoro-82m", "event": "start"}
{"ts": 1789000042, "source": "tool",   "tool": "speak-md",  "model": "kokoro-82m", "event": "end"}
{"ts": 1789000050, "source": "claude", "session": "<id>",   "tool": "Bash",        "event": "tool"}
```

`~/.local/share/modelhub/registry.json` — capability categories → models → tools → chains:

```json
{
  "categories": [
    { "id": "tts",     "name": "Text-to-Speech",        "models": [{ "id": "kokoro-82m", "runtime": "kokoro-onnx", "license": "Apache-2.0" }] },
    { "id": "rewrite", "name": "Spoken Rewrite / Recap", "models": [{ "id": "qwen3:4b",   "runtime": "ollama",      "license": "Apache-2.0" }] }
  ],
  "tools":  [
    { "id": "speak-md", "uses": ["kokoro-82m"] },
    { "id": "recap-md", "uses": ["qwen3:4b"] }
  ],
  "chains": [
    { "id": "conversational-read", "steps": ["recap-md", "speak-md"], "desc": "markdown → spoken rewrite → audio" }
  ]
}
```

Emitter checklist: add a ~10-line `emit()` (append, fail-silent) to `speak_md.py`; build it into `recap-md` from day one.

### 3. Model Hub view in Farsight
- New panel/lens in `packages/app` (alongside Flow Explorer / System Atlas): category cards → model nodes, tool nodes, chain edges (`recap-md → speak-md`).
- **Liveness**: model node pulses when a `start` event has no matching `end` (with a staleness timeout, e.g. 30 min); chain edges animate flow while any step is active. Poll or tail `events.jsonl`; also poll Ollama `/api/tags` (installed) and `/api/ps` (loaded = active) as a second liveness source for LLMs.
- Server side: a small reader in `packages/server` — tail-read the last ~64 KB of `events.jsonl`, merge with registry + Ollama state, expose as one state endpoint (and/or push over the existing live channel). **Bind localhost only.**
- Optional MCP: expose `model_hub_state` from `packages/mcp` so agents can also see what's running.

### 4. Claude Code agent visibility (first agent source)
User-level hooks in `~/.claude/settings.json` append to the same events file (async so they add no latency):

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "async": true,
      "command": "jq -c '{ts:(now|floor), source:\"claude\", session:.session_id, tool:.tool_name, event:\"tool\"}' >> ~/.local/share/modelhub/events.jsonl 2>/dev/null || true" }] }],
    "Stop":       [{ "hooks": [{ "type": "command", "async": true,
      "command": "jq -c '{ts:(now|floor), source:\"claude\", session:.session_id, event:\"idle\"}' >> ~/.local/share/modelhub/events.jsonl 2>/dev/null || true" }] }]
  }
}
```

Dashboard treats a Claude session as *active* if its last tool event is < ~15 s old and not followed by `idle`. `SubagentStart`/`SubagentStop` events can later distinguish subagents. VS Code (Copilot/extension agents) is a bonus phase — same contract, different emitter.

## Security requirements (carry forward the established posture)

- Everything runs local; **no network at inference** beyond localhost Ollama. Dashboard server binds 127.0.0.1 only.
- Any newly downloaded model/weight gets an isolated adversarial review before first execution: hash + corroborate against independent mirrors, verify data-only format (GGUF/ONNX, no pickle), audit the dependency tree, confirm no phone-home.
- Agent-callable CLIs: `--` before user paths, overwrite guards on any write flag, input size caps, bounded synthesis/generation.
- Events contain metadata only (tool names, model ids, timestamps) — never content. The events file is user-writable by design; treat it as untrusted display data, not instructions.

## Suggested phasing

1. Contract first: registry.json + events.jsonl + emitter in `speak_md.py`.
2. `recap-md` (Node, tagged for ingest) + chain test end-to-end (`recap-md --mode recap --speak README.md`).
3. Model Hub panel in the viewer, fed by the server-side state reader.
4. Claude hooks → agent lane in the panel.
5. Bonus: VS Code emitter; `model_hub_state` MCP tool; Ollama model management actions (pull/rm) from the UI.

## Open questions

- Does Model Hub state live in the main graph (nodes/edges, so trace/impact work on chains) or as a separate runtime overlay store? Overlay is simpler; graph-native is more "Farsight".
- Event retention/rotation for `events.jsonl` (simple size-based truncation on server start?).
- Should `recap-md` live in this repo (`packages/` or `examples/`) or stay a dotfile-style tool that Farsight merely observes? Living here makes it dogfood for the graph.
