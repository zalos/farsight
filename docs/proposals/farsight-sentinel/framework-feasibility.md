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
**6.4.3** (from a real `mvn dependency:tree`, not assumed from the brief). This is four apps and eleven
scenarios total, not a framework conformance suite, a taint/deep-flow engine, or a supported-version matrix.
Exact framework behavior for PRs 14–17 still needs its own, separately scoped runtime probes against a
broader fixture set before any support claim; this slice is evidence toward that gate, not the gate itself.

## Acquisition versus execution

Every candidate's dependencies are declared with an exact pinned version in its `package.json`/`pom.xml`
fixture (`packages/sentinel/test/fixtures/framework-feasibility/sources/*/`). The harness
(`scripts/sentinel-feasibility-frameworks.mjs`, `scripts/sentinel-feasibility/frameworks/*.mjs`) builds one
pinned Docker image per case — `docker build --platform linux/arm64`, base images pinned by exact digest
(`node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9`,
`maven@sha256:5a8b906c4faa11d33f6c74758f67db8eac25441e14b0729f6d50ff78992be58a`, both confirmed
`linux/arm64` on this host). **Acquisition is exactly this `docker build` step**: its `RUN npm install
--ignore-scripts` / `RUN mvn package` resolves the pinned manifest against the real npm/Maven registries,
with network allowed and nothing else. `--ignore-scripts` is used on every `npm install`; no native
postinstall step was required by any of these packages. No bespoke downloader exists in this harness —
acquisition is Docker's own, ordinary dependency resolution, run once per case, and nothing is fetched at
any other point.

**Execution is a separate step on the already-built image**: `docker run --platform linux/arm64 --network
none --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 --memory 1g --cpus 1 --tmpfs
/tmp:rw,noexec,nosuid,size=128m,mode=1777`, plus `--read-only` on three of the four images (Next's runtime
was observed writing small trace files even after an ahead-of-time `next build`; it alone runs without
`--read-only`, a recorded, not silent, weaker control — see Limitations). The container's own entrypoint
(`probe.sh`, generated and hashed by the harness, never downloaded) starts the app, waits for its health
route over loopback, sends each scenario's real HTTP request over that same loopback — never leaving the
container's own network namespace, which `--network none` strips of every route but loopback — and prints
one JSON result line. The harness parses that line outside the container; no inference, no mocked response.
Ownership/cleanup reuses the existing scanner harness's own `execute`/`scrub`/`cleanupOwned` primitives
(`scripts/sentinel-feasibility-scanners.mjs`, imported, never edited): every container is created with a
random per-run owner label, matched by exact ID before start and before removal, and force-removed in a
`finally` block. All sixteen containers created across every probe run in this slice (four cases × up to
two attempts while the harness was being fixed) were confirmed removed by owner/ID; the one orphaned
container and one orphaned image left by an early, since-fixed harness bug (below) were confirmed absent
after manual `docker rm --force`/`docker rmi --force`, and the final combined run leaves zero
`sentinel-feasibility-frameworks-*` containers or images. Built images are also removed by the harness
itself immediately after each case's probe completes; this is a bounded prototype, not an image cache.

## Measured results

This lane's file ownership for this slice is limited to the harness/fixture paths and this one document
(no `docs/proposals/farsight-sentinel/evidence/**` grant), so the full retained envelope is **not**
committed here; it stays with the implementing lane/session for the integrating lead to request or re-run.
Its exact bytes are content-addressed at `sha256:646f4be0674facbf367ba094ddffd58271fb7c35f7bbabced4143f62f6f54854`
(`results.json`, 192 KB), from a single combined
`node scripts/sentinel-feasibility-frameworks.mjs --run --out <fresh-directory>` run, revision `2bd38f6`
(dirty: true — a PR 01 continuation branch, not yet committed at measurement time), Node 24.21.0, Docker
Desktop 4.65.0 engine 29.2.1 on a native Linux/arm64 server. All four cases reached `measured`; the scrubbed
envelope has no home path and no credential beyond this repository's own inert
`NOT_A_SECRET_DO_NOT_USE`/`FIXTURE_CANARY_ONLY` markers (`express-order`'s opaque-middleware scenario pins
`SENTINEL_FIXTURE_OPAQUE_MODE=deny` so that branch is the one actually exercised). Every number and
statement below is read directly from that envelope.

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

Acquisition evidence retained per case (also in the linked envelope): `express-order` and `nest-validation`
and `next-matcher` each retain the exact `package-lock.json` npm resolved during their image build (29,675 /
57,393 / 14,230 bytes respectively, each sha256-identified in the envelope); `spring-chains` retains a real
`mvn dependency:tree` (2,726 bytes) naming `spring-security-config`/`spring-security-core`/
`spring-security-web` all at `6.4.3` under `spring-boot-starter-security:3.4.3`. These are read back from
the already-built image with `docker run --rm --network none --entrypoint cat`, after the image exists —
reading a baked-in file, not a second acquisition.

## Harness correctness, found and fixed during this slice

The first end-to-end attempt (`express-order`) built successfully but the probe step reported
`container ownership mismatch; refusing start or removal`: this module's own container-ownership label key
did not match the string the *imported*, unmodified `cleanupOwned()` (from
`scripts/sentinel-feasibility-scanners.mjs`) checks internally. The fix was to reuse that exact label string
rather than invent a second one; the file left an orphaned container and image from the failed attempt,
both confirmed and manually removed before the clean reruns in this record. The second defect was a
double-wrapping bug: each `probe.sh` printed `{"ok":true,"observations":{...}}`, and the harness's own
parser wrapped that whole payload inside a second `{ok, observations}` shell, so `nest-validation`'s first
clean-looking run ("state: measured") actually carried `observed: null` on every scenario because the
assessment function was reading the wrong nesting level. The fix narrows the marker-line contract to a
single `{"status": "ok"|"<failure-reason>", "observations"?: {...}}` object, asserted by a dedicated
`parseProbeOutput` test (`scripts/test/sentinel-feasibility-frameworks.test.mjs`) that rejects a missing
marker, invalid JSON, and a payload with no `status` field. Both defects are named here rather than
silently folded into a clean-looking final run, consistent with this proposal's own retained-failure
convention (see the prior slice's "initial failed scanner trial" and "failed noexec trial").

## Limitations

- Four original fixtures, eleven scenarios. This is not a framework conformance suite, does not exercise
  dynamic/dynamic-import registration, custom decorators, interceptors, WebFlux, or any multi-filter-chain
  interaction beyond the two chains built here, and makes no claim about any version other than the one
  pinned per candidate.
- The Next.js probe container runs without `--read-only` after an observed runtime trace-file write even
  with the app pre-built; the other three run fully read-only. This is a recorded, not silent, weaker
  control for that one candidate, in the same spirit as the existing scanner harness's documented Opengrep
  `noexec` exception.
- One successful run per scenario is one measurement, not a repeated-trial statistic; no flake/variance
  rate is established for any of the four probes.
- Spring Security's resolved version (6.4.3) is recorded from this one build's dependency tree, not pinned
  independently; a different Spring Boot patch release could resolve a different Spring Security patch.
- `package-lock.json`/`mvn dependency:tree` evidence names exact resolved versions but does not itself
  constitute an advisory/vulnerability check (PR 12 territory) or a license audit.
- This slice does not touch `core/openapi.ts`'s `guardsOf()`/`matchesGuard()`; the existing protocol's
  caution that those remain reconciliation heuristics, never an enforcement oracle, is unaffected and
  unextended here.
- No model call, no host scanner, no production Sentinel package, and no change to any shared PR 01 file
  (`scripts/sentinel-feasibility.mjs`, `scripts/sentinel-feasibility-scanners.mjs`,
  `packages/sentinel/test/fixtures/feasibility/**`) is part of this slice.

## Reproduce

```sh
node scripts/sentinel-feasibility-frameworks.mjs                                   # preview; no docker call
node scripts/sentinel-feasibility-frameworks.mjs --case express-order              # preview one case
node scripts/sentinel-feasibility-frameworks.mjs --run --out /tmp/sentinel-fw-new  # build + probe all four
```

`--out` must not already exist. Each case builds a pinned image (network allowed), runs it with
`--network none`, assesses the real result against the corpus's static label, and removes the image.
Requires Docker with a `linux/arm64` server (the harness refuses silently mismatched platforms the same
way the scanner harness does: `docker build --platform linux/arm64` and `docker run --platform linux/arm64`
fail outright on a server that cannot satisfy that platform, rather than falling back to emulation).

## Recommendation for PR 01's capability decision and the PRs 14–17 support matrix

Accept this slice as E2 **prototype** evidence, not a completed framework support claim: it demonstrates
that the "retain source-grounded labels; runtime/prototype order, matcher and chain evidence ... still
required" gate from the prior results record is answerable in practice, with a repeatable, self-cleaning,
network-separated method, on all four candidates the owner named. It does not by itself clear PRs 14–17's
own acceptance gates (bypass/late/unknown negative siblings reviewed against a broader fixture set, exact
supported-version behavior, no false protected verdict across dynamic/custom-decorator/multi-chain
variants). The one result worth carrying forward as a named risk for PR 17 specifically: Spring Security's
real behavior for a request matching no configured `SecurityFilterChain` is to apply none of that chain's
filters, not to fall back to the nearest chain's policy — any Spring adapter must treat "no matching chain"
as its own unprotected-by-omission finding, never silently inherit a neighboring chain's verdict.
