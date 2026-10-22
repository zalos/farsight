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
export function controls(record) {
  const isolation = record.isolation;
  const checks = {
    completed: completed(record),
    cleanup: record.cleanup?.state === 'removed-owned-container',
    pinnedImage: isolation?.image === record.expectedImage,
    networkNone: isolation?.networkMode === 'none',
    readOnlyRoot: isolation?.readOnlyRootfs === true,
    unprivileged: isolation?.user === '65534:65534',
    readOnlyMounts: Array.isArray(isolation?.mounts) && isolation.mounts.length >= 2 && isolation.mounts.every(m => m.readWrite === false),
    capDrop: isolation?.capDrop?.includes('ALL') === true,
    noNewPrivileges: isolation?.securityOpt?.some(x => x.startsWith('no-new-privileges')) === true,
    tmpfsPolicy: isolation?.tmpfs?.['/tmp']?.split(',').includes(record.candidate === 'semgrep' ? 'noexec' : 'exec') === true && isolation?.tmpfs?.['/tmp']?.split(',').includes('nosuid') === true,
    resourceLimits: isolation?.memory === 2147483648 && isolation?.nanoCpus === 2000000000 && isolation?.pidsLimit === 128,
  };
  if (record.scenario === 'version') checks.version = record.versionMatches === true && record.execution?.exitCode === 0;
  else if (record.scenario === 'missing-rules') checks.expectedFailure = record.execution?.exitCode !== 0 && record.assessment?.parseableJson === true && /not-present\.yaml/.test(record.execution?.stdout ?? '') && /(?:unable to find|not found|does not exist|no such file|invalid config)/i.test(record.execution?.stdout ?? '');
  else {
    checks.validJson = record.assessment?.parseableJson === true;
    if (record.scenario.startsWith('valid-')) {
      checks.exitZero = record.execution?.exitCode === 0;
      checks.noEngineErrors = record.assessment?.diagnostics.length === 0;
      checks.allEligibleFilesScanned = record.assessment?.scannedCount === 9 && record.assessment?.omittedCount === 0 && record.assessment?.unexpectedScanned.length === 0;
      checks.attribution = record.assessment?.unattributedFindings === 0 && record.assessment?.unknownRuleFindings === 0;
    }
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
