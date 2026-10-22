# @farsight/sentinel (draft)

The optional Sentinel security-analysis boundary. **This package does not scan anything yet.** It defines the
draft contracts the later implementation PRs build on, validates them, provides a draft local store for runs and
evidence (below), and ships a placeholder `farsight-sentinel` executable that lists what is unavailable. Nothing in
it captures source, starts a scanner or container, downloads a tool or contacts a model provider, and importing it
opens nothing: a store is opened only by an explicit `openStore()` call. Farsight's own packages neither
depend on it nor import it (a test checks this).

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
`strings-sentinel-storage-errors.ts`). There is no catalog of Sentinel's own. Human output prints each validation error as its
code, location and catalog words; the validator's diagnostic `message` appears only in `--json` output.

## Exit codes

`0` satisfied · `1` finding policy failed · `2` required coverage incomplete · `3` configuration or input error ·
`4` awaiting owner confirmation before admission. These codes are Sentinel's own: `farsight work` keeps using `2`
for awaiting confirmation. Configuration failure takes precedence over the others, followed by coverage and
then findings (`policyResultOf`). Every unavailable command in this draft exits `3`.

## Tests

`pnpm --filter @farsight/sentinel build && pnpm --filter @farsight/sentinel test`. The tests import `dist/`. They
cover valid fixtures for every kind and union branch, over 100 invalid cases (each with its expected error code
and location), exact-limit bounds, version refusal, the drift check, the enum pins, the CLI and the package
boundary, and the store: runtime gate, owner lock across real processes, ledger, objects, reachability and the
facade end to end (`test/store-integration.test.ts`). They need no scanner, container, network or credential. `test/fixtures/` holds PR 01's feasibility
inputs, which this package leaves untouched.
