import type { StringEntry } from './strings.js';

// Sentinel's production check drivers (PR 13 follow-up): why a planned check was not run by its adapter, and the
// titles and limitations of the original rules the drivers run. Both registers carry the same words until the PR 09
// vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_DRIVERS_STRINGS: Record<string, StringEntry> = {
  'sentinel.drivers.ruleUnsupported': same('the adapter does not run this rule', 'Each adapter runs only the shipped rules it was built and tested against, at their exact definition digests. A custom rule, or a copy with other bytes, is never run by it, so its checks are not run.'),
  'sentinel.drivers.scopeUnsupported': same('the adapter does not check this kind of scope', 'The rule names a scope kind its adapter does not read, so the check is not run.'),
  'sentinel.drivers.inputMissing': same('the file was not among the unit’s inputs', 'The check’s file was not given to the adapter, so the check is not run.'),
  'sentinel.drivers.databaseMissing': same('no advisory snapshot is admitted for this file’s ecosystem', 'Advisories come only from a snapshot the owner acquired and the plan pins. Without one for this ecosystem the file is not checked.'),
  'sentinel.drivers.notReported': same('the adapter reported nothing for this check', 'The adapter’s normalized result names neither a run nor a reason for this file and rule, so the check is not run.'),
  'sentinel.drivers.nothingApplicable': same('nothing in this unit applies to the adapter', 'No supported rule or no readable file remained, so the adapter was not started.'),
  'sentinel.drivers.contextInvalid': same('the adapter was given inputs it cannot use: {detail}', 'A tool pin, database or bundle record, or the driver’s own recorded context does not describe exactly what the adapter is pinned to.'),
  'sentinel.drivers.ruleBytesInvalid': same('a rule’s bytes are not the pack’s: {detail}', 'A rule implementation file did not hash to the digest its validated pack records, so nothing was run.'),
  'sentinel.drivers.rule.knownAdvisory': same('a dependency at a version a known advisory names', 'A component of a lockfile, manifest or SBOM, at a version an advisory in the pinned offline snapshot names.'),
  'sentinel.drivers.rule.workflowAudit': same('a CI configuration weakness', 'A GitHub Actions workflow, action or Dependabot setting that zizmor’s offline audits report.'),
  'sentinel.drivers.rule.misconfiguration': same('an infrastructure misconfiguration', 'A Dockerfile, Kubernetes manifest or Terraform setting that a check of the pinned trivy-checks bundle reports.'),
  'sentinel.drivers.limitation.advisorySnapshot': same('advisories as of the pinned snapshot', 'Only advisories in the owner-acquired snapshot are matched; newer ones are not known until a new snapshot is acquired.'),
  'sentinel.drivers.limitation.onlineAudits': same('online audits are not run', 'Audits that need the GitHub API, such as impostor commits and known-vulnerable actions, are skipped offline.'),
  'sentinel.drivers.limitation.checksBundle': same('checks as of the pinned bundle', 'Only the checks of the pinned trivy-checks bundle run; checks added later are not known until a new bundle is pinned.'),
};
