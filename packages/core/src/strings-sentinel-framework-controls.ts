import type { StringEntry } from './strings.js';

// Sentinel's framework control inspection (ADR 44): why an inspection check about a route or page did not complete,
// and the words of its rules. These are inspection facts, never an assessment: no key here names a finding. Both
// registers carry the same words until the PR 09 vocabulary freeze, as in strings-sentinel-capture.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_FRAMEWORK_CONTROLS_STRINGS: Record<string, StringEntry> = {
  // ---- the rules ----
  'sentinel.controls.rule.authentication': same('whether an authentication control applies to this surface', 'The framework libraries inspect, within the exact versions and shapes they model, whether a layer that establishes who the caller is runs before this route or page. The answer is a fact about the framework configuration, not a finding.'),
  'sentinel.controls.rule.authorization': same('whether an authorization control applies to this surface', 'The framework libraries inspect, within the exact versions and shapes they model, whether a layer that checks what the caller may do runs before this route or page. The answer is a fact about the framework configuration, not a finding.'),
  'sentinel.controls.rule.inputValidation': same('whether input validation applies to this surface', 'The framework libraries inspect, within the exact versions and shapes they model, whether the request input of this route or page is validated before its handler runs. The answer is a fact about the framework configuration, not a finding.'),
  'sentinel.controls.limitation.inspectionOnly': same('an inspection, not an assessment', 'A control that applies, or one that does not, is a fact about how the framework is configured. Neither is reported as a problem: a public route or one with no input to validate can be correct. Judging these facts against a policy is separate work.'),
  // ---- why a check did not complete ----
  'sentinel.controls.unclaimed': same('no framework library recognised this surface', 'None of the four libraries found this route or page in a framework and version it models, so nothing was inspected for it.'),
  'sentinel.controls.propertyNotModeled': same('the library that recognised this surface does not model this control', 'The library found the surface but gives no fact for this property, so it was not inspected.'),
  'sentinel.controls.conflict': same('the libraries that recognised this surface disagree', 'More than one library claims this surface and their answers differ, so no single answer is given.'),
  'sentinel.controls.analysisUnavailable': same('the parser evidence for this source is not available', 'The inspection reads the retained parser evidence of the captured source. It was not available for this run, so nothing was inspected.'),
  'sentinel.controls.libraryRefused': same('a framework library could not read this source', 'One of the libraries refused its inputs, so a surface it would have recognised may be missing an answer. What the other libraries established is kept, but not as the whole answer.'),
  'sentinel.controls.familyUnsupported': same('a control this inspection does not model', 'The rule asks about a control other than authentication, authorization or input validation, which the framework libraries do not inspect.'),
  'sentinel.controls.jobInvalid': same('the inspection job was not valid', 'The inspection received no job, more than one, or one that does not match the captured snapshot and source it names, so it did not run.'),
};
