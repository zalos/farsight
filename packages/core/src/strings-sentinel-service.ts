import type { StringEntry } from './strings.js';

// Sentinel's command line and local service (PR 09 prework): argument refusals, command outcomes, the admission
// verdicts as printed, who may ask, the local socket, initialization and the preview report. Both registers carry the
// same words until the PR 09 vocabulary freeze, as in strings-sentinel-cli.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_SERVICE_STRINGS: Record<string, StringEntry> = {
  'sentinel.cli.usageInit': same('farsight-sentinel init [--workspace <dir>] [--profile static] [--json]    create the private settings file once; never overwrites, downloads or scans', 'Writes the workspace\'s Sentinel settings from scrubbed defaults when the file is missing, and leaves an existing file exactly as it is.'),

  'sentinel.capability.draftPreviewCli': same('foundation preview only: plan and run in the foreground or in the background', 'The command line can initialize a workspace, adopt its settings, plan and run one original preview check in the foreground and print its report. It is not scanner coverage; background runs, waits and pause, resume and cancel go through the owner\'s local service.'),

  'sentinel.cli.unexpected': same('the command could not finish ({detail})', 'Something this command relies on failed in a way it does not name more precisely. Nothing was overwritten; the code in parentheses is the operating system\'s or the component\'s own.'),
  'sentinel.actor.payloadTooDeep': same('a request nests deeper than allowed', 'Request bodies nest at most 32 levels deep. A deeper one is refused rather than partly checked.'),

  // ---- arguments ----
  'sentinel.args.unknownCommand': same('unknown command: {detail}; run farsight-sentinel --help', 'The command is not one this executable knows.'),
  'sentinel.args.unknownFlag': same('unknown option for this command: {detail}', 'Each command accepts only the options it lists. An unknown one is refused rather than ignored, so a typo cannot quietly change what a command does.'),
  'sentinel.args.missingValue': same('{detail} needs a value', 'The option takes a value, and none was given.'),
  'sentinel.args.repeatedFlag': same('{detail} was given twice', 'An option may appear once, so the command never has to guess which value was meant.'),
  'sentinel.args.unexpectedArgument': same('unexpected argument: {detail}', 'The command was given more than it accepts.'),
  'sentinel.args.missingArgument': same('missing argument: {detail}', 'The command needs this argument.'),

  // ---- outcomes ----
  'sentinel.outcome.satisfied': same('policy satisfied', 'The scan finished, every required check completed and no finding broke the policy.'),
  'sentinel.outcome.findingPolicyFailed': same('a finding broke the policy', 'The scan finished and at least one finding is at or above the severity the policy fails on.'),
  'sentinel.outcome.requiredCoverageIncomplete': same('required checks did not complete', 'The scan finished, but at least one check the policy requires did not cover its scope, so the result cannot be called clean.'),
  'sentinel.outcome.configurationFailure': same('configuration or infrastructure failure', 'Something needed to run or judge the scan was missing or broken, so no policy result is given.'),
  'sentinel.outcome.awaitingConfirmation': same('waiting for the owner to confirm', 'Nothing has run yet. The action waits for its owner to confirm it on their own command line; this is not a scan result.'),
  'sentinel.outcome.submitted': same('submitted; not finished', 'The run was handed to the local service and will continue without this command. Its result is not known yet; ask for its status.'),
  'sentinel.outcome.unavailable': same('not available in this build', 'The command is planned and not built yet. Nothing was started.'),
  'sentinel.outcome.prepared': same('prepared', 'The command wrote what it was asked to and nothing else.'),
  'sentinel.outcome.kept': same('already there; left unchanged', 'What the command would create already exists, so its bytes were left exactly as they were.'),
  'sentinel.outcome.answered': same('answered', 'The command answered from this installation alone: no store, service or scan was involved.'),
  'sentinel.outcome.requested': same('requested; the run reaches it when its work in flight ends', 'The service accepted the control. A paused run finishes the work already started; a canceled one stops its workers.'),
  'sentinel.outcome.refused': same('refused', 'The command line or a local input could not be used. Nothing was started.'),

  // ---- verdicts ----
  'sentinel.verdict.notAsked': same('not asked', 'This command admitted nothing, so no policy, capability or credential verdict was asked for.'),

  // ---- who may ask ----
  'sentinel.actor.payloadClaim': same('a request may not say who is asking ({detail})', 'Who is asking is decided by how the request reached Sentinel, never by what it says, so a request naming an actor or a channel is refused.'),
  'sentinel.actor.confirmNotOwner': same('only the owner can confirm, on their own command line', 'Only the owner confirms an action, at their own terminal. An agent, the web bridge or a model cannot confirm, including its own request.'),
  'sentinel.actor.ownerChannelNotGrantable': same('the owner channel cannot be granted to a connection', 'The owner\'s command line is the only owner channel; a client of the local service is never given it.'),

  // ---- the local socket ----
  'sentinel.ipc.platformUnsupported': same('local service sockets are not qualified on {detail}', 'Socket path limits are known for macOS and Linux only; other systems are refused rather than guessed.'),
  'sentinel.ipc.pathTooLong': same('the local service address is too long ({detail})', 'A local socket path must fit the operating system\'s fixed size, counted in bytes with room for its terminator. A shorter private folder is used when the usual one is too deep.'),
  'sentinel.ipc.runtimeDirUnsafe': same('the local service folder is not private to this user ({detail})', 'The socket lives in a folder that must be a real folder, owned by this user and closed to everyone else. Anything else is refused, never changed.'),
  'sentinel.ipc.socketUnsafe': same('the local service socket is not this user\'s private socket ({detail})', 'Before connecting, the socket must be a socket, owned by this user and closed to others; otherwise the connection is refused.'),
  'sentinel.ipc.socketInUse': same('another local service is already listening for this store', 'One service owns a store at a time. A socket that still answers is never replaced.'),
  'sentinel.ipc.frameTooLarge': same('a local service message is too large', 'Each message is bounded so one client cannot exhaust the service\'s memory.'),
  'sentinel.ipc.frameMalformed': same('a local service message is not valid', 'Messages are length-prefixed UTF-8 JSON; anything else ends the connection.'),
  'sentinel.ipc.handshakeMismatch': same('the local service is not the one this store expects', 'The service must name the store and owner the client expects before any request is sent; a different or missing answer is refused.'),
  'sentinel.ipc.notListening': same('no local service is listening for this store', 'The store has no running service at its recorded address. Start one, or run in the foreground.'),
  'sentinel.ipc.socketIndeterminate': same('cannot tell whether a local service is still listening ({detail}); its socket was left in place', 'Only a refused connection proves a socket is stale. Any other error leaves the socket untouched, so a live service is never replaced; try again, or stop the other service.'),
  'sentinel.ipc.timeout': same('the local service did not answer in time', 'Connecting to the service and each request wait a bounded time for an answer; the service may still be working, and status shows what it did.'),
  'sentinel.ipc.canceled': same('the connection or request was canceled before it was answered', 'The caller stopped waiting; this does not stop work the service already admitted.'),
  'sentinel.ipc.requestFailed': same('the local service could not answer that request', 'The service refused or failed the request; its own reason code says why when it gives one.'),

  // ---- initialization ----
  'sentinel.init.workspaceUnsafe': same('the workspace cannot be initialized ({detail})', 'The workspace must be an existing folder given by an absolute path, with .farsight and its Sentinel folder real folders this user owns.'),
  'sentinel.init.settingsUnsafe': same('the settings path is not a regular file ({detail})', 'The settings file is read and written only as an ordinary file; a link or anything else at its path is refused, never replaced.'),
  'sentinel.init.profileUnknown': same('unknown scan profile: {detail}', 'This build describes one scan profile, static. Others arrive with later packages.'),
  'sentinel.init.created': same('created {path} from the default settings', 'The private settings file did not exist, so it was written from the scrubbed defaults: no grants, no providers, agents wait for a person.'),
  'sentinel.init.kept': same('kept {path} unchanged', 'The settings file already exists. Initialization never overwrites it; its bytes are exactly as they were.'),
  'sentinel.init.unrecognised': same('the existing settings file is not Sentinel settings; it was left as it is', 'The file at the settings path does not parse as Sentinel settings. It was not changed; fix or move it yourself.'),
  'sentinel.init.profile': same('profile: {profile} — source-only checks, a foundation preview; no scanner or framework coverage yet', 'The chosen scan profile and what it covers today. Later packages add scanners and framework checks; this build claims none.'),
  'sentinel.init.prerequisites': same('needs: Node 24 or later; a container runtime only for external scanners, which this build does not run', 'What this machine needs. Nothing was downloaded, installed or started by initialization.'),
  'sentinel.init.credentials': same('credentials: settings hold keychain references only (keychain:farsight/<name>), never a value', 'A provider credential is named by its keychain reference and read in-process when needed; a value shaped like a secret is refused.'),
  'sentinel.init.next': same('next: review the file, then adopt it as its owner (available with PR 06), then plan a scan (available with PR 09)', 'The settings grant nothing until their owner adopts these exact bytes. Planning and running arrive with the commands named here.'),
  'sentinel.init.noEffects': same('nothing was downloaded and no scan was started', 'Initialization only writes the settings file, and only when it is missing.'),

  // ---- the owner's local service ----
  'sentinel.service.settingsNotAdopted': same('this workspace\'s settings are not adopted', 'Nothing is planned or run until the owner adopts the workspace\'s settings with farsight-sentinel settings adopt --confirm. Changed settings must be adopted again.'),
  'sentinel.service.planUnknown': same('no prepared plan has that id', 'Run, status and report name a plan this workspace prepared with farsight-sentinel plan.'),
  'sentinel.service.policyChanged': same('the adopted settings changed since this plan was prepared; plan again', 'A plan is run only under the policy it was prepared with, so a settings change needs a new plan.'),
  'sentinel.service.planChanged': same('the plan no longer rebuilds to what was disclosed; plan again', 'Before running, the plan is rebuilt from its snapshot and must match the identity planning disclosed exactly.'),
  'sentinel.service.runNotCompleted': same('the run did not complete', 'The run stopped before every planned check finished, so there is no complete result to report.'),
  'sentinel.service.executionFailed': same('a planned check failed to execute', 'At least one check could not run to the end, so the run is an execution failure, not a scan result.'),
  'sentinel.service.previewNotCoverage': same('foundation preview complete: this is not required coverage', 'The preview detector ran to the end. A preview never satisfies the policy\'s required coverage, so the result is required coverage incomplete, with its findings kept.'),
  'sentinel.service.runUnknown': same('no run has that id in this store', 'Status reads a run this workspace\'s store has recorded.'),
  'sentinel.service.ownerReceipt': same('confirmed by the owner\'s receipt', 'The owner confirmed exactly this action in their own command line. The service spent that receipt once, after checking it names this action, plan and policy revision.'),
  'sentinel.service.anotherRunActive': same('the service is running another plan; wait for it or cancel it first', 'One run executes at a time in a workspace\'s service. Nothing was started for this plan.'),
  'sentinel.service.runNotActive': same('the run is not executing in the service', 'Pause applies to a run the service is executing now. Nothing was changed.'),
  'sentinel.service.runInterrupted': same('the run stopped before it finished; resume it to continue', 'The run\'s last recorded state is not final and nothing is executing it, for example after its service stopped. Resuming recovers what was in flight and continues.'),
  'sentinel.service.waitTimedOut': same('still running when the wait ended', 'The wait ended before the run did. The run continues; wait again or read its status.'),
  'sentinel.service.ownerServiceRunning': same('the workspace\'s service holds the store; use run --detach, status, wait or report', 'While the owner\'s background service runs, it alone opens the workspace\'s store. Commands that read go through it; a new plan waits until it stops.'),
  'sentinel.service.needsOwnerConfirm': same('the background service needs the owner\'s confirmation for this: add --confirm', 'Starting, resuming, pausing or cancelling a background run hands the service the owner\'s receipt for exactly that action on exactly this plan. That happens only after the owner confirms. Nothing was changed.'),
  'sentinel.service.notRunning': same('the workspace\'s service is not running', 'Wait, pause and cancel talk to the owner\'s background service, which is not running for this workspace. Status and report still read the store directly.'),
  'sentinel.service.recordUnsafe': same('the service record in your private state is not safe to use', 'Where a running service is recorded sits in the owner\'s private state: a regular file of this account, closed to others, never a link. Anything else is refused rather than followed or trusted.'),
  'sentinel.service.lockChanged': same('another promotion changed the rule lock meanwhile; promote again', 'A promotion is confirmed against one lock revision and becomes current only if that revision is still current. Nothing was selected.'),
  'sentinel.cli.usageRules': same('farsight-sentinel rules show | rules promote <packDir|builtin:foundation-preview> [--confirm] [--json]    the owner\'s rule lock; promote a validated pack into a new revision', 'Show prints the current lock revision and its packs. Promote validates the pack folder and, with --confirm, adds it to a new lock revision confirmed for exactly that pack against exactly the current lock; without --confirm it shows what would change and waits (exit 4).'),
  'sentinel.service.startFailed': same('the background service did not start', 'The command started the owner\'s service and could not reach it in time, so it stopped exactly the process it started. Nothing was handed to it.'),
  'sentinel.service.alreadyServing': same('another process already holds this workspace\'s store', 'Only one service, or one foreground command, opens a store at a time.'),
  'sentinel.service.unknownOperation': same('the service does not know that request', 'The local service answers a fixed set of requests; any other is refused.'),
  'sentinel.service.requestInvalid': same('the request is not one the service accepts', 'A request names a plan or run by its id and carries only the fields that request takes.'),
  'sentinel.service.serving': same('serving {workspace}; stops after {idle} ms with nothing to do', 'The owner\'s background service is listening on its private local socket.'),
  'sentinel.service.servingForever': same('serving {workspace} until stopped', 'The owner\'s background service is listening on its private local socket and keeps running until it is stopped.'),
  'sentinel.cli.usageServe': same('farsight-sentinel serve [--idle-ms <n>] [--json]    run the owner\'s background service for this workspace', 'Holds the workspace\'s store and answers its private local socket. It stops after the idle time with nothing to do, or never with --idle-ms 0.'),
  'sentinel.cli.usageDetach': same('farsight-sentinel run <planId> --detach --confirm [--json]    hand a prepared plan to the background service', 'Confirms the run as its owner and hands it to the background service, starting the service when needed. A second request for the same plan joins the same run.'),
  'sentinel.cli.usageWait': same('farsight-sentinel wait <runId> [--timeout <ms>] [--json]    wait for a background run and print its result', 'Waits for the run the service is executing and prints its final result, or that it is still running when the wait ends.'),
  'sentinel.cli.usageControls': same('farsight-sentinel pause|resume|cancel <runId> --confirm    control a background run', 'Pause stops starting new work and lets work in flight finish; cancel stops the workers; resume continues a paused or interrupted run. Each is a write and needs the owner\'s confirmation, as starting did.'),
  'sentinel.cli.usageSettings': same('farsight-sentinel settings adopt [--confirm] [--json]    adopt this workspace\'s settings as their owner', 'Without --confirm it shows what would be adopted and waits (exit 4); with it the owner adopts the exact settings bytes.'),
  'sentinel.cli.usagePlan': same('farsight-sentinel plan [--confirm] [--json]    capture this workspace and prepare a foundation-preview plan', 'Captures the workspace and prepares a plan. Nothing runs.'),
  'sentinel.cli.usageRun': same('farsight-sentinel run <planId> [--confirm] [--json]    run a prepared plan in the foreground', 'Runs the plan to the end in this process. A preview ends required coverage incomplete (exit 2), never satisfied.'),
  'sentinel.cli.usageStatus': same('farsight-sentinel status <runId> [--after <n>] [--limit <n>] [--json]    the run\'s state and a bounded page of its events', 'Reads the run\'s committed state and at most 50 events per page.'),
  'sentinel.cli.usageReport': same('farsight-sentinel report <runId> [--format md|json]    the preview report, from the ledger alone', 'Renders the report from stored results only; nothing is executed or re-read from the workspace.'),

  // ---- the built-in foundation-preview rule ----
  'sentinel.rule.previewSqlConcat': same('SQL text assembled from strings (foundation preview)', 'One line holds SQL text joined with + to something that is not a literal, or a template literal with SQL text and an interpolation, in TypeScript, JavaScript or Java. A candidate location to review, found by one original line-level check.'),
  'sentinel.rule.previewLimitation': same('a single-line text check: not taint analysis, not scanner coverage', 'The foundation-preview rule reads one line at a time. It does not follow values between lines, files or calls, and a preview never satisfies required coverage.'),

  'sentinel.preview.skipUnattributed': same('not checked: the unit did not name one file for one scope', 'The preview detector covers a unit only when it can tell which captured file is which scope. Otherwise every scope of the unit is reported skipped, never covered.'),
  'sentinel.preview.skipLanguage': same('not checked: not a TypeScript, JavaScript or Java file', 'The preview rule reads TypeScript, JavaScript and Java source only.'),
  'sentinel.preview.skipNotText': same('not checked: the file is not UTF-8 text', 'The preview detector reads only files that decode as UTF-8 text; any other file is reported skipped.'),
  'sentinel.service.packUnavailable': same('a pack the rule lock names is not kept here; promote it again', 'Planning resolves the owner\'s rule lock against the exact pack files that were promoted. A lock whose pack files are missing from the owner\'s private state cannot be planned from.'),
  'sentinel.service.noRuleLock': same('no rule pack is promoted yet: run farsight-sentinel rules promote builtin:foundation-preview', 'A plan checks only rules the owner promoted into the rule lock. With none, nothing can be planned.'),
  'sentinel.service.policyNotEvaluated': same('coverage complete, but the finding policy is not evaluated in this build', 'This build records coverage. Judging findings against the owner\'s policy arrives with the full report, so it never prints a satisfied result.'),
  'sentinel.service.bootstrapFailed': same('capturing, parsing or inventorying the workspace did not complete; farsight-sentinel rerun <runId> plans a new run after it', 'A plan is made only from evidence the run published. The bootstrap stages did not all publish, so nothing was planned for analysis, and that run is finished. Planning the same content again names it; rerun plans a new run after it.'),

  'sentinel.service.coverageIncomplete': same('required checks did not all complete', 'At least one required check was not planned, could not run or covered only part of its scope, so the run\'s required coverage is incomplete.'),
  'sentinel.service.runAwaiting': same('planned and admitted; waiting to run', 'The run\'s analysis is admitted and nothing of it has started. Run it with farsight-sentinel run, in the foreground or with --detach --confirm.'),

  'sentinel.service.runNotEnded': same('the run has not ended: resume it rather than retry it', 'Retry and rerun start a new run after one has completed or been canceled. A paused or interrupted run continues with farsight-sentinel resume.'),
  'sentinel.cli.usageFollow': same('farsight-sentinel rerun <runId> [--stage <unit,...>] · retry <runId> [--json]    a linked run over an ended run\'s retained snapshot', 'Either previews what would run again (the selected units and everything downstream) and what is reused from the parent (prerequisites, the published bootstrap), then plans and admits a new run naming the ended run as its parent, waiting to be run. Retry selects the units that did not publish. Changed source is a new plan.'),

  'sentinel.service.stageUnknown': same('no unit of the run\'s plan has that id', 'A rerun names units of the ended run\'s admitted analysis, as status lists them.'),
  'sentinel.service.selectionUnsupported': same('rerunning only some units is not available yet; the preview shows what it would run and reuse', 'A selected rerun runs the chosen units and everything downstream of them, and reuses the parent\'s published prerequisites. Planning just those units and reusing another run\'s published work are not built yet, so only the whole analysis can be rerun. Nothing was planned.'),
  'sentinel.service.nothingToRetry': same('every unit of the run published: nothing to retry', 'A retry runs again the units that did not publish. A run whose every unit published has none; rerun it to run everything again.'),

  'sentinel.service.ruleUnsupported': same('a promoted rule names an adapter that does not implement it; nothing was planned', 'A check adapter shipped with this build runs only the exact rules it implements: the same family, revision and definition bytes, detector description and fixtures included. A pack that names it for another rule, or for this rule with other bytes, is refused before anything runs, rather than reported as covered.'),

  // ---- the preview report ----
  'sentinel.report.previewTitle': same('Sentinel scan — foundation preview', 'The heading of a preview report: a run\'s counts with their scopes and re-check commands, before full reports exist.'),
  'sentinel.report.previewOnly': same('Foundation preview: these counts show the pipeline works end to end. They are not scanner or framework coverage.', 'A preview report demonstrates planning, running and reporting with one original fixture detector. It makes no claim about what real scanners would find.'),
  'sentinel.report.noScannerCoverage': same('No pinned scanner, framework check or model review ran; an empty finding list here says nothing about the code\'s safety.', 'Printed with every preview so its counts cannot be read as a clean result.'),
  'sentinel.report.countsHeading': same('Counts', 'Each number with what it counts, the scope it counts over and the command that prints it again.'),
  'sentinel.report.limitationsHeading': same('Limitations', 'What this report does not cover.'),
  'sentinel.report.invalid': same('the preview report is not valid ({detail})', 'A preview report must carry its label, its limitations, known scopes and words, breakdowns that sum, and a re-check command for every count.'),
};

export function sentinelServiceWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_SERVICE_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
