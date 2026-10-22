# @farsight/sentinel (draft)

The optional Sentinel security-analysis boundary. **This package does not scan anything yet.** It defines the
draft contracts the later implementation PRs build on, validates them, and ships a placeholder
`farsight-sentinel` executable that lists what is unavailable. Nothing in it captures source, opens a ledger,
starts a process or container, downloads a tool or contacts a model provider. Farsight's own packages neither
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

Spans are zero-based, half-open UTF-8 byte offsets. Paths are source-relative POSIX paths with no `.`/`..`
segment. Money is a decimal string. Resource ceilings are the PR 01 proposed defaults (2 GiB, 2 CPUs,
128 PIDs, 120 s, 4 MiB output); a profile can only lower them.

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
`sentinel.contract.*` and `sentinel.protocol.*`). There is no catalog of Sentinel's own. Human output prints each validation error as its
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
boundary. They need no scanner, container, network or credential. `test/fixtures/` holds PR 01's feasibility
inputs, which this package leaves untouched.
