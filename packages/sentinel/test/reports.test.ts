// PR 19: reports over a captured copy of the invoice-app example: a pinned application context proven against the
// capture, placement through core's folds, one document rendered as JSON, Markdown, offline HTML and SARIF, and the
// HTML opened in a real offline browser with JavaScript disabled after the source and store are gone. Synthetic
// observations only; nothing in the fixture is built or run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { compareAssessments } from '../dist/findings/index.js';
import {
  pinApplicationContext, contextPinIntent, placeNodes, placeFiles, buildReport, generateReport, renderHtml, renderMarkdown, toSarif, countText, COUNT_ORDER, ReportError,
} from '../dist/reports/index.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { validateEnvelope } from '../dist/index.js';
import { git, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(here, '../../../examples/invoice-app');

async function setup(t: any) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  cpSync(EXAMPLE, root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['add', '--all', '--force']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/invoice-app', root }] });
  // The enriched application graph, built from the same directory the capture read (test-only: a retained context).
  const { ingestRepo } = await import('../../parsers/dist/index.js');
  const fragment = await ingestRepo(root, { repoName: 'invoice-app' });
  const graph = { nodes: fragment.nodes, edges: fragment.edges, meta: fragment.meta };
  const inputs = snapshot.entries.filter((e: any) => e.sourceId === 'app' && e.kind === 'file' && e.disposition === 'included').map((e: any) => ({ relativePath: e.relativePath, content: e.content }));
  const entry = (p: string) => snapshot.entries.find((e: any) => e.relativePath === p && e.kind === 'file');
  const readContent = (id: string) => fx.store.readArtifact(id);
  return { t, dir, root, fx, snapshot, graph, inputs, entry, readContent };
}

const STATE = `sha256:${'5'.repeat(64)}`;
const POLICY = `sha256:${'6'.repeat(64)}`;
/** The owner's local CLI confirms one exact intent; the coordinator spends the receipt. */
function ownerConfirms(t: any, intent: any) {
  const book = new ReceiptBook(join(scratch(t, 'sentinel-trust-'), 'receipts'));
  const now = new Date('2026-10-22T09:30:00Z');
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent, stateDigest: STATE, policyRevision: POLICY }, { now, ttlMs: 600_000 });
  return book.consume(r.id, { intent, stateDigest: STATE, policyRevision: POLICY }, now);
}
/** A context the owner confirmed exactly (unless `authorization` is given). */
function pin(s: any, over: any = {}) {
  const base = { snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs, ...over };
  const intent = contextPinIntent(base);
  return pinApplicationContext({ ...base, authorization: 'authorization' in over ? over.authorization : intent ? ownerConfirms(s.t, intent) : undefined });
}
const planned = (...statuses: string[]) => statuses.map(st => ({ checkId: `check-${st}`, sourceId: 'app', files: ['src/server/invoiceService.ts'] }));

let seq = 0;
async function observation(s: any, path: string, needle: string, opts: { nodeId?: string; rule?: string; message?: string; severity?: string; limitations?: string[] } = {}) {
  const bytes = Buffer.from(await s.readContent(s.entry(path).content));
  const start = bytes.indexOf(Buffer.from(needle));
  assert.ok(start >= 0, needle);
  return {
    schema: 'sentinel-observation/draft-1', id: `obs-${++seq}`, snapshotId: s.snapshot.id,
    producer: { kind: 'scanner', adapterId: 'semgrep', adapterDigest: `sha256:${'a'.repeat(64)}`, attemptId: 'att-1' },
    producerRuleId: 'rule', rule: { familyId: opts.rule ?? 'sentinel.sql.dynamic-query', revisionDigest: `sha256:${'b'.repeat(64)}` },
    originalSeverity: opts.severity ?? 'high', message: opts.message ?? 'string concatenation reaches a SQL call',
    evidence: [{ snapshotId: s.snapshot.id, sourceId: 'app', relativePath: path, content: s.entry(path).content, span: { startByte: start, endByte: start + Buffer.byteLength(needle) }, ...(opts.nodeId ? { nodeId: opts.nodeId } : {}) }],
    limitationKeys: opts.limitations ?? [], observedAt: '2026-10-22T10:00:00Z',
  };
}

const coverage = (status: string, extra: any = {}) => ({
  schema: 'sentinel-coverage/draft-1', id: `cov-${status}`, runId: 'run-1', checkId: `check-${status}`, workId: 'w-1', workRevision: 1, status,
  granularity: 'per-file-per-rule', assessedScopeArtifact: `sha256:${'c'.repeat(64)}`, limitationsArtifact: `sha256:${'d'.repeat(64)}`,
  basis: status === 'complete' ? { kind: 'executed', attemptId: 'att-1' } : { kind: 'unavailable', reasonCode: 'sentinel.capability.notImplemented' },
  skipped: [], recordedAt: '2026-10-22T10:00:00Z', ...extra,
});

const RULES = new Map([['sentinel.sql.dynamic-query', {
  title: { business: 'Invoice data reaches a database query built from text', code: 'sentinel.sql.dynamic-query' },
  explanation: { business: 'Text the user typed could change what the database is asked.', code: 'String concatenation reaches a SQL call.' },
}]]);

async function report(s: any, observations: any[], over: any = {}) {
  return buildReport({
    id: 'rep-1', run: { id: 'run-1', snapshotId: s.snapshot.id, planRevision: 1 }, ledgerSequence: 10, evaluatedAt: '2026-10-22T11:00:00Z',
    catalogVersion: 'draft-1', disclosure: 'private', observations, coverage: [coverage('complete'), coverage('error')], plannedChecks: planned('complete', 'error'),
    inventory: { included: 40, seenByNoStage: 3, unknownScopeBoundaries: 0 }, readContent: s.readContent,
    contexts: new Map([['app', pin(s)]]),
    rules: RULES, ...over,
  });
}

test('a finding is placed on the screens and journeys that reach it, with a business sentence and its personas', needsStore, async t => {
  const s = await setup(t);
  const ctx = pin(s);
  assert.deepEqual([ctx.binding, ctx.reasons], ['matched', []]);
  const o = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const { document } = await report(s, [o]);
  const f = document.findings[0]!;
  assert.equal(f.place.binding, 'matched');
  const direct = f.place.screens.filter((x: any) => x.via === 'direct-use').map((x: any) => x.id).sort();
  assert.deepEqual(direct, ['invoice-app::page::/invoices', 'invoice-app::page::/invoices/new']);
  assert.ok(f.place.journeys.some((j: any) => j.id === 'invoice-app::flow::new-invoice' && j.screenIds.includes('invoice-app::page::/invoices/new')));
  assert.ok(f.place.personas.length >= 1 && f.place.personas.every((p: any) => p.screenIds.length >= 1));
  assert.equal(f.place.counts.screens.n, f.place.screens.length);
  assert.match(f.explanation.business, /used directly by the (New invoice|Invoice list) screen in the .+ journey/);
  // The context artifact and the receipt are named on the place and closed over by the report.
  assert.ok(document.artifactClosure.includes(f.place.context!.artifact) && document.artifactClosure.includes(f.place.context!.sourceBindingReceipt));
});

test('a context built from other bytes, an artifact-only graph or no context leaves findings honestly unplaced', needsStore, async t => {
  const s = await setup(t);
  const o = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const wrong = s.inputs.map((i: any) => (i.relativePath === 'src/server/invoiceService.ts' ? { ...i, content: `sha256:${'e'.repeat(64)}` } : i));
  const portable = { nodes: s.graph.nodes.filter((n: any) => n.kind !== 'flow'), edges: s.graph.edges, meta: {} };
  const omitted = s.inputs.filter((i: any) => i.relativePath !== 'farsight.config.json');
  for (const [name, ctx, binding, reason] of [
    ['mismatched input bytes', { graph: s.graph, inputs: wrong }, 'mismatched', 'sentinel.place.inputMismatch'],
    ['an omitted configuration file', { graph: s.graph, inputs: omitted }, 'mismatched', 'sentinel.place.inputOmitted'],
    ['a graph with no journeys', { graph: portable, inputs: s.inputs }, 'unavailable', 'sentinel.place.noJourneys'],
    ['no context', {}, 'unavailable', 'sentinel.place.noContext'],
  ] as const) {
    const pinned = pin(s, { graph: undefined, inputs: undefined, ...ctx });
    const { document } = await report(s, [o], { contexts: new Map([['app', pinned]]) });
    const p = document.findings[0]!.place;
    assert.equal(p.binding, binding, name);
    assert.deepEqual([p.screens.length, p.journeys.length, p.personas.length], [0, 0, 0], name);
    assert.ok(p.limitationKeys.includes(reason), name);
    assert.match(document.findings[0]!.explanation.business, /could not be placed/, name);
  }
});

// A structural subset of the SARIF 2.1.0 schema: the properties Sentinel emits and the shapes consumers rely on.
const SARIF_SUBSET = {
  type: 'object', required: ['version', 'runs', '$schema'], properties: {
    version: { const: '2.1.0' }, $schema: { type: 'string' },
    runs: { type: 'array', minItems: 1, items: { type: 'object', required: ['tool', 'results'], properties: {
      tool: { type: 'object', required: ['driver'], properties: { driver: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, rules: { type: 'array', items: { type: 'object', required: ['id'] } } } } } },
      results: { type: 'array', items: { type: 'object', required: ['message', 'ruleId'], properties: {
        ruleId: { type: 'string' }, ruleIndex: { type: 'integer', minimum: 0 }, level: { enum: ['none', 'note', 'warning', 'error'] },
        message: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        baselineState: { enum: ['new', 'unchanged', 'updated', 'absent'] },
        partialFingerprints: { type: 'object', additionalProperties: { type: 'string' } },
        locations: { type: 'array', items: { $ref: '#/$defs/location' } }, relatedLocations: { type: 'array', items: { $ref: '#/$defs/location' } },
      } } },
    } } },
  },
  $defs: { location: { type: 'object', properties: { physicalLocation: { type: 'object', required: ['artifactLocation'], properties: {
    artifactLocation: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } },
    region: { type: 'object', properties: { startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, byteOffset: { type: 'integer', minimum: 0 }, byteLength: { type: 'integer', minimum: 0 } } },
  } } } } },
};

test('every projection carries the same counts and facts; SARIF validates; untrusted text is escaped', needsStore, async t => {
  const s = await setup(t);
  const sql = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  // A rule family without readable words falls back to the producer's message, which is untrusted.
  const jsx = await observation(s, 'src/ui/router.tsx', '<', { rule: 'sentinel.xss.render', severity: 'medium', message: '<script>alert(1)</script> </pre> `code` ```' });
  const out = await generateReport({
    id: 'rep-1', run: { id: 'run-1', snapshotId: s.snapshot.id, planRevision: 1 }, ledgerSequence: 10, evaluatedAt: '2026-10-22T11:00:00Z',
    catalogVersion: 'draft-1', disclosure: 'private', observations: [sql, jsx], coverage: [coverage('complete'), coverage('partial')], plannedChecks: planned('complete', 'partial'),
    inventory: { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 1 }, readContent: s.readContent, rules: RULES,
    contexts: new Map([['app', pin(s)]]),
  });
  const doc = out.document;
  assert.equal(validateEnvelope('report', JSON.parse(out.json)).ok, true);
  assert.equal(doc.completeness, 'partial');
  for (const k of COUNT_ORDER) {
    const c = (doc.counts as any)[k];
    if (!c) continue;
    assert.ok(out.html.includes(countText(doc, c, 'business').replace(/&/g, '&amp;')), `HTML prints ${k}`);
    assert.ok(out.markdown.replace(/\\/g, '').includes(countText(doc, c, 'business')), `Markdown prints ${k}`);
  }
  assert.ok(out.markdown.replace(/\\/g, '').includes('0 of 40 captured files seen by no check'), 'a zero count is printed');
  // Every count, on the report and on each place, is a core Counted with registered words.
  const { countedProblems } = await import('../../core/dist/counts.js');
  const all = [...Object.values(doc.counts), ...doc.findings.flatMap((f: any) => Object.values(f.place.counts))];
  for (const c of all) assert.deepEqual(countedProblems(c as any), [], JSON.stringify(c));
  const sarif: any = out.sarif;
  const ajv = new Ajv({ strict: false });
  assert.equal(ajv.validate(SARIF_SUBSET, sarif), true, JSON.stringify(ajv.errors));
  assert.equal(sarif.runs[0].results.length, doc.findings.length);
  assert.deepEqual(sarif.runs[0].results.map((r: any) => r.partialFingerprints['sentinelIssue/exact/v1']).sort(), doc.findings.map((f: any) => f.fingerprint.exact).sort());
  assert.ok(!('primaryLocationLineHash' in sarif.runs[0].results[0].partialFingerprints));
  // Escaping: no markup from source or messages survives into the HTML.
  assert.ok(!/<script/i.test(out.html) && out.html.includes('&lt;script&gt;'));
  assert.ok(!out.html.includes('</pre> `code`'));
  // Every internal link has its target.
  for (const m of out.html.matchAll(/href="#([^"]+)"/g)) assert.ok(out.html.includes(`id="${m[1]}"`), m[1]);
  assert.ok(!/(src|href)="(https?:|\/\/)/i.test(out.html), 'no remote resource');
  // Export limits are explicit: too many results is a refusal, never a cut.
  assert.throws(() => toSarif(doc, { maxResults: 1 }), (e: any) => e instanceof ReportError && e.code === 'sentinel.report.tooLarge');
});

test('a shareable profile withholds source text without changing a finding, a place or a count; secrets are never disclosed', needsStore, async t => {
  const s = await setup(t);
  const sql = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const secret = await observation(s, 'src/server/notify.ts', 'export', { rule: 'sentinel.secrets.generic-key', severity: 'critical' });
  const priv = (await report(s, [sql, secret])).document;
  const share = (await report(s, [sql, secret], { disclosure: 'shareable' })).document;
  assert.deepEqual(share.counts, priv.counts);
  assert.deepEqual(share.findings.map((f: any) => [f.id, f.place.screens.length, f.severity]), priv.findings.map((f: any) => [f.id, f.place.screens.length, f.severity]));
  assert.ok(share.findings.every((f: any) => f.evidence.every((e: any) => e.state === 'withheld')));
  assert.ok(priv.findings.some((f: any) => f.evidence.some((e: any) => e.state === 'embedded')));
  for (const doc of [priv, share]) {
    const secretFinding = doc.findings.find((f: any) => f.ruleFamilyId === 'sentinel.secrets.generic-key')!;
    assert.ok(secretFinding.evidence.every((e: any) => e.state === 'withheld' && e.reasonCode === 'sentinel.report.withheld.secret' && !e.location));
    for (const rendering of [renderHtml(doc), renderMarkdown(doc).replace(/\\/g, ''), JSON.stringify(toSarif(doc)), JSON.stringify(doc)]) {
      assert.ok(!rendering.includes('notify.ts'), 'a secret\'s file is never named');
    }
  }
  const html = renderHtml(share);
  assert.match(html, /is withheld: source text withheld in a shareable report/);
});

test('a comparison report keeps baseline findings it does not continue, with their reasons', needsStore, async t => {
  const s = await setup(t);
  const a = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const b = await observation(s, 'src/server/payments.ts', 'export', { nodeId: 'app::src/server/payments.ts::markInvoicePaid', rule: 'sentinel.authz.missing' });
  const base = await report(s, [a, b]);
  const cur = await report(s, [a]);
  const files = new Set(s.inputs.map((i: any) => `app:${i.relativePath}`));
  const cond = { ruleRevision: 'r1', engine: 'e1', capabilities: 'c1', environment: 'x', relevantLimits: 'y' };
  const result = compareAssessments({
    baseline: { findings: base.findings, checks: [{ ruleFamilyId: 'sentinel.sql.dynamic-query', status: 'complete', files, conditions: cond }, { ruleFamilyId: 'sentinel.authz.missing', status: 'complete', files, conditions: cond }] },
    current: { findings: cur.findings, checks: [{ ruleFamilyId: 'sentinel.sql.dynamic-query', status: 'complete', files, conditions: cond }], surfaces: { files, unknownScope: [], graph: null } },
  });
  const summaries = new Map(base.document.findings.map((f: any) => [f.id, { id: f.id, ruleFamilyId: f.ruleFamilyId, severity: f.severity, title: f.title, place: f.place }]));
  const { document } = await report(s, [a], { id: 'rep-2', comparison: { baselineReportId: 'rep-1', result, baselineFindings: summaries } });
  assert.deepEqual(document.findings.map((f: any) => [f.comparison, f.match?.kind]), [['persistent', 'exact']]);
  assert.deepEqual(document.historical!.map((h: any) => [h.label, h.reasonCode]), [['unassessed-in-current-scope', 'sentinel.compare.noCurrentCheck']]);
  assert.equal(document.counts.historical!.n, 1);
  assert.match(renderMarkdown(document).replace(/\\/g, ''), /not checked this time/);
  // A comparison that does not cover every finding is refused.
  await assert.rejects(report(s, [a, b], { id: 'rep-3', comparison: { baselineReportId: 'rep-1', result, baselineFindings: summaries } }), (e: any) => e.code === 'sentinel.report.invalidInput');
});

// Browser delivery is mandatory in CI's browser-provisioned e2e job, rather than the unit-test job.
const offlineBrowser = process.env.SENTINEL_REPORT_BROWSER === '1' ? needsStore : { skip: 'set SENTINEL_REPORT_BROWSER=1 to check offline HTML delivery and printing in Chromium' };
test('the HTML report opens offline with JavaScript disabled after the source and store are gone, and prints', offlineBrowser, async t => {
  const s = await setup(t);
  const sql = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const jsx = await observation(s, 'src/ui/router.tsx', '<', { rule: 'sentinel.xss.render', severity: 'medium', message: '<img src="http://example.invalid/x.png">' });
  const priv = await generateReport({
    id: 'rep-1', run: { id: 'run-1', snapshotId: s.snapshot.id, planRevision: 1 }, ledgerSequence: 10, evaluatedAt: '2026-10-22T11:00:00Z',
    catalogVersion: 'draft-1', disclosure: 'private', observations: [sql, jsx], coverage: [coverage('complete')], plannedChecks: planned('complete'),
    inventory: { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 0 }, readContent: s.readContent, rules: RULES,
    contexts: new Map([['app', pin(s)]]),
  });
  const shareDoc = (await report(s, [sql, jsx], { disclosure: 'shareable' })).document;
  const out = join(s.dir, 'delivered');
  mkdirSync(out);
  writeFileSync(join(out, 'report.html'), priv.html);
  writeFileSync(join(out, 'redacted.html'), renderHtml(shareDoc));
  // Deliver: the source tree goes away; the report must not need it.
  rmSync(s.root, { recursive: true, force: true });
  assert.equal(existsSync(s.root), false);
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const name of ['report.html', 'redacted.html']) {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const requests: string[] = [];
    context.on('request', r => requests.push(r.url()));
    const page = await context.newPage();
    const url = pathToFileURL(join(out, name)).href;
    await page.goto(url);
    assert.deepEqual(requests, [url], `${name}: no request beyond the file itself`);
    const text = await page.locator('main').innerText();
    assert.match(text, /Findings/);
    assert.match(text, /New invoice|Invoice list/);
    if (name === 'redacted.html') assert.match(text, /withheld/);
    else assert.match(text, /<img src="http:\/\/example\.invalid\/x\.png">/, 'the message is shown as text, not loaded');
    // Internal navigation works without script.
    const first = await page.locator('nav a').first().getAttribute('href');
    await page.click(`nav a[href="${first}"]`);
    assert.ok(page.url().endsWith(first!));
    await page.screenshot({ path: join(process.env.SENTINEL_REPORT_SHOTS ?? out, `${name}.png`), fullPage: true });
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('nav').isVisible(), false, 'print hides the navigation');
    const pdf = await page.pdf({ format: 'A4' });
    assert.ok(pdf.length > 1000, `${name} prints`);
    assert.deepEqual(requests, [url], `${name}: printing loaded nothing`);
    await context.close();
  }
});

// ---- review round 1 (SOL, 07bfc14): disclosure across the whole envelope, missing coverage, context authenticity ----

const renderings = (doc: any) => ({ json: JSON.stringify(doc), html: renderHtml(doc), markdown: renderMarkdown(doc).replace(/\\/g, ''), sarif: JSON.stringify(toSarif(doc)) });

test('round 1: a secret finding discloses nothing in any field or format, and a shareable report never repeats source through a message', needsStore, async t => {
  const s = await setup(t);
  // A producer message naming the secret's file and a marker, and a symbol whose id names that file.
  const secret = await observation(s, 'src/server/notify.ts', 'export', { rule: 'sentinel.secrets.generic-key', severity: 'critical',
    nodeId: 'app::src/server/notify.ts::notify', message: 'SECRET-MARKER-7 found in src/server/notify.ts' });
  // An ordinary finding whose message quotes the source it cites.
  const quote = 'export async function createInvoice';
  const sql = await observation(s, 'src/server/invoiceService.ts', quote, { nodeId: 'app::src/server/invoiceService.ts::createInvoice', rule: 'sentinel.sql.unnamed', message: `found: ${quote}(draft)` });
  for (const disclosure of ['private', 'shareable'] as const) {
    const { document } = await report(s, [secret, sql], { disclosure });
    const secretFinding = document.findings.find((f: any) => f.ruleFamilyId === 'sentinel.secrets.generic-key')!;
    assert.deepEqual([secretFinding.place.nodeIds, secretFinding.place.limitationKeys], [[], ['sentinel.place.secretWithheld']]);
    for (const [format, text] of Object.entries(renderings(document))) {
      assert.ok(!text.includes('SECRET-MARKER-7'), `${disclosure} ${format}: no marker`);
      assert.ok(!text.includes('notify.ts'), `${disclosure} ${format}: no secret path`);
      if (disclosure === 'shareable') assert.ok(!text.includes(`${quote}(draft)`), `${disclosure} ${format}: no quoted source`);
    }
  }
  // Near neighbour: a private report may show the ordinary finding's message.
  const { document } = await report(s, [sql], { disclosure: 'private' });
  assert.match(document.findings[0]!.explanation.code, /createInvoice\(draft\)/);
});

test('round 1: a planned check without coverage, an unread file or an unlisted folder makes the report partial', needsStore, async t => {
  const s = await setup(t);
  const o = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const missing = (await report(s, [o], { coverage: [coverage('complete')], plannedChecks: planned('complete', 'missing'), inventory: { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 0 } })).document;
  assert.equal(missing.completeness, 'partial');
  assert.deepEqual(missing.gaps.map((g: any) => [g.checkId, g.status, g.reasonCode]), [['check-missing', 'not-run', 'sentinel.report.gap.noCoverage']]);
  for (const [name, inventory] of [['unread files', { included: 40, seenByNoStage: 2, unknownScopeBoundaries: 0 }], ['unlisted folders', { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 1 }]] as const) {
    const doc = (await report(s, [o], { coverage: [coverage('complete')], plannedChecks: planned('complete'), inventory })).document;
    assert.equal(doc.completeness, 'partial', name);
    for (const text of Object.values(renderings(doc))) assert.ok(!text.includes('Every planned check covered its scope'), name);
  }
  const whole = (await report(s, [o], { coverage: [coverage('complete')], plannedChecks: planned('complete'), inventory: { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 0 } })).document;
  assert.equal(whole.completeness, 'complete');
  // Coverage for a check the plan does not hold, or two records for one check, is refused.
  await assert.rejects(report(s, [o], { coverage: [coverage('complete')], plannedChecks: planned('other') }), (e: any) => e.code === 'sentinel.report.invalidInput');
  await assert.rejects(report(s, [o], { coverage: [coverage('complete'), coverage('complete')], plannedChecks: planned('complete') }), (e: any) => e.code === 'sentinel.report.invalidInput');
});

test('round 1: a gap is placed on the screens that rely on the code the check did not cover', needsStore, async t => {
  const s = await setup(t);
  const { document } = await report(s, [], { coverage: [coverage('complete'), coverage('error')], plannedChecks: planned('complete', 'error') });
  const gap = document.gaps[0]!;
  assert.equal(gap.place.binding, 'matched');
  assert.ok(gap.place.screens.some((x: any) => x.id === 'invoice-app::page::/invoices/new'));
});

test('round 1: matching input hashes do not authenticate a context; only the owner\'s confirmation of that exact context does', needsStore, async t => {
  const s = await setup(t);
  const o = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  // A fabricated label and relationship over the very same inputs.
  const forged = structuredClone(s.graph);
  forged.nodes.find((n: any) => n.id === 'invoice-app::page::/invoices/new').name = 'Fabricated screen';
  const placeWith = async (ctx: any) => (await report(s, [o], { contexts: new Map([['app', ctx]]) })).document.findings[0]!.place;
  const none = await placeWith(pin(s, { graph: forged, authorization: undefined }));
  assert.deepEqual([none.binding, none.limitationKeys], ['unavailable', ['sentinel.place.notOwnerConfirmed']]);
  // A receipt for the genuine context does not authenticate the forged one.
  const genuineReceipt = ownerConfirms(t, contextPinIntent({ snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs }));
  const swapped = await placeWith(pin(s, { graph: forged, authorization: genuineReceipt }));
  assert.equal(swapped.binding, 'unavailable');
  assert.ok(!JSON.stringify(swapped).includes('Fabricated screen'));
});

test('round 1: changing the caller\'s graph after pinning changes nothing in a report', needsStore, async t => {
  const s = await setup(t);
  const o = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const ctx = pin(s);
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.graph) && Object.isFrozen(ctx.graph!.nodes[0]));
  const before = (await report(s, [o], { contexts: new Map([['app', ctx]]) })).document;
  for (const n of s.graph.nodes) if (n.kind === 'page') n.name = 'Mutated after pinning';
  s.graph.edges.length = 0;
  const after = (await report(s, [o], { contexts: new Map([['app', ctx]]) })).document;
  assert.deepEqual(after.findings[0]!.place, before.findings[0]!.place);
  assert.ok(!JSON.stringify(after).includes('Mutated after pinning'));
});

test('round 1: a withheld-location citation (secret scan) is reported withheld, with no location', needsStore, async t => {
  const s = await setup(t);
  const o: any = await observation(s, 'src/server/notify.ts', 'export', { rule: 'sentinel.secrets.generic-key', severity: 'high' });
  const index = s.snapshot.entries.findIndex((e: any) => e.relativePath === 'src/server/notify.ts');
  o.evidence = [{ location: 'withheld', snapshotId: s.snapshot.id, sourceId: 'app', entry: index, content: o.evidence[0].content, span: o.evidence[0].span }];
  const { document } = await report(s, [o]);
  const e = document.findings[0]!.evidence[0]!;
  assert.deepEqual([e.state, (e as any).reasonCode, 'location' in e], ['withheld', 'sentinel.report.withheld.secret', false]);
  for (const text of Object.values(renderings(document))) assert.ok(!text.includes('notify.ts'));
});

// The official OASIS SARIF 2.1.0 schema is not vendored here; point SENTINEL_SARIF_SCHEMA at a local copy to run this.
const officialSchema = process.env.SENTINEL_SARIF_SCHEMA;
test('SARIF output validates against the official SARIF 2.1.0 schema', { ...needsStore, ...(officialSchema ? {} : { skip: 'set SENTINEL_SARIF_SCHEMA to a local copy of the official SARIF 2.1.0 schema' }) }, async t => {
  const s = await setup(t);
  const o = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const { readFileSync } = await import('node:fs');
  // The official schema has a pattern that is not valid as a Unicode regular expression.
  const ajv = new Ajv({ strict: false, validateFormats: false, unicodeRegExp: false });
  const validate = ajv.compile(JSON.parse(readFileSync(officialSchema!, 'utf8')));
  for (const disclosure of ['private', 'shareable'] as const) {
    const sarif = toSarif((await report(s, [o], { disclosure })).document);
    assert.equal(validate(sarif), true, JSON.stringify(validate.errors));
  }
});

// ---- runtime authority at every context consumer ----
const INVOICE_NODE = 'app::src/server/invoiceService.ts::createInvoice';
const INVOICE_FILE = 'src/server/invoiceService.ts';

test('context capability: direct placement accepts the genuine pin and refuses structural copies and proxies', needsStore, async t => {
  const s = await setup(t);
  const ctx = pin(s);
  const expected = { snapshotId: s.snapshot.id, sourceId: 'app' };
  assert.ok(placeNodes(ctx, [INVOICE_NODE], expected).screens.length > 0);
  assert.ok(placeFiles(ctx, [INVOICE_FILE], expected).screens.length > 0);
  const unauthorized = pin(s, { authorization: undefined });
  const forgeries = [{ ...unauthorized, binding: 'matched', reasons: [], graph: s.graph }, { ...ctx },
    JSON.parse(JSON.stringify(ctx)), Object.create(ctx), new Proxy(ctx, {})];
  for (const forged of forgeries) {
    for (const place of [placeNodes(forged, [INVOICE_NODE], expected), placeFiles(forged, [INVOICE_FILE], expected)]) {
      assert.equal(place.binding, 'unavailable');
      assert.deepEqual(place.screens, []);
      assert.ok(place.limitationKeys.includes('sentinel.place.notOwnerConfirmed'));
    }
  }
});

test('context capability: every placement needs its exact snapshot and source, including a missing expectation', needsStore, async t => {
  const s = await setup(t);
  const ctx = pin(s);
  for (const expected of [undefined, { snapshotId: 'other-snapshot', sourceId: 'app' }, { snapshotId: s.snapshot.id, sourceId: 'other-source' }]) {
    for (const place of [(placeNodes as any)(ctx, [INVOICE_NODE], expected), (placeFiles as any)(ctx, [INVOICE_FILE], expected)]) {
      assert.notEqual(place.binding, 'matched');
      assert.deepEqual(place.screens, []);
      assert.ok(place.limitationKeys.includes('sentinel.place.contextMismatch'));
    }
  }
  assert.equal(placeNodes(ctx, ['other-source::src/server/invoiceService.ts::createInvoice'], { snapshotId: s.snapshot.id, sourceId: 'app' }).binding, 'mismatched');
});

test('context capability: a real second capture cannot reuse the first pin for findings, gaps or artifact closure', needsStore, async t => {
  const s = await setup(t);
  const ctx = pin(s);
  const bytes = await s.readContent(s.entry(INVOICE_FILE).content);
  writeFileSync(join(s.root, INVOICE_FILE), Buffer.concat([bytes, Buffer.from('\n// synthetic capture B change\n')]));
  const { snapshot } = await captureSnapshot(s.fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/invoice-app', root: s.root }] });
  assert.notEqual(snapshot.id, s.snapshot.id);
  const current = { ...s, snapshot, entry: (p: string) => snapshot.entries.find((e: any) => e.relativePath === p && e.kind === 'file') };
  const o = await observation(current, INVOICE_FILE, 'export async function createInvoice', { nodeId: INVOICE_NODE });
  const { document } = await report(current, [o], { contexts: new Map([['app', ctx]]) });
  for (const place of [document.findings[0]!.place, document.gaps[0]!.place]) {
    assert.equal(place.binding, 'mismatched');
    assert.ok(place.limitationKeys.includes('sentinel.place.contextMismatch'));
    assert.deepEqual(place.screens, []);
  }
  assert.ok(!document.artifactClosure.includes(ctx.artifact!.id));
  assert.ok(!document.artifactClosure.includes(ctx.receipt.id));
});

test('context capability: report consumers reject observation, citation and map-source mismatches', needsStore, async t => {
  const s = await setup(t);
  const ctx = pin(s);
  const original = await observation(s, INVOICE_FILE, 'export async function createInvoice', { nodeId: INVOICE_NODE });
  for (const field of ['observation', 'citation', 'source'] as const) {
    const o: any = structuredClone(original);
    let contexts: any = new Map([['app', ctx]]);
    if (field === 'observation') o.snapshotId = 'other-snapshot';
    if (field === 'citation') o.evidence[0].snapshotId = 'other-snapshot';
    if (field === 'source') { o.evidence[0].sourceId = 'other-source'; o.evidence[0].nodeId = INVOICE_NODE.replace('app::', 'other-source::'); contexts = new Map([['other-source', ctx]]); }
    const { document } = await report(s, [o], { contexts });
    assert.equal(document.findings[0]!.place.binding, 'mismatched', field);
    assert.ok(document.findings[0]!.place.limitationKeys.includes('sentinel.place.contextMismatch'), field);
    assert.deepEqual(document.findings[0]!.place.screens, [], field);
  }
});

test('context capability: caller byte-array mutations cannot change retained artifacts or receipts', needsStore, async t => {
  const s = await setup(t);
  const ctx = pin(s);
  const o = await observation(s, INVOICE_FILE, 'export async function createInvoice', { nodeId: INVOICE_NODE });
  const before = await report(s, [o], { contexts: new Map([['app', ctx]]) });
  ctx.artifact!.bytes.fill(0);
  ctx.receipt.bytes.fill(0);
  const after = await report(s, [o], { contexts: new Map([['app', ctx]]) });
  assert.deepEqual(after.document, before.document);
  for (const a of after.artifacts) assert.equal(`sha256:${createHash('sha256').update(a.bytes).digest('hex')}`, a.id);
});

test('context capability: authorization access cannot swap the snapshot identity being authenticated', needsStore, async t => {
  const s = await setup(t);
  const snapshot = { ...s.snapshot };
  const other = { ...snapshot, id: 'other-snapshot' };
  const authorization = ownerConfirms(t, contextPinIntent({ snapshot: other, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs }));
  const ctx = pinApplicationContext({ snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs,
    get authorization() { snapshot.id = other.id; return authorization; } });
  assert.notEqual(ctx.binding, 'matched');
});
