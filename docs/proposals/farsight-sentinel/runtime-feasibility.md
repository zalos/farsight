# Sentinel runtime and resource feasibility

PR01 experiment only. The runner is `scripts/sentinel-feasibility-runtime.mjs`; preview is the default.
Execution requires `--run --out /tmp/sentinel-runtime-matrix-new`, a fresh directory, Node 24+, an already
installed local Docker service and the already acquired immutable Semgrep ARM64 image from the acquisition
manifest. It never acquires an image, executable or database and has no scanner host fallback. The script
refuses changed experiment code so a measured run names its committed revision and exact module hashes.

## What is measured

E7 records an actual missing host executable, absent image inspection without pulling, and a missing
executable inside the pinned container. No candidate advisory database is available in this lane. The
missing-database filesystem check is explicitly synthetic: it cannot establish a scanner's database
format, freshness, offline audit semantics or vulnerability verdict. Required unavailable online/advisory
work is an explicit gap. Network denial requires the shared `networkDenied` predicate: inspected network
`none` and an actual Linux socket `OSError` with `ENETUNREACH` 101. A refused connection or timeout fails it.

E8 inspects host/VM identities and resource-controller capabilities, admits one fixed request and rejects
a request above the actual VM memory quota before container creation. Seven harmless agent-authored Python
commands in the existing pinned image test network denial, readable cgroup limits and a 32 MiB allocation,
missing executable, timeout, cancellation, output budget, and a 1 MiB tmpfs exhausted by a bounded 2 MiB write.
The harness never runs fixture application code. Containers have no host mounts, read-only root, UID 65534,
no capabilities or privilege escalation, 256 MiB memory+swap ceiling, 1 CPU and 32 PIDs. Before start it validates
these inspected properties. Timeout/cancellation/output checks remove only the exact inspected ID bearing
the current random owner label, then verify absence. If ownership is uncertain, removal is refused.
The Docker client can stop before its container: that intermediate running state is retained before cleanup.
These controls are normal-process prototype behavior. Process death, host crashes, orphan reconciliation,
publication recovery and production resource admission remain PR08/26 (and foundation isolation PR07).
The harmless 256 MiB limit is not evidence that scanners fit that ceiling. Existing scanner limits and the
Semgrep noexec / Opengrep explicit exec exception remain unchanged.

The resource corpus consists of original parser-style and scan-style JSON at minimum 64 KiB, 1 MiB and 8 MiB
sizes. Rows have varying paths, line spans and deterministic hashes. It represents artifact structure,
not a random sample or actual parser accuracy workload. Every exact input and encoded output is retained
and hashed. Each input/codec has three serial repetitions, each in a fresh trusted Node child. Raw copy,
gzip level 6 and Node's default zstd are measured; options and runtime library versions are recorded. Child
encode/decode wall times exclude disk I/O and hashing. Parent wall time includes process startup, I/O and
hashing. Child maxRSS is process-lifetime high-water including startup, input, operation, output and hashing,
not a codec-only peak. RSS snapshots are not allocation attribution. No model usage/cost is estimated as
observed. Missing APIs/metrics remain unavailable; no numerical zero is substituted. Synthetic admission
controls reject individual/total input and trial budgets and unavailable measurement. They do not simulate
actual host OOM or establish production memory admission. Shared-host contention must be excluded from
measured windows; these small in-memory codec trials cannot establish disk throughput or scanner ranking.

## Runtime scope and installation

The run below measures one host/backend combination. Runtime acceptance remains the owner/integration decision.
The executable gate is limited to native ARM64 macOS or Linux with a Linux ARM64 Docker server and ARM64
image; only the actual observed host/backend combination may be proposed for initial support. Independent
Linux hosts, Docker Engine installations without Desktop, Colima, Windows, AMD64 and emulation are unmeasured
and deferred. Architectural eligibility is not a support claim.

[Docker's Mac installation instructions](https://docs.docker.com/desktop/setup/install/mac-install/)
require a supported macOS and at least 4 GB RAM; Desktop starts only after accepting its subscription terms.
The owner must decide rights/terms suitability; installed software and successful experiments do not accept
commercial rights. The documented organization-size/revenue and government-use conditions can require a paid
subscription. No installation or terms acceptance is performed by this runner.
[Desktop resource settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
separately limit VM CPU, memory and disk; per-container ceilings do not reserve the VM's whole budget.
[Colima's upstream instructions](https://github.com/abiosoft/colima) describe installing Colima plus a Docker
client for its Docker runtime. Colima has not been installed, started or tested by this lane. Current
installation documentation may describe later releases than the actual pinned backend; measured identities
and control evidence are the authority for this experiment's bounded capability claims.

## Measured run: 2026-10-21 local / 2026-10-22 UTC

Committed harness revision `df8bc9993b20a7514fc4fb9678b764abd7c1e6d0` ran with clean experiment files
from `01:35:19.895Z` to `01:35:27.695Z`. The result was `measured-with-explicit-gaps`: all 14 controls
passed, seven real container trials completed their expected outcomes and verified exact owned-container
removal, and 54 codec trials roundtripped retained bytes. Nine focused regression tests passed before the
run. No primary build/test, image/tool acquisition, fixture dependency installation or application execution
occurred in this lane. Raw original/synthetic artifacts remain outside the repository for integration
retention: `result.json` SHA-256
`c7bc1c07fe0f5beb1172aa08cf90e4f814dc814930129cd813eecb7bab214821`.
Its artifact inventory names 61 files totaling 99,118,381 bytes, including six exact JSON inputs,
54 encoded outputs and the incremental progress record. Each artifact has its own full SHA-256.

This retained run predates the cross-review hardening of parent-side input/output identity binding and
exact missing-image failure classification. Its numbers remain historical observations from the named
revision; they are not evidence for the corrected final runner. The corrected runner independently compares
each metric's input hash/byte count to its generated original, verifies retained input/output hashes and
byte counts per trial, and rechecks every input after all trials. Missing/changed artifacts fail the run.
Missing-image controls now require a completed nonzero inspection and the exact immutable reference in the
absence diagnostic. Integration must remeasure the final committed source; this lane did not rewrite or
rerun historical evidence after those corrections.

The host was macOS 27.0 (Darwin 27.0.0), native ARM64 Apple M4, 10 logical CPUs, 17,179,869,184 bytes RAM,
Node 24.19.0. Docker client and Engine were 29.2.1. A separate read-only installation identity supplement
verified Docker Desktop 4.65.0 build 221669 from its installed app metadata; the `docker desktop version`
output in the original result identifies the CLI plugin v0.3.0, not the Desktop application. Supplement
SHA-256: `791c66884082265fdc596d44aabdd4a604281ea8485ca236b64e01ce44169c68`.
The Docker VM was Linux ARM64 (`aarch64`), kernel `6.12.76-linuxkit`, cgroup v2/cgroupfs, 10 CPUs and
8,217,059,328 bytes RAM; memory, swap, CPU quota and PID controllers were reported available. Its inspected
security options named built-in seccomp and cgroup namespaces. This establishes neither an independent
Linux host nor a broad Docker/backend version range.

| Control | Actual retained observation | Boundary |
|---|---|---|
| Missing host executable | `ENOENT` from the fresh output's deliberately absent executable | Preflight failure, no fallback |
| Missing image | Docker inspection exited 1 with the exact absent image diagnostic | Inspection only; no pull/create |
| Missing container executable | Nonzero completed client failure named the exact absent entrypoint; inspected container stayed `created`, exit 127 | Tool absence is visible, then exact cleanup |
| Actual quota admission | 256 MiB / 1 CPU admitted; 8,217,059,329-byte request rejected against the measured 8,217,059,328-byte VM quota | Quota comparison, not a reservation or observed free-memory guarantee |
| Network | Inspected `none`, Python `OSError`, errno 101 | Passed shared `networkDenied`; no timeout/refusal substitution |
| Limits | `memory.max=268435456`, `cpu.max=100000 100000`, `pids.max=32` inside the container | Bounded harmless allocation, not scanner sizing |
| Memory observation | Python process lifetime maxRSS 42,000 KiB; sampled cgroup `memory.peak=39448576` bytes during a 32 MiB allocation | Different accounting domains/times; neither is a codec or production scanner peak |
| Timeout and cancellation | Trusted READY marker appeared; client stopped near its 1.5-second boundary; both containers were still `running` before explicit cleanup | Killing the client does not stop its container; exact owned removal and absent verification passed |
| Output budget | 16,384 retained stdout bytes, `outputExceeded=true` | Truncation remains budget exhaustion even though the short bounded writer could exit 0 |
| Temporary storage | Bounded 2 MiB write in inspected 1 MiB noexec tmpfs returned `OSError`, errno 28 | Real isolated storage exhaustion, not host disk exhaustion |
| Synthetic controls | Missing database prerequisite, unavailable controller/measurement, and input/total/trial admission exhaustion rejected | They remain named synthetic; no candidate DB or disabled-host-controller claim |

The lead sequenced engine/framework measurement jobs around this 7.8-second run. Framework dependency
preparation and ordinary desktop activity were not suspended; global host idleness, CPU load and disk
contention were not sampled. Trials used fixed codec order and three repetitions. The table is descriptive
of these exact original payloads and this Node build; no cross-codec or cross-host performance ranking is
accepted from it. Compression/decompression timers exclude I/O/hashing; parent wall includes them.
Memory ranges are the fresh child process-lifetime maxRSS over three repetitions, in KiB.

| JSON | Minimum size | Codec | Exact input bytes | Encoded bytes | Encode median ms | Decode median ms | Parent wall median ms | Child lifetime maxRSS KiB range |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| parser | 64 KiB | raw | 65,693 | 65,693 | 0.010 | 0.007 | 25.962 | 50,224–50,288 |
| parser | 64 KiB | gzip | 65,693 | 18,095 | 0.861 | 0.142 | 25.985 | 50,592–50,720 |
| parser | 64 KiB | zstd | 65,693 | 16,492 | 0.487 | 0.085 | 26.175 | 51,120–51,136 |
| parser | 1 MiB | raw | 1,048,641 | 1,048,641 | 0.062 | 0.075 | 26.509 | 53,104–53,120 |
| parser | 1 MiB | gzip | 1,048,641 | 279,516 | 8.366 | 1.488 | 36.831 | 54,016–54,016 |
| parser | 1 MiB | zstd | 1,048,641 | 269,511 | 2.105 | 0.676 | 29.692 | 56,320–56,384 |
| parser | 8 MiB | raw | 8,388,927 | 8,388,927 | 1.061 | 1.027 | 40.445 | 74,720–74,880 |
| parser | 8 MiB | gzip | 8,388,927 | 2,220,355 | 67.032 | 11.883 | 113.134 | 80,000–80,160 |
| parser | 8 MiB | zstd | 8,388,927 | 2,162,352 | 17.233 | 6.085 | 60.450 | 83,568–83,680 |
| scan | 64 KiB | raw | 65,782 | 65,782 | 0.012 | 0.007 | 29.572 | 50,240–50,288 |
| scan | 64 KiB | gzip | 65,782 | 9,899 | 0.708 | 0.121 | 30.661 | 50,624–50,736 |
| scan | 64 KiB | zstd | 65,782 | 8,840 | 0.501 | 0.086 | 29.993 | 50,976–51,152 |
| scan | 1 MiB | raw | 1,048,702 | 1,048,702 | 0.086 | 0.074 | 32.989 | 53,136–53,264 |
| scan | 1 MiB | gzip | 1,048,702 | 150,672 | 4.836 | 0.955 | 33.562 | 53,744–53,856 |
| scan | 1 MiB | zstd | 1,048,702 | 144,553 | 1.670 | 0.624 | 35.805 | 56,032–56,144 |
| scan | 8 MiB | raw | 8,388,720 | 8,388,720 | 0.848 | 1.075 | 37.927 | 74,752–74,848 |
| scan | 8 MiB | gzip | 8,388,720 | 1,197,040 | 34.909 | 7.180 | 77.273 | 77,904–77,952 |
| scan | 8 MiB | zstd | 8,388,720 | 1,174,504 | 10.872 | 4.371 | 48.344 | 81,296–81,376 |

For the largest payloads gzip retained 2,220,355 parser bytes and 1,197,040 scan bytes; zstd retained
2,162,352 and 1,174,504 bytes respectively. That small additional byte reduction on these payloads does not
by itself justify an extra restore/runtime compatibility requirement. Raw copy remains necessary for
already-compressed data; these JSON trials do not measure that workload. The proposal below keeps gzip
as the initial codec while preserving original-byte hashes and a separate zstd decision.

Required online/advisory work and candidate database semantics remain gaps even though offline failure
controls passed. Full scanner RSS/CPU/corpus budgets, production admission/retention implementation,
crash/orphan recovery, graph payload effects and other host/backend combinations remain unmeasured.

## Proposed starting policy for owner review

These are proposed product defaults, not implemented settings or accepted support decisions:

| Boundary | Initial proposal | Reason and tradeoff |
|---|---|---|
| Object codec | gzip level 6; raw for already compressed objects; preserve content hash over original bytes | Existing codec boundary and broad tooling support. zstd stays experimental until restore/runtime compatibility is established. Timing alone does not select storage. |
| Object decoded size | 16 MiB maximum, explicit gap/refusal above it | Bounds decompression and transient buffers; large scanner outputs need chunking or a separately reviewed limit. Corpus stops near 8 MiB and does not prove 16 MiB worst-case memory. |
| Per-run capture | 512 MiB raw captured bytes; 3 GiB total retained workspace artifacts; reserve expected output before admission | Predictable workstation footprint; large monorepos may need opt-in increases. Compression ratio is never used to bypass decoded capture bounds. |
| Scanner concurrency | One external scanner; 2 GiB memory, 2 CPU, 128 PIDs, 256 MiB tmpfs; at least 512 MiB extra VM memory headroom before admission | Keeps current scanner prototype ceiling, leaves room on the observed roughly 8 GiB VM. Actual peak and full-engine/corpus sufficiency need engine-specific evidence. Resource availability can change after preflight. |
| Scanner time/output | 120 s and 4 MiB scrubbed process output initially, separately bounded artifact output | Matches the existing scanner experiment. Timeout/truncation are gaps, never clean analyses. Large corpora may need partitioning. |
| Retention | Up to 10 completed unpinned snapshots within 30 days; failed/cancelled artifacts 7 days; retain small identity/gap metadata 90 days; explicit pins within the same 3 GiB ceiling | Limits growth while preserving a short comparison horizon. Pruning removes restore history; surface that consequence before enabling this policy. Never delete an active, referenced or pinned object; refuse new work at the cap when pruning is unsafe. |

A container reservation needs a production coordinator, durable ownership and current free disk accounting;
this prototype only demonstrates quota/controller checks and bounded controls. Model budgets, graph payload
regression, full scanner RSS on representative corpora and retention UX remain separate gates. The owner and
integration lead accept or revise these defaults using measured output and the broader PR01 decision record.


## Integrated retained-file verification

The lead repeated the corrected runtime experiment at clean probe revision
`4353d4fbf58f430330d8460c508e76d17ab33bc3`. The [final result](evidence/2026-10-22-decisions/runtime-final.json),
SHA-256 `dcc954e40a13367b6c5d343f071f8cf30c606c2a5798bb8012a28959f3e950b7`, passed all 14 controls,
all seven exact-owner cleanup checks and all 54 codec trials with independently verified retained input/output
bytes and hashes. Each of the six original inputs was rechecked after all trials. The earlier measurement
is retained with its pre-hardening limitation. [The artifact archive](evidence/2026-10-22-decisions/runtime-artifacts.tgz)
stores each distinct byte sequence once, with a manifest mapping every original path from all three runs to its
hash; this preserves original progress metadata as well as encoded artifacts without duplicating identical files.

The lead sequenced the final run after package/browser tests, engine trials and the performance suite.
No competing experiment container was running at the pre-run check. Two pre-existing unrelated service
containers remained running; the desktop was not a dedicated benchmark machine. Absolute timing is therefore
observational and cannot support broad throughput or engine-ranking claims. The original artifact byte sizes
and codec choices are deterministic; the proposed resource ceilings remain policy choices, not guarantees.


The [identity-corrected intermediate result](evidence/2026-10-22-decisions/runtime-identity-corrected.json)
remains unchanged. Claude's subsequent review identified an optional-codec gap: unavailable zstd APIs should
retain an explicit unavailable attempt while raw/gzip continue. The final runner accepts only that exact
completed unavailable result, verifies original input identity and absence of an encoded artifact, and accounts
for every expected attempt. Its injected regression records 36 measured and 18 unavailable attempts; that is
a synthetic control, not the host measurement. On the measured Node 24.19.0 host all 54 attempts were measured
and zero were unavailable. Other child failures or unknown unavailable reasons still fail the experiment.
