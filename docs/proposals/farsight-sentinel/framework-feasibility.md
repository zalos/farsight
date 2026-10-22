# Sentinel PR 01 E2 framework evidence

This slice extends PR 01's E2 gate, which the [prior results record](feasibility-results.md#decisions-and-remaining-gates)
explicitly left open: *"Keep all framework versions as candidates; retain source-grounded labels ...
Runtime/prototype order, matcher and chain evidence, exact supported versions ... still required."* It
introduces no production Sentinel package, framework adapter or public contract. It does not authorize
PRs 14–17; it is bounded prototype evidence for their eventual E2 gate, and for PR 01's own decision record.

## What this slice adds, and what it does not

The existing [corpus](../../../packages/sentinel/test/fixtures/feasibility/README.md) already carries
source-grounded static labels for Express, Nest, Next and Spring fixtures (`express-order`,
`nest-validation`, `next-matcher`, `spring-chains`). Those labels describe what the source text supports;
the [protocol](feasibility-protocol.md) is explicit that they "do not certify runtime protection." This
slice is a second, independent corpus,
[`packages/sentinel/test/fixtures/framework-feasibility/`](../../../packages/sentinel/test/fixtures/framework-feasibility/README.md),
with one complete, minimal, original app per framework and candidate version, each built into a pinned
container image and then actually run with `--network none`, sending it real loopback HTTP requests from
inside its own container and recording the real status codes. The static label and the runtime observation
are kept as two separate fields on every scenario; nothing here lets a runtime pass upgrade a label, and
nothing here lets a label stand in for a measurement.

Pinned candidates, as requested: Express 4.21.2; Nest 10.4.15 with class-validator 0.14.1 and
class-transformer 0.5.1; Next 14.2.25 with React 18.3.1; Spring Boot 3.4.3 with
`spring-boot-starter-security`, whose actually resolved Spring Security version this build recorded as
**6.4.3** (from a real `mvn dependency:tree`, not assumed from the brief, and checked again on every
acquisition — see Acquisition below). This is four apps and eleven scenarios total, not a framework
conformance suite, a taint/deep-flow engine, or a supported-version matrix. Exact framework behavior for
PRs 14–17 still needs its own, separately scoped runtime probes against a broader fixture set before any
support claim; this slice is evidence toward that gate, not the gate itself.

## Acquisition, execution and disposal are three separate commands

A source review of the first version of this slice found that acquisition and execution were only
separated *within* one `--run` invocation, which rebuilt (and so re-resolved dependencies from the
registry) on every invocation rather than freezing a pinned result a trial could repeat against. The
harness (`scripts/sentinel-feasibility-frameworks.mjs`, `scripts/sentinel-feasibility/frameworks/*.mjs`)
now has three explicit commands, and `--run` never builds, pulls or resolves anything:

```sh
node scripts/sentinel-feasibility-frameworks.mjs --acquire --out <fresh-dir>                      # network allowed
node scripts/sentinel-feasibility-frameworks.mjs --run --acquired <acquire-out-dir> --out <fresh-dir>  # --network none
node scripts/sentinel-feasibility-frameworks.mjs --dispose --acquired <acquire-out-dir>            # removes exactly those images
```

**`--acquire`** builds one pinned image per case — `docker build --platform linux/arm64`, base images
pinned by exact digest (`node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9`,
`maven@sha256:5a8b906c4faa11d33f6c74758f67db8eac25441e14b0729f6d50ff78992be58a`, both confirmed
`linux/arm64` on this host; `buildImage()` refuses a resulting image whose own reported platform isn't
`linux/arm64`). Its `RUN npm install --ignore-scripts` / `RUN mvn package` resolves the pinned manifest
against the real npm/Maven registries — network allowed, and nothing else; `--ignore-scripts` is used on
every `npm install`, and no native postinstall step was required by any of these packages. Acquisition then
reads back the exact dependency evidence baked into that same image — `package-lock.json` for the three npm
cases, `mvn dependency:tree` for Spring — through one more owned, bounded, `--network none` container
(`cat` only; see below), and **validates every pinned candidate's resolved version against `cases.json`'s
own declared pins before accepting the acquisition**: a resolved `express` other than `4.21.2`, or any
Nest/Next package other than its declared pin, fails that case's acquisition outright. Spring's
`spring-security-core` has no a-priori pin (it is resolved transitively through
`spring-boot-starter-security`); its actual resolved version is recorded, not assumed, and this run again
measured `6.4.3`. Acquisition freezes the result — tag, exact content-addressed image ID, dependency
evidence and its hash, build log (scrubbed) — into `acquisition.json`. No bespoke downloader exists
anywhere in this harness: acquisition is Docker's and npm's/Maven's own ordinary dependency resolution, run
once per case.

**`--run`** reads `acquisition.json` and, for each case, first confirms by `docker image inspect --format
'{{.Id}}'` that the exact content-addressed image from acquisition is still present — if it is missing or
its ID has changed, that case fails immediately with `acquired-image-missing-or-changed-since-acquisition`;
`--run` never falls back to building or pulling. It then creates and starts a container **from that exact
image ID** (not the mutable tag) with `--network none --user 65534:65534 --read-only --cap-drop ALL
--security-opt no-new-privileges:true --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 --tmpfs
/tmp:rw,noexec,nosuid,size=128m,mode=1777`. Before the container is ever started, the harness inspects the
*created-but-not-yet-running* container and requires every one of these eleven properties to match exactly
what was requested — image ID, network mode, UID, read-only root, dropped capabilities, no-new-privileges,
memory limit, memory-swap not exceeding the memory limit, CPU quota, PID limit, and zero host bind mounts
(only the `/tmp` tmpfs) — before calling `docker start`; any mismatch aborts without ever running the probed
process. After the container exits, a second inspection requires the client's own exit code, the daemon's
own recorded exit code, `Status: exited`, `Running: false`, `OOMKilled: false` and `Dead: false` to all
agree, and the image ID and network mode to still match, before the case is allowed to read as `measured`.
The container's own entrypoint (`probe.sh`, generated and hashed by the harness, never downloaded) starts
the app, waits for its health route over loopback, sends each scenario's real HTTP request over that same
loopback — never leaving the container's own network namespace, which `--network none` strips of every
route but loopback — and prints one JSON result line, parsed outside the container by `parseProbeOutput()`.

**`--dispose`** removes exactly the images one acquisition built, each re-verified present by its own exact
ID immediately before removal, and re-verified absent immediately after; it is never a broader
`docker image prune` or a tag-based match. The final evidence run below disposed all four of its acquired
images after `--run` completed.

Container ownership/cleanup (`inspectOwnedContainer`/`cleanupOwnedContainer` in `runtime.mjs`) is now fully
self-contained to this module, under this module's own label (`org.farsight.sentinel-feasibility-frameworks.owner`):
every container is created with a random per-run owner, matched by exact label *and* exact ID before start
and before removal, and force-removed in a `finally` block regardless of outcome. The first version of this
slice instead imported the *scanner* harness's `cleanupOwned()` and tried to reuse its label string by
duplicating it as a literal — an implicit, unreviewable coupling across two lanes' files that a source
review correctly flagged; this module now owns its full container lifecycle (including the dependency-
evidence read-back, which previously used an ad hoc `docker run --rm`) and depends on the scanner harness's
file only for the generic, stateless `execute`/`scrub` process primitives, never anything stateful.

## Measured results

This lane's file ownership for this slice is limited to the harness/fixture paths and this one document
(no `docs/proposals/farsight-sentinel/evidence/**` grant), so the full retained envelopes are **not**
committed here; they stay with the implementing lane/session for the integrating lead to request or re-run.
This record is from the final, clean-tree run against the committed revision below — not a dirty working
tree — using the three commands above with no case filter (all four cases, one acquisition, one run, one
disposal):

- `acquisition.json`: `sha256:1e22742370dd9a1ffd3fd030856f436cc7ccd39e330f5135483e4041bc365c8d` (bytes
  recorded at acquisition time)
- `results.json`: `sha256:3988498a08fb7c25ba2542a459bb8e864ef562c439a90c42d1e75f3bd0269efe` (104 KB)
- revision `536e6b1062681dc4af79367e3389391504a4616c`, **dirty: false** (this is the committed harness, not
  a working-tree snapshot)
- Node 24.21.0, Docker Desktop 4.65.0 engine 29.2.1, native Linux/arm64 server

All four cases reached `measured`, every case's pre-start isolation check passed all eleven properties,
every post-start completion check agreed, and every container's cleanup verified `removed-owned-container`.
All four acquired images were disposed by exact ID after this run. The scrubbed envelopes have no home path
and no credential beyond this repository's own inert `NOT_A_SECRET_DO_NOT_USE`/`FIXTURE_CANARY_ONLY` markers
(`express-order`'s opaque-middleware scenario pins `SENTINEL_FIXTURE_OPAQUE_MODE=deny` so that branch is the
one actually exercised). Every number and statement below is read directly from those envelopes.

| Case | Scenario | Static label | Expected runtime | Observed runtime | Agrees |
|---|---|---|---|---|---|
| express-order | auth-before-route | bounded-safe-pattern | 401 / 200 | 401 / 200 | yes |
| express-order | auth-after-route | unknown-enforcement | 200 / 200 | 200 / 200 | yes |
| express-order | unknown-custom-middleware | unknown-enforcement | 403 (pinned deny branch) | 403 | yes |
| nest-validation | validator-with-pipe | bounded-safe-pattern | 400 | 400 | yes |
| nest-validation | validator-without-pipe | unknown-enforcement | 201 | 201 | yes |
| next-matcher | matched-and-blocked | bounded-safe-pattern | 403 | 403 | yes |
| next-matcher | matched-but-exempted | unknown-enforcement | 200 | 200 | yes |
| next-matcher | excluded-by-matcher | unknown-enforcement | 200 | 200 | yes |
| spring-chains | overlapping-open-chain | unknown-enforcement | 200 (no credentials) | 200 | yes |
| spring-chains | later-authenticated-chain | bounded-safe-pattern | 401 / 200 | 401 / 200 | yes |
| spring-chains | unmatched-no-chain-applies | unknown-enforcement | measured, not assumed | **200 (no credentials)** | n/a by design |

Every `bounded-safe-pattern` scenario's runtime agreed with its static label, as intended: these are the
cases where source order/declaration genuinely supports a gate claim. Every `unknown-enforcement` scenario
is where the static label *correctly declined to claim protection*, and the runtime measurement shows real,
divergent behavior underneath that honest abstention — not a defect in the fixtures, the lesson itself:

- **Express**: a `requireAuth` middleware registered with `app.use` *after* the route it names never runs
  for that route (`auth-after-route`: 200 with no token, same as with one). Registration order, not the
  presence of a gating call in the file, decides reach. A middleware chosen from an environment switch
  (`unknown-custom-middleware`) really can block (403, pinned to its denying branch here) — but no amount of
  static review of this source file can show which branch is live without that external switch.
- **Nest**: a `CreateUserDto` decorated with `class-validator` rules behind an explicit, route-scoped
  `@UsePipes(new ValidationPipe())` really does reject an empty body with 400. The identical DTO type on a
  second route with no pipe anywhere (route-level or global) returns 201 — unvalidated. Nest's own default
  success status for an unannotated `@Post()` is 201, not 200; the fixture's original expectation of 200 was
  wrong until this measurement corrected it, which is the general point: measure, don't assume.
- **Next**: `config.matcher: ['/api/dashboard/:path*']` makes `/api/dashboard/secret` and
  `/api/dashboard/open` both reach the middleware function (necessary), but the function's own body lets
  `open` through while blocking `secret` (sufficient is a separate fact). `/api/public/info` is outside the
  matcher and never reaches the middleware at all — a third, structurally different way to end up
  unprotected that a matcher-only reading would conflate with the first.
- **Spring**: the empirical result worth keeping is `unmatched-no-chain-applies`. Neither configured
  `SecurityFilterChain` bean's `securityMatcher` reaches `/api/other/thing`. The measurement shows Spring
  Security 6.4.3 does not fall back to any implicit chain for that request: it returns 200 with no
  credentials, i.e. the request reaches the controller with none of Spring Security's filters — not
  authentication, not CSRF — ever applied. This is a known, genuinely easy-to-miss Spring Security 6
  multi-chain pitfall, reproduced here from real HTTP behavior rather than cited from memory, and it is the
  clearest case in this slice for why "no implicit fallback chain is invented" has to stay a measured fact,
  never a convenient assumption, in any later Spring adapter (PR 17).

Dependency acquisition evidence retained per case (also in `acquisition.json`, version-checked as described
above): `express-order`, `nest-validation` and `next-matcher` each retain the exact `package-lock.json` npm
resolved during their image build, every pinned candidate's resolved version matching its declared pin
exactly (`valid: true, mismatches: []`); `spring-chains` retains a real `mvn dependency:tree` naming
`spring-security-config`/`spring-security-core`/`spring-security-web` all at `6.4.3` under
`spring-boot-starter-security:3.4.3` (`resolvedSpringSecurityCoreVersion: "6.4.3"`). These are read back from
the already-built image through the same owned, `--network none`, UID-65534, read-only container lifecycle
as the probe itself — reading a baked-in file, never a second acquisition.

## Harness correctness, found and fixed across two rounds

**First pass (self-found before any outside review):** the first end-to-end attempt (`express-order`) built
successfully but the probe step reported `container ownership mismatch; refusing start or removal` — an
earlier version of this module imported the *scanner* harness's `cleanupOwned()` and had to duplicate its
private label string as a literal to make ownership checks pass, and got the string wrong on the first try.
The orphaned container and image that attempt left were confirmed and manually removed. The second
self-found defect was a double-wrapping bug: each `probe.sh` printed `{"ok":true,"observations":{...}}`,
and the harness's own parser wrapped that whole payload inside a second `{ok, observations}` shell, so one
case's first clean-looking run ("state: measured") actually carried `observed: null` on every scenario. The
fix at the time narrowed the marker-line contract to a single `{"status": ..., "observations"?: {...}}`
object.

**Second pass (a manager source review of that fixed version) found four further, more serious defects,**
named here in full rather than folded into a clean-looking final run:

1. **A vacuous pass was still possible.** `evaluateCaseOutcome`'s predecessor filtered out every scenario
   whose `matchesExpected` was `null` before checking `.every(...)` — so a probe payload that parsed as
   valid JSON but carried the wrong keys (every scenario's `observed` reading as `null`) would leave an
   *empty* filtered array, and `[].every(...)` is vacuously `true`: the case would read `measured` with
   nothing actually checked. `evaluateCaseOutcome()` now requires every declared scenario to carry a real,
   non-null observation — a missing one fails the case outright — and only *then* separately checks that
   every scenario with a fixed expectation matched it. A regression test constructs exactly the
   all-`null`-observation case and asserts it fails, not passes.
2. **The cross-module label coupling above was still fragile even after the first fix**, because it worked
   only by this module silently matching an unexported constant in a file it does not own; a future edit to
   that constant would silently break this module's cleanup again with no compiler or test to catch it.
   `runtime.mjs` now owns its own `inspectOwnedContainer`/`cleanupOwnedContainer` under its own label and
   depends on the scanner harness only for the stateless `execute`/`scrub` primitives.
3. **`--run` built and potentially re-resolved dependencies on every invocation**, instead of separating
   acquisition from execution into two commands a trial could repeat against a frozen result — fixed by the
   `--acquire`/`--run`/`--dispose` split described above.
4. **Containers ran without any pre-start isolation verification, without the unprivileged run UID, and
   Next's probe ran with its entire root filesystem writable** instead of a bounded fix. Investigating the
   actual Next failure under UID 65534 (rather than assuming it was unfixable) found a plain, ordinary
   cause: `COPY`'d files are owned by `root` at build time, and UID 65534 could not even open
   `/app/package.json` — `npm error EACCES ... open '/app/package.json'`, reproduced directly. Adding
   `RUN chown -R 65534:65534 /app` to all four Dockerfiles (not just Next's) fixed this for real; all four
   candidates now run fully read-only and non-root with no exception anywhere, verified by the pre-start
   inspection described above on every run.

All four cases were re-measured clean after every one of these four fixes, under the new pipeline, against
the committed revision cited above.

## Limitations

- Four original fixtures, eleven scenarios. This is not a framework conformance suite, does not exercise
  dynamic/dynamic-import registration, custom decorators, interceptors, WebFlux, or any multi-filter-chain
  interaction beyond the two chains built here, and makes no claim about any version other than the one
  pinned per candidate.
- One successful run per scenario is one measurement, not a repeated-trial statistic; no flake/variance
  rate is established for any of the four probes.
- Spring Security's resolved version (6.4.3) is recorded from this build's dependency tree, not pinned
  independently; a different Spring Boot patch release could resolve a different Spring Security patch —
  which is exactly why `--acquire` records and the doc above reports the actually resolved version rather
  than assuming it stays fixed.
- `package-lock.json`/`mvn dependency:tree` evidence names exact resolved versions but does not itself
  constitute an advisory/vulnerability check (PR 12 territory) or a license audit.
- This slice does not touch `core/openapi.ts`'s `guardsOf()`/`matchesGuard()`; the existing protocol's
  caution that those remain reconciliation heuristics, never an enforcement oracle, is unaffected and
  unextended here.
- Acquired images are not cached/reused across separate `--acquire` invocations by design (each gets a
  fresh random tag); an operator who wants to run `--run` multiple times against the same acquisition
  should keep its `--out` directory until `--dispose` is actually wanted.
- No model call, no host scanner, no production Sentinel package, and no change to any shared PR 01 file
  (`scripts/sentinel-feasibility.mjs`, `scripts/sentinel-feasibility-scanners.mjs`,
  `packages/sentinel/test/fixtures/feasibility/**`) is part of this slice.

## Reproduce

```sh
node scripts/sentinel-feasibility-frameworks.mjs                                              # preview; no docker call
node scripts/sentinel-feasibility-frameworks.mjs --case express-order                          # preview one case
node scripts/sentinel-feasibility-frameworks.mjs --acquire --out /tmp/sentinel-fw-acq          # build; network allowed
node scripts/sentinel-feasibility-frameworks.mjs --run --acquired /tmp/sentinel-fw-acq --out /tmp/sentinel-fw-run  # --network none
node scripts/sentinel-feasibility-frameworks.mjs --dispose --acquired /tmp/sentinel-fw-acq     # remove exactly those images
```

Every `--out` must not already exist. `--run` never builds, pulls or resolves anything; it fails outright if
the image `--acquire` froze is missing or has changed. Requires Docker with a `linux/arm64` server (the
harness refuses silently mismatched platforms: `docker build --platform linux/arm64` and the acquired
image's own reported platform must both be `linux/arm64`, rather than falling back to emulation).

## Recommendation for PR 01's capability decision and the PRs 14–17 support matrix

Accept this slice as E2 **prototype** evidence, not a completed framework support claim: it demonstrates
that the "retain source-grounded labels; runtime/prototype order, matcher and chain evidence ... still
required" gate from the prior results record is answerable in practice, with a repeatable, self-cleaning,
acquisition/execution-separated method with verified isolation, on all four candidates the owner named. It
does not by itself clear PRs 14–17's own acceptance gates (bypass/late/unknown negative siblings reviewed
against a broader fixture set, exact supported-version behavior, no false protected verdict across
dynamic/custom-decorator/multi-chain variants). The one result worth carrying forward as a named risk for
PR 17 specifically: Spring Security's real behavior for a request matching no configured
`SecurityFilterChain` is to apply none of that chain's filters, not to fall back to the nearest chain's
policy — any Spring adapter must treat "no matching chain" as its own unprotected-by-omission finding, never
silently inherit a neighboring chain's verdict.
