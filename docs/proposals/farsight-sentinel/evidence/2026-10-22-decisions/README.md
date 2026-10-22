# PR01 decision evidence

[index.json](index.json) gives each retained file's exact byte count, SHA-256 and interpretation. These are
original synthetic experiments, not customer data. Every historical result keeps its original bytes and
limitations. A file's `measured` field is not acceptance when the index names a known false-pass defect.

- [Engine final](engine-final.json): both fixed profiles reconcile nine valid files. Pattern finds three
  direct positives; local taint finds six direct/local positives; neither qualifies on three cross-file
  positives. Nine safe symbols have no hits. Malformed, out-of-rule-language, oversized and missing-rule
  controls retain their diagnostics and inventories. Four runs show the denominator, control and safe-span
  corrections without overwriting earlier records.
- [Runtime final](runtime-final.json): 14 controls, seven owned container trials and 54 codec attempts.
  This host measured every codec attempt; injected unavailable-zstd tests are separate. Missing candidate
  advisory-database semantics remain an explicit gap. Three retained runs distinguish original measurements,
  artifact-identity hardening and optional-codec handling.
- [Framework final acquisition](framework-acquisition-final.json) and [offline runtime](framework-run-final.json):
  all four cases, 11 scenarios and 14 expected responses agree. All 14 dependency/app containers passed
  inspected isolation/completion checks and were removed. [Disposal](framework-disposal-final.json) removes
  only final acquisition tags without force and confirms each final image ID absent.
- Framework history includes an owner-label cleanup failure, a result incorrectly labeled `measured` despite
  null observations, and intermediate acquisition/runtime runs. Their filenames and index notes mark them
  historical. The final reviewed corpus has 19 sources, 11 scenarios and 14 fixed HTTP-status expectations.

[runtime-artifacts.tgz](runtime-artifacts.tgz) retains the original runtime inputs, encoded outputs and progress
records for all three runs. Its `manifest.json` maps each run-relative path to `objects/<sha256>`, with bytes
and hash. Identical bytes are stored once: 183 original paths reference 21 distinct objects. To reconstruct a
run, copy each named object to the associated relative path; verify its length and SHA-256 first. Git LFS stores
the archive, so download the LFS object before unpacking; the small pointer alone is not the evidence archive.

No scanner binary, dependency installation or container image is committed. Framework images are identified
by immutable IDs and dependency evidence; reproduction requires explicit acquisition. The evidence is tied to
the recorded revisions and inputs, not a claim that an arbitrary newer revision was measured. Proposed support
and resource policy live in [the decision manifest](../../feasibility-decisions.json), with owner acceptance
still required before PR02. See [the acceptance record](../../feasibility-acceptance.md) for the definition of done.

[framework-acquisition-files.tgz](framework-acquisition-files.tgz) retains 32 exact files: 19 reviewed sources,
eight generated Dockerfiles/request drivers and five lock/tree/POM evidence files. Its manifest supplies each
relative path, byte count and SHA-256. This archive contains no installed dependencies or executable scanner.
