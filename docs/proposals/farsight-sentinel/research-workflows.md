# Farsight Sentinel workflow and integration research

Checked: 2026-10-17; repository baseline `4fce1c8` (PR #115 merged). Scope: durable execution, local evidence storage, incremental scans, reporting standards, and VS Code Copilot integration. The architecture recommendations below are proposed Sentinel choices; product capabilities are linked to their primary documentation. Sources, including those added by the independent review, were accessed on 2026-10-17. No experiment E1–E8 was run during this revision.

## Recommended foundation

Start with a local Sentinel coordinator, a dedicated SQLite ledger, and immutable compressed artifacts addressed by content hash. CLI, Farsight GUI, CI, and MCP should invoke the same coordinator operations. The coordinator owns the plan, progress, retries, validation, and accepted results. A model or scanner executes a work item; it does not decide whether the whole scan is complete.

Keep the application graph, execution graph, and evidence records distinct. Security evidence references Farsight node IDs and snapshot digests. It does not require putting every prompt, attempt, source bundle, and scanner finding into the viewer's application graph. A versioned runner interface should accommodate scripts, external scanners, configured model providers, and a connected agent host without requiring one agent framework everywhere.

## Execution options

| Option | What it supplies | What Sentinel still owns | Recommendation |
|---|---|---|---|
| SQLite ledger and local runner | Transactional progress, explicit attempts, local queries, simple installation | Scheduling, owned-child recovery, external-claim leases, retries, cancellation, evidence validation, dependency invalidation | Initial implementation, with a deliberately bounded single-host scope |
| Temporal | Durable workflow history, replay, activities, retry policies, worker coordination | Security semantics, artifacts, model provenance, cache equivalence, idempotent external operations | Optional backend when multi-host workers or an always-on service become requirements |
| LangGraph | Agent state checkpoints, interrupts, branching, parallel agent work | Sentinel's audit ledger, evidence contract, invalidation, reporting, external side-effect safety | Optional implementation inside an agent runner |

SQLite WAL permits concurrent readers and a writer, but only one writer at a time and only on the same host. Use short transactions, a coordinated write path, and a local filesystem. Choose `synchronous=FULL` where committed scan progress must survive power loss. Export through a consistent database backup rather than copying a live database without its WAL. These are operational requirements, not automatic properties of selecting SQLite. [SQLite WAL documentation](https://www.sqlite.org/wal.html)

Record `process.versions.sqlite` in the ledger header and check it before opening a ledger. SQLite lists the WAL-reset fix in 3.51.3 and 3.53.0; accept a verified fixed release (3.51.3+ in the 3.51 series or 3.53.0+), or an explicitly documented backport. A bare numeric `>= 3.51.3` check would also admit the withdrawn 3.52.0 release. A read-only probe of the installed Node 24.21.0 runtime confirmed SQLite 3.53.4 on the research date; the runtime actually launching Sentinel must pass the gate independently. [SQLite changes](https://sqlite.org/changes.html)

Temporal resumes by replaying workflow commands against recorded history. Completed activity results are reused, but an activity whose successful execution was not recorded can run again. Its documentation explicitly distinguishes observing completion once from executing an activity once. Scanner and model calls therefore still need stable operation IDs, retry limits, and handling for ambiguous outcomes. Temporal is attractive for distributed workers, but introduces a service and operational footprint that the initial local workflow does not need. [Workflow execution](https://docs.temporal.io/workflow-execution), [activity idempotency and retries](https://docs.temporal.io/activity-definition)

LangGraph persists graph state through checkpointers; in-memory savers do not survive restarts. Its documentation describes checkpoints at node boundaries, with an interrupted node restarting from its beginning. Synchronous persistence narrows the crash window; asynchronous and exit-only persistence have different durability tradeoffs. This is useful inside an agent workflow, but Sentinel still needs its own definition of a completed security check and when an old result remains applicable. [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [node boundaries and durability](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)

## Local ledger and artifact protocol

Use separate records for a scan, immutable plan revision, planned check, work item, execution attempt, input/output artifact, finding observation, adjudication, and report revision. Persist dependency edges explicitly. A retry appends an attempt; the final Sentinel proposal puts a changed model, changed rule, or forced rerun in a child run with its own pinned plan. Neither rewrites historical evidence.

Recommended publication protocol for one coordinator and its child workers:

1. Hold an exclusive coordinator lock and transactionally bind a ready work item to an attempt and coordinator epoch. Child workers have no ledger handle and receive attempt-specific scratch space.
2. Run outside the database transaction against immutable inputs and bounded resources. The coordinator owns child supervision, deadlines and cancellation; child workers do not need heartbeat leases.
3. Workers return candidate output. The coordinator verifies schema, referenced evidence and hashes, then flushes and atomically publishes immutable blobs.
4. In one ledger transaction, revalidate the current epoch, attempt, input fingerprint and cancellation state before accepting artifact references, observations, completion and the progress event. A uniqueness constraint permits only one accepted result per work revision.

On restart, fence the previous epoch and mark its unfinished child attempts `interrupted`. Reconcile or terminate only the processes belonging to those attempts before rescheduling; if their termination or external effects cannot be established, record that uncertainty and do not blindly duplicate a paid operation. A process group does **not** ensure children die with their parent: Node explicitly documents that children may survive parent exit even without `detached`. Attempt-specific scratch space, coordinator-only publication and epoch revalidation protect accepted results even if an orphan continues running. Cleanup must be designed and exercised per supported OS. [Node 24 child-process lifecycle](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#optionsdetached)

Keep leases, renewal and fencing generations for client-hosted `claim`/`submit` review work, which can arrive after a chat or coordinator session ends. Expired claims cannot complete work. Publication remains coordinator-owned on both paths. A cancellation request stops new work and rejects later result publication, but does not prove a provider stopped computing or billing. Record `canceled-after-spend` when usage is confirmed; record unknown usage or an ambiguous provider outcome explicitly otherwise.

A crash before the final transaction leaves retryable work and possibly orphaned blobs. A missing or corrupt committed blob is an integrity error, never a successful empty result. Garbage collection must retain artifacts reachable from reports, active work, and retained history. Exercise these boundaries with process-kill tests, including concurrent submissions and duplicate completion.

The content store should contain the graph snapshot, file manifest, parser diagnostics, framework facts, traversal summaries, scanner outputs, model evidence packets, and report exports. Keep a Sentinel-owned copy of the graph artifact so application snapshot pruning cannot remove required scan inputs. Hash canonical uncompressed content; record the compression codec/version separately. Portable gzip remains the initial choice. Node 24 already supplies `zstdCompress` and `createZstdCompress` without an added package; the APIs are experimental and were added in v23.8.0/v22.15.0. Benchmark gzip against zstd in increment A before choosing another default; that benchmark remains unrun here. [Node 24 zlib](https://nodejs.org/docs/latest-v24.x/api/zlib.html), [version-pinned 24.21.0 documentation](https://nodejs.org/download/release/v24.21.0/docs/api/zlib.html)

A compressed graph alone cannot support arbitrary future rules. A rule may require source syntax or configuration absent from the graph. Preserve the locally authorized source/configuration inputs needed for rescans, or mark an archive as requiring the original checkout. Source retention, redaction, and export policy belong in the manifest. Do not silently reconstruct historical inputs from today's working tree.

## Resume and differential scan semantics

Freeze a coverage plan before executing it: attack surface × applicable rule/version × required analysis mode. Include exclusions, unsupported constructs, and unresolved dispatch. Progress is measured against this plan, not the number of findings. Every planned check ends with an explicit outcome or remains visibly incomplete. Reusing evidence is itself a recorded outcome with its originating attempt and equivalence proof.

An execution key should incorporate source/scope digest, relevant dependency closure, parser/framework-adapter version, rule and locator digests, scanner/version, configuration, environment assumptions, and agent prompt/model/tool-policy identity where applicable. A persisted read set helps invalidate evidence, but cannot by itself discover newly relevant code: compare both old and new graph dependencies and rerun affected locators.

| Change | Required work |
|---|---|
| Interrupted process, unchanged inputs | Resume ready or expired work; retain accepted completed attempts |
| Model or prompt changed | Reuse eligible parsing and deterministic evidence; rerun the selected agent checks and downstream synthesis |
| Rule changed or added | Recompute applicability and locators for that rule, then rerun its checks and dependent adjudications |
| Application code changed | Reparse affected inputs, resolve changed edges, invalidate reverse dependencies and influenced entry points |
| Shared middleware, routing, framework configuration changed | Recompute effective control chains and invalidate every dependent entry point and exception |
| Parser or framework semantics changed | Conservatively rebuild affected facts and dependent checks; use a full rescan if the boundary is uncertain |
| Resolved framework version changed in a lockfile | Invalidate dependent layer stages, route-protection facts and dispositions even when application source bytes are unchanged; advisory refresh alone is insufficient |
| Rule applicability narrowed, engine digest or capability set changed | Recompute the plan; report `changed detection` unless an explicit compatibility mapping establishes a comparable check |
| A declaration touched by LOW-confidence name resolution changed or was added | Re-resolve callers and invalidate affected checks; an unchanged caller does not establish unchanged meaning |

Dependency, generated-code, CI/CD, build-profile, and infrastructure changes are inputs too. If analysis cannot establish a reliable dependency boundary, expand scope. An incomplete or narrower scan cannot declare an earlier finding fixed merely because it did not produce that finding again. Separate code changes from rule/model changes in comparisons so users can distinguish remediation from changed detection behavior.

Deterministic scheduling and evidence replay do not make fresh LLM responses deterministic. Record separate observations and disagreements. Keep general model review as an attributed lane whose coverage and confidence are independent of rule-based detection. Static analysis also cannot promise the exact executable order of every runtime path: preserve unresolved reflection, dynamic dispatch, callbacks, profile conditions, and bounds as evidence gaps.

## Evidence and exception lifecycle

Record model provider, requested model, returned model identifier, available immutable version, host, parameters, prompt/template digest, tools and versions, source packet digest, timestamps, usage, and concise evidence-based rationale. Store tool requests and returned evidence where policy permits. Do not require private chain-of-thought. A provider alias without a resolved version has weaker reproducibility and must be labeled accordingly.

A compensating control is a structured adjudication, not deletion of an observation. Bind it to the finding fingerprint, control source/configuration digests, applicable routes and profiles, required ordering, reviewer, rationale, and expiry. A changed dependency invalidates the adjudication and restores review work. Claimed middleware protection must prove applicability to the affected path; a comment or an agent assertion alone is insufficient. Distinguish a detector false positive, a mitigated condition, accepted risk, and unresolved evidence.

External protection has its own reusable `DeploymentAssertion`, with owner, route/profile/environment scope, evidence references, expiry and trust level (`asserted`, `imported-config`, `runtime-observed`). Unverified assertions do not satisfy mitigation policy. A disposition covers only its evidenced subset of affected paths; newly reachable entry points, weakened resolution, changed framework versions and expiry reopen the relevant assessment. Report an expired decision as `reopened: disposition expired`.

## Agent privacy and evaluation

Treat every source comment, document and scanner output as untrusted data. OWASP recommends output validation, least privilege and adversarial tests; it does not claim prompt injection can be eliminated. Willison's analysis identifies private data, untrusted content and external communication as the hazardous combination. Legit Security's CamoLeak disclosure demonstrates indirect injection through hidden PR comments and source exfiltration through rendered external content. These are reasons to isolate evidence access and reporting, not evidence that an untested Sentinel control already works. [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), [CamoLeak](https://legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code)

A hosted provider is an external channel receiving the expressly approved packet. Its adapter must record retention/training terms, their source and access date, and the intended source disclosure. Evidence tools never fetch model-supplied URLs or execute arbitrary commands; rendered findings must not load external images or other automatic network content. Provider opt-in does not authorize sending additional files requested by source comments. Citation validation can reject invented evidence but cannot detect every omission, severity distortion or false reassurance.

Evaluate agent lanes on labelled cases with repeated trials and injected canary instructions. Show a per-model agreement matrix: same issue, related issue, agent-only finding, and deterministic finding omitted by the agent. Agreement is not ground truth; precision and recall require labelled evidence. Preserve agent-only findings and attribution separately from deterministic counts. E5's proposed canary threshold remains an owner decision and, even if met, would establish only the measured test result. Plan estimates must disclose token-estimation uncertainty and provider pricing assumptions; hard token/cost budgets stop new calls and retain the unfinished frontier. E5 and E8 remain experiments for increment A.

## SARIF and VEX

Use SARIF 2.1.0 as the findings interchange format. It supports rule metadata, locations, code flows, suppressions, fingerprints, and baseline states. Fingerprints should survive line movement; line numbers alone are unsuitable identities. Keep richer workflow history and the complete check inventory in Sentinel's versioned JSON/SQLite bundle rather than relying on SARIF consumers to preserve them. [OASIS SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)

GitHub accepts a supported subset of SARIF 2.1.0: at the research date, at most 20 runs per file, 25,000 results per run and 10 MB gzipped per upload, with only the top 5,000 results included by severity. The local report remains authoritative. Keep `ruleId` stable as the Sentinel rule-family ID, with rule revision recorded separately. Sentinel's versioned issue fingerprint can be a namespaced `partialFingerprints` entry; GitHub's `primaryLocationLineHash` needs the actual source-line hashing algorithm, not an arbitrary issue hash. Use the documented upload action's hashing or a compatible implementation against captured source. Keep tool identity, paths and scan category stable and validate standard and GitHub-specific projections separately. [GitHub SARIF support](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support), [GitHub fingerprint implementation](https://github.com/github/codeql-action/blob/main/src/fingerprints.ts)

VEX expresses a vulnerability's impact on identified products over time. OpenVEX allows public or internally understood vulnerability identifiers, but a weakness category such as a CWE is not itself a specific vulnerability. A `not_affected` statement needs a justification or impact statement. Export VEX when product and vulnerability identities and evidence support that claim; do not translate every suppressed source finding or accepted risk into `not_affected`. [OpenVEX specification](https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md)

## MCP and VS Code Copilot

Ship MCP first. VS Code supports local and remote MCP servers, tools, resources, and prompts; its extension guidance recommends MCP when tools should work across environments and do not need editor APIs. A later extension can add diagnostics, navigation, or richer editor interaction while calling the same Sentinel engine. [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)

The existing SARIF Viewer extension can display local findings before Sentinel needs its own extension. Evaluate its Problems/results navigation in increment E; create a custom extension only when rerun, disposition or other coordinator actions justify it. [SARIF Viewer](https://marketplace.visualstudio.com/items?itemName=MS-SarifVSCode.sarif-viewer), [extension repository](https://github.com/microsoft/sarif-vscode-extension)

Expose bounded operations such as plan/start/status/pause/resume, inspect evidence, claim a review packet, and submit a structured observation. Long-running scans return run IDs. A connected agent's submission must include its work-item/input identity, and the coordinator validates it before accepting completion. If the chat ends, uncompleted work remains available to another runner. Do not make chat history the durable queue.

MCP sampling lets a server request a model through the client, but depends on negotiated capabilities and leaves model selection/control with the client. Sampling responses contain a model field; ordinary tool invocations do not establish equivalent provider provenance. Record unavailable model identity as unknown and distinguish host-supplied metadata from agent self-report. Do not infer a model from product branding. Use configured provider runners where auditable identity or unattended execution is required. [MCP sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)

A later VS Code extension can obtain `id`, `name`, `vendor`, `family` and `version` from `vscode.lm`'s `LanguageModelChat`, recorded as `identitySource: host-reported-vscode-lm`. This is stronger than an agent self-report, but the API defines opaque, extension-supplied identities rather than guaranteeing an immutable provider checkpoint. Copilot model use requires user consent; gracefully handle unavailable models or consent. [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model), [LanguageModelChat contract](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChat)

MCP's 2025-11-25 task facility is experimental and capability-negotiated. Treat any task extension as a transport optimization, not Sentinel's persistence contract; start/status/result tools remain a portable baseline. [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
