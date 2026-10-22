// PR 19: reports over a captured copy of the invoice-app example: a pinned application context proven against the
// capture, placement through core's folds, one document rendered as JSON, Markdown, offline HTML and SARIF, and the
// HTML opened in a real offline browser with JavaScript disabled after the source and store are gone. Synthetic
// observations only; nothing in the fixture is built or run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { compareAssessments } from '../dist/findings/index.js';
import {
  pinApplicationContext, buildReport, generateReport, renderHtml, renderMarkdown, toSarif, countText, COUNT_ORDER, ReportError,
} from '../dist/reports/index.js';
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
  return { dir, root, fx, snapshot, graph, inputs, entry, readContent };
}

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
    catalogVersion: 'draft-1', disclosure: 'private', observations, coverage: [coverage('complete'), coverage('error')], plannedChecks: 2,
    inventory: { included: 40, seenByNoStage: 3, unknownScopeBoundaries: 0 }, readContent: s.readContent,
    contexts: new Map([['app', pinApplicationContext({ snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs })]]),
    rules: RULES, ...over,
  });
}

test('a finding is placed on the screens and journeys that reach it, with a business sentence and its personas', needsStore, async t => {
  const s = await setup(t);
  const ctx = pinApplicationContext({ snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs });
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
    const pinned = pinApplicationContext({ snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', ...ctx });
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
    catalogVersion: 'draft-1', disclosure: 'private', observations: [sql, jsx], coverage: [coverage('complete'), coverage('partial')], plannedChecks: 2,
    inventory: { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 1 }, readContent: s.readContent, rules: RULES,
    contexts: new Map([['app', pinApplicationContext({ snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs })]]),
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

test('the HTML report opens offline with JavaScript disabled after the source and store are gone, and prints', needsStore, async t => {
  const s = await setup(t);
  const sql = await observation(s, 'src/server/invoiceService.ts', 'export async function createInvoice', { nodeId: 'app::src/server/invoiceService.ts::createInvoice' });
  const jsx = await observation(s, 'src/ui/router.tsx', '<', { rule: 'sentinel.xss.render', severity: 'medium', message: '<img src="http://example.invalid/x.png">' });
  const priv = await generateReport({
    id: 'rep-1', run: { id: 'run-1', snapshotId: s.snapshot.id, planRevision: 1 }, ledgerSequence: 10, evaluatedAt: '2026-10-22T11:00:00Z',
    catalogVersion: 'draft-1', disclosure: 'private', observations: [sql, jsx], coverage: [coverage('complete')], plannedChecks: 1,
    inventory: { included: 40, seenByNoStage: 0, unknownScopeBoundaries: 0 }, readContent: s.readContent, rules: RULES,
    contexts: new Map([['app', pinApplicationContext({ snapshot: s.snapshot, sourceId: 'app', repo: 'invoice-app', graph: s.graph, inputs: s.inputs })]]),
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
