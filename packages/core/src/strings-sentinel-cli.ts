import type { StringEntry } from './strings.js';

// Sentinel's placeholder executable, capability reasons and contract error codes (PR 02). Command-line output
// prints the professional register; both registers carry the same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_CLI_STRINGS: Record<string, StringEntry> = {
  'sentinel.cli.title': same('farsight-sentinel: optional security-analysis companion to Farsight (draft, no scanner yet)', 'Sentinel is an optional companion installed separately from Farsight. This draft build defines and validates its record formats only.'),
  'sentinel.cli.scope': same('This build only defines and validates draft contracts. It cannot capture source, plan or run a scan, and it never downloads a tool, starts a container or contacts a model provider.', 'Every analysis capability is listed as unavailable until the planned change that delivers it is merged.'),
  'sentinel.cli.usageHeading': same('usage:', 'The commands this build accepts.'),
  'sentinel.cli.usageHelp': same('farsight-sentinel --help | --version', 'Print this help, or the package version and the contract draft it reads.'),
  'sentinel.cli.usageCapabilities': same('farsight-sentinel capabilities [--json]    what this build can and cannot do, with reasons', 'Lists every planned capability with its state, the reason and the planned change that delivers it.'),
  'sentinel.cli.usageValidate': same('farsight-sentinel validate <kind> <file> [--json]    check one JSON record against its draft schema', 'Reads one local JSON file and checks its version, its schema and the rules a schema cannot express.'),
  'sentinel.cli.kinds': same('kinds: {kinds}', 'The record kinds this build can validate.'),
  'sentinel.cli.planned': same('planned, not available: {commands}', 'Commands the implementation plan names that this draft build refuses without starting anything.'),
  'sentinel.cli.exitCodes': same('exit codes: 0 ok, 1 finding policy failed, 2 required coverage incomplete, 3 configuration or input error (also every unavailable command), 4 awaiting owner confirmation', 'Sentinel has its own exit codes. They differ from the work commands, where 2 means waiting for confirmation.'),
  'sentinel.cli.version': same('farsight-sentinel {version}, contracts {draft}', 'The installed package version and the contract draft this build reads and writes.'),
  'sentinel.cli.stateDraft': same('draft', 'Available as a draft: its format can still change before the contract review approves a freeze.'),
  'sentinel.cli.stateUnavailable': same('unavailable', 'Not implemented in this build. Nothing is started for it.'),
  'sentinel.cli.plannedIn': same('planned in {change}', 'The planned change in the implementation plan that delivers this.'),
  'sentinel.cli.unavailable': same('unavailable: {command} is not implemented in this draft build (planned in {change}). Nothing was started.', 'A planned command was asked for. The draft build refuses it with exit 3 and starts no process, container or network request.'),
  'sentinel.cli.unknownCommand': same('unknown command; run farsight-sentinel --help', 'The command is not one this build knows.'),
  'sentinel.cli.validateUsage': same('usage: farsight-sentinel validate <{kinds}> <file>', 'Validation needs a record kind and the path of one local JSON file.'),
  'sentinel.cli.refusedTooLarge': same('refused: larger than {bytes} bytes', 'Records above the size limit are refused before they are read, so a large file cannot exhaust memory.'),
  'sentinel.cli.refusedUnreadable': same('refused: cannot read that file', 'The path is missing, is not a regular file or could not be read.'),
  'sentinel.cli.valid': same('valid {schema}', 'The record matched its version, its schema and its cross-field rules.'),
  'sentinel.cli.invalid': same('invalid {schema}', 'The record was refused. Each line names the error code and where in the record it applies.'),
  'sentinel.cli.more': same('{count} more', 'Further errors were found than are printed here.'),

  'sentinel.capability.draftContracts': same('draft contracts only', 'The record formats exist as drafts with schemas and validation; nothing analyses code yet.'),
  'sentinel.capability.draftStore': same('draft local store only', 'A library can open a local store, record runs and publish verified evidence objects. Nothing scans source with it yet.'),
  'sentinel.capability.draftParser': same('draft parser reconciliation only', 'A library can parse a captured snapshot\'s TypeScript, JavaScript and Java source with the public parser, check every read it made against the captured files, and record which files it parsed. That is syntax evidence over captured source only: it scans nothing and no check relies on it.'),
  'sentinel.capability.draftPolicy': same('draft policy library only', 'A library can validate and lock rule packs, adopt trusted settings, issue owner receipts and decide admission. No plan or scan uses it yet.'),
  'sentinel.capability.draftPlanning': same('draft deterministic planner only', 'A library can plan checks from a pinned rule lock, policy and parsed snapshot and hand canonical work to a coordinator. Nothing runs a scanner from the plan yet.'),
  'sentinel.capability.draftExpress': same('draft Express pack only, from source', 'A library can read a captured Express 4.21.2 source and say, for each route, what runs before its handler, which layers can refuse the request and what it cannot read. It never credits a refusal as authentication or authorization. It reads source only and runs nothing; no scan uses it yet.'),
  'sentinel.capability.notImplemented': same('not implemented yet', 'The capability is planned and has not been built, so no check relies on it.'),
  'sentinel.capability.noQualifiedEngine': same('no engine qualified', 'No evaluated engine followed a flow across files in the feasibility trials, so no deep analysis is promised.'),

  'sentinel.contract.unknownKind': same('not a Sentinel record kind', 'The requested kind is not one of the published record kinds.'),
  'sentinel.contract.tooLarge': same('record too large', 'The serialized record is larger than the accepted limit and was refused before parsing.'),
  'sentinel.contract.malformedJson': same('not valid JSON', 'The input could not be decoded as JSON.'),
  'sentinel.contract.missingVersion': same('version missing', 'The record has no version string, and a version is never assumed.'),
  'sentinel.contract.wrongKind': same('a different kind of record', 'The version names another record kind than the one requested.'),
  'sentinel.contract.unsupportedVersion': same('version not supported', 'The record is of a known kind at a version this build does not read. It is refused rather than converted.'),
  'sentinel.contract.invalid': same('does not match its schema', 'A field is missing, unknown, of the wrong type or outside its bounds.'),
  'sentinel.contract.invariant': same('breaks a record rule', 'The fields are well formed, but together they contradict a rule, such as complete coverage that skipped part of its scope.'),
  'sentinel.contract.errorLimit': same('too many errors to list', 'Validation stopped collecting errors at its limit, so a very broken record cannot use unbounded memory. Fix the listed errors and validate again.'),
  'sentinel.protocol.noSharedVersion': same('no shared protocol version', 'The worker and the coordinator speak no common protocol version, so the coordinator refuses rather than guessing.'),
};

export function sentinelWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_CLI_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
