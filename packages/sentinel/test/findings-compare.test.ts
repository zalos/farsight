// PR 19: finding identity and full-run comparison, adversarially. Synthetic observations over in-memory captured
// bytes; every case that could falsely resolve a finding (line movement, duplicate names, a shared sink, a narrowed
// rule or scope, a missing engine, a removed route) is asserted not to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalizeObservation, correlate, matchFindings, compareAssessments,
} from '../dist/findings/index.js';
import { validateEnvelope } from '../dist/index.js';

const sha = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A tiny content-addressed store of file versions. */
function files(map: Record<string, string>) {
  const byId = new Map<string, Buffer>();
  const ids: Record<string, string> = {};
  for (const [path, text] of Object.entries(map)) { const b = Buffer.from(text); const id = sha(b); byId.set(id, b); ids[path] = id; }
  return { ids, read: async (id: string) => { const b = byId.get(id); if (!b) throw new Error(`no ${id}`); return b; }, text: map };
}

let seq = 0;
function obs(fs: ReturnType<typeof files>, spans: { path: string; needle: string; nodeId?: string }[], opts: { rule?: string; adapter?: string; severity?: string; snapshot?: string; limitations?: string[] } = {}) {
  const evidence = spans.map(s => {
    const start = Buffer.from(fs.text[s.path]!).indexOf(Buffer.from(s.needle));
    assert.ok(start >= 0, s.needle);
    return { snapshotId: opts.snapshot ?? 'snap-1', sourceId: 'app', relativePath: s.path, content: fs.ids[s.path]!, span: { startByte: start, endByte: start + Buffer.byteLength(s.needle) }, ...(s.nodeId ? { nodeId: s.nodeId } : {}) };
  });
  const o = {
    schema: 'sentinel-observation/draft-1', id: `obs-${++seq}`, snapshotId: opts.snapshot ?? 'snap-1',
    producer: { kind: 'scanner', adapterId: opts.adapter ?? 'semgrep', adapterDigest: `sha256:${'a'.repeat(64)}`, attemptId: 'att-1' },
    producerRuleId: 'sql-concat', rule: { familyId: opts.rule ?? 'sentinel.sql.dynamic-query', revisionDigest: `sha256:${'b'.repeat(64)}` },
    originalSeverity: opts.severity ?? 'high', message: 'string concatenation reaches a SQL call', evidence,
    limitationKeys: opts.limitations ?? [], observedAt: '2026-10-22T10:00:00Z',
  };
  assert.equal(validateEnvelope('observation', o).ok, true);
  return o;
}

async function findings(fs: ReturnType<typeof files>, observations: any[]) {
  const n = [];
  for (const o of observations) n.push(await normalizeObservation(o as any, fs.read));
  return correlate(n);
}

const SERVICE = `export function findUser(id: string) {
  return db.query("select * from users where id = '" + id + "'");
}
`;
const N = (name: string, path = 'src/service.ts') => `app::${path}::${name}`;
const COND = { ruleRevision: 'r1', engine: 'e1', capabilities: 'c1', environment: 'env1', relevantLimits: 'l1' };
const check = (files: string[], over: Partial<typeof COND> = {}, status = 'complete') => ({ ruleFamilyId: 'sentinel.sql.dynamic-query', status, files: new Set(files.map(f => `app:${f}`)), conditions: { ...COND, ...over } });
const surfaces = (files: string[], nodeIds: string[] | null, unknownScope: string[] = []) => ({
  files: new Set(files.map(f => `app:${f}`)), unknownScope,
  graph: nodeIds ? { nodeIds: new Set(nodeIds), analysedFiles: new Set(files.map(f => `app:${f}`)) } : null,
});

test('line movement keeps identity: the same claim moved down a file is the same finding, never resolved', async () => {
  const before = files({ 'src/service.ts': SERVICE });
  const after = files({ 'src/service.ts': `// a new header comment\n\n${SERVICE}` });
  const span = [{ path: 'src/service.ts', needle: `"select * from users where id = '" + id + "'"`, nodeId: N('findUser') }];
  const [b] = await findings(before, [obs(before, span)]);
  const [c] = await findings(after, [obs(after, span)]);
  assert.equal(b!.fingerprint.exact, c!.fingerprint.exact, 'no line or offset enters the fingerprint');
  const r = compareAssessments({
    baseline: { findings: [b!], checks: [check(['src/service.ts'])] },
    current: { findings: [c!], checks: [check(['src/service.ts'])], surfaces: surfaces(['src/service.ts'], [N('findUser')]) },
  });
  assert.deepEqual(r.current.map((o: any) => [o.label, o.reasonCode, o.match.kind]), [['changed-evidence', 'sentinel.compare.evidenceMoved', 'exact']]);
  assert.deepEqual(r.historical, []);
});

test('version correlation: two producers making the same claim are one finding with both observations', async () => {
  const fs = files({ 'src/service.ts': SERVICE });
  const span = [{ path: 'src/service.ts', needle: `db.query(`, nodeId: N('findUser') }];
  const fx = await findings(fs, [obs(fs, span, { adapter: 'semgrep' }), obs(fs, span, { adapter: 'opengrep', severity: 'ERROR' })]);
  assert.equal(fx.length, 1);
  assert.equal(fx[0]!.observationIds.length, 2);
  // A secret claim on the same span is never merged into a non-secret finding.
  const secret = await findings(fs, [obs(fs, span), obs(fs, span, { limitations: ['sentinel.secrets.redacted'] })]);
  assert.equal(secret.length, 2);
});

test('same-sink distinct issues stay distinct, and the one that disappears is not resolved without a comparable check', async () => {
  const fs = files({ 'src/a.ts': 'export const fromQuery = (req) => run(req.query.q);\nexport const fromBody = (req) => run(req.body.q);\n', 'src/sink.ts': 'export function run(sql) { return db.query(sql); }\n' });
  const sink = { path: 'src/sink.ts', needle: 'db.query(sql)', nodeId: 'app::src/sink.ts::run' };
  const q = obs(fs, [{ path: 'src/a.ts', needle: 'req.query.q', nodeId: 'app::src/a.ts::fromQuery' }, sink]);
  const bo = obs(fs, [{ path: 'src/a.ts', needle: 'req.body.q', nodeId: 'app::src/a.ts::fromBody' }, sink]);
  const base = await findings(fs, [q, bo]);
  assert.equal(base.length, 2, 'two weaknesses sharing a sink are two findings');
  const cur = await findings(fs, [obs(fs, [{ path: 'src/a.ts', needle: 'req.query.q', nodeId: 'app::src/a.ts::fromQuery' }, sink])]);
  const both = ['src/a.ts', 'src/sink.ts'];
  const nodes = ['app::src/a.ts::fromQuery', 'app::src/a.ts::fromBody', 'app::src/sink.ts::run'];
  const scoped = compareAssessments({ baseline: { findings: base, checks: [check(both)] }, current: { findings: cur, checks: [check(['src/sink.ts'])], surfaces: surfaces(both, nodes) } });
  assert.deepEqual(scoped.historical.map((h: any) => [h.label, h.reasonCode]), [['unassessed-in-current-scope', 'sentinel.compare.scopeNarrowed']]);
  const clean = compareAssessments({ baseline: { findings: base, checks: [check(both)] }, current: { findings: cur, checks: [check(both)], surfaces: surfaces(both, nodes) } });
  assert.deepEqual(clean.historical.map((h: any) => h.label), ['resolved-by-comparable-check']);
  assert.deepEqual(clean.current.map((c: any) => c.label), ['persistent']);
});

test('duplicate names and competing candidates are ambiguous: nothing is chosen and nothing is resolved', async () => {
  const before = files({ 'src/service.ts': 'export function handle(a) { return q("x" + a); }\nexport function handle(b) { return q("y" + b); }\n' });
  const after = files({ 'src/service.ts': 'export function handle(a) { return q("z" + a); }\n' });
  const node = N('handle');
  const base = await findings(before, [obs(before, [{ path: 'src/service.ts', needle: 'q("x" + a)', nodeId: node }]), obs(before, [{ path: 'src/service.ts', needle: 'q("y" + b)', nodeId: node }])]);
  const cur = await findings(after, [obs(after, [{ path: 'src/service.ts', needle: 'q("z" + a)', nodeId: node }])]);
  const m = matchFindings(base, cur);
  assert.equal(m.exact.length + m.probable.length, 0);
  assert.equal(m.ambiguous.length, 1);
  const r = compareAssessments({ baseline: { findings: base, checks: [check(['src/service.ts'])] }, current: { findings: cur, checks: [check(['src/service.ts'])], surfaces: surfaces(['src/service.ts'], [node]) } });
  assert.deepEqual(r.current.map((c: any) => [c.label, c.match.kind, c.match.baselineFindingIds.length]), [['changed-evidence', 'ambiguous', 2]]);
  assert.deepEqual(r.historical.map((h: any) => [h.label, h.reasonCode]), [['changed-evidence', 'sentinel.compare.ambiguousMatch'], ['changed-evidence', 'sentinel.compare.ambiguousMatch']]);
  // Same name in two files is two symbols: each pairs exactly with its own.
  const two = files({ 'src/a.ts': 'export function handle(a) { return q("x" + a); }\n', 'src/b.ts': 'export function handle(a) { return q("x" + a); }\n' });
  const pair = await findings(two, [obs(two, [{ path: 'src/a.ts', needle: 'q("x" + a)', nodeId: 'app::src/a.ts::handle' }]), obs(two, [{ path: 'src/b.ts', needle: 'q("x" + a)', nodeId: 'app::src/b.ts::handle' }])]);
  assert.equal(matchFindings(pair, pair).exact.length, 2);
});

test('an edit inside the same function is a probable match: open, pending review, never resolved', async () => {
  const before = files({ 'src/service.ts': SERVICE });
  const after = files({ 'src/service.ts': SERVICE.replace("where id = '\" + id + \"'\"", "where id = '\" + id.trim() + \"'\"") });
  const b = await findings(before, [obs(before, [{ path: 'src/service.ts', needle: 'db.query(', nodeId: N('findUser') }, { path: 'src/service.ts', needle: `" + id + "`, nodeId: N('findUser') }])]);
  const c = await findings(after, [obs(after, [{ path: 'src/service.ts', needle: 'db.query(', nodeId: N('findUser') }, { path: 'src/service.ts', needle: `" + id.trim() + "`, nodeId: N('findUser') }])]);
  const r = compareAssessments({ baseline: { findings: b, checks: [check(['src/service.ts'])] }, current: { findings: c, checks: [check(['src/service.ts'])], surfaces: surfaces(['src/service.ts'], [N('findUser')]) } });
  assert.deepEqual(r.current.map((o: any) => [o.label, o.reasonCode, o.match.kind]), [['changed-evidence', 'sentinel.compare.probableMatch', 'probable']]);
  assert.deepEqual(r.historical, []);
});

test('an absent finding resolves only through a comparable complete check of all its files', async () => {
  const fs = files({ 'src/service.ts': SERVICE, 'src/routes.ts': 'export const route = () => findUser(1);\n' });
  const b = await findings(fs, [obs(fs, [{ path: 'src/service.ts', needle: 'db.query(', nodeId: N('findUser') }])]);
  const outcome = (current: any, checks = [check(['src/service.ts'])]) =>
    compareAssessments({ baseline: { findings: b, checks }, current: { findings: [], ...current } }).historical.map((h: any) => `${h.label}/${h.reasonCode.replace('sentinel.compare.', '')}`)[0];
  const all = ['src/service.ts', 'src/routes.ts'];
  assert.equal(outcome({ checks: [check(['src/service.ts'])], surfaces: surfaces(all, [N('findUser')]) }), 'resolved-by-comparable-check/comparableCheckClean');
  // A narrowed rule (new revision), a new engine or capability: changed detection, the issue kept.
  assert.equal(outcome({ checks: [check(['src/service.ts'], { ruleRevision: 'r2' })], surfaces: surfaces(all, [N('findUser')]) }), 'changed-detection/detectionChanged');
  assert.equal(outcome({ checks: [check(['src/service.ts'], { engine: 'e2' })], surfaces: surfaces(all, [N('findUser')]) }), 'changed-detection/detectionChanged');
  // ...unless a reviewed mapping says the two detect the same things.
  const mapped = compareAssessments({ baseline: { findings: b, checks: [check(['src/service.ts'])] }, current: { findings: [], checks: [check(['src/service.ts'], { engine: 'e2' })], surfaces: surfaces(all, [N('findUser')]) },
    compatibility: [{ ruleFamilyId: 'sentinel.sql.dynamic-query', from: COND, to: { ...COND, engine: 'e2' }, rationale: 'reviewed: same rule semantics' }] });
  assert.equal(mapped.historical[0]!.label, 'resolved-by-comparable-check');
  // A missing engine, a failed check, a narrower scope: unassessed.
  assert.equal(outcome({ checks: [], surfaces: surfaces(all, [N('findUser')]) }), 'unassessed-in-current-scope/noCurrentCheck');
  assert.equal(outcome({ checks: [check(['src/service.ts'], {}, 'error')], surfaces: surfaces(all, [N('findUser')]) }), 'unassessed-in-current-scope/checkIncomplete');
  assert.equal(outcome({ checks: [check(['src/routes.ts'])], surfaces: surfaces(all, [N('findUser')]) }), 'unassessed-in-current-scope/scopeNarrowed');
  // Different environment or limits: incomparable.
  assert.equal(outcome({ checks: [check(['src/service.ts'], { environment: 'env2' })], surfaces: surfaces(all, [N('findUser')]) }), 'incomparable-conditions/conditionsDiffer');
  // Removed code is a removed surface, not a fix; a folder capture could not list is unknown.
  assert.equal(outcome({ checks: [check(['src/routes.ts'])], surfaces: surfaces(['src/routes.ts'], ['app::src/routes.ts::route']) }), 'removed-surface/fileRemoved');
  assert.equal(outcome({ checks: [check(['src/service.ts'])], surfaces: surfaces(all, ['app::src/routes.ts::route']) }), 'removed-surface/symbolRemoved');
  assert.equal(outcome({ checks: [check(['src/service.ts'])], surfaces: surfaces([], null, ['app:src/']) }), 'unassessed-in-current-scope/unknownScope');
  // Without a current analysis of its files, whether its code is still there is not shown: never resolved
  // (review round 1 corrected the earlier expectation, which resolved it).
  assert.equal(outcome({ checks: [check(['src/service.ts'])], surfaces: surfaces(all, null) }), 'unassessed-in-current-scope/surfaceUnverified');
});

test('new findings say whether the baseline looked; reopened and expired-disposition findings are labelled', async () => {
  const fs = files({ 'src/service.ts': SERVICE });
  const f = await findings(fs, [obs(fs, [{ path: 'src/service.ts', needle: 'db.query(', nodeId: N('findUser') }])]);
  const s = surfaces(['src/service.ts'], [N('findUser')]);
  const label = (r: any) => r.current.map((c: any) => `${c.label}/${c.reasonCode.replace('sentinel.compare.', '')}`)[0];
  assert.equal(label(compareAssessments({ baseline: { findings: [], checks: [check(['src/service.ts'])] }, current: { findings: f, checks: [check(['src/service.ts'])], surfaces: s } })), 'new/newInAssessedScope');
  assert.equal(label(compareAssessments({ baseline: { findings: [], checks: [] }, current: { findings: f, checks: [check(['src/service.ts'])], surfaces: s } })), 'new/notPreviouslyAssessed');
  assert.equal(label(compareAssessments({ baseline: { findings: [], checks: [check(['src/service.ts'], { ruleRevision: 'r0' })] }, current: { findings: f, checks: [check(['src/service.ts'])], surfaces: s } })), 'changed-detection/detectionChanged');
  assert.equal(label(compareAssessments({ baseline: { findings: [], checks: [check(['src/service.ts'])], resolved: f }, current: { findings: f, checks: [check(['src/service.ts'])], surfaces: s } })), 'reopened/reopened');
  assert.equal(label(compareAssessments({ baseline: { findings: f, checks: [check(['src/service.ts'])], expiredDispositions: new Set([f[0]!.id]) }, current: { findings: f, checks: [check(['src/service.ts'])], surfaces: s } })), 'reopened-disposition-expired/dispositionExpired');
});

test('review round 1: part of an issue\'s code removed (the source gone, the sink still there) is never a clean recheck', async () => {
  const fs = files({ 'src/a.ts': 'export const fromQuery = (req) => run(req.query.q);\n', 'src/sink.ts': 'export function run(sql) { return db.query(sql); }\n' });
  const b = await findings(fs, [obs(fs, [{ path: 'src/a.ts', needle: 'req.query.q', nodeId: 'app::src/a.ts::fromQuery' }, { path: 'src/sink.ts', needle: 'db.query(sql)', nodeId: 'app::src/sink.ts::run' }])]);
  const both = ['src/a.ts', 'src/sink.ts'];
  const outcome = (s: any, checks = [check(both)]) => compareAssessments({ baseline: { findings: b, checks: [check(both)] }, current: { findings: [], checks, surfaces: s } }).historical.map((h: any) => `${h.label}/${h.reasonCode.replace('sentinel.compare.', '')}`)[0];
  // The source's symbol is gone, the sink's remains: a removed surface, never resolved.
  assert.equal(outcome(surfaces(both, ['app::src/sink.ts::run'])), 'removed-surface/partRemoved');
  // The source's file is gone, the sink's remains.
  assert.equal(outcome(surfaces(['src/sink.ts'], ['app::src/sink.ts::run']), [check(['src/sink.ts'])]), 'removed-surface/partRemoved');
  // Near neighbour: both still there and comparably rechecked clean.
  assert.equal(outcome(surfaces(both, ['app::src/a.ts::fromQuery', 'app::src/sink.ts::run'])), 'resolved-by-comparable-check/comparableCheckClean');
});

test('review round 1: a secret claim and an ordinary claim over the same span are distinct findings with distinct ids', async () => {
  const fs = files({ 'src/service.ts': SERVICE });
  const span = [{ path: 'src/service.ts', needle: 'db.query(', nodeId: N('findUser') }];
  const fx = await findings(fs, [obs(fs, span), obs(fs, span, { limitations: ['sentinel.secrets.redacted'] })]);
  assert.equal(fx.length, 2);
  assert.equal(new Set(fx.map((f: any) => f.id)).size, 2);
  assert.notEqual(fx[0]!.fingerprint.exact, fx[1]!.fingerprint.exact);
});

test('review round 1: a withheld location is never read, never a path, and never resolved', async () => {
  const fs = files({ 'src/service.ts': SERVICE });
  const o: any = obs(fs, [{ path: 'src/service.ts', needle: 'db.query(' }], { rule: 'sentinel.secrets.generic-key' });
  o.evidence = [{ location: 'withheld', snapshotId: 'snap-1', sourceId: 'app', entry: 3, content: fs.ids['src/service.ts'], span: o.evidence[0].span }];
  assert.equal(validateEnvelope('observation', o).ok, true);
  let reads = 0;
  const n = await normalizeObservation(o, async (id: string) => { reads++; return fs.read(id); });
  assert.equal(reads, 0, 'a withheld location is not read');
  assert.equal(n.anchors[0]!.relativePath, null);
  assert.equal(n.secret, true);
  const f = correlate([n]);
  const r = compareAssessments({ baseline: { findings: f, checks: [check(['src/service.ts'], {}, 'complete')] }, current: { findings: [], checks: [{ ...check(['src/service.ts']), ruleFamilyId: 'sentinel.secrets.generic-key' }], surfaces: surfaces(['src/service.ts'], [N('findUser')]) } });
  assert.deepEqual(r.historical.map((h: any) => h.reasonCode), ['sentinel.compare.locationWithheld']);
});
