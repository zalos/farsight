import type { StringEntry } from './strings.js';

// The words of Sentinel's read model for the viewer (Sentinel v2 §4, lane L-UX): the SCANS · PIPELINE · STAGE stops
// and the answers Sentinel's loopback host serves them (packages/sentinel/src/transport/http/). Spread into STRINGS
// in strings.ts. Every count is a Counted with one of the sentinel.viewer.scope.* scopes (docs/COUNTS.md § Sentinel
// read model). The business register says scan, stage, task, checked by and cost (*step* stays the storyline's word); it never prints a hash or an id.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });
const one = (text: string, pluralKey: string): StringEntry => ({ hud: text, professional: text, singularOf: pluralKey });

export const SENTINEL_VIEWER_STRINGS: Record<string, StringEntry> = {
  // ── what a number counts over ─────────────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.scope.scans': same('of the scans listed', 'What the number beside it counts over: the scans this workspace keeps, newest first, as many as the list shows.'),
  'sentinel.viewer.scope.scan': same('in this scan', 'What the number beside it counts over: one scan, every stage its plan admitted and the work it recorded, as of this read.'),
  'sentinel.viewer.scope.stage': same('in this stage', 'What the number beside it counts over: one stage of one scan, every task it planned and every try of each task.'),
  'sentinel.viewer.scope.task': same('in this task', 'What the number beside it counts over: one task of one stage, every try it made.'),
  'sentinel.viewer.scope.turn': same('in this exchange', 'What the number beside it counts over: one request to the model and its reply.'),

  // ── counts ────────────────────────────────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.count.scans': same('{n} scans', 'Scans this workspace keeps, each one capture of the source and the stages that ran over it.'),
  'sentinel.viewer.count.scansOne': one('1 scan', 'sentinel.viewer.count.scans'),
  'sentinel.viewer.count.stages': same('{n} stages', 'Stages of a scan: capture, parse, list, each tool that checks the code and each review by a model.'),
  'sentinel.viewer.count.stagesOne': one('1 stage', 'sentinel.viewer.count.stages'),
  'sentinel.viewer.count.agentic': same('{n} agentic', 'Stages a model ran. Their observations are claims with citations and never change what the tools found or the coverage.'),
  'sentinel.viewer.count.checkedByModel': same('{n} checked by a model', 'Stages a model ran. What a model says is a claim it must cite, never a finding on its own.'),
  'sentinel.viewer.count.units': same('{n} work units', 'Planned units of work: each runs one stage over one part of the source and keeps its own inputs, tries and outputs.'),
  'sentinel.viewer.count.unitsOne': one('1 work unit', 'sentinel.viewer.count.units'),
  'sentinel.viewer.count.tasks': same('{n} tasks', 'The pieces a stage was split into, each over one part of the source.'),
  'sentinel.viewer.count.tasksOne': one('1 task', 'sentinel.viewer.count.tasks'),
  'sentinel.viewer.count.attempts': same('{n} attempts', 'Recorded tries of the work units. A retry after an interruption is a second attempt; only one attempt per unit is accepted.'),
  'sentinel.viewer.count.attemptsOne': one('1 attempt', 'sentinel.viewer.count.attempts'),
  'sentinel.viewer.count.tries': same('{n} tries', 'How many times the tasks ran. A task that was interrupted and run again counts twice.'),
  'sentinel.viewer.count.triesOne': one('1 try', 'sentinel.viewer.count.tries'),
  'sentinel.viewer.count.inputs': same('{n} captured files read', 'Captured files the work units were given to read, each file once per unit that read it.'),
  'sentinel.viewer.count.inputsOne': one('1 captured file read', 'sentinel.viewer.count.inputs'),
  'sentinel.viewer.count.tokensIn': same('{n} tokens in', 'Tokens sent to the model, as the provider reported them. A provider that reports none leaves this unrecorded, never zero.'),
  'sentinel.viewer.count.tokensOut': same('{n} tokens out', 'Tokens the model sent back, as the provider reported them.'),
  'sentinel.viewer.count.turns': same('{n} turns', 'Requests Sentinel sent the model and the replies it read back, one turn each.'),
  'sentinel.viewer.count.turnsOne': one('1 turn', 'sentinel.viewer.count.turns'),
  'sentinel.viewer.count.exchanges': same('{n} exchanges with the model', 'Times the model was asked something and answered.'),
  'sentinel.viewer.count.exchangesOne': one('1 exchange with the model', 'sentinel.viewer.count.exchanges'),
  'sentinel.viewer.count.modelObservations': same('{n} model observations', 'Claims a model made with citations into the code it was shown. An observation never changes a tool finding or the coverage.'),
  'sentinel.viewer.count.modelObservationsOne': one('1 model observation', 'sentinel.viewer.count.modelObservations'),
  'sentinel.viewer.count.modelNotes': same('{n} notes from a model', 'Points a model raised and backed with a quote from the code. A note is never a finding on its own.'),
  'sentinel.viewer.count.modelNotesOne': one('1 note from a model', 'sentinel.viewer.count.modelNotes'),
  'sentinel.viewer.count.requiredCovered': same('{n} of {m} required checks covered', 'Required checks that ran to the end over their whole scope, out of every check the policy requires.'),
  'sentinel.viewer.count.citations': same('{n} citations', 'Places in the captured code a model observation points to.'),
  'sentinel.viewer.count.citationsOne': one('1 citation', 'sentinel.viewer.count.citations'),
  'sentinel.viewer.count.part.done': same('{n} done', 'Finished and accepted.'),
  'sentinel.viewer.count.part.running': same('{n} running', 'Running now, as the record says.'),
  'sentinel.viewer.count.part.waiting': same('{n} waiting', 'Planned and not started yet.'),
  'sentinel.viewer.count.part.failed': same('{n} failed', 'Ended without an accepted result.'),
  'sentinel.viewer.count.part.held': same('{n} held', 'Held back by a missing prerequisite or by policy, with the reason recorded.'),
  'sentinel.viewer.count.part.reused': same('{n} reused', 'Taken as it was from an earlier scan of the same captured source, not run again.'),
  'sentinel.viewer.count.part.notRun': same('{n} not run', 'Planned, but the scan ended before it started.'),

  // ── stages, by what they do (a stage is the work unit's contract until the declared pipeline lands) ──────────
  'sentinel.viewer.stage.capture': same('Capture the source', 'Copies the files of the source into the store, so every later stage reads the same bytes and the scan survives the source changing.'),
  'sentinel.viewer.stage.parse': same('Parse the code', 'Reads the captured code into Farsight\'s graph: its routes, screens, functions and how they call each other.'),
  'sentinel.viewer.stage.inventory': same('List what was captured', 'Records every captured file and every folder that was skipped, so a check that missed something can be seen.'),
  'sentinel.viewer.stage.preview': same('Preview pattern check', 'Sentinel\'s own small pattern check, run in a child process. A preview never counts as required coverage.'),
  'sentinel.viewer.stage.secrets': same('Secrets', 'Looks for credentials and keys written into the source, with a pinned scanner in a container.'),
  'sentinel.viewer.stage.dependencies': same('Dependencies', 'Looks up the declared packages in a pinned copy of the public advisory database.'),
  'sentinel.viewer.stage.patterns': same('Patterns', 'Matches known weakness patterns in the code with a pinned scanner and pinned rules.'),
  'sentinel.viewer.stage.infrastructure': same('Infrastructure as code', 'Checks container and infrastructure files with a pinned scanner.'),
  'sentinel.viewer.stage.workflows': same('CI workflows', 'Checks the build workflows with a pinned scanner.'),
  'sentinel.viewer.stage.controls': same('Framework controls', 'Reads how the framework guards each route, from the captured source only.'),
  'sentinel.viewer.stage.paths': same('Call paths', 'Follows recorded calls from an entry point inward, as far as the graph shows.'),
  'sentinel.viewer.stage.otherCheck': same('Other checks', 'Checks by a tool this view has no name for. The code register shows which.'),
  'sentinel.viewer.stage.reviewGeneral': same('Review the code', 'A model reads fixed parts of the code and reports what the code it cites shows.'),
  'sentinel.viewer.stage.reviewGuided': same('Review what the checks found', 'A model reads the code one rule at a time, starting from what the checks planned, and reports what it cites.'),
  'sentinel.viewer.stage.other': same('Other stage', 'A stage this view has no name for. The code register shows which.'),

  // ── what kind of stage, and where it ran ────────────────────────────────────────────────────────────────────
  'sentinel.viewer.kind.builtin': same('built in', 'Sentinel\'s own code, at the version that is pinned by digest in the plan.'),
  'sentinel.viewer.kind.tool': same('tool', 'A scanner in a pinned container image. It is never pulled during a scan and never falls back to the host.'),
  'sentinel.viewer.kind.script': same('script', 'A script the owner promoted, run on this computer or in a pinned container.'),
  'sentinel.viewer.kind.agent': same('agent', 'A model, asked through a provider. What it says is a cited claim, never coverage.'),
  'sentinel.viewer.where.inProcess': same('in Sentinel\'s own process', 'Ran inside the owner service, with no separate process to find.'),
  'sentinel.viewer.where.child': same('a child process on this computer', 'Ran as a separate process Sentinel started and watched, with this computer\'s Node and no inherited environment.'),
  'sentinel.viewer.where.container': same('a pinned container', 'Ran in a container from an image pinned by digest, with no network.'),
  'sentinel.viewer.where.external': same('an outside client', 'Ran in a client that held a claim on the work. Its identity is what the client reported.'),
  'sentinel.viewer.where.notYet': same('not run yet', 'No try of this stage has started, so where it runs is not recorded yet.'),
  'sentinel.viewer.where.provider': same('through a model provider', 'The model ran at the provider the settings name; Sentinel ran the conversation and kept every request.'),

  // ── a stage's and a scan's state ────────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.status.done': same('done', 'Finished, and its result was accepted into the store.'),
  'sentinel.viewer.status.running': same('running', 'Running now, as the record says. A record cannot prove a process is still alive.'),
  'sentinel.viewer.status.waiting': same('waiting', 'Planned and waiting for what it needs.'),
  'sentinel.viewer.status.failed': same('failed', 'Ended without an accepted result. Its tries and their errors are kept.'),
  'sentinel.viewer.status.held': same('held', 'Held back by a missing prerequisite or by policy; the reason is recorded.'),
  'sentinel.viewer.status.reused': same('reused', 'Taken as it was from an earlier scan of the same captured source.'),
  'sentinel.viewer.status.notRun': same('not run', 'Planned, but the scan ended before it started.'),
  'sentinel.viewer.scanState.planned': same('planned', 'Admitted and waiting to start.'),
  'sentinel.viewer.scanState.running': same('running', 'Running, as the record says.'),
  'sentinel.viewer.scanState.pausing': same('pausing', 'Asked to pause; the running task finishes first.'),
  'sentinel.viewer.scanState.paused': same('paused', 'Paused by its owner; it can be resumed.'),
  'sentinel.viewer.scanState.canceling': same('canceling', 'Asked to stop; the running task is being stopped.'),
  'sentinel.viewer.scanState.canceled': same('canceled', 'Stopped by its owner before it finished.'),
  'sentinel.viewer.scanState.completed': same('finished', 'Ran to its end. Read the coverage and the findings: finishing is not the same as passing.'),
  'sentinel.viewer.selection.held': same('not selected for this rerun', 'A rerun runs only the stages it selected and what depends on them. This task was not run again; nothing the earlier scan found is copied into this one.'),
  'sentinel.viewer.scanState.awaiting': same('waiting for its first run', 'A rerun admitted and not started yet.'),

  // ── the policy word on a scan ───────────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.policy.notEvaluated': same('policy · not evaluated', 'Coverage is complete, but this build does not yet judge the findings against the owner\'s policy.'),
  'sentinel.viewer.policy.preview': same('preview · not coverage', 'Only the preview check ran. A preview never satisfies required coverage.'),
  'sentinel.viewer.policy.incomplete': same('coverage incomplete', 'At least one required check did not run to the end over its whole scope.'),
  'sentinel.viewer.policy.failed': same('failed', 'A planned check could not run to the end, so this is not a scan result.'),
  'sentinel.viewer.policy.inProgress': same('in progress', 'The scan has not finished, so nothing is judged yet.'),
  'sentinel.viewer.policy.stopped': same('stopped', 'The scan was stopped before it finished, so nothing is judged.'),

  // ── what a stage read and produced ──────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.io.snapshot': same('the captured source', 'The files the capture copied, pinned by the digest of their bytes.'),
  'sentinel.viewer.io.parsed': same('the parsed code', 'Farsight\'s graph of the captured code: routes, screens, functions and calls.'),
  'sentinel.viewer.io.inventory': same('the inventory', 'The list of captured files and skipped folders.'),
  'sentinel.viewer.io.capturedFiles': same('captured files', 'Files from the capture this stage was given to read.'),
  'sentinel.viewer.io.findings': same('findings', 'What the checks found, kept as the tool reported it and grouped in the report.'),
  'sentinel.viewer.io.coverage': same('coverage', 'Which rules ran over which files, to the end or not.'),
  'sentinel.viewer.io.toolResult': same('the tool\'s raw result', 'What the tool wrote out, kept byte for byte.'),
  'sentinel.viewer.io.observations': same('observations', 'Claims with citations: what a tool or a model reported before grouping.'),
  'sentinel.viewer.io.reviewRecord': same('the review record', 'What the model was served, what it asked for and how it ended, kept for inspection.'),
  'sentinel.viewer.io.requests': same('the requests', 'Every request Sentinel sent the model, kept exactly.'),
  'sentinel.viewer.io.instructions': same('the instructions', 'The prompt and skills the model was given, pinned by digest.'),
  'sentinel.viewer.io.prompt': same('the prompt text', 'The words the model was told before it saw any code.'),
  'sentinel.viewer.io.controls': same('control answers', 'How the framework guards each route, read from the source.'),
  'sentinel.viewer.io.inspection': same('the inspection', 'What a framework library read and could not read.'),
  'sentinel.viewer.io.other': same('other output', 'Output this view has no name for. It is kept in the store with its digest.'),

  // ── a model's turn, and the reply it gave ──────────────────────────────────────────────────────────────────
  'sentinel.viewer.turn.task': same('the task', 'What Sentinel asked the model to do and the files in its scope.'),
  'sentinel.viewer.turn.toolResult': same('what Sentinel served', 'The answer to the model\'s last request: lines of a file, a rule, or a list.'),
  'sentinel.viewer.turn.list': same('asked for the file list', 'The model asked which files are in its scope.'),
  'sentinel.viewer.turn.read': same('asked to read lines', 'The model asked for lines of one file in its scope.'),
  'sentinel.viewer.turn.rule': same('asked for a rule', 'The model asked for the definition of one rule in its task.'),
  'sentinel.viewer.turn.paths': same('asked for call paths', 'The model asked which calls the graph records from one node.'),
  'sentinel.viewer.turn.final': same('answered', 'The model gave its verdict and its cited claims.'),
  'sentinel.viewer.turn.unreadable': same('a reply Sentinel could not read', 'The reply was not one of the shapes the model was allowed to send, so it was refused and kept.'),

  // ── money ───────────────────────────────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.cost.none': same('no model cost', 'No stage here asked a model, so there is nothing to price.'),
  'sentinel.viewer.cost.unobserved': same('cost unobserved', 'A model ran, but its provider reported no price (a subscription, or a provider with no rates). Never read this as zero.'),
  'sentinel.viewer.cost.recorded': same('at the recorded rates', 'Priced from the token counts at the rates the owner recorded for the model. A price, not a bill.'),
  'sentinel.viewer.cost.mixed': same('in several currencies', 'The tries were priced in more than one currency, so they are not added up.'),

  // ── absent, and why ─────────────────────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.absent.notRecorded': same('not recorded', 'The store does not record this yet. It is shown as absent, never as zero.'),
  'sentinel.viewer.absent.pipelineUndeclared': same('no declared pipeline yet', 'This scan\'s stages were derived from the promoted rules. A declared pipeline with its own revision arrives with the pipeline file.'),
  'sentinel.viewer.absent.notFinished': same('counted when the scan finishes', 'The report that counts findings is made from a finished scan only.'),
  'sentinel.viewer.absent.reportUnavailable': same('the report could not be made', 'The report fold refused this scan, so its findings are not counted here. The CLI\'s report command says why.'),
  'sentinel.viewer.absent.notCounted': same('not counted yet', 'Counting this scan took longer than this read allows. Open the scan, or read the list again.'),
  'sentinel.viewer.absent.withheld': same('withheld', 'A secret was found in this scan, so file names, model text and prompts are not shown anywhere for it.'),
  'sentinel.viewer.absent.noReview': same('no review in this scan', 'No stage of this scan asked a model.'),
  'sentinel.viewer.absent.reviewUnreadable': same('the review record could not be read', 'The retained review could not be verified, so nothing from it is shown.'),

  // ── the read model's own refusals ───────────────────────────────────────────────────────────────────────────
  'sentinel.viewer.readOnly': same('The scan view only reads.', 'This address answers reads of retained scans and refuses every write. Starting or changing a scan is confirmed in the owner panel.'),
  'sentinel.viewer.scanUnknown': same('There is no such scan.', 'No retained scan has that number in this workspace\'s list.'),
  'sentinel.viewer.stageUnknown': same('There is no such stage in this scan.', 'The scan\'s plan has no stage by that name.'),
  'sentinel.viewer.notPaired': same('The scan view needs the owner panel\'s pairing.', 'Reads of retained scans use the read pass the paired owner panel gives this page. Reconnect to pair again.'),
};
