import type { StringEntry } from './strings.js';

// Sentinel's placeholder executable, capability reasons and contract error codes (PR 02). Command-line output
// prints the professional register; both registers carry the same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_CLI_STRINGS: Record<string, StringEntry> = {
  'sentinel.evidence.usage': same('farsight-sentinel evidence import <run> --source <id> --report <file> --manifest <file> [--confirm] [--expect-candidate <digest>]\n  farsight-sentinel evidence read <candidate> [--baseline <run>] [--format json|md] [--out <new-file>]\n  farsight-sentinel evidence list <run> --source <id> [--after <cursor>] [--limit <n>]\n  farsight-sentinel evidence abandon <old-operation> [--confirm]    all accept --workspace and --json', 'Import preview/confirm needs --source, --report and --manifest; read accepts an accepted candidate digest; list needs a run and --source; abandon names one old pending operation. Import and list require a completed run. Reads can retain canceled accepted data but withhold it. These owner-only commands refuse while another owner holds the store. No shareable projection is available.'),
  'sentinel.evidence.importedClaims': same('Imported claims; owner-local, not guaranteed safe to share; no control or coverage conclusion', 'The owner associated an external report with retained source. The report producer and what its text claims remain unverified; imports do not establish a control, a finding or mitigation. Clean normalized imports can contain private report data and are not guaranteed safe to share.'),
  'sentinel.evidence.ownerBusy': same('The store is held by another owner; retry after natural release', 'Nothing imported or confirmed. A detached service can retain read buffers beyond its ordinary idle interval; do not poll it to wait, force it to stop, or infer owner authority from a connection.'),
  'sentinel.evidence.inputRefused': same('The import input or option was refused', 'Only supported bounded report and manifest formats and the declared flags are read. The refusal does not repeat private paths, member names or report text.'),
  'sentinel.evidence.denied': same('The adopted policy does not allow this owner action', 'The owner must explicitly adopt a grant for importing reports or releasing old pending pins. Confirmation does not widen grants.'),
  'sentinel.evidence.confirmationStale': same('The candidate changed; review a fresh preview', 'The expected digest no longer matches the freshly prepared candidate. No receipt is spent for a different report.'),
  'sentinel.evidence.sourceUnavailable': same('The retained source or accepted evidence could not be verified', 'No imported claims are returned when their exact retained source, authority, closure or privacy assessment is unavailable.'),
  'sentinel.evidence.storageRefused': same('The owner store could not be opened safely', 'No owner capability was obtained. Missing or invalid workspace, trust or storage records are not replaced or inferred from a report.'),
  'sentinel.evidence.spentNotPublished': same('Confirmation was spent; no acceptance was published', 'A new confirmation is required for another attempt. An old pending operation can be explicitly abandoned; object bytes are not deleted.'),
  'sentinel.evidence.acceptedReadbackUnverified': same('Acceptance was recorded but could not be verified for delivery', 'The stored acceptance may be recovered through a later read. Its claims are not delivered until retained authority and privacy validate; no new confirmation is automatically spent.'),
  'sentinel.evidence.publicationUncertain': same('The import publication state could not be established', 'The owner lost a reliable readback. Read the candidate again before deciding whether a fresh confirmation is needed; permission is never rebuilt from receipt JSON.'),
  'sentinel.evidence.spentNotApplied': same('Confirmation was spent; pending pins were not released', 'The abandon transaction did not apply. A new owner confirmation is required for another release attempt.'),
  'sentinel.evidence.applicationUncertain': same('The pending-pin release state could not be established', 'No physical object deletion or producer cleanup was requested. Inspect the exact old operation before another explicit confirmation.'),
  'sentinel.evidence.outputTooLarge': same('Output exceeds the delivery limit; acceptance state is retained', 'The complete requested output exceeded its fixed limit and was not delivered. A recorded acceptance is not rolled back and can be read again with supported output choices.'),
  'sentinel.evidence.deliveryRefused': same('Delivery was refused; the acknowledgement retains the publication state', 'Rendering, output bounds or a no-overwrite file write failed. A committed acceptance is not rolled back; its fixed acknowledgement remains available.'),
  'sentinel.evidence.countScope': same('this imported report', 'Counts concern the accepted external report only, never checks completed, findings verified or application coverage.'),
  'sentinel.evidence.pageScope': same('this returned import page', 'Counts include only metadata rows returned on this page, never total history or verified payload availability. Pages follow stable operation identifiers, not chronological order.'),
  'sentinel.evidence.candidate': same('candidate {candidate}', 'The exact digest to compare with --expect-candidate after reviewing this import preview. The digest is not permission.'),
  'sentinel.capability.draftImports': same('draft owner report imports', 'The owner can preview, confirm, retain and read imported claims and explicitly release old pending pins through a local-only command. Another live owner yields busy; imports establish no controls, findings, mitigation or coverage.'),
  'sentinel.evidence.claims': same('{n} imported claims', 'Statements retained from the external report. They are not verified findings or controls.'),
  'sentinel.evidence.exchanges': same('{n} reported exchanges', 'Request and response records stated by the imported report, not proof that requests were executed.'),
  'sentinel.evidence.cookies': same('{n} reported cookie facts', 'Cookie facts parsed from the reported messages, not proof of deployment or protection.'),
  'sentinel.evidence.operations': same('{n} import operations on this page', 'Metadata rows returned by this bounded page. Payload availability is not evaluated by listing.'),
  'sentinel.cli.title': same('farsight-sentinel: optional security-analysis companion to Farsight (draft)', 'Sentinel is installed separately from Farsight and records immutable captured inputs, accepted scanner observations and explicit coverage.'),
  'sentinel.cli.scope': same('Initialize, adopt settings, promote rules, plan, run pinned scanners and regenerate reports. Scans never acquire assets or use a host scanner. External engines need explicitly adopted pinned local images and offline assets; Framework inspections and bounded structural path tasks use fixed supervised workers; configured review stages require separate foreground model confirmation.', 'The static preset retains the original foundation preview. The scanners preset selects the five shipped scanner rule packs; the secrets preset selects only current-tree secret scanning. Assets are separate explicit owner actions, and a completed run never means policy satisfaction in this command slice.'),
  'sentinel.cli.usagePaths': same('farsight-sentinel paths <ancestorRunId> --request <canonical-request.json> [--workspace <folder>] [--confirm] [--json]', 'Prepares and discloses one immutable linked structural call query plan from an ended run. Its request is source-derived data; starting the prepared run needs a separate run.start admission.'),
  'sentinel.cli.pathsPrepared': same('structural plan {run} · request {request} · run requires separate approval', 'The exact retained request and admitted plan identify this prepared structural task. Preparation starts no worker, and query completion never establishes data flow or security clearance.'),
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
  'sentinel.capability.draftSpring': same('draft Spring pack, source only', 'A library can read the Spring Security servlet chains, rules and method security of captured Java source for exactly Spring Boot 3.4.3 with Spring Security 6.4.3, and say for each route which control applies, or why that is unknown. It builds and runs nothing, claims nothing for other versions or WebFlux, and no scan runs it yet.'),
  'sentinel.capability.draftPolicy': same('draft policy library only', 'A library can validate and lock rule packs, adopt trusted settings, issue owner receipts and decide admission. No plan or scan uses it yet.'),
  'sentinel.capability.draftPlanning': same('draft deterministic planner only', 'A library can plan checks from a pinned rule lock, policy and parsed snapshot and hand canonical work to a coordinator. The public command layer separately admits execution through exact trusted drivers and owner-adopted assets.'),
  'sentinel.capability.draftPaths': same('bounded structural call queries', 'The owner can prepare an exact retained-source request, separately confirm its fixed worker run, and read its reported paths or frontiers with captured call sites. A call path never establishes data flow, protection or required security coverage.'),
  'sentinel.capability.draftDeepImport': same('draft import of attested deep-analysis results only', 'A library can import results from a deep analyzer the customer ran, when the owner trusts the attestation and its licence terms and the results bind to the captured source. No deep engine is included or run.'),


  'sentinel.capability.draftReports': same('draft report library only', 'A library can group observations into findings, compare two complete assessments, place findings on screens and journeys through a proven application context, and write the report as JSON, Markdown, offline HTML and SARIF. The command line builds it from a completed scanner run\'s accepted evidence (report --full, compare); dispositions and a finding policy verdict are not part of it yet.'),
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
