import type { StringEntry } from './strings.js';

// Sentinel's model review (PR 22): why a model's tool request or reply was refused, why part of a review's scope was
// left unfinished, what a model claim is, and what the E5/E8 harness still needs. Each key is the stable code a
// refusal, a frontier, an observation or a gate report carries. Both registers carry the same words until the PR 09
// vocabulary freeze, as in strings-sentinel-parser.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_REVIEW_STRINGS: Record<string, StringEntry> = {
  'sentinel.review.planLimit': same('review plan exceeds its segment cap: {detail}', 'At most 32 configured review segments may be planned at once. Narrow the captured source or configure explicit segments within that cap instead of silently omitting segments. General review can also exceed the cap. This refusal starts no model call.'),
  'sentinel.review.secretCoverageRequired': same('a complete accepted secret scan is required before hosted review', 'Unless the adopted hostedReviewSecretScan policy is when-selected and no secret scanner rule is selected, the exact current source needs one genuine successful Gitleaks repository scan covering every captured entry, with complete coverage and no skipped or unresolved scope before any hosted model admission, credential read or call. Partial or per-file publications cannot be combined to satisfy this gate. No matches is not proof that a scan ran.'),
  'sentinel.review.outputSchema': same('a native stage answer does not match its output schema: {detail}', 'A native agent stage ends with one JSON answer that must match the output schema the stage declares, cite only its own inputs, and claim inspection only of files its read tools opened, as its retained transcript shows. An answer that fails is a failed attempt: nothing it said is published, and its usage still counts against the budget.'),
  'sentinel.review.nativeBudget': same('a native stage states its turns, tokens and seconds', 'A native agent stage runs the CLI\'s own loop only within a budget the stage itself declares: model turns, tokens in and out together, and seconds. A stage without all three is refused before anything is admitted or sent; there is no built-in default.'),
  'sentinel.review.packInvalid': same('a stage pack is not valid: {detail}', 'A stage pack is a folder whose manifest names its kind (stage or skill), its id, its revision and every file it holds with that file\'s digest. A skill pack also holds the skill\'s own instructions file. The files are small UTF-8 text the model reads; nothing in a pack runs.'),
  'sentinel.review.packChanged': same('a stage pack byte changed: {detail}', 'A promoted stage pack is re-read from the trust folder before every use and checked file by file against its manifest, and the manifest against the digest recorded when it was promoted. A changed, added or missing byte refuses the stage before any model is asked; promote a new revision instead of editing one.'),
  'sentinel.review.packUnapproved': same('a stage pack is not promoted: {detail}', 'A stage may only use prompts, instructions and skills the owner promoted, with confirmation, into the trust folder. A reference to a pack that was never promoted refuses the stage before any model is asked.'),
  'sentinel.review.instructionsUnsealed': same('a stage with promoted packs needs its instruction record sealed first', 'Before a stage that uses promoted instructions or skills is sent anywhere, its exact instruction record (every byte and digest it will send) must be retained in the owner\'s private record. A run without that seal is refused before any reservation or launch.'),
  'sentinel.review.foregroundRequired': same('configured model review requires foreground owner confirmation', 'Use run PLAN --confirm --confirm-models in the local owner CLI. Detached service, MCP and resume cannot authorize this model workflow. They refuse before consuming a run-start receipt or starting work.'),
  // ---- tool refusals ----
  'sentinel.review.tool.outOfScope': same('outside this review\'s scope', 'The model asked for a file, rule or node this review was not given. Its scope is fixed before it starts, and nothing in the code under review can widen it.'),
  'sentinel.review.tool.unknown': same('not a tool of this review', 'The model asked for something the review offers no tool for. It can list its files, read lines of them, read its rule and read recorded call paths; nothing else.'),
  'sentinel.review.tool.budget': same('over the review\'s evidence budget', 'The model asked for more than one read may return, or more tool calls or evidence than the review allows in total.'),
  'sentinel.review.tool.withheld': same('withheld from disclosure', 'This part of a file is marked as one that must not be sent to a model, for example where a secret was found. It was not sent, and the review says so.'),
  'sentinel.review.tool.invalidArgs': same('the request\'s arguments are not valid', 'The model asked to read lines that are not a valid range, or more lines than one read allows.'),
  // ---- reply rejections ----
  'sentinel.review.reply.notJson': same('the reply is not one JSON object', 'A reply must be exactly one JSON object of the review\'s grammar. Anything else is rejected and the model is told why, within a small limit.'),
  'sentinel.review.reply.shape': same('the reply is not in the review\'s grammar', 'The reply named an action, a field or a value the grammar does not have. Requests to approve, suppress, promote, add a tool or a target, or send anything elsewhere are not part of it.'),
  'sentinel.review.reply.unknownCitation': same('the reply cites evidence it was never given', 'Every claim must cite evidence ids this review served. An invented or remembered id is rejected.'),
  'sentinel.review.reply.citationChanged': same('the cited evidence no longer matches the captured bytes', 'A citation is re-checked against the snapshot\'s bytes before it is accepted. One that no longer matches is rejected.'),
  'sentinel.review.reply.missingCitation': same('a claim cites no evidence', 'A claim without a citation, or a finding without a cited claim, is rejected.'),
  'sentinel.review.reply.inspectedUnread': same('the reply says it inspected files it never read', 'What a review inspected is taken from what it was served, never from what the model says. A reply that claims more is rejected.'),
  'sentinel.review.reply.truncated': same('the reply stopped at its output allowance', 'An answer the provider cut off is incomplete, so it is neither a tool request nor a conclusion. It counts as a rejected reply.'),
  // ---- frontiers ----
  'sentinel.review.frontier.budget': same('stopped at the review\'s budget', 'The review used all the input, tokens or money it was allowed. What it had not finished stays unfinished; nothing is assumed about it.'),
  'sentinel.review.frontier.steps': same('stopped at the review\'s limit on model calls', 'The review made as many model calls as it may. Its scope is unfinished.'),
  'sentinel.review.frontier.deadline': same('stopped at the review\'s deadline', 'The review ran out of time. Its scope is unfinished.'),
  'sentinel.review.frontier.invalidReplies': same('stopped after too many rejected replies', 'The model kept replying outside the grammar or with invalid citations. Its scope is unfinished.'),
  'sentinel.review.frontier.modelError': same('stopped because the model call failed', 'The provider could not be reached or refused the call before it was sent. Its scope is unfinished.'),
  'sentinel.review.frontier.copilotLogin': {
    hud: 'the Copilot CLI cannot use a login — start `copilot` and run `/login`',
    professional: 'Copilot needs a login — open Copilot and use /login',
    define: 'The pinned Copilot CLI could not use a login in this run. No token, account name or native error text is recorded here. Sign in with the CLI, then start a new run; this review did not finish.',
  },
  'sentinel.report.review.unfinished': same('a model review did not finish; read its reason above', 'A model review is unfinished. Its reason is recorded in Model observations.'),
  'sentinel.review.frontier.uncertainUsage': same('stopped after a call whose usage is unknown', 'A call may have been charged without its answer arriving. It is not sent again; the review stops and its scope is unfinished.'),
  'sentinel.review.frontier.notCaptured': same('not captured, so not reviewed', 'The file was recorded without its bytes, so no model could read it.'),
  'sentinel.review.frontier.tooLarge': same('too large for one review partition', 'The file is larger than a partition may hold, so it was not given to a model.'),
  'sentinel.review.frontier.withheld': same('part of the scope was withheld from the model', 'The model asked for a span that must not be disclosed. It was not sent, so that part was not reviewed.'),
  'sentinel.review.frontier.unsupportedLanguage': same('a language the review does not read', 'Only TypeScript, JavaScript and Java source is partitioned for review.'),
  'sentinel.review.frontier.unknownScope': same('a folder whose contents were not listed', 'Capture did not list this folder, so what it holds was not reviewed and is unknown, not clean.'),
  'sentinel.review.frontier.notInspected': same('in scope, but never read', 'The review was given this file and did not read it. It is not counted as reviewed, whatever the model concluded.'),
  'sentinel.review.frontier.canceled': same('the review was canceled', 'The review was stopped on request. Its scope is unfinished.'),
  'sentinel.review.frontier.fenced': same('handed to a newer coordinator', 'Recovery fenced the coordinator that was running this review. It stops without writing; the newer coordinator resumes from the last checkpoint.'),
  // ---- limitations ----
  'sentinel.review.limitation.modelClaim': same('a model\'s claim, not a checked result', 'A model read the cited code and made this claim. The citations are real bytes of the snapshot, but whether the claim is right is for a person to decide. It is never coverage of a check.'),
  // ---- errors ----
  'sentinel.review.invalidInput': same('the review request is not valid: {detail}', 'A review names its run, its fixed scope, its limits and its budget. One that is incomplete or out of bounds is refused before any model is called.'),
  'sentinel.review.integrity': same('the review read bytes that are not what was captured: {detail}', 'Every file a review reads is checked against its captured content id. A mismatch stops the review.'),
  'sentinel.review.checkpoint': same('the review checkpoint cannot be used: {detail}', 'A review resumes only from its own checkpoint for the same scope, prompt, budget and tools, with its evidence still matching the snapshot.'),
  // ---- E5 / E8 ----
  'sentinel.review.eval.mockOnly': same('only mock models were evaluated', 'The evaluation ran against mock replies. It exercises the harness and proves nothing about a real model.'),
  'sentinel.review.eval.modelsMissing': same('fewer than two configured models', 'The model accuracy gate compares two configured models. Until the owner configures them, it cannot be met.'),
  'sentinel.review.eval.casesMissing': same('fewer than 30 labeled cases or five trials', 'The gate needs 30 labeled cases, each run five times per model, clean and with hostile text added.'),
  'sentinel.review.eval.labelsUnreviewed': same('the labels have not been reviewed', 'A person other than the author must review the expected answers before any precision or recall is claimed.'),
  'sentinel.review.eval.thresholdsMissing': same('no thresholds are set', 'The owner sets the precision, recall, hostile-text and unfinished-run thresholds before the gate can be judged.'),
  'sentinel.review.eval.incomplete': same('not every evaluation ran', 'Some planned evaluations have no result, so the gate cannot be judged.'),
  'sentinel.review.eval.estimate': same('an estimate, not observed usage', 'These numbers are upper bounds computed before any call. What a provider actually used is in the review records and the budget ledger.'),
};

export function sentinelReviewWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_REVIEW_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
