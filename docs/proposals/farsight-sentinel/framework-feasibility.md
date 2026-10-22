# Sentinel framework feasibility

This PR01 continuation tests four original synthetic applications with real loopback HTTP requests inside
Linux containers. It supplies bounded E2 evidence for framework ordering, validation registration, matching
and chain selection. Production source-analysis packs, broader supported-version matrices and arbitrary-request
security remain PR14–17 work. No response in these experiments is itself a vulnerability verdict.

## Reviewed corpus and candidates

The [corpus](../../../packages/sentinel/test/fixtures/framework-feasibility/README.md) has 19 hashed sources,
four cases, 11 scenarios and 14 fixed HTTP-status expectations. An independent SOL review verified every
source hash and request driver before the lead's confirming measurement. The reviewed `cases.json` SHA-256
is `3fd763363d2f1168b9fe61e1c651ed522a286cc8fae6ca086bcf5bccf86aac36`; the companion
[acceptance record](feasibility-acceptance.md#framework-criteria-and-independent-label-review) preserves the
original author-review field. The static label and observed response remain separate facts.

| Case | Exact candidate versions | Scope |
|---|---|---|
| Express | express 4.21.2 | Middleware before/after a responding route; opaque function selected once at registration with the environment pinned to `deny` |
| Nest | core/common/platform-express 10.4.15; class-validator 0.14.1; class-transformer 0.5.1 | Empty body with a route ValidationPipe versus the same DTO without a pipe |
| Next | next 14.2.25; react/react-dom 18.3.1 | Matcher inclusion, literal exemption in the body, and excluded path |
| Spring | Boot 3.4.3; Security core 6.4.3 | Two ordered overlapping chains, authenticated branch and unmatched route |

Security 6.4.3 is an exact checked expectation managed by Boot's BOM, not an independently overridden
Maven coordinate. The [versioned Boot dependency definition](https://raw.githubusercontent.com/spring-projects/spring-boot/v3.4.3/spring-boot-project/spring-boot-dependencies/build.gradle)
names that version. The [versioned FilterChainProxy source](https://raw.githubusercontent.com/spring-projects/spring-security/6.4.3/web/src/main/java/org/springframework/security/web/FilterChainProxy.java)
selects the first matching chain and delegates normally when none matches. Alongside this fixture's
controller, that supports the unmatched GET's fixed expectation of 200. An earlier exploratory observation
was retained; it is not substituted for the confirming fixed-expectation run.

## Acquisition and execution boundaries

The preview performs no external calls. `--acquire` is the explicit network-enabled dependency preparation
step: Docker builds original, reviewed fixture applications using digest-pinned Node/Maven base images.
Npm installs use `--ignore-scripts`; Maven and framework compilation run only inside this controlled build.
It never runs a user's analyzed project or an intentionally vulnerable benchmark application. The build
freezes exact resolved dependency evidence and the resulting content-addressed image IDs. This is not a
license audit or an advisory scan. Transitive resolution occurs during acquisition; the acquired image and
retained lock/tree bytes freeze what the subsequent run uses.

`--run` consumes the acquisition record and exact image IDs. It never builds, pulls, installs or contacts a
registry. It checks the corpus and all seven harness hashes, acquisition input identities, the actual image
platform and retained dependency evidence. A requested subset must be explicit and belong to the complete
acquisition selection; omitted work is never silently relabeled as complete. Native host ARM64 and a Linux
ARM64 Docker server are required. These eligibility checks do not establish support for every such host.

Each dependency reader and application probe is created before it starts, then inspected against the requested
image, UID 65534, network `none`, read-only root, no added capabilities or privilege escalation, 1 GiB memory
and swap ceiling, 1 CPU, 256 PIDs and 128 MiB noexec/nosuid temporary storage. Unexpected mounts or altered
limits fail before start. No host bind mounts or published ports are used. Requests remain inside the
container's loopback network. Client completion must agree with the inspected container exit, and post-run
isolation must still match. Cleanup verifies the random owner label and exact ID, removes only that container,
and requires an exact absence response. Normal cancellation still permits bounded cleanup; this is not a
host-crash or durable orphan-recovery implementation.

Every declared HTTP field must be an integer status in 100–599. Empty, null, primitive, partial, duplicated or
ambiguous observations cannot pass. Mismatches are retained as mismatches; absence remains failure. All
four final fixture apps run with a read-only root: the earlier Next failure was an ownership error, corrected
by assigning the built application to UID 65534. It did not justify weakening read-only isolation.

## Final integrated measurement

The lead ran explicit acquisition and then offline execution at clean committed revision
`74eec663d4e32311dd919deb7d78e95504e81ab9`, after independent label and integrated-source review. All four
cases measured successfully: 11 scenarios and all 14 fixed status fields agreed. Every one of the 14 owned
containers (five acquisition dependency readers, five runtime dependency readers and four app probes) passed
pre/post isolation and completion checks and was verified removed. No dependency acquisition occurred during
`--run`. The host used Node 24.19.0 on macOS ARM64 and Docker Engine 29.2.1 with Linux ARM64 containers.

[Final acquisition](evidence/2026-10-22-decisions/framework-acquisition-final.json) SHA-256:
`9966a8c62af6ee8399e78adcdd8191702cbc4c7cedcfdb885cf01150f9797f2a`.
[Final runtime](evidence/2026-10-22-decisions/framework-run-final.json) SHA-256:
`e57bfd5a49c4feaae3f044a40da39c4c2c04a00709759e3ae15075a031d1d1ac`.
[The input archive](evidence/2026-10-22-decisions/framework-acquisition-files.tgz) retains all 32 exact source,
generated and dependency-evidence files with a manifest. The four final acquisition tags were then removed
without force and each image ID was independently confirmed absent; [disposal evidence](evidence/2026-10-22-decisions/framework-disposal-final.json)
retains those checks. Earlier acquisition images are separate historical resources, not reported as removed.
The decision manifest remains proposed for owner acceptance before PR02.

Every observed result matched the following fixed expectation:

| Case | Scenario | Static label | Expected status |
|---|---|---|---|
| Express | auth before route | bounded-safe-pattern | 401 without token; 200 with token |
| Express | auth after responding route | unknown-enforcement | 200 with and without token |
| Express | opaque middleware, fixed deny branch | unknown-enforcement | 403 |
| Nest | validator with pipe | bounded-safe-pattern | 400 for empty body |
| Nest | validator without pipe | unknown-enforcement | 201 for empty body |
| Next | matched and blocked | bounded-safe-pattern | 403 |
| Next | matched but exempted | unknown-enforcement | 200 |
| Next | excluded by matcher | unknown-enforcement | 200 |
| Spring | earlier open chain | unknown-enforcement | 200 without credentials |
| Spring | later authenticated chain | bounded-safe-pattern | 401 without credentials; 200 with credentials |
| Spring | no matching chain | unknown-enforcement | 200 without credentials |

A configured response can refine knowledge of that run without changing an unknown static label. The
permissive opaque-middleware branch is unmeasured. GET status 200 does not prove that every security filter,
including CSRF processing, did or did not execute. Source structure supplies the bounded explanation; a
future adapter must retain an unmatched-chain condition and its uncertainty rather than inherit another
chain's policy or declare a vulnerability without a required policy.

## Retained corrections and limits

[The evidence index](evidence/2026-10-22-decisions/index.json) names immutable originals with byte counts,
hashes and limitations. It retains the initial owner-label cleanup refusal, the invalid Nest result that
said `measured` with null observations, the dirty-tree combined run, the acquisition/run split at `536e6b1`,
and corpus-corrected acquisition at `0cb1a3c`. None is acceptance evidence for the final hardened runner.
The original orphaned resources were cleaned up by their exact identities; unrelated services were preserved.

Review corrected the owner-label mismatch, nested probe-payload parsing and vacuous success, then separated
acquisition from offline execution. SOL cross-review added strict command completion, exact isolation and
cleanup checks, bounded file identity, cancellation, acquisition provenance and nonempty typed outcomes.
Corpus review fixed the unchecked descriptive Spring version, froze the unmatched-route expectation and
corrected Express's registration-time explanation. These changes are covered by focused regressions and a
fresh integrated measurement, not by rewriting earlier outputs.

One confirming run per scenario supplies no flake rate or broad conformance claim. Dynamic registration,
custom decorators, interceptors, WebFlux, arbitrary chain combinations and other versions remain unmeasured.
Framework declarations alone still do not prove enforcement. `core/openapi.ts::guardsOf` and `matchesGuard`
remain reconciliation heuristics; this work does not turn them into an enforcement oracle.

## Reproduce

```sh
node scripts/sentinel-feasibility-frameworks.mjs
node scripts/sentinel-feasibility-frameworks.mjs --acquire --out /tmp/sentinel-fw-acquisition-new
node scripts/sentinel-feasibility-frameworks.mjs --run --acquired /tmp/sentinel-fw-acquisition-new --out /tmp/sentinel-fw-run-new
```

Use fresh output directories and committed experiment inputs. `--case` selects a named case or comma-separated
subset. The separately requested disposal command removes only the exact acquired images after identity
verification; it is not part of a scan. It must not remove another workstream's containers or images.
