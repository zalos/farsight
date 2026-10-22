import type { StringEntry } from './strings.js';

// Sentinel's glossary (the register vocabulary frozen before PR 09, implementation-plan.md): each code-register term
// beside its business twin under `sentinel.term.biz.*`, the way the journey words keep `journey.biz.*`. A term with
// no accurate business explanation stays code-only; no raw technical unit reaches the business words.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_GLOSSARY_STRINGS: Record<string, StringEntry> = {
  'sentinel.term.rule': same('rule', 'One check Sentinel applies to one part of the code, identified by a versioned rule id.'),
  'sentinel.term.biz.rule': same('check', 'Something Sentinel looks at in the application, such as whether a database query is built safely.'),
  'sentinel.term.finding': same('finding', 'What the report lists after grouping the observations that point at the same weakness.'),
  'sentinel.term.biz.finding': same('issue', 'A problem the report asks someone to look at, counted once however many checks noticed it.'),
  'sentinel.term.coverageGap': same('coverage gap', 'A check that did not cover all of the scope it was planned for: unsupported, not run, failed or partial.'),
  'sentinel.term.biz.coverageGap': same('gap in the checks', 'Part of the application a check was meant to look at and did not, so nothing is known about it from that check.'),
  'sentinel.term.disposition': same('disposition', 'A recorded decision about a finding, with its scope, evidence, actor and expiry.'),
  'sentinel.term.biz.disposition': same('decision', 'What someone decided about an issue (accepted, fixed, not applicable), who decided and until when.'),
  'sentinel.term.sarif': same('SARIF', 'The Static Analysis Results Interchange Format: the standard file developer tools read results from.'),
  'sentinel.term.biz.sarif': same('results file for developer tools', 'A file that development tools can import to show the issues beside the code. Its format details are in the advanced export.'),
  'sentinel.term.cwe89': same('CWE-89', 'The Common Weakness Enumeration entry for SQL injection: a database query built from untrusted input.'),
  'sentinel.term.biz.cwe89': same('unsafe database query', 'A database query built from input the application did not control, which could let someone read or change data they should not.'),
  'sentinel.term.scc': same('strongly connected component', 'A group of functions that call one another in a cycle; a check summarises the group rather than following the loop.'),
  'sentinel.term.biz.scc': same('repeated calls limited the check', 'The code calls itself in a loop, so the check stopped following it at a set point.'),
  'sentinel.term.frontier': same('frontier', 'A place where a check stopped following the code (an unresolved call, a limit or an unsupported construct), recorded rather than guessed past.'),
  'sentinel.term.biz.frontier': same('part the check could not follow', 'Somewhere the check could not see past, so what happens beyond it is unknown, not safe.'),
  'sentinel.term.epoch': same('epoch', 'One acquisition of a store\'s owner lock; records from an earlier epoch are refused.'),
  'sentinel.term.biz.epoch': same('the scan restarted', 'Shown only when it matters: the scan\'s owner process restarted and continued from what was already saved.'),
  'sentinel.term.attempt': same('attempt', 'One execution of one planned check, bound to its work revision and owner epoch.'),
  'sentinel.term.biz.attempt': same('run of this check', 'One time a check was carried out; a check that failed may be run again.'),
  'sentinel.term.publication': same('publication', 'An attempt\'s accepted result, recorded once per work revision after its bytes were verified.'),
  'sentinel.term.biz.publication': same('saved result', 'A check\'s result once it was safely stored; it is never saved twice.'),
  'sentinel.term.sourceSpan': same('source span', 'A file, line and column range in a captured file that a finding or an observation cites.'),
  'sentinel.term.biz.sourceSpan': same('supporting code', 'The lines of the application\'s code that show the issue.'),
  'sentinel.term.frameworkOrder': same('framework order', 'The order in which a framework applies its guards, filters and middleware to a request.'),
  'sentinel.term.biz.frameworkOrder': same('order in which the checks apply', 'Which of the application\'s protections run first when a request arrives.'),
};
