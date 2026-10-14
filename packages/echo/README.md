# Farsight Echo

Echo is an optional, independently running memory companion for Farsight. It has its own package, settings, model connection, and memory stores. The regular Farsight CLI does not need Echo or agentmemory.

**This iteration supports explicit memory storage, scoped recall, a read-only memory portal, and an optional sub-mind for memory research.** With `serve` running, you can save a memory, retrieve it from the CLI, or ask the sub-mind for a concise sourced brief with programmatic follow-up actions. The sub-mind can use a local model, a remote Ollama desktop, or a hosted OpenAI-compatible endpoint. It defaults to off; mock mode exercises the research flow without model inference. Host hooks support manual lookup or explicitly enabled background sub-mind research. Background hooks return a session-bound handle rather than raw evidence. The portal searches saved records and shows their source evidence. Automatic conversation capture and memory editing come later.

Choose a **workspace store** for memories kept with one project, or a **global store** for your own memories shared across selected workspaces. Each workspace connects to one profile at a time. Two workspaces connected to the same global configuration and profile read and write the same memory store.

## Prerequisites

- **Node 24 or newer.** Source development also requires **pnpm 9.0.0**.
- **macOS or Linux, arm64 or x64**, for the managed memory runtime. The local memory bridge, hooks, and credential-store integration target macOS/Linux in this iteration. An external backend can be hosted elsewhere.
- **A model endpoint only when using model mode or the optional model test.** Use an existing Ollama text model locally or remotely, or a hosted compatible endpoint. No model is needed for the synthetic demo, mock research, or raw recall. Echo never installs or starts Ollama and never silently downloads a model.
- Network access for initial package and engine downloads. The local memory and Ollama path does not require a hosted model API key.

The package pins `@agentmemory/agentmemory` to **0.9.30** and the iii engine to **0.22.1**. Echo verifies the downloaded archive against its pinned checksum, keeps the executable in a private user cache, and checks its recorded binary hash before every execution.

## Try the sub-mind without running a model

From a built checkout:

```sh
node packages/echo/dist/cli.js submind-demo
```

From the standalone package, use `farsight-echo submind-demo`. This uses a synthetic in-memory fixture and deterministic mock output. It needs no configuration, `serve`, agentmemory process, model, network connection, or saved user memory. It demonstrates a bounded brief with citations and a follow-up read. Mock output is labeled and is not evidence of model quality.

To research your existing store without model inference, set **Sub-mind → Research mode → Mock** in the settings view, save, and restart that profile's `serve`. Then run:

```sh
farsight-echo ask --query "What did we learn about cold shipping?"
```

This searches the running profile's backend, so it requires that backend, but it never invokes a model. Opening settings or saving a mode never sends a generation request. Leave the mode off when no research should be allowed. Raw `recall` remains available in all modes. Background prompt research requires both a research mode and its separate opt-in; off mode never generates.

## Explore the portal without a backend or model

From a built checkout:

```sh
node packages/echo/dist/cli.js portal-demo
```

From the installed package:

```sh
farsight-echo portal-demo
```

Open the printed URL. The default port is `4491`; use `portal-demo --port 0` to choose an available port, or provide another available port explicitly. The **Synthetic preview** banner identifies example memories held in memory. This command starts an isolated local web server and private memory bridge, creates disposable configuration and trust state, and neither reads existing Echo settings nor connects to a real memory store, model, or engine. Settings are read-only. Ctrl-C closes the preview and removes its temporary state. This preview tests the interaction flow, not model quality or stored-memory persistence.

Try searching for `shipping`, selecting a card, and reading its evidence. **Load more** retrieves another page; **Topics in loaded results** filters only cards already fetched. Ask the mock sub-mind about `shipping`, then use **Read more** on a checked reference. Neither action loads or invokes a model in this preview.

## Browse your saved memories

Run the normal `serve` command with your selected configuration and profile, then open its printed URL. It serves the same portal on that profile’s configured web port, backed by its actual memory connection.

- **Memories** presents compact cards grouped by saved date, with content excerpts, actual saved topics, and known source workspace. Select a card for saved content, timestamp, and verified provenance when available. The saved date describes when the record was stored, not necessarily when its subject happened.
- **Search memories** sends an ordinary store lookup, without inference. The start and end dates include the full selected UTC days. The topic menu filters loaded records only; it is not a store-wide topic index.
- **Load more** continues the current query and date selection. An empty page after date filtering can still have another page. Each displayed count covers its server response, not the whole store or all accumulated cards; counts are hidden while a topic filter is active. Pagination is not a snapshot and does not establish exhaustive recall.
- **Memory detail** follows the exact ID and content revision. If the record changed, Echo labels the current content as changed; if it is missing or out of scope, no content is shown. Shortened evidence is labeled. Echo does not promise historical revision retention.
- **Ask sub-mind** is a separate explicit action. Off mode disables research while leaving ordinary browsing available. Mock mode returns labeled deterministic excerpts. Model mode sends the question and selected evidence to your configured local or remote provider. The brief shows problem, concise fix, supported explanation, and checked references. **Read more** follows a typed memory reference without inference. **Cancel research** or leaving the Memories tab cancels the active request.

The running profile and its individual/team/project labels define the browsing scope. Selecting another profile in **Settings** edits that profile only; it never redirects the memory view. Changes to the running configuration require a restart before further memory requests. If the portal reports stale settings, restart the same `serve` command and reload the page. Unsaved form changes survive switching between the two tabs.

Normal pages request at most 50 records. If the upstream response exceeds the 2 MB transport limit, Echo retries that same page with 10 records, then one; other errors do not trigger this retry. Returned titles, content, and topics share a 64,000-character page allowance. The portal reports clipping and incomplete coverage. Queried search inherits the pinned backend’s global candidate ranking limit, so additional pages cannot guarantee that every matching scoped memory will appear. There is no overall memory count or inferred relationship graph.

## Quick start from this repository

Run these commands from the repository root using Node 24:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/echo/dist/cli.js setup --scope workspace
```

For a first test, choose an installed Ollama model, answer **no** to the hook questions, and **yes** to installing the managed runtime. Workspace hooks can be installed separately later.

Workspace setup creates `.echo/settings.json` with `personal` and `work` profiles. Both begin with hooks disabled and separate memory addresses. Setup configures the selected profile; the default is `personal`. It does not start a server. Without an explicit scope or configuration, interactive setup asks whether to use workspace or global settings.

Check the configuration, exercise storage, then start the memory portal:

```sh
node packages/echo/dist/cli.js doctor
node packages/echo/dist/cli.js smoke
node packages/echo/dist/cli.js serve
```

Open the URL printed by `serve`: with the default personal profile it is [http://127.0.0.1:4480](http://127.0.0.1:4480). Leave this terminal running. Ctrl-C shuts down Echo's web server and its owned memory processes.

If you declined engine installation during setup, run `node packages/echo/dist/cli.js install-runtime` before the smoke test. To test storage without a model, run `smoke` without `--with-model`; `doctor` skips model readiness checks in off and mock modes (including legacy profiles without a sub-mind policy).

You can also run `smoke` in a second terminal while `serve` is running. It chooses separate available ports and disposable stores; it does not test against or write into the running profile's store.

## Install the standalone package

You can test Echo without running the rest of the Farsight workspace. From a built checkout:

```sh
pnpm pack:echo
```

This writes an installable tarball under `build/echo/` and prints its exact filename. Replace `VERSION` below with the version in the filename. Choose how to install the executable:

```sh
npm install --global ./build/echo/farsight-echo-VERSION.tgz
farsight-echo --help
```

For a package installed in one workspace instead, run this from that workspace, using the tarball's actual path:

```sh
npm install --save-dev /absolute/path/to/farsight-echo-VERSION.tgz
npx --no-install farsight-echo setup --scope workspace
```

Use `npx --no-install farsight-echo` for subsequent commands with that local package. The rest of this guide uses the globally available `farsight-echo`; from source, substitute `node packages/echo/dist/cli.js` while in the repository root.

Installing the executable and choosing the memory store are separate decisions. A globally installed executable can manage a workspace-only store. A workspace connected to a global store needs only its hook definitions and connection file; it does not need another package or backend copy.

These commands install a local artifact; they do not publish to npm. The standalone package includes the memory portal, settings view, and pinned agentmemory dependency. Source workspace installs include that dependency tree; pnpm permits dependency lifecycle scripts only for esbuild. Engine installation remains an explicit setup step. Package installation never installs hooks or starts a service.

For a workspace store, change to the workspace and run:

```sh
farsight-echo setup --scope workspace
farsight-echo doctor
farsight-echo smoke
farsight-echo serve
```

For a shared global store, run `farsight-echo setup --scope global`, then use the [two-workspace walkthrough](#share-memories-between-two-workspaces) below.

## Test the current iteration

| Test | What to do | What a successful result means |
|---|---|---|
| Configuration | Run `doctor` | The pinned package and managed engine are available, and the isolation precondition passes; model mode also checks the chosen Ollama model. Managed `doctor` does not start the backend. |
| Memory storage | Run `smoke` | `remember-recall`, `restart-persistence`, and `store-isolation` each report `ok: true`. |
| Persistent memory | Keep `serve` running, then use `remember` and `recall` as shown below | The explicitly saved fact is returned from the selected managed profile and survives restart. |
| Model-free portal | Run `portal-demo --port 0`, open its printed URL, search and select a card, then explicitly ask the sub-mind | Synthetic memories, evidence detail, and mock research work without an existing configuration, backend, or model. |
| Model-free sub-mind | Run `submind-demo` | A synthetic brief and follow-up read work without a model or backend. |
| Research on your store | Choose mock mode, restart `serve`, run `ask --query TEXT` | Labeled deterministic excerpts and follow-up references come from the selected scope without inference. |
| Optional model connection | Run `smoke --with-model` only when inference is desired | The same storage checks pass, plus `model-summary` returns a short summary of synthetic shipping text. |
| Memory portal | Run `serve`, open its URL, search saved text, select a card, and follow its detail | The running profile’s records appear with saved dates, topics when present, and known source provenance. Browsing does not invoke a model. |
| Settings view | In the portal, select Settings and refresh the checks | The settings page loads and the running backend reports readiness. Settings remain available if the backend needs attention. |
| Save/reload | Change a harmless setting, save, and reload the page | The saved value persists. Restart `serve` to apply runtime changes. |
| Profile editing | Select `work` in the settings view | You can edit work's settings; the running profile indicator remains on the profile started by `serve`. Selecting an editor tab does not switch services. |

Smoke uses disposable stores and synthetic text. It never writes into your personal/work memory store or an external backend. It stops its own processes and removes successful test data. A failed test prints a temporary diagnostics location and retains its synthetic logs.

The optional `smoke --with-model` check performs real inference, even when sub-mind mode is off or mock. It summarizes the synthetic sample directly after the storage assertions. To exercise the bounded research workflow instead, use `ask` with model mode explicitly enabled and available compute.

The web view opens on **Memories**. Its separate **Settings** tab retains unsaved edits when you switch views. Memory editing, deletion, and conversation capture history are not part of this iteration.

## Save and recall a memory

Keep `serve` running for the selected **managed** profile. In another terminal, use the same configuration and profile. This example deliberately saves a synthetic test fact to your selected profile's persistent store:

```sh
farsight-echo remember --profile personal --topic echo-test --content "The synthetic echocoldtest shipment uses a blue insulated test container."
farsight-echo recall --profile personal --query "echocoldtest" --limit 3
```

`remember` returns the stored `id` and `createdAt`. `recall` returns a `memories` list with each record's `id`, `title`, `content`, and `timestamp`, plus historical `provenance` and a `truncated` indicator. New saves record the calling workspace, its HEAD revision when available, and the save date; old records report unknown provenance. These are memories, not facts read from the current code. Credential-shaped content or topics are refused without repeating the value. The list should contain the test fact. Stop and restart `serve`, then repeat `recall` to check that it persists. Unlike `smoke`, `remember` writes a real memory to the selected store; it is not a disposable test operation.

Repeat `--topic` to attach more than one topic. Topics and timestamps are stored metadata. The portal groups records by saved date and filters loaded records by their saved topics; automatic day/topic rollups are not implemented. Recall returns at most five records, with combined title/content bounded by the profile's brief-character limit. `--limit` can request fewer records; it cannot bypass that ceiling.

You can ask a host agent to invoke these commands after the hook has supplied the access instructions. Storing a memory is an explicit action. Echo does not import old chats or silently save each prompt, tool result, or response.

Commands and hooks connect to the running Echo process through a local filesystem-protected Unix socket. The portal exposes guarded, local read-only memory routes; it has no memory mutation route. If Echo is stopped or its selected configuration has changed since startup, restart `serve` before using memory commands.

**Explicit saves currently require managed mode.** External mode supports scoped reads, including portal browsing and research, but no memory writes. Echo refuses external writes because the pinned backend's memory supersession can affect older unscoped records. External recall accepts only records already in the exact Echo namespace and individual scope; it does not import legacy unscoped memories.

## Configuration and profiles

Select a memory location independently of the package installation:

| Selection | Configuration and behavior |
|---|---|
| `--scope workspace` | The workspace's `.echo/settings.json` and adjacent state. Explicitly selects this local store even when the workspace is connected to a global profile. |
| `--scope global` | `${XDG_CONFIG_HOME:-~/.config}/farsight-echo/settings.json` and adjacent state, for the current user. |
| `--config /absolute/path/settings.json` | A custom configuration and adjacent state. Cannot be combined with `--scope`. |
| No explicit selection | Use the nearest connection or local settings inside the nearest Git boundary, including from nested directories. If neither exists, expect `.echo/settings.json` at that Git root, or the current directory outside Git. There is no automatic fallback to the global store. |

`--profile` selects a profile within that configuration. Otherwise, a connection's recorded profile takes precedence over the configuration's `defaultProfile`. Use an explicit scope when you want to override a workspace connection:

```sh
farsight-echo setup --scope workspace --profile work
farsight-echo doctor --scope global --profile personal
farsight-echo serve --scope global --profile personal
farsight-echo serve --config /absolute/path/to/echo/settings.json --profile personal
```

Run one `serve` per active profile; several connected workspaces use that same running process. Never start two writers for the same store. Default ports allow one workspace configuration and one global configuration to coexist:

| Scope | Personal web / backend base | Work web / backend base |
|---|---|---|
| Workspace | 4480 / 4611 | 4481 / 4711 |
| Global | 4490 / 5211 | 4491 / 5311 |

Each managed backend also reserves its base port plus 1, plus 2, and plus 46023. The configuration validator rejects overlaps across profiles and local model/web ports. Additional independent workspace stores need different ports. Set the selected profile's ports with `init` or `setup`, for example `setup --scope workspace --port 4492 --backend-port 5411`, or edit its settings.

For noninteractive initialization, replace `MODEL_NAME` with the exact installed model name:

```sh
farsight-echo init --scope workspace --model MODEL_NAME
farsight-echo install-runtime --scope workspace
```

`init` refuses to overwrite an existing file. For an existing profile, use `setup --model MODEL_NAME`, edit it in the settings view, or edit the local JSON and explicitly trust the reviewed file again. `setup` requires an interactive terminal and asks whether to install each host's workspace hooks and the managed runtime. Accepting a hook question writes the workspace connection and that host's definitions; it does not merely prepare a preview.

| Setting | How to use it |
|---|---|
| Identity | Set an individual, project, and optional team. The project is a memory namespace; it does not change with the calling workspace. These are routing labels, not authenticated team membership. |
| Memory connection | Choose `managed` for Echo-owned local processes or `external` for your own agentmemory instance. |
| Model | Select `ollama` or `openai-compatible`, the service origin, a model name, and an optional keychain reference. Local and remote endpoints use the same research flow. |
| Sub-mind | Select off, mock, or model research and per-request search, evidence, input, age, and deadline limits. Existing settings without this section default to off. |
| Limits | Set the request timeout, generated-token limit, and final summary-character limit. An incomplete model response fails the check. |
| Hooks | Record which host may bind sessions and use prompt recall. These switches do not install hook definitions into a host. |
| Skill directories | Save explicit future discovery locations. Echo does not yet read, install, or execute these skills. |
| Farsight address for embedding | Optionally allow an exact local Farsight origin to frame the view. Farsight navigation integration is not built yet. |

Use service origins without paths or credentials in URLs. The compatible adapter adds `/v1/chat/completions` itself; do not put `/v1` in the configured origin. Prefer HTTPS or a localhost SSH tunnel for remote endpoints. Private-network HTTP requires the explicit exception described below. Current remote request handling is verified with synthetic protocol fixtures; each real deployment still needs its own connection check when inference is appropriate. `doctor` in model mode checks only the model selection for compatible endpoints; `model-test` verifies a structured generation without starting the memory backend; `smoke --with-model` additionally exercises disposable memory storage.

Personal and work have separate local stores. Within one configuration directory, a host session is bound to its chosen profile, identity, backend, and model settings. Start a **new host session** when changing those boundaries. Keep personal and work in the same configuration file so their session bindings are checked against the same registry. This is local isolation, not multi-user team authorization.

Global means a store owned by the current operating-system user. New global profiles start with `identity.project` set to `shared`; connected workspaces keep that configured namespace instead of substituting their folder names. Global setup does not create a hosted team service, install hooks in every workspace, merge local and global results, or copy existing memories. Connecting a workspace changes which profile it uses; any existing local store stays in place. Select it explicitly with `--scope workspace` or reconnect the workspace to it.

## Find and test a model

In **Settings**, save the selected profile before using **Find installed models** or **Test model**. Discovery lists models from the saved Ollama address without loading or downloading one. Choose a result and save again before testing it. Compatible APIs keep a manually entered model name.

The model test sends fixed synthetic evidence and checks structured output. It makes one generation request, even when research is off or mock, and never reads saved memories or starts the memory backend. Cancel stops the request. Editing settings, switching profiles, or leaving Settings cancels and discards pending results. The synthetic portal preview disables these actions.

The same checks work without a running Echo service:

```sh
farsight-echo models --scope global --profile personal
farsight-echo model-test --scope global --profile personal
```

Settings shows the **running** provider, address, model, and research mode separately from the saved profile. A successful test verifies the saved endpoint; it does not switch the running memory service. When **Restart Echo to use the saved settings.** is shown, stop and restart that profile's `serve`, then open Memories and explicitly ask the sub-mind. Browse and Read more remain model-free.

Native Ollama has two optional resource controls:

```json
"ollama": { "contextTokens": 4096, "keepAliveSeconds": 0 }
```

Place this object inside the profile's `model` object. Context size accepts 2,048–131,072 tokens; retention accepts 0–3,600 seconds. Omitted settings use 4,096 and zero: each completed request unloads the model. Longer retention keeps it warm for subsequent requests and uses memory between requests. These settings apply to local or remote native Ollama; compatible APIs control their own context and residency. Character allowances and the provider's context window are separate limits, not an exact token conversion. See Ollama's [context settings](https://docs.ollama.com/faq#how-can-i-specify-the-context-window-size) and [chat API](https://docs.ollama.com/api/chat).

## Configure the sub-mind and its remote model

A profile's optional `submind` settings are separate from `model`, which selects where inference runs. A local memory store can use a remote model. Echo still runs locally with its memory backend; it sends the explicit question and selected evidence to the configured model endpoint in model mode. This is remote inference, not a remotely exposed Echo service.

| Setting | Default | Meaning |
|---|---:|---|
| `mode` | `off` | `off` disables research; `mock` returns labeled deterministic excerpts; `model` invokes the configured provider. |
| `maxSteps` | 3 | Maximum model decisions per research request. |
| `maxSearches` | 3 | Maximum backend searches per request. |
| `maxCandidates` | 12 | Maximum candidate memories considered. |
| `evidenceMaxChars` | 12000 | Saved evidence allowance, separate from the brief shown to the main agent. |
| `inputMaxChars` | 48000 | Cumulative serialized provider request content, including the schema and request envelope; evidence sent twice counts twice. |
| `lookbackDays` | 90 | Eligible memory age by save timestamp; this does not remove older records. |
| `timeoutMs` | 30000 | Total research deadline. |
| `expandedMaxChars` | 12000 | Maximum evidence returned by an explicit follow-up read. |

`budget.briefMaxChars` limits the combined findings and follow-up actions; response metadata is additional. `budget.modelMaxTokens` limits each model response, and `budget.timeoutMs` bounds an individual model request. Research also applies its total deadline. These are request-level limits, not session/day quotas or guaranteed monetary caps. Automatic/proactive fetching, caches, capture, and edits are deferred. The returned usage describes work performed, rather than claiming the main agent saved tokens.

After saving and restarting, use the same profile as the running service:

```sh
farsight-echo ask --profile personal --query "How did we handle duplicate shipment requests?"
```

The result uses `schema: "echo-memory/v1"` and reports `status` (`ready`, `partial`, `empty`, `disabled`, or `unavailable`), execution `mode`, findings with problem/fix/why and citations, typed actions, search coverage, and usage. Echo attaches each citation’s title, save timestamp, and known historical provenance from the inspected record. Coverage explicitly remains non-exhaustive. Usage reports model calls, searches, evidence/input size, duration, and tokens when the provider reports them; unknown token usage is not zero. A `read_more` action names `operation: "memory.expand"` and supplies `arguments: {id, revision}`. Follow those exact values:

```sh
farsight-echo expand --profile personal --id MEMORY_ID --revision REVISION_HASH
```

Expansion reads evidence without model inference and rechecks the selected scope and content revision. Expansion reports `ready`, `changed`, or `missing`. A terminal read returns no further actions; clipped evidence is marked truncated rather than offering a repeating continuation. Treat a changed or missing reference as such; do not silently substitute a newer memory for the cited evidence. Actions are data describing supported Echo operations, not model-generated shell commands.

For a desktop Ollama service reached through SSH, keep Ollama on its desktop loopback interface and forward it from the machine running Echo:

```sh
ssh -N -L 11435:127.0.0.1:11434 user@desktop.example
```

Set the profile's model block to:

```json
{
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11435",
  "model": "your-installed-model"
}
```

The SSH tunnel carries requests to the desktop's existing Ollama API. It must remain available during research. This configuration does not start a model until an explicit model request is made; Echo does not start or manage the remote service.

For an Ollama API already available on a trusted private network, the explicit exception is:

```json
{
  "provider": "ollama",
  "baseUrl": "http://192.168.1.20:11434",
  "model": "your-installed-model",
  "allowInsecureHttp": true
}
```

The exception accepts canonical RFC1918 IPv4 addresses only, not public HTTP origins, remote DNS names, or IPv6 addresses. Do not add `secretRef`: credentials are refused on an unencrypted remote connection. Questions and memory evidence travel in plaintext on this connection; use HTTPS or the tunnel when encryption is required. Network access and the remote service's access controls remain the operator's responsibility.

For a hosted or custom compatible gateway, configure its HTTPS origin:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://models.example.com",
  "model": "your-model",
  "secretRef": "keychain:farsight-echo/models-example"
}
```

Echo adds `/v1/chat/completions`; do not append `/v1` to the configured address. The custom gateway must implement that request/response contract; an arbitrary inference API requires a separate adapter. Keep the credential in the operating system keychain. Credential references remain pinned to the approved service origin. Echo never silently falls back from one endpoint to another. Connection failures return a bounded failure result rather than starting a local model.

Use the settings view to save these fields, or edit the local JSON and explicitly trust the reviewed configuration as described below. A page load, settings save, and service start never perform sub-mind generation. `doctor` and the connection-check button inspect model endpoint availability only in model mode; `smoke --with-model` explicitly requests real inference. Do not use that option during a model-free test round.

## Let the sub-mind handle prompt memory research

Echo separates three responsibilities: agentmemory stores and searches records; the sub-mind researches those records using the selected model; the main agent receives a small sourced brief with typed follow-up actions. Research evidence stays inside Echo’s bounded request context rather than being added to the main agent’s conversation.

In Settings, select **Configured model** (or **Mock** for a model-free check), then set **Prompt memory research** to **Prepare a brief in the background**. Save, restart Echo, and start a fresh host session. The saved setting is `submind.hookResearch: "background"`; omitted settings default to `"manual"` for compatibility. Loading or saving settings never starts inference.

A prompt hook returns immediately with `echo-hook-brief/v1` and an engine-created `memory.brief` action. Follow its `requestId`, `workspace`, `host` and `sessionId` exactly using the pinned Echo command from SessionStart:

```sh
farsight-echo brief --request REQUEST_ID --workspace /absolute/path/to/workspace --host claude --session-id SESSION_ID
```

A `pending` result means work is still running; continue useful work before checking again. Polling never starts another generation. A `ready` result contains the usual problem/fix/why findings and checked `memory.expand` actions. `cancel-brief` accepts the same arguments. No model-provided shell command or URL is executed.

Transient jobs belong to one profile, canonical workspace, host and session. They expire after five minutes and disappear on restart. Identical submissions within that session reuse the retained job. A newer prompt cancels still-running research for that session; while the provider is settling, Echo reports `busy` and does not queue more work. Competing sessions also receive `busy` rather than an unbounded queue. Explicit `ask --query TEXT` remains available for fresh research. Shared saved memories remain accessible across connected workspaces; transient research contexts are not shared.

Every job uses the configured model, search, candidate, evidence, input, output, history and time limits. When searching is exhausted or repeats a query, a remaining model decision can synthesize already inspected evidence with an answer-only schema. Hard input and deadline limits still stop work; they are never silently raised. Background research can incur provider costs per new prompt. There are no daily currency caps yet.

Memory management remains explicit in this iteration: `remember` saves supplied content and topic labels. Background research does not capture conversations, alter memories, or grant the model write/delete tools. Model-assisted capture and editing are separate follow-up capabilities.

## Trust an existing configuration

`init`, interactive setup, and saves in the local settings view approve the exact settings they write for this user. A repository-supplied file, a copied example, or a later hand edit is refused before model calls, credential access, or runtime startup. Inspect its service addresses and credential references, then explicitly approve it:

```sh
farsight-echo trust --config /absolute/path/to/.echo/settings.json --confirm
```

Use `trust --scope global --confirm` for an existing global configuration. After upgrading an older preview, trust your existing configuration, run `install-runtime --scope global` to populate the private engine cache, and reconnect each selected workspace with `connect --scope global --workspace /absolute/path/to/workspace`. For a workspace store, use `--scope workspace`; for a custom configuration, use `--config PATH` on each step. Explicit selection bypasses the untrusted legacy pointer until reconnection approves it. A connection copied from another workspace is not trusted: run `connect` to create this user's receipt. Moving or editing settings requires fresh trust; hooks never grant it automatically.

Trust receipts and credential-origin pins live under `${XDG_STATE_HOME:-~/.local/state}/farsight-echo/`, outside repositories. Credential references must use `keychain:farsight-echo/ACCOUNT`. Each reference is permanently pinned to the exact service origin first approved for it; use a different account for a different origin. Never approve an unfamiliar repository's settings without reviewing them.

## Share memories between two workspaces

This walkthrough assumes the global executable is installed, both workspace folders exist, and the selected model is installed in Ollama. Use absolute workspace paths for the connection commands.

1. Configure the shared profile and start its service:

   ```sh
   farsight-echo setup --scope global --profile personal
   farsight-echo serve --scope global --profile personal
   ```

   Accept engine installation during setup, or run `install-runtime --scope global` before starting `serve`. For this walkthrough, decline setup's hook questions and connect both workspaces in the next step. Keep `serve` running. The default global personal settings view is [http://127.0.0.1:4490](http://127.0.0.1:4490).

2. In another terminal, connect both workspaces to that same profile:

   ```sh
   farsight-echo connect --scope global --profile personal --host all --workspace /absolute/path/to/workspace-a
   farsight-echo connect --scope global --profile personal --host all --workspace /absolute/path/to/workspace-b
   ```

   Each workspace gets hooks for Claude Code, Codex, and VS Code Local, plus `.echo/connection.json`. The connection records the chosen configuration and profile. There is one shared store and one running service.

3. Save a synthetic fact from workspace A, then retrieve it from workspace B:

   ```sh
   cd /absolute/path/to/workspace-a
   farsight-echo remember --topic echo-sharing-test --content "The synthetic echosharedtest verification phrase is copper lantern."
   cd /absolute/path/to/workspace-b
   farsight-echo recall --query echosharedtest
   ```

   The returned memory should contain **copper lantern**. Neither command needs `--scope` or `--profile` because each workspace's connection supplies them.

4. Complete the host's trust steps below and open a fresh chat in workspace B. Ask: **“What does Echo remember about echosharedtest? Answer from the hook context without reading files or running tools.”** The expected phrase is **copper lantern**.

Hook installation does not grant host trust. In Codex, use `/hooks` to review and trust the definitions. To return workspace B to an existing local store, run `farsight-echo connect --scope workspace --profile personal --host all --workspace /absolute/path/to/workspace-b` from workspace B and start its local `serve`. Start a fresh chat after reconnecting. The shared memory remains in the global store; reconnection does not migrate it.

## Managed or external memory

Managed mode starts the pinned agentmemory worker and iii engine with a deliberately restricted environment. Credentials are generated in memory for that run; leave the managed backend credential reference empty. Echo owns their lifecycle and will not adopt a process already listening on the configured ports.

For an external instance, edit the selected profile in the settings view:

1. Set memory mode to `external` and enter the instance's service origin.
2. If it requires a credential, store it in macOS Keychain or Linux Secret Service and enter only a reference such as `keychain:farsight-echo/example`.
3. Save, restart Echo, and run `doctor --profile NAME` to check the backend identity and supported version.

External mode expects agentmemory **0.9.30**. It does not install, start, or stop that service. Give personal and work different instances; project filters alone do not establish tenant security. `smoke` intentionally requires managed mode so it cannot insert test records into an external store.

The external connection is read-only through Echo's memory bridge in this iteration. `remember` is refused; `recall` still applies the selected Echo namespace and individual filter.

Echo resolves only `keychain:farsight-echo/<account>` locally. In the example, the service is `farsight-echo` and the account is `example`. References to another service or a different previously pinned origin are refused before reading the secret. Do not put secret values into settings, URLs, command arguments, or committed files. Keychain integration currently supports macOS and Linux.

## Connect a workspace to its agents

Package installation never prompts or modifies your agent's settings. `setup` offers workspace hook installation. To connect a workspace to an already configured profile directly, run:

```sh
farsight-echo connect --scope global --profile personal --host all --workspace /absolute/path/to/workspace
```

`connect` defaults to all hosts and the current workspace when `--host` and `--workspace` are omitted. It installs hooks pointing at the chosen executable, configuration, and profile, and records `.echo/connection.json` for ordinary CLI commands in the workspace. To select the workspace's local store, use `--scope workspace`. This existing installation command also records the connection:

```sh
farsight-echo hooks --host all --install --workspace /absolute/path/to/workspace --profile personal
```

Use `--scope global` for the global configuration or `--config /absolute/path/to/echo/settings.json` for a custom one. The installer preserves unrelated hooks/settings, records original bytes in a private restoration journal under the user-state directory, and can be run again to update its own definitions. It refuses malformed existing settings before writing. Installing definitions does not bypass host trust or install editor extensions.

The generated definitions and connection file contain this machine's absolute Echo/configuration paths. Keep them local and untracked; they are not portable team configuration. Reconnecting replaces the selected target without copying memory. All already installed Echo host definitions in that workspace move to the same target, even if `--host` names only one additional host. A workspace never combines profiles across its Echo hooks.

| Host | Workspace configuration | What to do after installation |
|---|---|---|
| Claude Code CLI and Claude Code's VS Code extension | `.claude/settings.local.json` | Open that workspace and start a fresh Claude session. Review the host's hook settings and permissions. |
| Codex CLI and the Codex VS Code extension | `.codex/hooks.json` | Ensure hooks are enabled, trust the project, and review the exact hook definitions. Start `codex -C /absolute/path/to/workspace`, use `/hooks` for inspection and trust, then start a new session in the intended host. |
| VS Code Local chat | `.github/hooks/echo.json` | Use a trusted workspace and a Local chat session with `chat.useHooks` enabled. This does not target Copilot Agent Host sessions. |

Do not enable the same Echo hook through both a plugin and workspace settings. For VS Code Local chat, avoid loading the Echo hooks again through `chat.useClaudeHooks` when the dedicated `.github/hooks/echo.json` is installed. The installer refuses an installation that would create that duplicate path; it does not rewrite editor preferences to bypass the conflict. Use `--host claude`, `--host codex`, or `--host vscode` with `--install` to select one workspace integration.

To prepare a reviewable plugin without installing workspace definitions, the earlier commands remain available:

```sh
farsight-echo hooks --host claude --profile personal
farsight-echo hooks --host codex --profile personal
```

They write `plugins/<profile>/<host>/` beside the selected configuration and print manual loading instructions. Without `--install`, `--host all` prepares all three hosts' files instead of changing workspace settings. Claude can load the plugin with `claude --plugin-dir <generated-directory>`. Codex uses the generated local marketplace, then separate installation and hook trust. Prefer one integration route per host.

The installed lifecycle points are `SessionStart` and `UserPromptSubmit`:

- `SessionStart` binds the session and supplies brief instructions for memory access.
- `UserPromptSubmit` searches the selected memory scope and adds bounded relevant context to the request.

Manual hook lookup does not call the configured model. When **Prompt memory research** is set to **Prepare a brief in the background**, the hook submits bounded sub-mind research and returns a small follow-up handle instead of raw records. The total injected text, including historical provenance, stays within the profile's brief-character limit. Omitted or shortened results carry “More matched; not shown.” Session start supplies the full command; prompt callbacks reference it briefly. If Echo is unavailable, hooks let the host continue without memory context. Explicit `remember` with a managed profile is the way to store a memory in this iteration.

Enable one Echo profile per host session. Disabling its hook preference stops Echo processing future callbacks; disable the host definition or plugin to stop launching the runner. Reinstall or reprepare hooks after moving Echo or its configuration because generated runners use absolute paths.

### Verify memory in a fresh chat

1. Start `serve`, save the `echocoldtest` fact above, and confirm that CLI `recall` returns it.
2. Install hooks for the intended workspace, complete the host's trust steps, and open a **new** chat in that workspace.
3. Ask: **“What does Echo remember about echocoldtest? Use only the stored memory.”** The relevant result is the blue insulated test container.
4. If needed, ask the agent to run Echo's printed recall command explicitly. This separates a working memory connection from a host that has not loaded its hooks.

A session binding file under the selected configuration's `sessions/` directory only demonstrates that a callback reached Echo. It does not prove prompt recall worked. Verify the stored fact in the actual host response or its hook diagnostics; synthetic runner tests do not establish that an editor extension loaded the definitions.

For VS Code Local, **Chat: Configure Hooks** shows discovered files, and the **GitHub Copilot Chat Hooks** output channel reports callback output/errors. Those Local controls do not configure the Claude or Codex extension's hooks.

## Disconnect a workspace

```sh
farsight-echo disconnect --workspace /absolute/path/to/workspace
```

This removes Echo-owned workspace hooks and its connection pointer while preserving memory stores. If a hook file has not changed since installation, Echo restores its original bytes (or removes a file it created). Later unrelated edits are preserved while Echo's entries are removed. Separately prepared plugins must be disabled in their host.

Before installation, Echo adds local Git exclusions for generated files and refuses tracked targets or ignore overrides. Its three host files contain machine paths and must remain untracked. Do not force-add them. Restoration records are private user-state files, not repository backups.

## Stop, restart, and local files

Stop `serve` with **Ctrl-C** and wait for it to exit. It closes the settings view and only the backend processes it started. Externally managed services stay running. Start the same command again to apply saved runtime settings. A normal restart preserves the selected profile's store.

Workspace settings keep state under the workspace's `.echo/`. Global settings keep the same structure under `${XDG_CONFIG_HOME:-~/.config}/farsight-echo/`:

```text
.echo/
  settings.json          Local configuration
  profiles/personal/     Personal store, runtime config, and logs
  profiles/work/         Work store, runtime config, and logs
  sessions/              Session binding metadata
  plugins/               Prepared host plugins
  backups/               Earlier workspace connection pointers
```

A connected workspace also has `.echo/connection.json`. When connected globally, this is a pointer to the shared configuration and selected profile; no local runtime or store is needed. An older local `settings.json` and store can remain alongside it, selected explicitly with `--scope workspace`.

The native executable lives separately in `~/.cache/farsight-echo/runtime/0.22.1/<platform-architecture>/`; repository-local engine files are never executed. New saves also keep content-bound provenance files inside the selected profile.

Managed mode disables upstream consolidation, scheduled automatic forgetting, and lesson/insight decay. Similar new saves can still supersede earlier facts. This is not a long-term retention guarantee: the pinned backend still owns storage maintenance, and verification covers normal restart persistence only.

Agentmemory uses iii's file-backed state store. These live files are not a Git collaboration format. Keep `.echo` runtime state ignored; commit only scrubbed examples such as this repository's `.echo/settings.example.json`. Moving a configuration file also changes where its adjacent runtime state is located.

## Troubleshooting

| Symptom | Next step |
|---|---|
| Model unavailable or no models listed | Confirm Ollama is running and check `ollama list`. Select that exact name. If necessary, explicitly download your chosen model with `ollama pull MODEL_NAME`, then rerun setup. |
| Model stops before completing its brief | Increase the generation limit or choose a suitable local model. For a slow first load, increase the timeout. Echo refuses incomplete output. |
| Engine missing or checksum mismatch | For a missing engine, run `install-runtime` with explicit scope. If an installed cache fails verification, inspect and move the affected version/platform cache directory aside before reinstalling; Echo will not execute or overwrite a suspicious cached binary. |
| Managed mode refuses global agentmemory configuration | The published worker reads `~/.agentmemory/.env` globally. Use a deliberately isolated external instance if you need that existing installation. Do not delete another tool's settings to bypass the check. |
| Port already in use | Stop your own existing Echo instance or select non-overlapping ports. Do not kill unrelated servers. |
| Profile locked after a crash or forced kill | Restart normally: Echo recovers a verifiably dead owner lock and still refuses occupied ports. Live, malformed, or symlinked locks require inspection; preserve the store and any unrelated processes. |
| Saved setting is not active | Restart `serve`. Editing another profile or changing the default does not switch an already running process or host session. |
| Settings changed elsewhere | Reload the view, review the new values, and reapply your changes. Conflicting edits are refused rather than silently overwritten. |
| Recall cannot reach Echo | Start `serve` with the same configuration and profile. After changing identity, backend, or model settings, restart it and use a fresh host session. |
| Another workspace cannot find the saved memory | Confirm both connections name the exact same configuration and profile, and that this profile's `serve` is running. Matching profile names in different configurations do not share a store. |
| Reconnected workspace still uses old hooks | Reopen the host in a fresh chat and review any changed hook trust. Remove a separately loaded Echo plugin if it still points to the old profile. |
| No memories appear in the main agent | First confirm CLI `recall` finds an explicitly saved memory. Then check the intended workspace, host support, hook preference, exact-definition trust, and a fresh chat. Hooks fail open if Echo is unavailable. |
| A conversation was not saved | Automatic capture, daily/topic rollups, and skill discovery are deferred. Use explicit `remember` for selected facts; `ask` researches memories already saved. |
| Portal says settings changed | Restart the selected `serve` process and reload the page. Requests remain bound to the startup profile; selecting another editor profile is not a runtime switch. |
| No cards match, but Load more remains | Continue paging. UTC date filtering can remove every record on one page without exhausting subsequent pages. |
| Sub-mind research is disabled | Set mock or model mode, save, and restart the selected service. The running-mode indicator shows the startup mode. |
| Remote model address is refused | Use an origin without a path. Prefer HTTPS or a local SSH tunnel; private numerical HTTP requires explicit opt-in and no credential reference. |

For the architecture boundaries and configuration reference, see [Echo setup and boundaries](../../docs/ECHO.md). Host references: [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), and [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks).
