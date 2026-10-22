# Synthetic Sentinel framework feasibility fixtures

These are inert, original source lessons for PR 01's E2 framework evidence. They are not production
application code. `cases.json` maps every `.fixture` blob to a temporary source path with its exact
SHA-256, a source-grounded static label per scenario, and the runtime outcome the implementing lane
expects. Labels start `needs-independent-review` with a null reviewer; a passing probe never fills that
field by itself.

Each case is a complete, minimal, runnable app for one framework/version pin (Express 4.21.2,
Nest 10.4.15 + class-validator 0.14.1/class-transformer 0.5.1, Next 14.2.25, Spring Boot 3.4.3 +
Spring Security, resolved version recorded by the build rather than assumed). The harness under
`scripts/sentinel-feasibility/frameworks/` builds each app into a pinned container image (acquisition,
network allowed) and then runs that image with `--network none` (execution, no network): the container's
own entrypoint starts the app, sends it loopback HTTP requests, and reports the real status codes. Real
runtime evidence is kept as a field distinct from the static label; the two are expected to agree on the
`bounded-safe-pattern` scenarios and to diverge, on purpose, on every `unknown-enforcement` scenario — that
divergence is the lesson, not a defect in the fixture.

No private application code, external benchmark code, real credential, or provider transcript is included.
`spring-chains`'s in-memory password uses this repository's existing inert marker,
`NOT_A_SECRET_DO_NOT_USE`, never a real credential. See [framework-feasibility.md](../../../../../docs/proposals/farsight-sentinel/framework-feasibility.md)
for the harness, the exact image/package pins, the acquisition-versus-execution boundary, measured
results and open gates, and the [protocol](../../../../../docs/proposals/farsight-sentinel/feasibility-protocol.md)
for the shared E1–E8 vocabulary this evidence fits into.
