# Sentinel owned-sample runtime checks — bounded design for review (PR 30)

Status: bounded architecture reviewed by SOL on 2026-10-22; implementation and qualification remain pending.
The review resolved uncertain request outcomes, role attribution and reset lineage. See
[PR 30](implementation-prs.md#pr-30--managed-runtime-scanning) and the [progress ledger](execution-progress.md).
The initial supported target is only the original local Java/Spring sample the owner requested. Arbitrary
hosts, production environments, externally supplied targets and project-selected destinations are unavailable.
PR 30 remains separate from source-only scanning. This design does not claim that passive imported evidence
or a source scan has executed runtime checks.

## Authorization and supported scope

The current instruction authorizes constructing, running and testing the original sample in Linux containers,
including the necessary pinned public tools. Record that delegated authorization truthfully, bounded to the
reviewed sample snapshot, images, operations and budgets. Do not fabricate an interactive human receipt or ask
for the same authorization again. Future product users use PR 06's policy, capability and credential verdicts
and its scoped approval mechanism. Repository content and model output cannot create or expand that authority.

The first profile supports an HTTP-only fixture application, a generated ephemeral data store and synthetic
roles. It has a fixed set of sample routes and reset operations. HTTPS interception, arbitrary authentication
flows, third-party systems and generalized target discovery are unsupported. Any expansion needs a separately
reviewed profile and qualification evidence, without changing the source-only defaults.

## Three distinct operations

1. Passive import reads a bounded recorded report, contacts no target and labels its contents as imported claims.
   A versioned provenance artifact names the claimed target, build, observation time and expiry. It cannot mark
   a Sentinel check as executed or approve a disposition.
2. A bounded observation run requests only the sample's allowlisted read operations. It records actual responses;
   an unvisited route remains not observed. Passive checks are labelled passive.
3. A fixture check run permits only named checks and operations against the original disposable sample. Each
   state-changing check declares its reset action and verifies the reset outcome. It never inherits a broader
   crawler or tool default. Failure to reset stops further admitted work and leaves the result incomplete.

## Identity and admission

The coordinator constructs the target descriptor from the accepted sample build publication, exact snapshot,
work revision and attempt, image digest, generated fixture configuration and a fresh environment ID. A path,
branch name, source URL, container label alone or worker-supplied descriptor is insufficient.

The trusted registry selects pinned scanner and broker images and approved check IDs. Images are acquired in
an explicit preparation operation, never pulled by scan execution. The selected tool version and rules must be
measured before claiming support; this document invents no qualified ZAP version. The initial tool adapter is
optional and remains unavailable until its concrete installation and canaries pass.

Admission binds the exact descriptor, check set, method/path/role scope, input artifacts, reset policy, resource
limits, request/rate/time budgets and expiry. All retries and reset requests count against these budgets.
The parent holds this authority; a worker result or request cannot increase it.

## Network boundary for the owned fixture

PR 07's default scanner network remains denied. PR 30 introduces a separate explicitly admitted fixture profile:
scanner -> trusted request broker -> owned sample. Two distinct internal container networks separate the scanner
from the target. Only the broker joins both. No host networking, published target ports, external egress,
credentials, host proxy configuration or Docker socket is available to these containers. The tool may reach only
the broker. The broker connects only to the admitted target's inspected container ID, address and port.

This topology must be tested on each supported backend; an internal-network flag alone is not qualification.
If direct scanner-to-target or external communication remains possible, the profile refuses admission.

The broker enforces scope and budgets on every request. It rejects tunnels, upgrades, unsupported encodings,
oversized/ambiguous requests, unapproved methods or paths, and any address or target identity change. It performs
no arbitrary DNS resolution and has no general proxy function. The initial profile uses its inspected fixed
container address. Redirects do not expand scope: any subsequent request is independently checked and recorded.
Unexpected redirect destinations are a limitation, not a reason to contact another host.

The coordinator durably records admission and a forwarding intent before the broker may send a request,
then records any observed response. The journal distinguishes admitted, may-have-been-forwarded, response
observed and outcome unknown. A crash or lost response can leave a state change applied without a known outcome;
never automatically retry it without a verified fresh reset. These live checkpoints precede final immutable
artifact capture. Scanner-reported counts, URLs or coverage remain claims until reconciled with the journal
and admitted check list. Tool exit zero never establishes that a check ran. Role attribution comes from the
broker's admitted synthetic credential identity, never scanner labels or arbitrary headers. The credential
prohibition concerns host and real credentials; only generated fixture credentials enter this environment.

## Lifecycle, reset and resources

Each run creates fresh application state and synthetic credentials. Configuration contains no real user's
credentials. The sample's entrypoint is a trusted profile choice bound to the accepted build, never a command
read from repository content. The application still runs as untrusted code inside the container boundary.

The coordinator reserves capacity for the application, broker and scanner before admission. Existing per-worker
limits are retained initially: at most 120 seconds, 2 GiB and one heavy scanner, with aggregate memory and Docker
headroom checked as well. Each component has an explicit smaller or equal reservation. Startup and reset have
bounded stages; a timeout yields incomplete evidence. No contract increase is implicit.

The broker has fixed total-request and rate ceilings, bounded bodies and journal size. The concrete first-profile
values are selected and measured with the sample; the profile is unavailable until those values are pinned.
Output artifacts stay within PR 02/03 envelope, object and receipt limits. Exceeding a bound records an explicit
limitation, never silently drops rows or promotes the run to complete.

Cancellation revokes further requests at the broker before stopping components. Cleanup verifies exact IDs and
owner/store/attempt/epoch identities and stops only those components. A killed client is not proof of cleanup.
Recovery reconciles every recorded component and ambiguous create response before replacement. Uncertain identity
blocks destructive cleanup and a replacement run. No broad process or container matching is permitted.

The coordinator captures final results only after writers are stopped; live admission and outcome checkpoints
are durable throughout the run. A reset is visible as an admitted operation with an observed outcome. Fresh
environment creation is the initial reset strategy: revoke the old descriptor, record the old-to-new environment
and component lineage, and derive the new descriptor within the already-authorized reset budget. This neither
silently retargets a running check nor asks for repeated human permission. Target and scanner images
are read-only, non-root, capability-restricted, with bounded writable scratch and no shared mutable cache.

## Evidence and privacy

Store the input descriptor, effective profile, journal, scanner result, reset outcomes and final component
identities as immutable artifacts. Bind the result to its accepted producer publication, work revision, attempt,
owner epoch and verified output closure. A valid-looking JSON document alone is never trusted provenance.

Request/response bodies and synthetic credentials have source-level privacy. Public reports, events, logs,
exports and model packets contain redacted, bounded excerpts only. Escape response content; load no remote
resources from it. Retain which redaction and truncation rules were applied. Imported and executed observations
remain separate in Counted breakdowns.

Each executed observation names the exact sample build, environment, request, role, check version and time. It
says nothing about sibling paths, other roles or another deployment. Unknown mappings remain unknown; absence of
an alert is not an observed safe result. Runtime observations cannot clear unrelated static findings. Assertions
expire or reopen when their relevant build, control, environment or evidence changes; historical reports remain
fixed at their retained ledger sequence.

## Acceptance before any capability is enabled

- From an empty prepared environment, the pinned sample starts only within the admitted Linux containers.
- Missing images/runtime/budgets refuse explicitly, with no download or host-execution fallback during a run.
- The actual topology denies direct target bypass, host-file access and external communication; canaries record
  denied attempts without contacting an unrelated system.
- Redirects, target replacement, wrong environment IDs, unexpected operations and expired scope are refused
  before an out-of-scope request reaches a destination.
- Actual broker requests reconcile exactly with scoped observations; skipped checks and unvisited routes stay
  explicit, including a zero-exit scanner that omits required work.
- Request/rate/time/body/output limits, cancellation and reset failure stop work with inspectable reasons.
- Crash at create/start/request/reset/publish boundaries recovers only owned components and publishes once;
  interruption after forwarding but before response recording yields outcome unknown and no unsafe retry.
- Synthetic credentials never appear in any user-visible or exported artifact; hostile response content cannot
  execute or trigger remote loads in a report.
- A known fixture case, its safe sibling and an unsupported case produce the expected distinct evidence, with
  no inferred deployment-wide or static-coverage claim.
- CLI, MCP and GUI expose operation mode, scope, reset effects and evidence provenance consistently.

Remaining qualification work: select and pin the actual scanner/broker versions; measure the concrete sample's
resource and request limits; implement and prove topology isolation on each host/backend; verify the reset and
crash matrix. Until these gates pass, managed runtime checks remain unavailable. No target execution was done
for this design review.
