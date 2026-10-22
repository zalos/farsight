import type { StringEntry } from './strings.js';

// Sentinel's zizmor CI-configuration adapter (PR 13, ADR 34): why a CI file is or is not covered, why an engine
// finding was refused, how a run failed, and why a job was refused. Each key is the stable reason code the adapter
// records. Both registers carry the same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_ZIZMOR_STRINGS: Record<string, StringEntry> = {
  // ---- coverage of one file ----
  'sentinel.zizmor.coverage.complete': same('every offline audit ran on this file', 'The engine reported completing its audits of this file, and none of them needs the network.'),
  'sentinel.zizmor.coverage.onlineAuditsSkipped': same('audits that need the GitHub API were skipped', 'Scans have no network and no token, so the audits that check pinned commits, known-vulnerable actions and stale references did not run. That is a gap, not a pass.'),
  'sentinel.zizmor.coverage.offlineDegraded': same('some audits ran with less information offline', 'Without the GitHub API, an audit cannot resolve a commit-pinned action’s version or confirm that a referenced repository exists, so it may miss what it would otherwise report.'),
  'sentinel.zizmor.coverage.auditNotLoaded': same('an audit failed to load', 'An audit that should run offline did not load in this run, so its checks did not run on any file.'),
  'sentinel.zizmor.coverage.notAudited': same('the engine collected this file but did not audit it', 'The file could not be parsed, or is not valid for its kind. The engine finished without auditing it, which is a gap, not a pass.'),
  'sentinel.zizmor.coverage.notCollected': same('the engine did not collect this file', 'The file was sent but the engine never reported collecting it. No audit is known to have run on it.'),
  'sentinel.zizmor.coverage.notCiConfiguration': same('not a CI file this adapter reads', 'Only GitHub Actions workflows, action definitions and Dependabot configuration are read. Other files are listed, not checked.'),
  'sentinel.zizmor.coverage.pathUnsupported': same('a path the adapter cannot hand to the engine', 'Paths are sent only when every part uses letters, digits, dots, dashes and underscores. This file was not sent and was not checked.'),
  'sentinel.zizmor.coverage.tooLarge': same('larger than the per-file limit', 'CI files above 1 MiB are not sent to the engine. This file was not checked.'),
  'sentinel.zizmor.coverage.tooMany': same('past the run’s file or size limit', 'One run sends at most 2,000 files and 64 MiB. Files after the limit were not checked.'),
  'sentinel.zizmor.coverage.inputMismatch': same('the audited copy is not the captured file', 'The copy the engine read does not hash to the captured artifact, so its results are not used.'),
  'sentinel.zizmor.coverage.reportInconsistent': same('the engine’s report disagreed with its own summary', 'The engine’s exit status names the severity of its highest finding, and its log names the audits it skipped. When the report or the skipped audits do not match, nothing from the run counts.'),
  'sentinel.zizmor.coverage.attemptFailed': same('the isolated run failed', 'The worker did not complete under the isolated execution service, so no file is covered.'),
  'sentinel.zizmor.coverage.attemptTimedOut': same('the isolated run ran out of time', 'The worker did not finish within its deadline, so no file is covered.'),
  'sentinel.zizmor.coverage.attemptCanceled': same('the isolated run was canceled', 'The run was stopped before it finished, so no file is covered.'),
  'sentinel.zizmor.coverage.engineFailed': same('the engine failed', 'The engine exited with an error, so none of its output is used.'),
  'sentinel.zizmor.coverage.engineTimedOut': same('the engine ran out of time', 'The engine did not finish within the worker’s bound, so none of its output is used.'),
  'sentinel.zizmor.coverage.outputTruncated': same('the engine’s report was over the size limit', 'A report larger than the bound is not read, so nothing from this run counts.'),
  'sentinel.zizmor.coverage.platformUnmeasured': same('the engine ran on a platform not measured for this adapter', 'Results count only from a platform whose conformance has been measured, so nothing from this run counts.'),
  // ---- engine findings refused ----
  'sentinel.zizmor.refused.unknownPath': same('a finding named a file that was not sent', 'The engine reported a location outside the run’s own files, so the finding was not used.'),
  'sentinel.zizmor.refused.malformed': same('a finding was not in the expected form', 'A finding had an unexpected audit name, severity, confidence or location kind, or not exactly one primary location.'),
  'sentinel.zizmor.refused.locationInvalid': same('a finding named bytes outside the file', 'The span a finding named does not exist in the captured file, so it was not used.'),
  'sentinel.zizmor.refused.ignored': same('a finding was marked as ignored', 'Ignore comments are turned off, so an ignored finding means the run was not configured as stated.'),
  'sentinel.zizmor.refused.notAudited': same('a finding named a file the engine did not report auditing', 'A finding disagreed with the engine’s own log, so it was not used.'),
  // ---- how the engine failed ----
  'sentinel.zizmor.engine.engineError': same('the engine reported an error', 'The engine exited with its error status.'),
  'sentinel.zizmor.engine.usage': same('the engine refused its arguments', 'The engine exited with its argument error status.'),
  'sentinel.zizmor.engine.killed': same('the engine was stopped', 'The engine was killed, by the worker’s time bound or the container’s limits.'),
  'sentinel.zizmor.engine.unknown': same('the engine exited unexpectedly', 'The engine exited with a status the adapter does not recognize.'),
  // ---- the worker refused its job ----
  'sentinel.zizmor.jobAmbiguous': same('the run did not receive exactly one job', 'The worker found no job file, or more than one, among its inputs.'),
  'sentinel.zizmor.jobInvalid': same('the job was not in the expected form', 'A line of the job did not have the expected shape, so the worker stopped.'),
  'sentinel.zizmor.targetMissing': same('a file named by the job was not among the inputs', 'The worker stops rather than audit a partial set.'),
  // ---- refusals ----
  'sentinel.zizmor.targetInvalid': same('a CI file could not be used: {detail}', 'Each file is a distinct safe relative path whose bytes are the captured artifact.'),
  'sentinel.zizmor.outputInvalid': same('the run’s output could not be read: {detail}', 'The run record must name this job, the pinned engine version and the report it lists, in the expected form.'),
};
