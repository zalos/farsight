import type { StringEntry } from './strings.js';

// Sentinel's Trivy misconfiguration adapter (PR 13, ADR 33): why a configuration file is or is not covered, why an
// engine result was refused, how a run failed, and why acquisition or a job was refused. Each key is the stable reason
// code the adapter records. Both registers carry the same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_TRIVY_STRINGS: Record<string, StringEntry> = {
  // ---- coverage of one file ----
  'sentinel.trivy.coverage.complete': same('every selected check ran on this file', 'The engine reported scanning this file, or its Terraform module folder, against the pinned checks bundle, and nothing limited it.'),
  'sentinel.trivy.coverage.inlineIgnore': same('the file holds an inline ignore comment the engine honours', 'A trivy: or tfsec: ignore comment in the file suppresses checks, and the engine offers no way to turn that off. Findings it hides are not reported, so the file is partial.'),
  'sentinel.trivy.coverage.remoteModuleUnresolved': same('a remote Terraform module was not loaded', 'The configuration uses a module from a registry or another remote source. Scans have no network, so the module was not read and anything it would configure was not checked.'),
  'sentinel.trivy.coverage.variablesNotRead': same('the module’s variable files were not read', 'Variable files beside this module were not given to the engine, so checks saw default values only.'),
  'sentinel.trivy.coverage.notReported': same('the engine did not report scanning this file', 'The engine finished without an error but did not report scanning a file it may read (it always skips folders named .git, for one). That is an omission, not a pass: no check is known to have run on it.'),
  'sentinel.trivy.coverage.parseFailed': same('the engine could not parse this file', 'The engine reported that this file could not be parsed, so no check ran on it.'),
  'sentinel.trivy.coverage.notRecognized': same('this YAML cannot be a Kubernetes manifest', 'The engine reads YAML as Kubernetes only when a document has apiVersion, kind and metadata. This file lacks one of those keys, so no configuration check applies to it.'),
  'sentinel.trivy.coverage.notConfiguration': same('not a configuration file this adapter reads', 'Only Dockerfiles, Kubernetes YAML and Terraform files are read. Other files are listed, not checked.'),
  'sentinel.trivy.coverage.dependencyCache': same('a downloaded Terraform module, not the repository’s own configuration', 'Files under a .terraform folder are copies of downloaded modules. They are listed and not checked.'),
  'sentinel.trivy.coverage.variablesFile': same('a Terraform variable file, not checked on its own', 'Variable files supply values to a module; they are not checks’ inputs by themselves. Modules beside one are marked partial.'),
  'sentinel.trivy.coverage.pathUnsupported': same('a path the adapter cannot hand to the engine', 'Paths are sent only when every part uses letters, digits, dots, dashes and underscores. This file was not sent and was not checked.'),
  'sentinel.trivy.coverage.tooLarge': same('larger than the per-file limit', 'Configuration files above 1 MiB are not sent to the engine. This file was not checked.'),
  'sentinel.trivy.coverage.tooMany': same('past the run’s file or size limit', 'One run sends at most 2,000 files and 64 MiB. Files after the limit were not checked.'),
  'sentinel.trivy.coverage.bundleMissing': same('the pinned checks bundle has not been acquired', 'Checks come only from the pinned trivy-checks bundle, which the owner acquires separately. Without it nothing was run and no file was checked.'),
  'sentinel.trivy.coverage.bundleNotLoaded': same('the engine did not show that it used the pinned checks', 'The engine falls back silently to checks built into its binary. Its own log did not show the pinned bundle loading, so nothing from this run counts.'),
  'sentinel.trivy.coverage.inputMismatch': same('the scanned copy is not the captured file', 'The copy the engine read does not hash to the captured artifact, so its results are not used.'),
  'sentinel.trivy.coverage.attemptFailed': same('the isolated run failed', 'The worker did not complete under the isolated execution service, so no file is covered.'),
  'sentinel.trivy.coverage.attemptTimedOut': same('the isolated run ran out of time', 'The worker did not finish within its deadline, so no file is covered.'),
  'sentinel.trivy.coverage.attemptCanceled': same('the isolated run was canceled', 'The run was stopped before it finished, so no file is covered.'),
  'sentinel.trivy.coverage.engineFailed': same('the engine failed', 'The engine exited with an error, so none of its output is used.'),
  'sentinel.trivy.coverage.engineTimedOut': same('the engine ran out of time', 'The engine did not finish within the worker’s bound, so none of its output is used.'),
  'sentinel.trivy.coverage.outputTruncated': same('the engine’s report was over the size limit', 'A report larger than the bound is not read, so nothing from this run counts.'),
  'sentinel.trivy.coverage.platformUnmeasured': same('the engine ran on a platform not measured for this adapter', 'Results count only from a platform whose conformance has been measured, so nothing from this run counts.'),
  // ---- engine results refused ----
  'sentinel.trivy.refused.unknownTarget': same('a result named a file that was not sent', 'The engine reported a file or folder outside the run’s own list, so the result was not used.'),
  'sentinel.trivy.refused.notScanned': same('a result named a file the engine did not report scanning', 'A result disagreed with the engine’s own scan log, so it was not used.'),
  'sentinel.trivy.refused.notFromBundle': same('a result came from a check outside the pinned bundle', 'Only checks from the pinned bundle are used.'),
  'sentinel.trivy.refused.malformed': same('a result was not in the expected form', 'A result had an unexpected type, check id or severity, so it was not used.'),
  'sentinel.trivy.refused.locationInvalid': same('a result named lines outside the file', 'The lines a result named do not exist in the captured file, so it was not used.'),
  'sentinel.trivy.refused.inputMismatch': same('a result was for a copy that is not the captured file', 'The copy the engine read does not hash to the captured artifact, so the result was not used.'),
  // ---- how the engine failed ----
  'sentinel.trivy.engine.engineError': same('the engine reported an error', 'The engine exited with its error status.'),
  'sentinel.trivy.engine.killed': same('the engine was stopped', 'The engine was killed, by the worker’s time bound or the container’s limits.'),
  'sentinel.trivy.engine.unknown': same('the engine exited unexpectedly', 'The engine exited with a status the adapter does not recognize.'),
  // ---- the worker refused its job ----
  'sentinel.trivy.jobAmbiguous': same('the run did not receive exactly one job', 'The worker found no job file, or more than one, among its inputs.'),
  'sentinel.trivy.jobInvalid': same('the job was not in the expected form', 'A line of the job did not have the expected shape, so the worker stopped.'),
  'sentinel.trivy.bundleUnsupported': same('the job named a checks bundle other than the pinned one', 'The worker evaluates only the pinned trivy-checks bundle.'),
  'sentinel.trivy.bundleMissing': same('the job had no checks bundle', 'The worker does not run without the pinned checks bundle.'),
  'sentinel.trivy.bundleUnreadable': same('the checks bundle could not be unpacked', 'The worker could not unpack the pinned bundle, so nothing was run.'),
  'sentinel.trivy.targetMissing': same('a file named by the job was not among the inputs', 'The worker stops rather than scan a partial set.'),
  // ---- refusals ----
  'sentinel.trivy.targetInvalid': same('a configuration file could not be used: {detail}', 'Each file is a distinct safe relative path whose bytes are the captured artifact.'),
  'sentinel.trivy.bundleInvalid': same('the checks bundle could not be used: {detail}', 'Only the pinned bundle, stored privately with a manifest that matches its bytes, is used.'),
  'sentinel.trivy.outputInvalid': same('the run’s output could not be read: {detail}', 'The run record must name this job, this bundle and the engine report it lists, in the expected form.'),
  'sentinel.trivy.acquisitionUnauthorized': same('the checks bundle needs the owner’s confirmation: {detail}', 'Acquiring the bundle uses the network, so it needs the owner’s spent receipt for exactly the pinned bundle, used once.'),
  'sentinel.trivy.acquisitionRefused': same('the acquisition was refused: {detail}', 'Only the pinned manifest and layer are fetched, within their sizes, from the allowlisted registry and its blob host.'),
  'sentinel.trivy.acquisitionFailed': same('the checks bundle could not be acquired: {detail}', 'The registry did not return the pinned bytes. Nothing was stored.'),
};
