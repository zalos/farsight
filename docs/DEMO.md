# Demo: the Farsight viewer and a Copilot review on a fresh machine

A numbered runbook for showing Farsight and Sentinel on a machine that has never had either: build the two packages
from this repository, install them into one folder, open the viewer on an example application, scan it, and let a
GitHub Copilot model review part of it. Every command below was run end to end, in this order, on a clean npm prefix.
In the command blocks, lines that start with `#   ` are what the command printed, with `…` where a path or a digest
was shortened; a comment on a command's own line is a note (its time, its exit code).

> **Verified** end to end on `main` `e4f49098` and again on `69842407` (2026-10-28), each from a fresh clone into a
> clean npm prefix, macOS on Apple silicon, Node 24.21.0, Copilot CLI 1.0.105, no Docker; steps 2 and 4c again on
> `3f82c972` (the viewer's SCANS · PIPELINE · STAGE ladder, #227); steps 2 and 4a, 4b up to the model confirmation,
> and mistakes 1, 2, 3a and 3b again on `4fd4e251` (the `scan` command, #237). This file is re-run and updated as later
> changes land.

| step | what you do | time |
|---|---|---|
| 1 | prerequisites: Node 24, pnpm 9 or npm 10, Git LFS, Copilot CLI 1.0.105 logged in | 5 to 10 min, once |
| 2 | clone, build, pack, install both packages into one folder | about 70 s with a warm pnpm store; a few minutes on a new machine |
| 3 | ingest the example, open the viewer | under 1 min |
| 4 | Sentinel: initialise, adopt, a first scan, then the Copilot review | 2 to 3 min (the review itself about 40 s) |
| 5 | if something refuses: the likely mistakes | — |

## 1. Prerequisites

The qualified Copilot runtime is **macOS on Apple silicon only** (`darwin-arm64`); Sentinel refuses any other Copilot
build or platform rather than fall back. No Docker is needed for this demo.

```sh
# Node 24 (any Node 24 on PATH works; nvm shown)
nvm install 24 && nvm use 24
node --version                     # v24.x
# For the pnpm path only: corepack enable && corepack prepare pnpm@9.0.0 --activate
pnpm --version                     # 9.0.0
# or: npm --version                # 10.x (npm install -g npm@10 if needed)
git lfs install                    # the example's images are LFS files; without it they show as missing

# GitHub Copilot CLI, the exact version Sentinel pins (1.0.103 is also accepted; nothing newer is)
npm install -g @github/copilot@1.0.105
copilot --no-auto-update --version # GitHub Copilot CLI 1.0.105.
copilot login                      # sign in with the GitHub account that has Copilot; follow the device code
```

Do not run `copilot update`: Sentinel checks the exact bytes of the CLI and of its runtime folder
(`Library/Caches/copilot/pkg/darwin-arm64/1.0.105` under your home folder), and a newer version is refused, not used.
The runtime folder appears once the CLI has run (the login above); this runbook was verified on a machine where it
already existed, not on a clean home folder. `gh` is not needed: the repository is public.

**Keep Node 24 first on PATH** in every shell you use below. `farsight-sentinel` refuses to open its store under Node 22
(see mistake 4).

## 2. Build the two packages and install them into one folder

Choose pnpm 9 or npm 10: every `# or:` line is the npm alternative to the pnpm command above it. Run one of each pair. pnpm remains the contributor/CI path; npm uses `npm install`, not `npm ci`, because only `pnpm-lock.yaml` is committed and npm’s generated lockfile is ignored. Start with a fresh clone when changing managers.

```sh
git clone https://github.com/zalos/farsight.git
cd farsight
pnpm install --frozen-lockfile     # 3 s with a warm store, a few minutes on a new machine
# or: npm install
pnpm build                         # about 17 s
# or: npm run build
node scripts/pack.mjs              # packaged: build/farsight-cli-0.3.0.tgz  (built …, commit <sha>)
pnpm pack:sentinel                 # packaged: build/sentinel/farsight-sentinel-0.0.0-draft.1.tgz  (built …, commit <sha>)
# or: npm run pack:sentinel

mkdir -p ~/farsight-demo
npm install -g --prefix ~/farsight-demo/prefix \
  ./build/farsight-cli-0.3.0.tgz ./build/sentinel/farsight-sentinel-0.0.0-draft.1.tgz
export PATH="$HOME/farsight-demo/prefix/bin:$PATH"

farsight --version                 # farsight 0.3.0 · built <time> · commit <sha> · packed
farsight-sentinel --version        # farsight-sentinel 0.0.0-draft.1, contracts draft-1
```

The `npm install` takes about 2 s and needs the network: two type packages (`@types/node`, `undici-types`) come from
the npm registry, so an offline install from an empty cache fails. Installing into `~/farsight-demo/prefix` leaves any
other `farsight` on the machine alone. `farsight-sentinel --version` names no commit; `farsight --version` does, and
both tarballs come from the same build.

## 3. Ingest the example and open the viewer

```sh
cp -R examples/invoice-app ~/farsight-demo/app
cd ~/farsight-demo
farsight ingest app --repo invoice-app --out graph.json
#   + invoice-app: 130 nodes, 170 edges (config applied)
#   ingested 1 repo in 141ms → …/farsight-demo/graph.json

cd app                             # serve from the folder Sentinel will scan: the Sentinel tab looks for its companion there
farsight serve ../graph.json --port 4581
#   farsight: http://localhost:4581  (graph: …/graph.json, workspace: …/farsight-demo/app)
```

Leave it running and open **http://127.0.0.1:4581** (use `127.0.0.1`, not `localhost`: the Sentinel companion in step 4
is bound to that exact origin). The front door shows the example's journeys and the state of play. Ingest is written
from `~/farsight-demo` so that its history (`.farsight/farsight.db`) stays out of the folder Sentinel captures.

## 4. Sentinel

Open a second terminal and work in the example's folder:

```sh
nvm use 24
export PATH="$HOME/farsight-demo/prefix/bin:$PATH"
cd ~/farsight-demo/app
```

### 4a. A first scan, no model

```sh
farsight-sentinel init                                              # 0.2 s
#   created …/app/.farsight/sentinel/settings.json from the default settings
#   created …/app/.farsight/sentinel/pipeline.json from the static profile
#   …
#   next: review both files, then run scan: it shows what it would adopt (the settings and pipeline, as settings
#   adopt --confirm), the rule packs this profile uses that it would promote (rules promote
#   builtin:foundation-preview --confirm) and what it would run; scan --confirm does all of it as their owner
farsight-sentinel settings adopt --confirm                          # 0.3 s
#   settings sha256:…
#   pipeline sha256:…
#     preview: a rule the pipeline selects is not promoted yet (sentinel.preview.sql-string-concat is not in the owner's promoted rule lock)
#   prepared
farsight-sentinel rules promote builtin:foundation-preview --confirm  # 0.4 s
#   pack sentinel-foundation-preview 0.1.0 · candidate sha256:… · replaces lock sha256:… · now lock sha256:…
#   prepared
farsight-sentinel scan                                              # 0.2 s; exit 4
#   1. capture (builtin) · runs in-process · local-artifacts
#   2. parse (builtin) · runs child · local-artifacts
#   3. inventory (builtin) · runs child · local-artifacts
#   4. preview (tool) · runs child · local-artifacts
#   5. report (builtin) · runs in-process · local-artifacts
#   stages: the static profile's defaults (settings-configured reviews included); declare them in pipeline.json to pin them
#   to confirm as the owner: farsight-sentinel scan --confirm
#   waiting for the owner to confirm: the scan waits for the owner to confirm it; nothing was captured or run
farsight-sentinel scan --confirm                                    # about 15 s; exit 2
#   plan run-<id> · sha256:…
#   run run-<id> · completed
#   next: farsight-sentinel report
#   required checks did not complete: foundation preview complete: this is not required coverage
farsight-sentinel report                                            # the latest scan; exit 0
```

`scan` without `--confirm` only shows what would happen (exit 4) and runs nothing. Adopting and promoting first, as
above, keeps each owner step visible; `scan` alone would list them (*first, as the owner: adopt the settings sha256:…
and the pipeline sha256:…* · *then, as the owner: promote the foundation-preview rule pack*) and `scan --confirm` would
do them itself. **Exit 2 is the honest result**, not a failure: the static profile runs one original preview check
(SQL text assembled from strings) over every source file, and Sentinel never calls that required coverage. The report
says so. There is no run id to copy: `report` reads the latest scan (`report run-<id>` reads any other).

### 4b. The Copilot review

`init` does not write a model provider: the provider's pins and terms are the owner's own statements. Add them to
`.farsight/sentinel/settings.json`, adopt again and plan a new run. The block below is the package README's *Copilot
CLI foreground review* section with the pins filled in for Copilot 1.0.105; the script edits the file in place:

```sh
node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.farsight/sentinel/settings.json';
const s = JSON.parse(readFileSync(file, 'utf8'));
s.hostedReviewSecretScan = 'when-selected'; // no Docker here, so no secrets scanner runs before the review
s.providers = [{
  id: 'native-copilot', kind: 'copilot-cli', endpoint: 'https://api.githubcopilot.com',
  credential: null, disclosure: 'hosted',
  copilotProfile: {
    id: 'copilot-1.0.105-darwin-arm64-seatbelt-v6',
    executableDigest: 'sha256:5fd7d15ff02deb08a58593b1b488015bb52c1686014b80b5509e28263cb3ad70',
    runtimeDigest: 'sha256:aad20f2ab2d430999091a36d937e6c667d3dbba16a86cd38d90bda609cbb34c7',
    profileDigest: 'sha256:16ca6c1edc26bfb31175c852e1a8e0688d35f1c1af85757bc848e7333ba23b1a',
  },
  budget: { maxTokens: 816000, maxCost: null, currency: null },
  models: [{
    id: 'luna', model: 'gpt-6-luna',
    limits: { maxRequestBytes: 65536, maxResponseBytes: 16384, timeoutMs: 60000, maxOutputTokens: 512,
              contextTokens: 272000, maxMessages: 32, templateTokensPerMessage: 8 },
    pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
    terms: { retention: 'unknown', training: 'unknown', source: 'demo machine; vendor terms not reviewed',
             recordedAt: '2026-10-28' },
    capability: { schema: 'sentinel-model-capability/draft-1', kind: 'copilot-cli',
                  origin: 'https://api.githubcopilot.com', model: 'gpt-6-luna', listed: true, revision: null,
                  probedAt: '2026-10-28T00:00:00.000000000Z' },
  }],
}];
s.reviewModels = { stages: [{ stage: 'general', providerId: 'native-copilot', modelId: 'luna' }], segments: [] };
s.grants[0].scope.effects = ['local-artifacts', 'paid-inference', 'source-disclosure', 'network'];
s.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always', scope: { providers: ['native-copilot'] } });
writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
EOF
```

- **The pins.** On Copilot 1.0.103, take the four `copilotProfile` values from
  `farsight-sentinel capabilities --models --json > ../model-profiles.json` (keep that file outside the workspace) and
  use them instead. On 1.0.105 the values above are the only source today: `capabilities --models` reports the
  1.0.103 profile only.
- **The terms** are what you, the owner, record about the vendor's retention and training terms; `unknown` is honest
  when you have not reviewed them.
- **The grants**: the `run.start` grant gains the three effects a hosted model needs, and `paid.admit` lets you confirm
  a model call to this provider. Without either, the run is refused before anything runs (mistakes 3a and 3b).

Then:

```sh
farsight-sentinel settings adopt --confirm
#   settings sha256:…
#   pipeline sha256:…
#   prepared
farsight-sentinel plan
#   plan run-<id2> · sha256:… · pinned checks and model review · effects: local-artifacts, paid-inference,
#   source-disclosure, network · Foundation preview: …
#   stages: the static profile's defaults (settings-configured reviews included); declare them in pipeline.json to pin them
farsight-sentinel run run-<id2> --confirm --confirm-models          # about 40 s; exit 2 again
#   run run-<id2> · completed · preview findings: 0
#   required checks did not complete: foundation preview complete: this is not required coverage
farsight-sentinel report run-<id2> --full
```

`--confirm-models` is the separate confirmation for the model call. Without it `run` stops at exit 4 and shows what
it would call and the exact line to type:

```text
model for review-general: native-copilot luna through native-copilot · budget 816000 tokens
to confirm as the owner: farsight-sentinel run run-<id2> --confirm --confirm-models
waiting for the owner to confirm: the background service needs the owner's confirmation for this: add --confirm
```

(the last line still says *add --confirm*; the line above it is the one to type). The full report includes **How each stage ran**, one
line per stage; the review's line carries the model, the turns, the tokens and the cost (the numbers vary from run
to run):

```text
- review-general (work-review-…) · through a sandboxed command-line tool · copilot-cli brokered · model gpt-6-luna ·
  3 turns · 12042 tokens in · 326 out (confirmed) · cost unobserved · subscription · 23849 ms
```

*Cost unobserved · subscription* is the honest word for a Copilot subscription: Sentinel records the tokens it was told
and no money. What the model read and proposed is in the private record,
`farsight-sentinel report run-<id2> --instructions --json` (it holds source excerpts: do not share it). On the example
the brokered review uses its three turns to list the files and read two of them (`src/server/routes.ts` and
`src/server/auth.ts`) and ends **unfinished**, with no observations; the report's *Model observations* section is then
empty. Keep the demo to what that shows: which model ran where, under what grant, at what cost, with what it read.

### 4c. Sentinel in the viewer

Start Sentinel's owner service in a third terminal and its companion in a fourth (same PATH, same folder), bound to
the viewer's exact origin. Wait for the service's *serving …* line before starting the companion: a companion started
while the service is still opening exits with *the command could not finish (sentinel.service.operationUnavailable)*.

```sh
# third terminal
nvm use 24 && export PATH="$HOME/farsight-demo/prefix/bin:$PATH" && cd ~/farsight-demo/app
farsight-sentinel serve --idle-ms 600000
#   serving …/farsight-demo/app; stops after 600000 ms with nothing to do

# fourth terminal, once the line above has appeared
nvm use 24 && export PATH="$HOME/farsight-demo/prefix/bin:$PATH" && cd ~/farsight-demo/app
farsight-sentinel owner-ui --workspace . --farsight-origin http://127.0.0.1:4581
#   Launch the owner companion for this workspace, then reconnect.      (it keeps running)
```

Open **SENTINEL** in the viewer (or press *Reconnect* if it was already open). The tab pairs with the companion
once per launch: keep to that one browser tab; a second tab or browser shows *This pairing link has already been used
or is no longer available*, and the fix is to stop and relaunch `owner-ui`, then *Reconnect*.

- **SCANS** lists the two runs, newest first: `#2 · 5 stages · 1 agentic · cost unobserved · 56 s` with
  `0 FINDINGS`, `0 MODEL OBSERVATIONS`, `PREVIEW · NOT COVERAGE`, and `#1 · 4 stages · 0 agentic · no model cost`.
- Click **#2** for **PIPELINE**: five cards top to bottom (capture, parse, inventory, the preview check, *Review the
  code*), each with what it read and produced. The dock on the right shows the picked stage; for the review it reads
  `RUNNER native-copilot`, `MODEL requested gpt-6-luna · reported gpt-6-luna`, `PROMPT sentinel.review.general · rev 1`,
  `SKILLS none`, `TURNS 3 turns`, `TOKENS 12044 tokens in · 335 tokens out`, `COST cost unobserved`.
- Press **OPEN THE STAGE** in the dock for **STAGE**: the review's instructions, then each turn (Sentinel's message and
  its tokens in, the model's request and its tokens out: *asked for the file list*, *asked to read lines
  src/server/auth.ts:1–40*), and what it left. The address is `#/sentinel/<run id>/sentinel.stage.review.general`.
- The owner panel (the dock's second tab) is the companion page: capture, checks and retained inputs and outputs.
- **SCAN** at the top right is greyed while the adopted settings name a model review: a run that calls a model starts
  only from the command line (step 4b). *Rerun this stage* is greyed too on this build.

Stop everything with Ctrl-C in each terminal (the service also stops by itself after the idle time).

### Profiles on other machines

- **No Docker** (this runbook): `init` with the default `static` profile, plus the Copilot provider above. A review
  stage you add to `pipeline.json` by hand is checked at `plan` but not yet planned; the review runs from the
  settings' `reviewModels` binding. A `review` profile for this case is **pending (P-4b)**; this runbook does not use
  it yet.
- **With Docker**: the `agentic` profile adds the pinned Gitleaks and Semgrep scanners; it needs those images already
  installed, `farsight-sentinel assets adopt-tool secrets-gitleaks --confirm` and `… pattern-semgrep --confirm`, and a
  current Gitleaks publication before a hosted review may run. As written today it also names a Claude `triage` stage
  (refused on a Copilot-only machine with *a stage needs a feature that is off*) and five prompt and skill packs no
  package ships; until P-4b drops them, remove the `triage` stage and the `prompt`/`skills` lines from `pipeline.json`.
  This path has not been dry-run here yet.

## 5. If something refuses: the likely mistakes

| mistake | what you see | exit | what to do |
|---|---|---|---|
| **1. Copilot is not logged in** | exactly the success lines of step 4b: `run … · completed · preview findings: 0` and *required checks did not complete: foundation preview complete: this is not required coverage*. Only `report <id> --full` differs: the review line reads `model luna · 1 turns · tokens unknown · cost unobserved · subscription`, and `report <id> --instructions --json` names `sentinel.review.frontier.modelError` | 2 | `copilot login`, then `plan` and `run … --confirm --confirm-models` again |
| **2. Settings not adopted** (or `init` never ran) | `plan`: *configuration or infrastructure failure: this workspace's settings are not adopted* (exit 3). `scan` lists the adoption it would do (exit 4); before `init`, `scan` says *configuration or infrastructure failure: the Sentinel settings file could not be read* (exit 3) | 3 or 4 | `farsight-sentinel init` if needed, then `settings adopt --confirm` and `rules promote builtin:foundation-preview --confirm` (or `scan --confirm`, which does both) |
| **3a. The run.start grant lacks the model effects** (`scope.effects` names `local-artifacts` only) | `run … --confirm --confirm-models`: *configuration or infrastructure failure: no trusted grant allows this action*, in under a second; nothing runs | 3 | set `grants[0].scope.effects` as in step 4b, `settings adopt --confirm`, `plan`, `run` again |
| **3b. No `paid.admit` grant for the provider** | the same line, *configuration or infrastructure failure: no trusted grant allows this action*, in under a second; nothing runs, and `report run-<id> --full` answers *the run has no completed analysis to report* | 3 | append the `paid.admit` grant as in step 4b, `settings adopt --confirm`, `plan`, `run` again |
| **4. Node 22 on PATH** | *SQLite {found} has not been qualified for the Sentinel store on {host} (qualified there: {qualified}) (SQLite 3.51.3 has not been qualified for the Sentinel store on darwin-arm64 (qualified there: 3.53.3, 3.53.4))*; the SQLite version is the one the Node 22 release bundles (3.47.2 on 22.14.0, 3.51.3 on 22.22.3) | 3 | `nvm use 24` in that shell; npm installs the package under Node 22 without complaint, but it only runs under Node 24 |

A changed `pipeline.json` or `settings.json` is refused until adopted again (*the pipeline changed since it was
adopted*). While `farsight-sentinel serve` runs (step 4c), `plan`, `scan`, `status`, `report` and `report --full` go
through it, but the foreground model run and `report --instructions` refuse with *the workspace's service holds the
store; this needs the store in this process (plan, scan, status, report and scans go through the service)*: stop the
service for step 4b. `report` with no run id reads the latest scan, so after a `plan` you have not run yet it answers
*the run did not complete*; name the run (`report run-<id>`) instead.
