import type { StringEntry } from './strings.js';

// Sentinel's command line and local service (PR 09 prework): argument refusals, command outcomes, the admission
// verdicts as printed, who may ask, the local socket, initialization and the preview report. Both registers carry the
// same words until the PR 09 vocabulary freeze, as in strings-sentinel-cli.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_SERVICE_STRINGS: Record<string, StringEntry> = {
  'sentinel.cli.usageInit': same('farsight-sentinel init [--workspace <dir>] [--profile static] [--json]    create the private settings file once; never overwrites, downloads or scans', 'Writes the workspace\'s Sentinel settings from scrubbed defaults when the file is missing, and leaves an existing file exactly as it is.'),

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
