import type { StringEntry } from './strings.js';

// Sentinel worker execution (PR 07): the bounded worker protocol, the trusted adapter registry, container
// isolation and the supervisor. Each key is the stable reason code an ExecutionError or a worker outcome carries;
// the professional text is its message. Startup refusals also have a business-register explanation.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_EXECUTION_STRINGS: Record<string, StringEntry> = {
  'sentinel.execution.isolationUnavailable': same('no container runtime is available for isolated scanning ({reason})', 'External scanners run only inside a local Linux container. When none is reachable the scanner does not run; it is never run on this computer instead.'),
  'sentinel.execution.backendUnqualified': same('the container runtime {backend} on {host} has not been qualified for isolated scanning', 'Isolation is trusted only on the host, container runtime and processor combinations where the isolation tests were run. Any other combination is refused rather than assumed to isolate the same way.'),
  'sentinel.execution.imageMissing': same('the pinned tool image is not installed: {image}', 'Tool images are installed ahead of time and pinned by digest. A scan never downloads one, so a missing image stops that scanner until someone installs that exact image.'),
  'sentinel.execution.imageMismatch': same('the installed tool image does not match its pin: {image}', 'The installed image has a different digest, operating system or processor than the pin names, so it is not used.'),
  'sentinel.execution.isolationMismatch': same('the container was not created with the required isolation: {setting}', 'Before a worker starts, its container is read back and every isolation setting is compared with what was asked for. A difference stops the attempt and the container is removed.'),
  'sentinel.execution.adapterUnknown': same('no trusted adapter is registered as {adapter}', 'Only tools registered in the trusted adapter list can run. A name from a repository or a worker is never enough.'),
  'sentinel.execution.adapterInvalid': same('the adapter definition is not acceptable: {reason}', 'An adapter needs an exact pinned image or module, fixed arguments and bounded limits before it can be registered.'),
  'sentinel.execution.adapterIsolationRefused': same('an external tool may only run inside a container', 'Only workers built into Sentinel may run as a local process. Every external tool must run in an isolated container.'),
  'sentinel.execution.inputMismatch': same('a captured input does not match its digest', 'Each input is copied into the attempt and hashed while it is copied. Bytes that differ from the digest the plan pinned are refused.'),
  'sentinel.execution.frameTooLarge': same('a worker message is larger than the limit', 'Worker messages are size-checked before they are decoded, so an oversized or endless message cannot exhaust memory. The worker is stopped.'),
  'sentinel.execution.frameMalformed': same('a worker message is not valid text or JSON', 'A worker message must be one line of valid UTF-8 JSON. Anything else stops the worker.'),
  'sentinel.execution.messageInvalid': same('a worker message does not match the protocol schema', 'Every message is checked against the protocol schema before it is read. A message that fails stops the worker.'),
  'sentinel.execution.protocolViolation': same('the worker broke the protocol: {rule}', 'Messages must arrive in order, carry this attempt’s identity and coordinator epoch, and count up without gaps. A worker cannot choose its own attempt or authority.'),
  'sentinel.execution.versionRefused': same('the worker speaks no protocol version this build reads', 'The worker and Sentinel share no protocol version, so the worker is refused rather than guessed at.'),
  'sentinel.execution.adapterIdentityMismatch': same('the worker announced a different adapter than the one started', 'A worker names its adapter and digest when it starts. If they differ from the trusted registration, its output is not accepted.'),
  'sentinel.execution.resultMismatch': same('the worker result does not belong to the inputs it was given', 'A result must name the input fingerprint of its start message. A result for other inputs is refused.'),
  'sentinel.execution.outputMismatch': same('the worker outputs do not match what it reported: {reason}', 'Each output file is re-read and hashed. A missing, extra, linked, resized or changed file, or a reference to an output that was not produced, is refused.'),
  'sentinel.execution.outputTooLarge': same('the worker wrote more output than its limit', 'Output written by a worker is measured while it runs and after it exits. A worker that writes past its limit is stopped and its output is not accepted.'),
  'sentinel.execution.stdoutBudget': same('the worker sent more protocol data than its limit', 'The protocol channel has a total byte limit. A worker that floods it is stopped.'),
  'sentinel.execution.deadlineExceeded': same('the worker did not finish before its deadline', 'Every attempt has a deadline. A worker still running at the deadline is stopped and the attempt ends without a result.'),
  'sentinel.execution.canceled': same('the attempt was canceled', 'Cancellation was asked for. The worker was told to stop and, if it did not stop in time, was stopped.'),
  'sentinel.execution.resourceExceeded': same('a resource limit or capacity stopped the attempt', 'The attempt reached a configured memory or CPU limit, or its requested resources exceeded scheduling capacity. Details name the resource and observation. Container memory evidence comes from the runtime or verified counters for that exact container; a kernel observation records limit activity and an out-of-memory kill without proving a causally paired killer.'),
  'sentinel.execution.closureRefused': {
    professional: 'the built-in worker’s startup verification refused to run it',
    hud: 'Sentinel’s built-in check stopped at its startup check, before checking anything',
    define: 'Before it does any work, the built-in worker checks its installed files and entry point against what was registered. When that check fails it ends with no result. Reinstall or re-register Sentinel and plan again.',
  },
  'sentinel.execution.workerExited': same('the worker stopped without a valid result', 'The worker ended, or ended with an error, before it delivered a result that passed every check.'),
  'sentinel.execution.cleanupFailed': same('the worker container could not be confirmed removed: {container}', 'After every attempt its container is removed by its exact identity and its absence is confirmed. When that cannot be confirmed the attempt is recorded as needing cleanup.'),
  'sentinel.execution.reconciliationPending': same('the container runtime may still create this attempt\u2019s container: {name}', 'A create request ended without a confirmed answer, so the container may appear later. Its name and ownership labels are kept so recovery can find and remove it; the attempt does not succeed and absence is never assumed.'),
  'sentinel.execution.stderrBudget': same('the worker wrote more diagnostics than its limit', 'Diagnostics on stderr have their own byte limit, and stdout and stderr together have one too. A worker that writes past either is stopped.'),
  'sentinel.execution.planInvalid': same('the plan cannot be executed: {reason}', 'A plan must be a graph without cycles whose dependencies are all in the same run and plan revision, with bounded retry and admission settings. A plan that is not is refused before anything is recorded.'),
  'sentinel.execution.durabilityFailed': same('a store file could not be made durable ({operation}: {osCode})', 'Execution records are synced to disk before they count. An input or output error, a full disk or a read-only file system stops the attempt instead of being ignored; only a platform that cannot sync a folder at all is allowed, and reported.'),
  'sentinel.execution.journalUnreadable': same('a recovery journal record could not be read: {reason}', 'A journal record that is not a small private regular file with the expected fields is kept as it is and reported, so cleanup it may describe is never silently dropped.'),
  'sentinel.execution.cleanupObligation': same('a worker of an earlier coordinator could not be confirmed stopped: process {pid}', 'Recovery stops an earlier worker only after confirming it is that worker. When it cannot confirm either way, the obligation is kept and checked again by every later recovery.'),
  'sentinel.execution.dependencyFailed': same('held because a work unit it depends on did not publish', 'This work waits on another that failed or is itself held, so it cannot run in this plan revision.'),
  'sentinel.execution.runDeadline': same('the run used up its time budget', 'A run has a deadline over all its work. Attempts still running when it passes are stopped, and work that could not start in time is held; the run then ends with an execution failure.'),
  'sentinel.execution.notSelected': same('not part of this selected rerun', 'A selected rerun runs only the chosen units and what depends on them. This unit was not chosen, so it is held here and not run; the result the parent run published for it stays the parent\'s, and its checks are not counted as covered by this run.'),
  'sentinel.execution.analysisUnavailable': same('the retained analysis could not be verified', 'This check needs the exact parser evidence retained by the admitted setup work. A missing or mismatched source, snapshot, parser setting or publication stops this check before it starts; it is never treated as coverage or automatically retried.'),
  'sentinel.execution.stageInputMissing': same('a stage input this work reads was not published: {stage} reads {inputs}', 'A stage that reads another stage\'s output runs only after that stage published it. One it reads is still waiting or ended without publishing, so this work does not start and the input is named.'),
  'sentinel.execution.stageInputWithheld': same('an output {stage} reads is withheld from it: {inputs}', 'Before a model or a script may read another stage\'s output, every upstream artifact passes the secret fold: a secret scanner\'s own output, anything that cannot be inspected, anything carrying withheld evidence or naming a file a secret match withheld, and everything in a run whose secret scan found a match, is withheld. One was, so this stage does not start and nothing partial is handed to it.'),
  'sentinel.execution.featureOff': same('this stage needs a feature the adopted settings leave off: {feature}', 'Some stages run only when the owner turned their feature on in the adopted settings; a host script needs host scripts on. The feature is off, so the stage does not start and nothing of it runs.'),
  'sentinel.execution.bootstrapEvidence': same('the setup evidence does not hold', 'Capture, parse and inventory publish only what they verified: the run\'s admitted snapshot, the parser\'s analysis of each of its sources, and those analyses gathered once. A snapshot that was not admitted here, a source the plan does not parse, or an analysis of another snapshot fails the stage instead of being recorded.'),
  'sentinel.execution.commandFailed': same('a container runtime command failed ({operation})', 'A command to the container runtime returned an error, so the attempt stopped. No other container was touched.'),
  'sentinel.execution.scratchUnsafe': same('the attempt scratch folder is not a private folder', 'Attempts work in a folder only this user can open, so inputs and outputs cannot be read or swapped by others.'),
};

export function sentinelExecutionWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_EXECUTION_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
