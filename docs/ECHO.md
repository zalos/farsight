# Echo: optional memory companion

Echo runs alongside an agent and can optionally embed its local memory and settings view in Farsight. It has its own installable package, process, configuration, and storage. Installing or running the normal Farsight CLI does not start Echo or require agentmemory.

The intended workflow is a small brief before each agent request, with source links and detail calls for further retrieval. Echo would use its own model to find and summarize relevant memories and configured skills, then capture useful memories as work proceeds. For example, a cold-storage shipping request could surface a few relevant past shipments and container decisions. Those memory claims remain separate from Farsight's code-derived graph.

## What this foundation includes

| Ready to configure and verify | Deferred |
|---|---|
| Separate personal and work profiles | Shared service authentication and team permissions |
| Workspace stores or one current-user global store connected to selected workspaces | Memory migration and combined local/global retrieval |
| Managed local or explicitly configured external agentmemory | Shared hosted deployment and synchronization |
| Configurable sub-mind through local/remote Ollama or a hosted compatible API; deterministic mock mode | Additional native providers, endpoint-specific live acceptance checks, and automatic provider selection |
| Standalone read-only memory portal with timeline cards, search, evidence detail, explicit research, and a settings tab; allowed Farsight embedding origin | Memory editing/deletion and a Farsight navigation entry |
| Explicit managed-memory saves, scoped recall, bounded prompt context, and explicit or opted-in background sub-mind research with follow-up evidence reads | Automatic capture and memory edits |
| Workspace hooks for Claude Code, Codex, and VS Code Local; optional Claude/Codex plugin preparation | Copilot Agent Host integration and automatic host trust |
| Configured skill directories | Skill discovery, installation, and execution |
| Synthetic save, search, restart, and isolation verification; isolated model-free portal preview | Production retention, daily/topic rollups, and memory mutation workflows |

## Install and configure

Use Node 24 or newer. For source development, use pnpm 9:

```sh
pnpm install
pnpm build
node packages/echo/dist/cli.js setup --scope workspace
```

For a standalone install, `pnpm pack:echo` creates `build/echo/farsight-echo-<version>.tgz`. Install that file with
`npm install --global` for one executable available across workspaces, or `npm install --save-dev` in one workspace
and invoke it with `npx --no-install farsight-echo`. Echo is packaged separately; these commands do not publish it.
Package location and memory scope are independent: a global executable can use workspace-only settings.

Interactive setup asks where memories live unless given `--scope` or `--config`. Workspace scope uses
`.echo/settings.json`; global scope uses `${XDG_CONFIG_HOME:-~/.config}/farsight-echo/settings.json`. Both keep
profile state beside that configuration; the executable is kept separately in a private user cache. Setup offers installed Ollama models, asks separately whether to install
each host's workspace hooks, and offers installation of the pinned local engine. Answers default to no for hooks
and engine installation. Accepting a hook question installs its workspace definitions and connection, rather than
only generating a plugin preview. If no model is installed, setup explains how to download one explicitly. Echo
does not choose and download a model silently.

For the first local test, choose an installed model, decline the host hook questions, and accept the engine
installation. Setup writes configuration; it does not start the settings view or backend. The `personal` and
`work` profiles are both created, but setup configures only the profile selected by `--profile` or `defaultProfile`.

For scripted setup:

```sh
farsight-echo init --scope workspace --model your-installed-model
farsight-echo install-runtime --scope workspace
farsight-echo doctor --scope workspace
farsight-echo serve --scope workspace
```

Commands accept `--scope workspace|global` or `--config <path>`, plus `--profile <name>`. Scope and an explicit
configuration are mutually exclusive. With neither, Echo discovers the nearest workspace connection or local
settings within the nearest Git boundary, including when called from a nested folder. A connection's profile is
used unless explicitly overridden; otherwise the configuration's `defaultProfile` applies. If there is no
connection or configuration, the expected local file is `.echo/settings.json` at the Git root, or at the current
directory outside Git. Global settings are never an implicit fallback. Explicit scope/configuration bypasses a
workspace connection. `init` refuses to overwrite an existing configuration. Use scrubbed examples as a reference;
local settings, connection pointers, and runtime state must stay outside version control.

Settings created by `init` or saved through setup/the web view are approved for the current user. Repository-supplied,
copied, moved, or manually edited settings require an explicit review followed by
`farsight-echo trust --config /absolute/path/settings.json --confirm`. No credential lookup, model request, or runtime
startup occurs before that approval. Trust receipts bind the canonical path and exact bytes in private user state
under `${XDG_STATE_HOME:-~/.local/state}/farsight-echo/`; a repository cannot supply its own receipt. Reconnect copied
or older-preview connections with `connect`. After upgrading, run `install-runtime` and `connect` with explicit `--scope global`, `--scope workspace`, or `--config PATH`
until reconnection approves the legacy pointer. Bare commands will refuse that untrusted pointer.

`serve` runs in the foreground and prints the memory portal URL. The view remains available if the model or memory service needs fixing. Stop with Ctrl-C; Echo shuts down only its own child processes. Externally managed memory services remain running. Restart `serve` after changing runtime settings so its active services use the saved configuration.

The default workspace personal portal URL is `http://127.0.0.1:4480`; work uses port `4481`. Selecting work in the settings
view edits that profile and does not switch the running service. Start `serve --profile work` in another terminal
to run its distinct store. Workspace backend base ports default to `4611` and `4711`. New global configurations
use web ports `4490`/`4491` and backend base ports `5211`/`5311`, allowing a global service to run alongside one
workspace service. Each managed instance also uses base plus 1, plus 2, and plus 46023. Use `init` or `setup` with
`--port` and `--backend-port` to set the selected profile's ports; additional independent stores need their own
available ports. Echo rejects configuration collisions and occupied runtime ports.

## One profile across selected workspaces

Global scope is a current-user configuration and store, not a hosted team service or automatic hooks in every
project. Install the executable once and configure the shared profile:

```sh
farsight-echo setup --scope global --profile personal
farsight-echo serve --scope global --profile personal
```

Install the managed runtime during setup, decline its hook questions for this walkthrough, and keep `serve`
running. In another terminal, select which workspaces use it:

```sh
farsight-echo connect --scope global --profile personal --host all --workspace /absolute/path/to/workspace-a
farsight-echo connect --scope global --profile personal --host all --workspace /absolute/path/to/workspace-b
```

`connect` installs hooks and a local `.echo/connection.json` pointer containing the selected configuration and
profile. It defaults to all hosts and the current workspace. The hooks pin the executable, configuration, and
profile with absolute paths. A connected workspace needs no package, backend, or store copy. Ordinary CLI calls
from that workspace follow the same pointer. One running profile serves both workspaces:

```sh
cd /absolute/path/to/workspace-a
farsight-echo remember --topic echo-sharing-test --content "The synthetic echosharedtest verification phrase is copper lantern."
cd /absolute/path/to/workspace-b
farsight-echo recall --query echosharedtest
```

The returned fact should contain **copper lantern**. After host trust and a fresh chat in workspace B, ask what
Echo remembers about `echosharedtest`, using only the hook context. This tests actual host delivery separately
from CLI recall. See the [README walkthrough](../packages/echo/README.md#share-memories-between-two-workspaces).

Each workspace chooses one profile. Reconnecting moves all already installed Echo host definitions to the same
target, including when `--host` selects only one new host. It does not merge retrieval scopes or migrate memory.
An existing local configuration and store stay in place; use `--scope workspace` to select them, or reconnect with
`connect --scope workspace` from that workspace to make them its default again. Start a new host session after
reconnecting. Separately loaded Echo plugins must be removed or updated so they do not keep using the old target.

## Profiles and identity

A profile selects one individual, optional team, project, memory connection, model connection, web port, and hook preference. Personal and work profiles use distinct local stores. Within one configuration directory, a host session is bound to its selected profile and its identity/store/model configuration. Changing that boundary requires a new host session; an existing session cannot silently switch to another profile. Keep personal and work profiles in the same configuration file so their bindings use the same registry.

Workspaces share memory only when they select the same configuration and profile. Matching profile names in
separate configurations do not share data. `identity.project` is a memory namespace; it is not inferred from the
calling workspace's path. New global configurations use `shared` for that label, and all connected workspaces use
the profile's configured identity. Changing the identity changes the lookup namespace rather than relabeling or
migrating old memories.

These identity fields are local routing metadata. They are not login, membership verification, or authorization. Run separate local instances in this phase. Do not treat an agentmemory project filter as a security boundary between teams, and do not expose the local settings service as a shared team service.

| Configuration area | Purpose |
|---|---|
| `identity` | Individual, optional team, and project labels |
| `backend` | Managed or external agentmemory connection and credential reference |
| `model` | Ollama or OpenAI-compatible provider, endpoint, model, and optional credential reference |
| `web` | Local port and optional exact Farsight origin allowed to embed the view |
| `hooks` | Whether each host may bind sessions and use prompt recall; installation is separate from host trust |
| `skills.directories` | Explicit future skill sources; no installation or execution |
| `budget` | Individual model timeout, per-response generation limit, and final brief character limit |
| `submind` | Optional off/mock/model mode and per-request research, age, evidence, total input, deadline, and expansion limits; absent means off |

Credentials are references to local secret storage, never literal keys in settings. The settings view must not return credential values. A Farsight embedding origin permits framing the view; it does not grant access to memory or connect the two graphs.

External backend setup uses a service origin and an optional `keychain:farsight-echo/<account>` reference. For example,
`keychain:farsight-echo/example` reads service `farsight-echo`, account `example`, from macOS Keychain or Linux Secret
Service. Provision the secret through that local store, select external mode, save, restart Echo, and run `doctor`
for the selected profile. The connection must report agentmemory 0.9.30. No general external-backend write test is
provided; smoke intentionally requires managed mode. Each credential reference is pinned in private user state to
its first approved origin; another origin requires another account. Other keychain services and environment
credential references are refused before reading any secret. Echo and the work adapters share the bounded OS
keychain transport, while retaining their separate reference and origin policies.

The memory bridge permits explicit writes only to managed profiles. In this published backend, remember's
supersession behavior can reach legacy unscoped records, so Echo refuses external writes. External recall is kept
to the exact Echo namespace and individual scope; it does not import existing unscoped memories.

Use a service origin as the model address, without a path: Ollama uses its chat API, and the compatible adapter
uses `/v1/chat/completions`. Compatibility is tested with a local fixture; each hosted provider still needs its own
connection check. Ollama summaries use a structured response so thinking text is not mistaken for a brief.
The final summary is capped by characters; this is not a claim about the main agent's exact token count.

## Read-only memory portal

Normal `serve` serves the local **Memories** view at the configured web port. Open the URL it prints. It presents saved records as timeline cards, grouped by their saved date in UTC, and shows known workspace provenance alongside excerpts. An explicit search queries the store; inclusive UTC start/end dates narrow the results. The topic menu uses actual saved concepts from loaded records only. Browsing and exact record reads never invoke the sub-mind.

Each request remains bound to the running profile, identity, store, and policy. Selecting a different profile in **Settings** edits saved configuration but never switches the memory view. Unsaved edits survive tab switches. The web server checks trusted settings and the startup fingerprint before and after every asynchronous memory request; a changed running configuration requires a service restart. Another profile’s edits do not become a memory selection.

Browse responses use `echo-portal/v1`, with the running scope, saved records, an opaque continuation, clipping/coverage flags, and a per-response `Counted`. Pages request up to 50 records. Only an oversized upstream response causes the same selection and continuation to retry at 10, then one record, within a shared deadline. Transport is capped at 2 MB; returned title/content/topic text shares a 64,000-character allowance. Dates are filtered after the upstream page, so an empty page can still have a continuation. Counts describe each response before the browser’s loaded-topic filter, not an overall inventory; the UI hides them during topic filtering. Pagination is not a stable snapshot and coverage remains non-exhaustive, including when the final continuation is empty. Queried search still inherits upstream’s global candidate ranking limit.

Selecting a card follows its ID and content-bound revision through the existing expansion contract. Detail shows current saved evidence and provenance, with explicit changed, missing, and shortened states. Historical revisions are not retained by this contract. The browser renders memory and model text literally and only follows checked `memory.expand` actions; it does not invent a relation graph or execute model-provided links.

**Ask sub-mind** is separate from ordinary search. Off leaves browsing available and disables research; mock returns labeled deterministic excerpts; model mode uses the selected local or remote provider. Results show problem/fix/why and checked citations. **Read more** is an exact evidence read without inference. Cancellation or leaving the Memories tab aborts active requests, and late responses are ignored. Loading the page, searching, and saving settings do not generate a model response. Memory edits, deletion, and automatic capture remain deferred.

### Isolated preview

```sh
node packages/echo/dist/cli.js portal-demo
# Installed package:
farsight-echo portal-demo --port 0
```

The default is port `4491`; `--port 0` asks the operating system for an available port. Open the URL printed by the command. This uses the real portal and private memory bridge with synthetic in-memory records and mock research. It starts no model, agentmemory worker, or engine, and does not read an existing Echo configuration or memory store. Configuration and trust state are temporary, the **Synthetic preview** banner is visible, and settings are read-only. Ctrl-C closes both listeners and removes temporary state. It provides a low-resource interaction preview, not a persistence or model-quality test.

## Saved model setup and live operation

Settings can discover installed models from a saved Ollama endpoint and run one explicit synthetic structured-generation test. These actions read the selected saved profile, require its current settings revision, and do not depend on the memory backend. Discovery never generates or downloads. A test runs even when research is off or mock because it is an explicit request to use the model. Compatible endpoints use a manually entered model name. CLI equivalents are `models` and `model-test` with the ordinary scope/profile selectors.

The running model identity and a restart indicator distinguish a successful test of saved settings from the currently running service. Saving does not start generation or hot-switch an active profile. Restart that profile's `serve` to apply runtime changes, then use the real Memories view and explicit sub-mind question. `portal-demo` always remains synthetic and disables live setup actions.

Optional `model.ollama` settings contain `contextTokens` (2,048–131,072) and `keepAliveSeconds` (0–3,600), both required when the object is present. Effective defaults are 4,096 tokens and zero retention; legacy configuration files need no rewrite. Native Ollama requests include those values, while compatible requests omit them. Context capacity, serialized-input character allowance, and output allowance are distinct controls. Changing resource settings changes the session selection and requires a new service/host session.

## Sub-mind research and remote inference

The sub-mind is an optional read-only curator invoked by `ask --query TEXT`, the portal’s **Ask sub-mind** action, or opted-in background prompt research. In Settings, choose **Prepare a brief in the background** under **Prompt memory research** (`submind.hookResearch: "background"`), restart Echo, and start a fresh host session. Hooks then return a small session-bound handle; `brief` fetches the curated result without further inference. Raw evidence stays inside Echo. See the [background research walkthrough](../packages/echo/README.md#let-the-sub-mind-handle-prompt-memory-research) for polling, cancellation and limits. Missing policies keep manual lookup for compatibility.
It defaults to off, so an existing installation does not begin making model requests after upgrade. Mock mode
searches the selected memory store and produces labeled deterministic excerpts without model calls. Model mode
uses the profile's configured endpoint to research and summarize evidence. There is no fallback to another endpoint.

The selected question and evidence may leave the machine in model mode. Memory storage and inference locations
are independent: the memory backend can remain local while a desktop Ollama service or hosted compatible model
performs inference. This milestone does not host the full Echo service remotely or expose the localhost portal.

The settings view edits mode and limits without inference. It displays the running mode separately from saved
configuration. Saving and restarting applies the mode. Generation occurs on explicit research, opted-in background prompt research, **Test model**
in Settings, `model-test`, or the optional `smoke --with-model` check. These explicit model checks make a real model
call even when research mode is off or mock.

The policy defaults are `mode: off`, `maxSteps: 3`, `maxSearches: 3`, `maxCandidates: 12`,
`evidenceMaxChars: 12000`, `inputMaxChars: 48000`, `lookbackDays: 90`, `timeoutMs: 30000`, and
`expandedMaxChars: 12000`. Search history is based on recorded save timestamps, not a claim about when the event
actually occurred. Research allowances are independent of the initial brief limit; the total serialized input
allowance counts repeated evidence on subsequent model calls. These are per-request controls, not session/day
quotas or currency spending guarantees. Proactivity controls, capture, caches, and memory editing are later milestones.
The read-only exploration portal is available now.

The versioned `echo-memory/v1` result includes problem/fix/why findings, exact content citations, typed follow-up actions, non-exhaustive coverage, and per-request usage. The brief allowance bounds findings plus actions; envelope metadata is additional. `expand --id ID --revision HASH` reads more of the cited
record without inference while rechecking scope and content revision. Echo constructs the actions; models cannot
supply arbitrary executable URLs or commands. This is a discoverable-action contract inspired by hypermedia,
without requiring agentmemory or the tool client to implement HAL.

Configure models using service origins. An HTTPS gateway such as `https://models.example.com` with provider
`openai-compatible` must implement `/v1/chat/completions`; do not put `/v1` in the origin. For remote Ollama,
prefer HTTPS or a localhost tunnel such as `ssh -N -L 11435:127.0.0.1:11434 user@desktop.example`, then configure
`http://127.0.0.1:11435`. Echo does not start Ollama, download models, or manage that remote process.

An existing private-network API can instead use a literal RFC1918 address such as `http://192.168.1.20:11434`
with the explicit model setting `allowInsecureHttp: true`. Only canonical RFC1918 IPv4 addresses qualify. Remote plaintext credentials are refused, and public
HTTP addresses and remote DNS names do not qualify. Questions and evidence are unencrypted on that connection;
HTTPS or SSH provides transport encryption. Backend address rules remain unchanged. Real deployment acceptance
must be run separately when model compute is available; current protocol and research checks use synthetic fixtures.

For a fully isolated model-free demonstration, run `farsight-echo submind-demo`. It uses an in-memory synthetic
fixture, needs no configuration or running service, and starts no memory backend or model. See the
[README](../packages/echo/README.md#configure-the-sub-mind-and-its-remote-model) for setup examples and commands.

## Memory runtime and storage

The dependency is pinned to published `@agentmemory/agentmemory` **0.9.30**, with native **iii engine 0.22.1**. Managed mode installs the engine under `~/.cache/farsight-echo/runtime/0.22.1/<platform-architecture>/` after verifying the pinned archive checksum, records the binary hash, verifies it before every execution, and launches the released worker with an explicit environment and profile-specific storage. It does not use upstream's interactive onboarding or modify upstream's global hook settings. Native managed mode supports macOS and Linux on arm64 and x64. An external backend may be hosted elsewhere, but Echo's local memory bridge and hook integration currently target macOS/Linux.

Managed mode refuses to start if `~/.agentmemory/.env` exists: this release reads that file globally and provides no override. The refusal prevents unintended inheritance across personal and work contexts. Use a deliberately isolated external instance when that global configuration is needed elsewhere.

Managed backend credentials are generated in memory for each run; a managed profile does not accept a credential
reference. An external profile may resolve its explicit keychain reference and must report the supported
agentmemory version. Echo never adopts an existing process on its configured ports. After a crash, a verifiably dead owner lock is recovered; occupied ports still cause refusal. Live, malformed,
or symlinked owner locks require inspection. Do not delete the memory store.
Normal termination and interrupted CLI smoke tests close the owned children and remove the lock.

Source workspace installs include agentmemory's dependency tree, with dependency lifecycle scripts permitted only
for esbuild. The normal Farsight artifact remains independent.

Managed mode disables consolidation, scheduled automatic forgetting, and lesson/insight decay. Similar new saves can still supersede earlier facts. Upstream still owns
maintenance; normal restart persistence is tested, but long-term retention is not established.

Agentmemory persists its records through iii's file-backed state store. Echo's memory data is runtime state, not a Git merge format. Commit scrubbed configuration examples and documentation; do not commit live stores. External mode connects to an instance the user manages and does not start or stop it. A future hosted team service will need authentication and enforced tenant boundaries.

Search ranking remains an upstream limitation: the pinned backend ranks up to 500 candidates across its store
before applying the exact identity filters. A crowded shared backend can therefore omit a matching scoped memory.
Use dedicated instances for this preview; bounded excerpts and exact filtering do not establish exhaustive recall.

Agentmemory can store and search without an external model API. The backend handles storage and recall; Echo’s selected model handles sub-mind research in model mode and the optional synthetic summary check. Manual prompt lookup makes no model call; opted-in background research can use the configured model once per new prompt, within its request limits. Engine/package installation requires downloads. Local model inference does not require a hosted model API. Research spends sidecar compute, and the brief delivered to the main agent consumes its context. Mock research performs no inference.

## Memory access and isolation

`serve` starts a filesystem-protected local memory bridge alongside the memory portal and settings view. The bridge uses a Unix socket
under a current-user-only temporary directory on macOS/Linux, with owner-only socket access. It holds backend
credentials in memory. The web server exposes guarded local read-only browse, expand, and ask routes;
there is no memory mutation route. Expansion and research use the same private bridge as the CLI. Local callers connect with a
fingerprint of the configuration path, profile, data path, identity, backend, and model. A stale caller is refused;
restart the service and use a new host session after changing those boundaries.

Memory scope hashes the selected project, profile, individual, and team into a namespace, with a separate individual
filter. Recall checks that exact scope after backend lookup. This avoids mixing similarly named profiles or
upstream legacy unscoped results; it does not turn identity labels into authenticated tenant permissions. Changing
identity changes the lookup namespace and does not migrate earlier memories.

Keep the selected managed `serve` process running, then explicitly save and retrieve a test fact:

```sh
farsight-echo remember --profile personal --topic echo-test --content "The synthetic echocoldtest shipment uses a blue insulated test container."
farsight-echo recall --profile personal --query "echocoldtest" --limit 3
```

Remember returns `{id, createdAt}`. Recall returns `{memories, truncated}`; each memory contains its backend source
`id`, `title`, `content`, `timestamp`, and historical `provenance`. New saves record the calling workspace, HEAD
revision when available, and server save time in a content-bound local record; legacy or changed records report
unknown provenance. Hook output explicitly labels this as memory, not current code evidence. Credential-shaped
content and topics use the same refusal predicate as pinned lessons, without echoing the value. `--topic` is repeatable and maps to concepts metadata. The portal offers UTC saved-date navigation and
filters the loaded results by those stored topics; it does not generate topic labels. Recall returns at most five records and caps combined title/content at `budget.briefMaxChars`.
The released backend supplies ranking; it is keyword-based unless that backend has embeddings. Echo does not call
Ollama to rerank or summarize these results.

Unlike the disposable smoke test, this explicit remember command writes to the chosen persistent managed store.
It remains after a normal restart. There is no implicit conversation import or automatic capture of prompts, tool
results, or responses.

## Optional host hooks

Package installation does not prompt or install hooks. `setup` asks about workspace installation. To generate
reviewable plugin files without installing workspace definitions, use:

```sh
farsight-echo hooks --host claude --profile personal
farsight-echo hooks --host codex --profile personal
```

Each command creates reviewable files under `plugins/<profile>/<host>/` beside the selected configuration and prints loading instructions. The runner forwards event input to Echo with a fixed configuration and profile. Preparing files does not install them in a host.

The prepared events are `SessionStart` and `UserPromptSubmit`; capture events are not registered yet. Hook commands have short time limits. Hooks currently target macOS and Linux. Keep the installed Echo executable and configuration at their generated locations, or prepare the plugin again after moving them.

For Claude Code, review the generated files and start a new session with `claude --plugin-dir <generated-directory>`. Claude discovers `hooks/hooks.json`; the manifest does not register it a second time. See [Claude plugin manifests](https://code.claude.com/docs/en/plugins-reference) and [hook events](https://code.claude.com/docs/en/hooks).

For Codex, review the generated files and register their local marketplace with `codex plugin marketplace add <generated-directory>`. Restart the desktop app, install the plugin from that marketplace, and review and trust its hooks. Marketplace registration, plugin installation, and hook trust are separate steps. Admin policy may prevent non-managed hooks. See [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) and [Codex hooks](https://learn.chatgpt.com/docs/hooks).

For direct workspace installation instead of plugin preparation, use `connect` as above or:

```sh
farsight-echo hooks --host all --install --workspace /absolute/path/to/workspace --profile personal
```

The installer merges Echo-owned definitions into Claude's `.claude/settings.local.json`, Codex's `.codex/hooks.json`,
and VS Code Local's `.github/hooks/echo.json`. It preserves unrelated settings, records original bytes in private
user-state restoration journals, and refuses malformed existing files before writing. Before writing generated
files it adds local Git exclusions and refuses tracked targets or ignore overrides. Individual host selection is
available with `claude`, `codex`, or `vscode`. Without `--install`, `all` prepares all three hosts' files only.
`hooks --install` requires `--workspace` and records the same workspace connection as `connect`. The generated
definitions and connection contain machine-local absolute paths; keep them untracked rather than treating them
as portable team settings. Installing global Echo settings does not install host-global hooks.

Claude's workspace settings apply to its CLI and VS Code extension. Codex still needs the project and exact hook
definition trusted; enable hooks and use `/hooks` in its CLI for review. VS Code support targets Local chat, with
workspace trust and `chat.useHooks` enabled, not Copilot Agent Host. The installer refuses duplicate discovery through `chat.useClaudeHooks` rather than changing
editor preferences. See [VS Code's hook guide](https://code.visualstudio.com/docs/agent-customization/hooks).

`SessionStart` establishes the session binding and supplies bounded memory-access instructions. `UserPromptSubmit`
uses the prompt as a scoped lookup. Manual mode returns bounded excerpts without a model call. Background mode submits bounded sub-mind research and returns a complete follow-up handle instead of raw evidence; if the handle cannot fit, research is skipped before any model work. Prompt callbacks reference the session access command without repeating absolute paths. If the service is unavailable, hooks fail
open and the host continues without memory context. They do not automatically save the prompt or the response.
The complete injected context, including instructions and record metadata, is capped at `budget.briefMaxChars`.
Omitted or shortened results print “More matched; not shown.”
This is stricter than CLI recall's title/content cap and is still a character budget rather than an exact token count.

Enable one Echo profile per host session and choose one integration route per host. A prepared or installed
definition is not evidence that the host loaded it. Start `serve`, explicitly save the synthetic fact above, confirm
CLI recall, and ask a fresh trusted host chat what Echo remembers about `echocoldtest`. The expected stored fact is
the blue insulated test container. A file under the selected configuration's `sessions/` proves a binding callback only; it does not prove
that prompt recall succeeded. The settings view's hook preferences do not install definitions or grant host trust.

`farsight-echo disconnect --workspace /absolute/path/to/workspace` removes marker-owned hook entries and the
connection pointer, preserving memory stores. Unchanged files are restored byte for byte to their pre-install
state (new files are removed); later unrelated edits remain. Separately loaded plugins must be removed in the host.

## Verify the setup

```sh
farsight-echo doctor
farsight-echo smoke
farsight-echo smoke --with-model
```

`doctor` checks the selected setup and external backend identity/version when applicable. It checks Ollama model availability only in model mode; off, mock, and legacy profiles do not require a model endpoint.
For a managed profile it checks prerequisites without starting the backend; use the running settings view's checks
or smoke to verify readiness.
For compatible model endpoints it checks selection only; use `smoke --with-model` to verify an actual call.
The settings view also reports runtime readiness. `smoke` selects separate available ports and starts a disposable
managed store, saves and searches synthetic text, restarts on changed ports, checks persistence, then checks that a
fresh store cannot find that text. It can run in another terminal alongside `serve` and leaves the running profile's
store untouched.
`--with-model` also asks the configured model for a short synthetic summary. Smoke verification does not write to
an external backend or a personal/work memory store. Failed checks retain synthetic diagnostics in a temporary
directory; successful checks remove it. `pnpm test:echo:package` verifies the installable artifact without a model.
The model step summarizes the synthetic sample directly after the retrieval assertions; it verifies the model
connection independently and does not implement an agentic retrieve-and-summarize pipeline.

Successful output includes `remember-recall`, `restart-persistence`, and `store-isolation` with `ok: true`; the model
option adds `model-summary` and its short synthetic summary. In the web view, test saving a harmless setting and
reloading it. Restart the service to apply runtime changes. Conflicting settings edits are refused, so reload before
reapplying a change when another editor saved first.

The smoke result demonstrates package wiring and persistence. It does not establish retrieval quality, host-hook activation, shared-team security, or production summarization behavior.
