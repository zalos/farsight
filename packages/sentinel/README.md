# @farsight/sentinel (draft)

The optional Sentinel security-analysis package. It captures immutable source, admits canonical plans, runs the
four pinned scanners through isolated Linux containers, and regenerates observations and coverage from accepted
publications. `static` keeps the original foundation preview; `scanners` selects Pattern, OSV, Trivy and zizmor.
Importing the library starts nothing. Scans acquire no assets and execute no project scripts or package managers.
Farsight's application packages neither depend on nor import this optional package.

Plan: [`docs/proposals/farsight-sentinel/implementation-plan.md`](../../docs/proposals/farsight-sentinel/implementation-plan.md),
PR 02 in [`implementation-prs.md`](../../docs/proposals/farsight-sentinel/implementation-prs.md).

## Envelopes

| Kind | Version | What it records |
|---|---|---|
| `snapshot` | `sentinel-snapshot/draft-1` | Immutable capture facts: sources, the inventory (included / recorded / symlink / directory-boundary entries), framework versions with provenance or an unknown reason |
| `run` | `sentinel-run/draft-1` | One requested analysis over a snapshot: locks, policy, budgets, state; a completed run's outcome and policy result |
| `work` | `sentinel-work/draft-1` | One logical work unit at one immutable revision: stage, fingerprint, dependencies, resource ceilings, state |
| `attempt` | `sentinel-attempt/draft-1` | One append-only execution: worker identity (owned child, owned container, fenced external claim), usage and its certainty |
| `observation` | `sentinel-observation/draft-1` | One producer's original claim, with byte-span evidence; model identity at its real strength |
| `coverage` | `sentinel-coverage/draft-1` | What a check covered, at what granularity, on what basis (executed, reused, imported, unavailable) |
| `disposition` | `sentinel-disposition/draft-1` | A scoped, expiring decision; only the owner's CLI channel can record an approval |
| `report` | `sentinel-report/draft-1` | A projection at a pinned ledger sequence and evaluation time: findings with placement, gaps, decisions, scoped counts |
| `protocol` | `sentinel-worker/draft-1` | Every worker/coordinator message, from `hello` to `result` |
| `rulepack` | `sentinel-rulepack/draft-1` | A rule pack's manifest: rules with declarative applicability, required capabilities, fixtures and rights |
| `rulelock` | `sentinel-rulelock/draft-1` | The immutable lock a plan pins: packs by inventory digest, rules by definition digest, tools and databases by digest |
| `settings` | `sentinel-settings/draft-1` | The owner's trusted settings: mandatory rules, thresholds, grants, providers with keychain references |
| `repoconfig` | `sentinel-repoconfig/draft-1` | The repository's requests; refused where they would weaken trusted policy |
| `policy` | `sentinel-policy/draft-1` | The redacted effective policy, with every refused request |
| `adoption` | `sentinel-adoption/draft-1` | The owner's adoption of one settings digest for one workspace identity |
| `receipt` | `sentinel-receipt/draft-1` | A human owner's one-use, short-lived confirmation of one exact intent |
| `admission` | `sentinel-admission/draft-1` | The three ANDed verdicts (policy, capability, credential authority) and the outcome |
| `controls` | `sentinel-controls/draft-1` | A framework pack's control facts per surface, property and chain position (PRs 14–17) |

The types under `src/contracts/` are the one source. `pnpm --filter @farsight/sentinel schemas` generates
`schemas/*.schema.json` and the bundled `src/schemas.generated.ts`; `schemas:check` fails on drift, and the
tests run that check too. Validation (`validateEnvelope`, `parseEnvelope`) works in three steps: an exact
version check, then the JSON schema (unknown fields are refused, not dropped), then cross-field invariants
a schema cannot express. Each error carries a stable `sentinel.contract.*` code.

The newer implementation plan governs where it differs from the earlier `contracts.md` sketch. A snapshot holds
immutable capture facts only; stage coverage, parse outcomes and findings are separate, append-only records.
Every reference that names work carries `(id, revision)`: dependencies, attempts, coverage, reuse publications and
the worker protocol's binding. A test walks the generated schemas to enforce both rules.

There are no retention fields here. v1 never deletes anything automatically. The age and count values PR 01
proposed are only thresholds that make a record eligible for an explicit prune (PR 03/26).

Every report number is a core `Counted` (unit, optional business unit, scope, source, breakdown with labels,
recheck) whose words are in the shared catalog (`strings-sentinel-report.ts`, scopes `sentinel.scope.*` in
`COUNT_SCOPES`). *Seen by no stage* is always an exact count of included entries, zero included. Folders whose
contents were never listed are counted apart as unknown scope and never read as zero files. Placement uses
canonical graph identities (`repo::path/to/File.tsx::Component`), not ledger IDs. Timestamps are real UTC
calendar instants. Validation stops at the first schema failure and caps invariant errors at 100, so a large
broken record cannot multiply into a large error list.

Paths are checked segment by segment in the schema and again at runtime. A line break is a legal byte in a
POSIX name and is kept, but it cannot hide an empty, `.` or `..` segment. A run's policy result has to agree with
its state and outcome. A report decision's validity has to agree with its expiry at the report's own evaluation
time. Invalidation remains the service's own finding.

Spans are zero-based, half-open UTF-8 byte offsets. Paths are source-relative POSIX paths with no `.`/`..`
segment. Money is a decimal string. Resource ceilings are the PR 01 proposed defaults (2 GiB, 2 CPUs,
128 PIDs, 120 s, 4 MiB output); a profile can only lower them.

## Rule packs, the lock and trusted policy (draft)

`./rules` reads a candidate pack as data (`readPackDirectory`, `validatePack`) and promotes it into an immutable lock
(`promote`) only with the owner's spent receipt for that candidate against that lock; a plan pins `lockDigest(lock)`
and `verifyPinnedLock` refuses any other revision. `resolveLockedRules` returns the original definitions of the locked rules from the exact validated packs the lock pins, refusing any other pack. `./policy` parses settings and repository intent, merges them so the
repository can only tighten (`effectivePolicy`, whose `view` is the only policy to serve), binds settings to a workspace
through owner adoption in user state (`adoptionIntent`, `adoptSettings`, `loadPolicyInputs`), spends receipts once
(`ReceiptBook.consume`) and records three-verdict admission (`admit`). Receipt issuing is internal to the owner CLI
flow and is not exported. There is no planner yet (ADR 23).

## Deterministic planning (draft)

`farsight-sentinel/planner` turns a pinned rule lock, the effective policy, a captured snapshot and its parser
evidence into an immutable `sentinel-plan/draft-1` revision: every check a selected rule implies, each planned onto
exactly one work unit or kept with its reason (unsupported, applicability unknown, scope unavailable or unknown).
`workEnvelopesFor` gives the coordinator canonical work envelopes for a plan. A new rule plans a new revision over
the already published capture and parse; earlier revisions never change (ADR 24).

## The local store (draft)

```ts
import { openStore } from 'farsight-sentinel/store'; // also exported from 'farsight-sentinel'

const store = await openStore('/absolute/canonical/path/to/store'); // created 0700 when absent
try {
  const bytes = Buffer.from('evidence');
  const id = store.objects.identify(bytes);
  store.ledger.registerStaging('stage-1', [{ id: id.id, schema: 'text/plain', privacy: 'source' }], { work, attemptId });
  const receipt = await store.objects.put(bytes, { expect: id });           // written, fsynced, verified, linked
  store.ledger.publish({ work, attemptId, stageId: 'stage-1', receipts: [receipt], outputs: [id.id], endedAt });
  await store.readArtifact(id.id);                                          // any process, after a reopen
} finally {
  store.close();                                                            // closes the ledger, then the lock
}
```

`openStore` takes the real owner lock before it opens or migrates the ledger, binds the ledger to the object
store's own verifier, and releases everything if any step fails. One process owns a store at a time; each owner
has its own epoch, and records from an earlier epoch are refused. A publication is accepted in one transaction,
only after each named object was re-read and hashed in this store. `inspect()` and `planPrune()` are read-only;
nothing is ever deleted automatically, and the artifacts a retained work or attempt names (manifest, invocation,
outputs, diagnostics) are never prune candidates while its records are kept. Every refusal carries a stable reason code (`STORAGE_ERROR_CODES`) whose
words are in the shared catalog.

Qualified, and refused otherwise: an exact host and SQLite pair the release policy lists (`qualificationFor`), and a
canonical owner-only folder on a file system the path checks identify as local. Measured: darwin-arm64 with SQLite
3.53.3 and 3.53.4 on APFS; linux-x64 with SQLite 3.53.4 on ext4, Node 24.21.0
([CI evidence](https://github.com/zalos/farsight/actions/runs/39723522049/job/119642215934)). The other allowlisted local file system types are not measured. Any other pair is refused before a file is created. Durability holds across process death, not physical power loss (see ADR 19 in
`docs/ARCHITECTURE.md`). A store is a library facility in this draft: the `capabilities` list shows `ledger` as
`available-draft` and every scan capability as unavailable; there is no store command until the CLI (PR 09).

## Source capture (draft)

```ts
import { captureSnapshot, openSnapshot, restoreSnapshot } from 'farsight-sentinel/snapshot'; // also from 'farsight-sentinel'

const result = await captureSnapshot(store, {
  mode: 'committed-tree',                                   // or 'working-copy' (stability-checked)
  sources: [{ sourceId: 'app', repositoryId: 'example/app', root: '/canonical/path/to/app' }],
});
result.snapshot;                                            // sentinel-snapshot/draft-1, admitted by the ledger
const { snapshot, materialization } = await openSnapshot(store, result.record.snapshotId); // any process, later
await restoreSnapshot(store, result.record.snapshotId, '/canonical/parent/new-folder'); // read-only, from the store alone
```

A committed tree is read object by object from the local repository; no `git` process, hook, filter or fetch runs,
and missing objects are recorded, not fetched. A working copy is read, stored and read again; a change retries the
capture and one that never settles is refused. Every enumerated entry is recorded: hidden configuration is included,
`.git`, the store, dependency caches and policy exclusions are boundaries whose contents are unknown, and links,
special files, unsafe or colliding names, unreadable, too-large and over-quota files are recorded with their reason
(`CAPTURE_REASON_CODES`). LFS content and submodules come only from local inputs you name. Each artifact is staged
before it is written, and the whole snapshot is admitted in one ledger transaction, without a run. A materialization
sidecar keeps every listed folder (empty ones too), executable bits, Git and LFS provenance, link targets and
gitlink commits, so a restore reproduces the tree. Parser artifacts, framework versions and scan coverage are not
part of a snapshot yet. A restore is never executable: files are 0400 (0600 when writable), whatever their mode was;
the original mode stays provenance in the sidecar. A capture stores at most 512 MiB. See ADR 21 in `docs/ARCHITECTURE.md`.

### Parser evidence (draft)

```ts
import { parseSnapshot, retainSnapshotAnalysis } from 'farsight-sentinel/parser';

const analysis = await parseSnapshot(store, {
  snapshotId, workDir: '/canonical/private/folder',
  selection: { gitignore: true, testFiles: 'include' },            // stated in full; enrichment options are refused
  limits: { maxFiles: 10_000, maxFileBytes: 4 << 20, maxTotalBytes: 128 << 20, maxEntries: 100_000, maxDurationMs: 60_000 },
});
analysis.sources[0].result.entries;   // every captured entry: parsed, parse-failed, parser-skipped, not-selected, not-captured, unknown-scope
```

`parseSnapshot` restores the snapshot from the store into a private, read-only, non-executable folder, never the original
checkout, and runs the public `@farsight/code-parser` with its built-in TS/JS and Java adapters (loaded on first parse).
The tree is fingerprinted before and after. Every recorded parser input is reconciled by kind: content against the
captured bytes, folder listings, kinds, and missing paths. A missing path is verified absent, recorded by capture,
under an unenumerated boundary or inside a gitlink. Anything unexplained fails with `sentinel.parse.integrity`. The
complete analysis artifact (occurrences included), an index of node and call-site locations as captured content IDs
with UTF-8 byte spans, and a result record can be published with `retainSnapshotAnalysis`. `parserComplete` is the
parser's own selection flag, not coverage, and parser evidence clears no check (`clearsChecks: false`). No
application ingestion, configuration enrichment, network or process is used.
## Install and initialize with npm only (draft)

Sentinel needs Node 24 or later and npm; no pnpm and no Farsight checkout. Install one pinned tarball, then work in
the folder you want to scan:

```sh
npm install -g <pinned farsight-sentinel tarball URL>   # a GitHub Release asset once one is published (PR 26);
                                                        # until then a local build of scripts/pack-sentinel.mjs
cd /path/to/your/workspace
farsight-sentinel init                     # .farsight/sentinel/settings.json (0600); again: kept byte for byte
farsight-sentinel settings adopt --confirm # you, the owner, adopt these exact bytes (without --confirm: shown, exit 4)
farsight-sentinel rules promote builtin:foundation-preview --confirm   # the shipped original pack into your rule lock
farsight-sentinel plan                     # capture, publish the bootstrap, plan and admit the analysis; prints the run id
farsight-sentinel run <runId>              # foreground; a foundation preview ends exit 2 (never "satisfied")
farsight-sentinel status <runId>           # the run's state and a bounded page of its events
farsight-sentinel report <runId>           # Markdown (or --format json), from stored results only
farsight-sentinel run <runId> --detach --confirm   # hand it to the background service (started on demand)
farsight-sentinel wait <runId>             # its result once it ends; pause|resume|cancel <runId> --confirm
farsight-sentinel rerun <runId> [--stage <unit,...>]   # a linked run over the ended run's retained snapshot; previews
                                           #   what runs again (selected + downstream) and what is reused
farsight-sentinel retry <runId>            # the same, selecting the units that did not publish
```

`init` writes the settings file only when it is missing: PR 06's defaults plus one grant letting the owner (a
person, never an agent) capture and run the `static` profile. Settings name credentials by keychain reference
only (`keychain:farsight/<name>`). Nothing downloads a tool, installs a scanner, starts a container or contacts a
model provider. The default `static` preset is a **foundation preview**: one original coded check (SQL text assembled from strings in
TypeScript, JavaScript and Java) shows the whole path working; it is not scanner or framework coverage, and its
report says so. A background run survives the command that started it: the owner's service (`serve`, started on
demand, stopping when idle) holds the store, a duplicate start joins the same run, and a run interrupted by the
service stopping resumes with `resume <planId> --confirm`. Only the owner's `--confirm` hands a run over; another
client of the service gets what the adopted grants give agents, which by default is nothing. `retry` and full `rerun` prepare a child over the retained snapshot; strict stage selections remain disclosed and refused. With `--json`, every result carries its `outcome`, `exitCode`, the three
admission verdicts (`policy`, `capability`, `credential`) and its facts. See ADR 37 in `docs/ARCHITECTURE.md`.

## Explicit pinned scanner commands (draft)

Install the standalone tarball with npm and use the installed executable. The scanner preset is separate from the
preview and makes its seven shipped rule families mandatory. Initialization never overwrites existing settings;
a second initialization keeps the existing preset until the owner edits and adopts those settings.

```sh
farsight-sentinel init --profile scanners
farsight-sentinel settings adopt --confirm
farsight-sentinel rules promote builtin:pattern --confirm
farsight-sentinel rules promote builtin:advisories --confirm
farsight-sentinel rules promote builtin:infrastructure --confirm
farsight-sentinel rules promote builtin:ci --confirm
farsight-sentinel assets adopt-tool pattern-semgrep --confirm
farsight-sentinel assets adopt-tool advisories-osv --confirm
farsight-sentinel assets adopt-tool iac-trivy --confirm
farsight-sentinel assets adopt-tool ci-zizmor --confirm
farsight-sentinel assets adopt-database osv:npm --manifest <snapshot.json> --archive <snapshot.zip> --license <published-SPDX-expression> --confirm
farsight-sentinel assets adopt-database trivy-checks --manifest <checks.json> --archive <checks.tar.gz> --confirm
farsight-sentinel plan --json
farsight-sentinel run <runId> --detach --confirm --json
farsight-sentinel wait <runId> --json
farsight-sentinel report <runId> --json
```

Images must already be installed at the shipped immutable pins. `assets adopt-tool` inspects the qualified local
runtime and exact image; it never pulls or starts a scanner. Database adoption reads the explicitly named archive
and provenance through bounded descriptors, verifies their hashes and metadata, and retains independent private
copies outside the checkout. OSV adoption requires the owner to state its published license expression; this command
does not infer a blanket license for all advisory sources. The pinned Trivy checks bundle retains its MIT license,
separately from the engine's Apache-2.0 license. The receipt binds the exact candidate, provenance, rights
and previous lock revision. A scan uses the admitted lock, including older retained revisions, rather than whatever
lock happens to be current. Missing or changed required assets refuse before any scanner attempt.
External scanner runs disclose and require `tool-execution` as well as `local-artifacts`; a narrower adopted grant
refuses before any scanner attempt. The exact local preview remains a local-artifact action. Asset adoption decides
policy before querying Docker, and still confirms the final exact candidate after inspection.

For acquisition, `assets acquire-database osv:npm --max-bytes <limit> --confirm` (or `osv:Maven`) invokes the reviewed
OSV allowlisted broker; `assets acquire-database trivy-checks --confirm` invokes the pinned checks broker. Both are
separate, bounded owner actions with a deadline, no inherited login credentials, and a one-use receipt spent before
network access. Acquisition prints the held archive/manifest paths with `--json`; it does not promote them. Adopt
those explicit files separately. Nothing is downloaded during plan/run, and no database ships in the npm tarball.

Production units batch at most 32 scopes so an applicable file and explicit skipped-file gaps can publish together.
The preview keeps one scope per unit. A unit with nothing runnable refuses preparation and stays unpublished; failed,
unreported, unsupported, offline-limited and stale/age-unknown assessments cannot become zero-clean coverage.

The scanner report is the draft CLI slice `sentinel-scanner-report/draft-1`, distinct from the later full report
contract. It reads only accepted publications of the exact admitted plan, includes normalized observations, pinned
rule/tool/database identities and the canonical required-coverage fold, and carries scoped counts with recheck
commands. It regenerates after the original checkout and service disappear. Finding policy, framework checks and
model review remain outside this slice: even complete required coverage is not a satisfied policy result. The
platform statement comes from each actual verified worker outcome, including its measured/unmeasured state.

Qualification: `scripts/test-sentinel-scanner-consumer.mjs` exercises this installed npm-only command path with all
four existing pinned images, original inert positive/negative files, a tiny synthetic advisory snapshot and held
checks. `SENTINEL_ISOLATION=1` and `SENTINEL_TRIVY_CHECKS_DIR` select the explicit local prerequisites; no test pulls
an image or downloads a database. Public CLI, profile and asset commands remain internal modules of the executable,
not new JavaScript exports.

## Infrastructure configuration checks (draft)

The Trivy adapter (ADR 33) checks Dockerfiles, Kubernetes YAML and Terraform with Trivy 0.76.1's
misconfiguration scanner and the pinned trivy-checks 2.3.0 bundle, in an isolated container with no network. The
owner acquires the bundle once (`node scripts/acquire-trivy-checks.mjs --dir <private folder>`); without it nothing
runs and every configuration file is reported as `bundle-missing`. Coverage is per file and needs the engine's own scan
evidence; inline ignore comments, remote modules and unread variable files leave a file partial. Findings are a check
id, severity and lines at a captured path; no graph node is created. Real-engine tests run with `SENTINEL_ISOLATION=1`
and `SENTINEL_TRIVY_CHECKS_DIR` set to that folder.

The zizmor adapter (internal, ADR 34) audits GitHub Actions workflows, action definitions and Dependabot configuration
with zizmor 1.31.1, offline, with no token, repository configuration or ignore comments. The five audits that need the
GitHub API are reported as skipped on every workflow and action, which therefore stays partial; findings are an audit,
severity and byte spans at a captured path.

### Express control facts (draft)

```ts
import { analyzeExpress } from 'farsight-sentinel/frameworks/express';

const facts = await analyzeExpress({ snapshot, sourceId: 'app', analysis: analysis.sources[0], readContent: id => store.readArtifact(id) });
facts.facts;      // per route and property: applies / does-not-apply / unknown at a position before the handler
facts.frontiers;  // registrations the pack met and could not follow
```

For exactly Express 4.21.2 (an exact pin, or a range the npm lockfile resolves to it), the pack reads each route's
registration and every layer registered before it on the application and the routers on its path, in order, from
captured source only. No layer is credited with authentication or authorization: a body that refuses with 401 or 403
on a request value is cited as evidence with both properties unknown there, because the client may control that value;
a name never establishes anything, and a layer registered after a route never clears it. Conditional or dynamic registration, third-party middleware, unreadable paths and error
handlers that may resume routing are unknown with their reasons. The envelope is `sentinel-controls/draft-1`; ADR 31.

## Versions and evolution

- **Draft until review.** Every name ends in `/draft-1`. A name moves to `/v1` only after an independent
  contract review approves the freeze. A draft can still change incompatibly; when it does, its number goes up.
- **A mismatch is explicit.** A known envelope at an unsupported version returns `unsupportedVersion`, which
  lists the versions this build reads. A different envelope's name returns `wrongKind`, and a missing version
  returns `missingVersion`. A value is never upgraded, downgraded or partly read. A worker `hello` lists its
  versions: the coordinator either answers `welcome` with the one shared version or `refuse`s.
- **After a freeze, changes are additive only.** New optional fields and new enum members go into a new minor
  draft or `v1` revision, with the pin tests updated in the same change. A removal, a rename or a narrowed
  meaning needs a new major version (`/v2`) read side by side with the old one. Every enum set is pinned
  against an explicit literal list and the generated schema (`test/contracts.test.ts`).

## Words

Everything the executable prints comes from the shared two-register catalog in core
(`packages/core/src/strings-sentinel-cli.ts`, keys `sentinel.cli.*`, `sentinel.capability.*`,
`sentinel.contract.*` and `sentinel.protocol.*`; the store's reason codes in `strings-sentinel-store.ts` and
`strings-sentinel-storage-errors.ts`; arguments, outcomes, verdicts, actors, the local socket, `init` and the preview
report in `strings-sentinel-service.ts`). There is no catalog of Sentinel's own. Human output prints each validation error as its
code, location and catalog words; the validator's diagnostic `message` appears only in `--json` output.

## Exit codes

`0` satisfied · `1` finding policy failed · `2` required coverage incomplete · `3` configuration or input error ·
`4` awaiting owner confirmation before admission. These codes are Sentinel's own: `farsight work` keeps using `2`
for awaiting confirmation. Configuration failure takes precedence over the others, followed by coverage and
then findings (`policyResultOf`). Every unavailable command in this draft exits `3`, and so does a refused command
line: each command accepts only its own options, and an unknown, missing or repeated one is refused, never ignored.

## Tests

`pnpm --filter @farsight/sentinel build && pnpm --filter @farsight/sentinel test`. The tests import `dist/`. They
cover valid fixtures for every kind and union branch, over 100 invalid cases (each with its expected error code
and location), exact-limit bounds, version refusal, the drift check, the enum pins, the CLI and the package
boundary, and the store: runtime gate, owner lock across real processes, ledger, objects, reachability and the
facade end to end (`test/store-integration.test.ts`). They need no scanner, container, network or credential. `test/fixtures/` holds PR 01's feasibility
inputs, which this package leaves untouched.

## Pattern adapter (draft)

`src/adapters/pattern/` runs Semgrep 1.181.0 (`semgrep/semgrep@sha256:81474464…304b`, installed ahead, never pulled)
through the PR 07 execution service only. Semgrep cannot speak the worker protocol, so an original shim
(`worker-source.ts`, Python standard library) runs inside the pinned image as `/usr/bin/python3 -I -S -B
/input/<shim digest>`: it reads the one job among its inputs, materializes the targets under the container's noexec
`/tmp` by their relative paths (never repository ignore files, plus its own empty `.semgrepignore` so the engine's
default ignores cannot drop requested files), runs the fixed engine arguments (`--json --verbose --dataflow-traces
--metrics=off --disable-version-check --jobs 1 --timeout 20 --max-target-bytes 1000000 --disable-nosem --no-git-ignore
--no-rewrite-rule-ids --oss-only --time`) and returns the raw JSON and a run record as outputs. `normalize.ts` then decides,
coordinator-side: job rules on job targets in declared languages only, byte spans checked against the captured bytes,
Sentinel's own finding identity, structural locators kept apart from local taint, cross-file flows refused, and
coverage per file per rule: a rule is complete on a file only when the engine timed it there; a rule the engine's
prefilter skipped is not run, a rule-named timeout is partial, missing timing is not established, and a requested file
neither scanned nor skipped is omitted even on exit zero. Results from an unmeasured image platform are refused.

Measured scope (conformance, darwin-arm64 with Docker Desktop, the pinned image): the original pack in `rules/pattern/`
finds its three direct positives (TS, JS, Java) as structural locators and its three local positives as local taint,
none of its six negatives, and no cross-file flow; an engine-reported one-second rule timeout marks exactly the rules
that timed out (host-dependent, so it pins the reporting path, not a threshold). Semgrep 1.181.0's open-source engine
reported no dataflow trace for those taint results, so local-taint evidence names its sink and records the trace as not
reported. Platforms: linux/arm64 and linux/amd64 measured. Native amd64 qualification passed all 22 tests with zero skips
and ran the installed worker against its original fixtures ([qualification run](https://github.com/zalos/farsight/actions/runs/39790599932)). A failed engine run is reported
only as a fixed category and its exit code; no engine text is forwarded. The tarball ships the pack under
`rules/pattern/` and the worker with a digest/rights manifest under `assets/pattern/`; nothing exported invokes the
adapter, so the package gate is partial until the PR 09 command (ADR 26). Integration still open:
registering the adapter, the planner supplying the shim, job, rules and targets as inputs, and the scan command (PR 09).
## Dependency advisories (draft)

`src/adapters/osv/` matches dependency files against pinned OSV advisory snapshots with OSV-Scanner 2.7.0, fully offline,
through the PR 07 execution service. Inputs: `package-lock.json`, `pnpm-lock.yaml` (resolved, transitive as locked),
`pom.xml` (declared directs only; ranges and managed versions unknown; transitives never resolved offline) and
`*.cdx.json` (as the SBOM lists). Each component keeps its file, artifact, identity, version certainty and transitive
limit; findings are once per component and advisory group, keyed by the snapshot; coverage is per file (complete,
partial, database-absent, database-stale, error, empty, not applicable).

**Acquisition is a separate, owner-confirmed step**:

```sh
farsight-sentinel assets acquire-database osv:npm --max-bytes 536870912   # preview, then --confirm
```

It fetches only `https://osv-vulnerabilities.storage.googleapis.com/<ecosystem>/all.zip`, within the bound, checks the
origin's MD5 and stores the archive by SHA-256 with its provenance. Separately,
`scripts/qualify-osv-database.mjs --acquire --dir <private folder>` is the owner-run qualification (real archives,
synthetic fixtures and runtime-only positive controls). Measured on 2026-10-22 (darwin-arm64, Docker Desktop): npm
218,843,332 bytes and Maven 10,427,762 bytes acquired in about 12.5 s; on the real databases the synthetic fixtures gave
no finding, `lodash@4.17.11` (lockfile) 7 advisory groups and `jackson-databind@2.9.8` (POM, exact) 60; a scan with the
npm archive took about 7–10 s. The public scanner command layer now composes this adapter through the canonical coordinator; adoption and promotion remain explicit, and no JavaScript export starts work.

The offline advisory adapter is measured on Linux arm64 and native Linux amd64. The [amd64 qualification](https://github.com/zalos/farsight/actions/runs/39788785215) passed 21 tests with zero skips and ran the installed worker against its original fixtures. The public installed CLI path is qualified separately with the original synthetic corpus and held assets as described above.
### Secrets adapter qualification

The pinned Gitleaks 8.30.1 current-tree adapter has real container conformance evidence on ARM64 with Docker
Desktop (Engine 29.2.1) and native AMD64 on Ubuntu 24.04.5 with Node 24.22.0. The native
[isolation run](https://github.com/zalos/farsight/actions/runs/39801723971/job/119904045294) passed all 93 cases
without skips, including Gitleaks positive/negative, omission, malformed output and redaction cases. The same
image index, default rules and worker bytes apply; other platforms remain refused. This qualification does not
complete the public scan command integration or add Git-history scanning.
