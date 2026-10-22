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

Measured identities/results will be recorded after committed-code trials. Until then no runtime is accepted.
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
