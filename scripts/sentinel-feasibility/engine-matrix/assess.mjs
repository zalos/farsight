import { CANDIDATES } from '../../sentinel-feasibility-scanners.mjs';
const pathOf = value => String(value ?? '').replace(/^\/input\//, '').replace(/^\.\//, '');
const ruleOf = value => String(value ?? '').split('.').at(-1);
const inSpan = (finding, label) => pathOf(finding.path) === label.path && Number.isInteger(finding.start?.line) && Number.isInteger(finding.end?.line) && finding.start.line >= label.startLine && finding.end.line >= finding.start.line && finding.end.line <= label.endLine;

// Trace locations are inspected only inside the engine's dataflow_trace, never inferred from findings.
function traceLocations(value, locations = [], depth = 0) {
  if (depth > 30 || !value || typeof value !== 'object') return locations;
  if (typeof value.path === 'string' && Number.isInteger(value.start?.line)) locations.push({ path: pathOf(value.path), line: value.start.line });
  for (const child of Object.values(value)) if (child && typeof child === 'object') traceLocations(child, locations, depth + 1);
  return locations;
}
export function assess(record, { index, mode, stage }) {
  const inputStage = stage === 'missing-rules' ? 'valid' : stage;
  const expectedFiles = index.files.filter(f => f.stage === inputStage).map(f => f.path);
  const assessment = { stage, mode, requestedFiles: expectedFiles, requested: expectedFiles.length, scanned: null, omitted: null, skipped: null, diagnostics: [], labels: [], findings: [], gaps: [] };
  let output;
  try { output = JSON.parse(record.execution?.stdout ?? ''); }
  catch { assessment.gaps.push('missing-or-invalid-json'); return assessment; }
  if (!output || Array.isArray(output) || typeof output !== 'object' || !Array.isArray(output.results) || !Array.isArray(output.errors)) {
    assessment.gaps.push('invalid-output-shape'); return assessment;
  }
  assessment.parseableJson = true;
  assessment.diagnostics = output.errors;
  if (Array.isArray(output.paths?.scanned) && output.paths.scanned.every(p => typeof p === 'string')) {
    assessment.scanned = [...new Set(output.paths.scanned.map(pathOf))].sort();
    assessment.scannedCount = expectedFiles.filter(p => assessment.scanned.includes(p)).length;
    assessment.omitted = expectedFiles.filter(p => !assessment.scanned.includes(p));
    assessment.omittedCount = assessment.omitted.length;
    assessment.unexpectedScanned = assessment.scanned.filter(p => !expectedFiles.includes(p));
    if (assessment.omitted.length) assessment.gaps.push('requested-inputs-omitted');
    if (assessment.unexpectedScanned.length) assessment.gaps.push('unexpected-scanned-paths');
  } else assessment.gaps.push('scanned-path-inventory-unavailable');
  assessment.skipped = Array.isArray(output.paths?.skipped) ? output.paths.skipped : null;
  if (assessment.skipped === null) assessment.gaps.push('skip-reasons-unavailable');
  if (assessment.diagnostics.length) assessment.gaps.push('engine-reported-diagnostics');
  const labels = stage === 'valid' ? index.labels : [];
  const allowedRules = ['tsjs', 'java'].map(group => `sentinel-engine-${mode}-${group}`);
  assessment.findings = output.results.map(f => {
    const label = labels.find(l => inSpan(f, l) && ruleOf(f.check_id) === `sentinel-engine-${mode}-${l.language === 'java' ? 'java' : 'tsjs'}`);
    const locations = traceLocations(f.extra?.dataflow_trace);
    return { rule: ruleOf(f.check_id), path: pathOf(f.path), start: f.start, end: f.end, labelId: label?.id ?? null,
      tracePresent: !!f.extra?.dataflow_trace, traceLocations: locations,
      crossFileTrace: !!label?.sourcePath && locations.some(p => p.path === label.sourcePath && p.line >= label.sourceStartLine && p.line <= label.sourceEndLine) && locations.some(p => p.path === label.path && p.line >= label.startLine && p.line <= label.endLine) };
  });
  assessment.unknownRuleFindings = assessment.findings.filter(f => !allowedRules.includes(f.rule)).length;
  if (stage === 'valid') {
    assessment.unattributedFindings = assessment.findings.filter(f => f.labelId === null).length;
    for (const label of labels) {
      const findings = assessment.findings.filter(f => f.labelId === label.id);
      assessment.labels.push({ ...label, hit: findings.length > 0, locations: findings.length, crossFileTrace: findings.some(f => f.crossFileTrace) });
    }
    assessment.scores = Object.fromEntries(['direct', 'local', 'cross-file'].map(capability => {
      const positive = assessment.labels.filter(l => l.capability === capability && l.label === 'positive');
      const safe = assessment.labels.filter(l => l.capability === capability && l.label === 'safe');
      return [capability, { positiveHits: positive.filter(l => l.hit).length, positiveDenominator: positive.length, safeHits: safe.filter(l => l.hit).length, safeDenominator: safe.length, tracedPositiveHits: positive.filter(l => l.crossFileTrace).length }];
    }));
    if (assessment.unattributedFindings) assessment.gaps.push('unattributed-findings');
  }
  if (stage !== 'valid') assessment.gaps.push(`${stage}-input-is-not-a-clean-check`);
  return assessment;
}
export function completed(record) {
  const r = record.execution;
  return !!r && Number.isInteger(r.exitCode) && !r.spawnError && !r.timedOut && !r.outputExceeded && !r.cancelled && !r.exitSignal && record.containerCompleted === true && record.containerExitMatchesClient === true;
}
const inputControlPaths = Object.freeze({ partial: 'controls/partial.ts', 'out-of-rule-language': 'controls/unsupported.rs', oversize: 'controls/oversized.ts' });
function inputControlChecks(record) {
  const expected = inputControlPaths[record.scenario], a = record.assessment;
  const scanned = a?.scanned, omitted = a?.omitted, skipped = a?.skipped;
  const usableSkipped = Array.isArray(skipped) && skipped.every(skip => skip && typeof skip.path === 'string' && pathOf(skip.path) === expected && typeof skip.reason === 'string' && skip.reason.length > 0);
  const usableScanned = Array.isArray(scanned) && scanned.length <= 1 && scanned.every(path => path === expected);
  const expectedOmissions = usableScanned && scanned.includes(expected) ? [] : [expected];
  const reconciled = a?.requested === 1 && Array.isArray(a.requestedFiles) && a.requestedFiles.length === 1 && a.requestedFiles[0] === expected &&
    usableScanned && a.scannedCount === scanned.length && Array.isArray(omitted) && JSON.stringify(omitted) === JSON.stringify(expectedOmissions) && a.omittedCount === omitted.length &&
    Array.isArray(a.unexpectedScanned) && a.unexpectedScanned.length === 0 && usableSkipped;
  const findingsKnown = Array.isArray(a?.findings) && a.findings.every(finding => finding.path === expected);
  const checks = { exitZero: record.execution?.exitCode === 0, reconciledInputInventory: reconciled, findingPathsKnown: findingsKnown };
  if (record.scenario === 'partial') {
    const partialDiagnostic = error => error && ['warn', 'error'].includes(error.level) && pathOf(error.path) === expected &&
      Array.isArray(error.type) && error.type[0] === 'PartialParsing' && Array.isArray(error.type[1]) && error.type[1].length > 0 &&
      error.type[1].every(location => pathOf(location.path) === expected && location.start?.line === 4 && location.end?.line === 4);
    checks.intendedPartialDiagnostic = Array.isArray(a?.diagnostics) && a.diagnostics.length > 0 && a.diagnostics.every(partialDiagnostic);
    checks.intendedPartialSkip = usableSkipped && skipped.some(skip => skip.reason === 'analysis_failed_parser_or_internal_error');
  } else {
    checks.noEngineErrors = Array.isArray(a?.diagnostics) && a.diagnostics.length === 0;
    checks.intendedInputOmitted = usableScanned && scanned.length === 0 && Array.isArray(omitted) && omitted.length === 1 && omitted[0] === expected;
    checks.noFindings = Array.isArray(a?.findings) && a.findings.length === 0;
    if (record.scenario === 'oversize') checks.intendedSizeSkip = usableSkipped && skipped.some(skip => skip.reason === 'exceeded_size_limit');
  }
  return checks;
}
export function controls(record) {
  const isolation = record.isolation;
  const candidate = CANDIDATES.find(pin => pin.id === record.candidate);
  const exactTokens = (actual, expected) => typeof actual === 'string' && typeof expected === 'string' && JSON.stringify(actual.split(',').sort()) === JSON.stringify(expected.split(',').sort());
  const expectedMounts = candidate?.id === 'opengrep' ? ['/input', '/rules', '/tool/opengrep'] : ['/input', '/rules'];
  const missingRuleDiagnostic = Array.isArray(record.assessment?.diagnostics) && record.assessment.diagnostics.some(error => error?.level === 'error' && typeof error.message === 'string' &&
    /(?:^|[\s`'"(])\/rules\/not-present\.yaml(?=$|[\s`'")\]])/.test(error.message) &&
    /\b(?:unable to find a config|does not exist|not found|no such file|invalid config(?:uration)?(?: file)?|cannot (?:read|find)|failed to (?:read|load))\b/i.test(error.message));
  const checks = {
    completed: completed(record),
    cleanup: record.cleanup?.state === 'removed-owned-container',
    pinnedImage: !!candidate && isolation?.image === candidate.image && record.expectedImage === candidate.image,
    networkNone: isolation?.networkMode === 'none',
    readOnlyRoot: isolation?.readOnlyRootfs === true,
    unprivileged: isolation?.user === '65534:65534',
    readOnlyMounts: Array.isArray(isolation?.mounts) && isolation.mounts.length === expectedMounts.length && isolation.mounts.every(m => m.readWrite === false && m.type === 'bind') && JSON.stringify(isolation.mounts.map(m => m.destination).sort()) === JSON.stringify(expectedMounts),
    capDrop: Array.isArray(isolation?.capDrop) && isolation.capDrop.length === 1 && isolation.capDrop[0] === 'ALL',
    noNewPrivileges: Array.isArray(isolation?.securityOpt) && isolation.securityOpt.length === 1 && isolation.securityOpt[0] === 'no-new-privileges:true',
    tmpfsPolicy: !!candidate && Object.keys(isolation?.tmpfs ?? {}).length === 1 && exactTokens(isolation?.tmpfs?.['/tmp'], candidate.tmpfs.slice('/tmp:'.length)),
    resourceLimits: isolation?.memory === 2147483648 && isolation?.memorySwap === 2147483648 && isolation?.nanoCpus === 2000000000 && isolation?.pidsLimit === 128,
  };
  if (record.scenario === 'version') checks.version = record.versionMatches === true && record.execution?.exitCode === 0;
  else if (record.scenario === 'missing-rules') checks.expectedFailure = record.execution?.exitCode === 7 && record.assessment?.parseableJson === true && missingRuleDiagnostic === true;
  else {
    checks.validJson = record.assessment?.parseableJson === true;
    if (record.scenario.startsWith('valid-')) {
      checks.exitZero = record.execution?.exitCode === 0;
      checks.noEngineErrors = record.assessment?.diagnostics.length === 0;
      checks.allEligibleFilesScanned = record.assessment?.scannedCount === 9 && record.assessment?.omittedCount === 0 && record.assessment?.unexpectedScanned.length === 0;
      checks.noEligibleInputSkipped = Array.isArray(record.assessment?.skipped) && record.assessment.skipped.every(skip => skip && typeof skip.path === 'string' && typeof skip.reason === 'string' && skip.reason.length > 0 && !record.assessment.requestedFiles.includes(pathOf(skip.path)));
      checks.attribution = record.assessment?.unattributedFindings === 0 && record.assessment?.unknownRuleFindings === 0;
    } else if (Object.hasOwn(inputControlPaths, record.scenario)) Object.assign(checks, inputControlChecks(record));
    else checks.knownScenario = false;
  }
  return { passed: Object.values(checks).every(v => v === true), checks };
}
export function proposals(trials) {
  return Object.fromEntries(['semgrep', 'opengrep'].map(candidate => {
    const pattern = trials.find(t => t.candidate === candidate && t.scenario === 'valid-pattern');
    const taint = trials.find(t => t.candidate === candidate && t.scenario === 'valid-taint');
    const safeHits = trial => trial?.assessment?.labels.filter(l => l.label === 'safe' && l.hit).length;
    const p = pattern?.assessment?.scores, t = taint?.assessment?.scores;
    return [candidate, {
      patternCriteriaMet: pattern?.controls?.passed === true && p?.direct.positiveHits === 3 && safeHits(pattern) === 0,
      localTaintCriteriaMet: taint?.controls?.passed === true && t?.direct.positiveHits === 3 && t?.local.positiveHits === 3 && safeHits(taint) === 0,
      crossFileCriteriaMet: taint?.controls?.passed === true && t?.['cross-file'].positiveHits === 3 && t?.['cross-file'].tracedPositiveHits === 3 && safeHits(taint) === 0,
      scope: 'Proposed original micro-corpus criteria only; independent review and owner acceptance are separate.' }];
  }));
}
