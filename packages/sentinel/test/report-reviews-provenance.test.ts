// Model observations and stage provenance in the report (Sentinel v2 P-6): a cited class beside the findings, never a
// finding and never coverage, and one provenance record per published attempt. A report without either keeps its
// bytes: the retained-report fixture below was recorded before these sections existed, and the same inputs still
// give the same document, renderings and digests.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { canonicalJson } from '@farsight/graph';
import { generateReport, renderHtml, renderMarkdown } from '../dist/reports/index.js';
import { validateEnvelope } from '../dist/validate.js';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { openStore } from '../dist/store/index.js';
import { workspaceOf } from '../dist/service/local.js';
import { fullReport, withholdSecretRun, SECRET_RUN_WITHHELD } from '../dist/service/full-report.js';
import { git, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { trustedPolicy, mockEndpoint, json, ollamaReply } from './provider-helpers.ts';

/** The invoice-app example captured at a fixed clock, as the retained fixture was recorded from. */
async function invoiceApp(t: { after(fn: () => void): void }) {
  const dir = scratch(t, 'sentinel-golden-');
  const root = join(dir, 'repo');
  cpSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/invoice-app'), root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['add', '--all', '--force']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, {
    mode: 'working-copy',
    sources: [{ sourceId: 'workspace', repositoryId: 'local-workspace', root }],
    now: () => '2026-10-27T12:00:00.000000000Z',
  });
  return { store: fx.store, snapshot };
}

const RETAINED = new URL('./fixtures/report-retained/invoice-app.json', import.meta.url);
const sha = (s: string | Uint8Array) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const cleanups: (() => void)[] = [];
let fx: any;
before(async () => {
  if (!needsStore.skip) fx = await invoiceApp({ after: (fn) => cleanups.push(fn) });
});
after(() => {
  for (const fn of cleanups.reverse()) fn();
});

const entryOf = (path: string) =>
  fx.snapshot.entries.find((e: any) => e.kind === 'file' && e.relativePath === path && e.disposition === 'included');
const read = (id: string) => fx.store.readArtifact(id);

/** A scanner observation over the captured invoice service, cited by byte span. */
async function scannerObservation() {
  const e = entryOf('src/server/invoiceService.ts');
  const bytes = Buffer.from(await read(e.content));
  const needle = 'export async function createInvoice';
  const start = bytes.indexOf(Buffer.from(needle));
  return {
    schema: 'sentinel-observation/draft-1',
    id: 'obs-scanner-1',
    snapshotId: fx.snapshot.id,
    producer: { kind: 'scanner', adapterId: 'pattern-semgrep', adapterDigest: sha('adapter'), attemptId: 'att-1' },
    producerRuleId: 'rule',
    rule: { familyId: 'sentinel.sql.concatenated-query-tsjs', revisionDigest: sha('rule revision') },
    originalSeverity: 'high',
    message: 'string concatenation reaches a SQL call',
    evidence: [
      {
        snapshotId: fx.snapshot.id,
        sourceId: 'workspace',
        relativePath: 'src/server/invoiceService.ts',
        content: e.content,
        span: { startByte: start, endByte: start + needle.length },
      },
    ],
    limitationKeys: [],
    observedAt: '2026-10-27T10:00:00Z',
  };
}

const coverage = (status: string) => ({
  schema: 'sentinel-coverage/draft-1',
  id: `cov-${status}`,
  runId: 'run-retained',
  checkId: `check-${status}`,
  workId: 'w-1',
  workRevision: 1,
  status,
  granularity: 'per-file-per-rule',
  assessedScopeArtifact: `sha256:${'c'.repeat(64)}`,
  limitationsArtifact: `sha256:${'d'.repeat(64)}`,
  basis:
    status === 'complete'
      ? { kind: 'executed', attemptId: 'att-1' }
      : { kind: 'unavailable', reasonCode: 'sentinel.capability.notImplemented' },
  skipped: [],
  recordedAt: '2026-10-27T10:00:00Z',
});

/** The inputs every report here starts from: one scanner finding, one complete and one failed check. */
const baseInput = async (disclosure: 'private' | 'shareable', over: Record<string, unknown> = {}) => ({
  id: 'rep-retained',
  run: { id: 'run-retained', snapshotId: fx.snapshot.id, planRevision: 2 },
  ledgerSequence: 42,
  evaluatedAt: '2026-10-27T11:00:00Z',
  catalogVersion: 'draft-1',
  disclosure,
  observations: [await scannerObservation()],
  coverage: [coverage('complete'), coverage('error')],
  plannedChecks: ['complete', 'error'].map((s) => ({
    checkId: `check-${s}`,
    sourceId: 'workspace',
    files: ['src/server/invoiceService.ts'],
  })),
  inventory: { included: 40, seenByNoStage: 3, unknownScopeBoundaries: 0 },
  readContent: read,
  ...over,
});

const digests = (out: any) => ({
  json: sha(out.json),
  markdown: sha(out.markdown),
  html: sha(out.html),
  sarif: sha(canonicalJson(out.sarif)),
});

test(
  'a report with no model observation and no provenance keeps its retained bytes and digests',
  needsStore,
  async () => {
    const recorded: Record<string, unknown> = {};
    for (const disclosure of ['private', 'shareable'] as const)
      recorded[disclosure] = digests(await generateReport((await baseInput(disclosure)) as any));
    if (process.env.SENTINEL_RETAINED_WRITE === '1') writeFileSync(RETAINED, JSON.stringify(recorded, null, 2) + '\n');
    assert.deepEqual(recorded, JSON.parse(readFileSync(RETAINED, 'utf8')));
    const doc = (await generateReport((await baseInput('private')) as any)).document;
    assert.ok(validateEnvelope('report', doc).ok);
    assert.equal(Object.hasOwn(doc, 'reviews'), false);
    assert.equal(Object.hasOwn(doc, 'provenance'), false);
    assert.equal(Object.hasOwn(doc.counts, 'reviewObservations'), false);
  },
);

test(
  'an unfinished Copilot review explains its login refusal in every report rendering without native text',
  needsStore,
  async () => {
    const failure = {
      stage: 'review-general',
      unit: { id: 'review-unit-1', revision: 1 },
      reasonCode: 'sentinel.review.frontier.copilotLogin',
    };
    for (const disclosure of ['private', 'shareable'] as const) {
      const out = await generateReport((await baseInput(disclosure, { reviewFailures: [failure] })) as any);
      assert.equal(validateEnvelope('report', out.document).ok, true);
      assert.deepEqual(out.document.reviewFailures, [failure]);
      assert.ok(out.document.definitions?.some((d: any) => d.key === failure.reasonCode));
      assert.match(out.markdown, /Copilot needs a login/);
      assert.match(out.html, /Copilot needs a login/);
      assert.match(out.markdown, /A model review is unfinished/);
      assert.match(out.html, /A model review is unfinished/);
      assert.deepEqual((out.sarif as any).runs[0].properties.reviewFailures, [failure]);
      for (const rendered of [out.json, out.markdown, out.html, JSON.stringify(out.sarif)]) {
        assert.doesNotMatch(rendered, /original-private-token|original-account/);
        assert.match(rendered, /Copilot|copilotLogin/);
      }
    }
  },
);

/** A model observation over the captured invoice service: a cited claim, as an accepted review publishes one. */
async function modelObservation(message = 'The total is built from request text before it reaches SQL.') {
  const e = entryOf('src/server/invoiceService.ts');
  const bytes = Buffer.from(await read(e.content));
  const needle = 'export async function createInvoice';
  const start = bytes.indexOf(Buffer.from(needle));
  return {
    schema: 'sentinel-observation/draft-1',
    id: 'obs-model-1',
    snapshotId: fx.snapshot.id,
    producer: {
      kind: 'model-review',
      adapterId: 'sentinel.review.general',
      adapterDigest: sha('review adapter'),
      attemptId: 'att-review-1',
      model: {
        requestedModel: 'review-model:1',
        returnedModel: 'review-model:1',
        immutableRevision: null,
        source: 'provider-response',
      },
      promptDigest: sha('prompt'),
    },
    producerRuleId: 'sentinel.review.general',
    originalSeverity: 'unrated',
    message,
    evidence: [
      {
        snapshotId: fx.snapshot.id,
        sourceId: 'workspace',
        relativePath: 'src/server/invoiceService.ts',
        content: e.content,
        span: { startByte: start, endByte: start + needle.length },
      },
    ],
    limitationKeys: ['sentinel.review.limitation.modelClaim'],
    observedAt: '2026-10-27T10:30:00Z',
  };
}

const at = (s: number) => `2026-10-27T10:00:0${s}.000000000Z`;
const PROVENANCE = [
  {
    kind: 'builtin',
    stage: 'capture',
    unit: { id: 'w-capture', revision: 1 },
    attempt: 'att-capture',
    where: 'in-process',
    startedAt: at(0),
    endedAt: at(1),
    durationMs: 1000,
    read: [],
    wrote: [sha('snapshot')],
    invocation: sha('capture invocation'),
    operation: 'capture',
    moduleDigest: sha('capture module'),
    sentinelVersion: 'not recorded; identified by its module digest',
  },
  {
    kind: 'script',
    stage: 'notes',
    unit: { id: 'w-notes', revision: 2 },
    attempt: 'att-notes',
    where: 'host',
    startedAt: at(2),
    endedAt: at(3),
    durationMs: 900,
    read: [sha('findings')],
    wrote: [sha('notes')],
    invocation: sha('notes invocation'),
    entryDigest: sha('entry'),
    interpreter: { name: 'node', version: 'v24.0.0', digest: sha('node'), path: '/opt/runtime/bin/node' },
    confinement: 'none',
    outputSchema: { id: 'sentinel.notes/v1', digest: sha('schema') },
    argv: ['entry.mjs'],
    environmentNames: [],
    image: null,
  },
  {
    kind: 'agent',
    stage: 'review-general',
    unit: { id: 'w-review', revision: 2 },
    attempt: 'att-review-1',
    where: 'in-process',
    startedAt: at(4),
    endedAt: at(6),
    durationMs: 2000,
    read: [],
    wrote: [sha('record')],
    invocation: sha('review invocation'),
    mode: 'brokered',
    runner: 'hosted-api',
    runnerVersion: null,
    executableDigest: null,
    model: { requested: 'review-model:1', reported: 'review-model:1', identitySource: 'provider-response' },
    promptDigest: sha('prompt'),
    skillDigests: [],
    wires: [sha('wire 1'), sha('wire 2')],
    transcript: null,
    turns: 2,
    tokens: { input: 120, output: 40, certainty: 'confirmed' },
    cost: { basis: 'unobserved', reason: 'no-rates' },
    deadline: { grantedMs: 120000, usedMs: 2000 },
  },
];

test(
  'a model observation is a cited class beside the findings, under the same disclosure profile',
  needsStore,
  async () => {
    const review = {
      observation: await modelObservation(),
      stage: 'review-general',
      unit: { id: 'w-review', revision: 2 },
    };
    const priv = await generateReport(
      (await baseInput('private', { reviews: [review], provenance: PROVENANCE })) as any,
    );
    const shared = await generateReport(
      (await baseInput('shareable', { reviews: [review], provenance: PROVENANCE })) as any,
    );
    for (const out of [priv, shared]) {
      assert.ok(validateEnvelope('report', out.document).ok, JSON.stringify(validateEnvelope('report', out.document)));
      // Never a finding and never coverage: the counts of what the checks found are those of the same report without it.
      assert.equal(out.document.findings.length, 1);
      assert.equal(out.document.counts.reviewObservations.n, 1);
      assert.equal(out.document.reviews.length, 1);
      assert.equal(Object.hasOwn(out.document.reviews[0], 'progress'), false, 'the older review shape remains valid');
      assert.equal(out.document.provenance.length, 3);
    }
    const plain = await generateReport((await baseInput('private')) as any);
    assert.deepEqual(priv.document.counts.findings, plain.document.counts.findings);
    assert.deepEqual(priv.document.gaps, plain.document.gaps);

    const p = priv.document.reviews[0];
    assert.equal(p.stage, 'review-general');
    assert.deepEqual(p.unit, { id: 'w-review', revision: 2 });
    assert.equal(p.model.requestedModel, 'review-model:1');
    assert.equal(p.message, 'The total is built from request text before it reaches SQL.');
    assert.equal(p.evidence[0].state, 'embedded');
    assert.equal(p.evidence[0].excerpt, 'export async function createInvoice');
    assert.equal(p.evidence[0].location.relativePath, 'src/server/invoiceService.ts');
    assert.ok(priv.document.artifactClosure.includes(p.evidence[0].content));

    // The shareable profile withholds the excerpt and the model's statement, as it withholds a finding's source.
    const sh = shared.document.reviews[0];
    assert.equal(Object.hasOwn(sh, 'message'), false);
    assert.equal(sh.evidence[0].state, 'withheld');
    assert.equal(sh.evidence[0].reasonCode, 'sentinel.report.withheld.shareable');
    assert.equal(Object.hasOwn(sh.evidence[0], 'excerpt'), false);
    // A host interpreter's path names this computer's folders: kept in a private report only.
    const script = (d: any) => d.provenance.find((x: any) => x.kind === 'script');
    assert.equal(script(priv.document).interpreter.path, '/opt/runtime/bin/node');
    assert.equal(Object.hasOwn(script(shared.document).interpreter, 'path'), false);

    // Markdown escapes its control characters; read it as text.
    const asText = (t: string) => t.replace(/\\(.)/g, '$1');
    for (const text of [asText(priv.markdown), priv.html]) {
      assert.match(text, /Model observations/);
      assert.match(text, /proposed by a model: a cited claim, not a finding and not coverage/);
      assert.match(text, /review-model:1/);
      assert.match(text, /How each stage ran/);
      assert.match(text, /runs unconfined on this computer as you/);
      assert.match(text, /cost unobserved · no rates/);
      assert.match(text, /120 tokens in · 40 out \(confirmed\)/);
      assert.doesNotMatch(text, /\b0(?:\.0+)? USD\b/);
    }
    assert.match(priv.markdown, /The total is built from request text/);
    assert.doesNotMatch(shared.markdown, /The total is built from request text/);
    assert.doesNotMatch(shared.html, /export async function createInvoice/);
  },
);

test(
  'an unfinished review says so beside its limited inspection, without making a SARIF finding',
  needsStore,
  async () => {
    const review = {
      observation: await modelObservation(),
      stage: 'review-general',
      unit: { id: 'w-review', revision: 2 },
      progress: {
        outcome: 'unfinished',
        turnsUsed: 3,
        turnCap: 3,
        filesRead: 1,
        filesGiven: 6,
        source: 'brokered',
      },
    };
    const out = await generateReport((await baseInput('private', { reviews: [review] })) as any);
    assert.ok(validateEnvelope('report', out.document).ok);
    assert.equal(out.document.reviews?.[0]?.progress?.outcome, 'unfinished');
    assert.match(out.json, /"outcome":"unfinished"/);
    assert.match(out.markdown, /review unfinished.*3 of 3 model exchanges used.*1 of 6 files opened for this review/);
    assert.match(out.html, /review unfinished.*3 of 3 model exchanges used.*1 of 6 files opened for this review/);
    assert.equal(out.sarif.runs[0]?.results.length, out.document.findings.length);
  },
);

test('a native Copilot observation and its retained provenance render in every report format', needsStore, async () => {
  const observation = await modelObservation('The native review found request text flowing into SQL.');
  observation.producer.model.requestedModel = 'gpt-6-luna';
  observation.producer.model.returnedModel = 'gpt-6-luna';
  observation.producer.model.source = 'host-reported';
  const agent = {
    ...PROVENANCE[2],
    where: 'sandboxed-cli',
    mode: 'native',
    runner: 'copilot-cli',
    runnerVersion: '1.0.105',
    executableDigest: sha('pinned Copilot executable'),
    model: { requested: 'gpt-6-luna', reported: 'gpt-6-luna', identitySource: 'host-reported' },
    wires: [],
    transcript: sha('retained native transcript'),
    tokens: { input: 1234, output: 56, certainty: 'confirmed' },
    cost: { basis: 'unobserved', reason: 'subscription' },
  };
  const reviews = [{ observation, stage: 'review-general', unit: { id: 'w-review', revision: 2 } }];
  const input = await baseInput('private', { reviews, provenance: [PROVENANCE[0], PROVENANCE[1], agent] });
  const out = await generateReport(input as any);
  assert.ok(validateEnvelope('report', out.document).ok);
  assert.equal(out.document.counts.reviewObservations.n, 1);
  assert.equal(out.document.reviews[0].evidence[0].state, 'embedded');
  assert.deepEqual(out.document.provenance[2], agent);
  assert.match(out.markdown, /The native review found request text/);
  assert.match(out.html, /cost unobserved · subscription/);
  assert.match(out.markdown.replace(/\\(.)/g, '$1'), /copilot-cli 1\.0\.105 native/);
  for (const text of [out.markdown, out.html]) {
    assert.ok(text.includes(agent.executableDigest));
    assert.ok(text.includes(agent.transcript));
  }
  assert.equal(out.sarif.version, '2.1.0');
  assert.equal(out.sarif.runs[0].results.length, 1, 'SARIF retains the scanner finding, not the model claim');
  assert.deepEqual(digests(out), {
    json: 'sha256:bc87377ad2fe73519f853ce8012d860ce572eb0b02a8da1fe2fc1bbe7ac85271',
    markdown: 'sha256:3e5fd825adeb91167d6185ce573380383fe2f4df55df1b601d7ac4c62442b1a9',
    html: 'sha256:b041f332b6ef241a155971be57ec4df5dd0a9d087ac9e6e2588f7e8fd13c8893',
    sarif: 'sha256:8b769e712b16a71bdbfe9dd21f78054b5b629cdf967fe06d3c20fc9a58f24ca1',
  });
  const withheld = withholdSecretRun(out.document, new Map());
  assert.equal(Object.hasOwn(withheld.reviews[0], 'message'), false);
  assert.equal(withheld.reviews[0].evidence[0].state, 'withheld');
  assert.equal(withheld.provenance[2].mode, 'native');
  assert.deepEqual(withheld.provenance[2].cost, { basis: 'unobserved', reason: 'subscription' });
  const shared = await generateReport(
    (await baseInput('shareable', { reviews, provenance: [PROVENANCE[0], PROVENANCE[1], agent] })) as any,
  );
  assert.equal(shared.document.reviews[0].evidence[0].state, 'withheld');
  assert.doesNotMatch(shared.markdown, /The native review found request text/);
});

test('a brokered-only review retains its four report renderings', needsStore, async () => {
  const review = {
    observation: await modelObservation(),
    stage: 'review-general',
    unit: { id: 'w-review', revision: 2 },
  };
  const out = await generateReport((await baseInput('private', { reviews: [review], provenance: PROVENANCE })) as any);
  assert.deepEqual(
    out.document.definitions.filter((d: any) => d.key.startsWith('sentinel.report.provenance.')).map((d: any) => d.key),
    [
      'sentinel.report.provenance.cost.no-rates',
      'sentinel.report.provenance.heading',
      'sentinel.report.provenance.where.host',
      'sentinel.report.provenance.where.in-process',
    ],
  );
  assert.deepEqual(digests(out), {
    json: 'sha256:d1910c88d98f00b8ba812397febc485246b25f9f5c9c79a263e749789a893e51',
    markdown: 'sha256:84e230fb3cab7ad225ec95efc6654b2d9ee8edfca1f4814e45218b9283cc4c11',
    html: 'sha256:699d8077e63ea47661623445f9c7fc013b62220eb2968079a17b2ca9e681848f',
    sarif: 'sha256:8b769e712b16a71bdbfe9dd21f78054b5b629cdf967fe06d3c20fc9a58f24ca1',
  });
});

test(
  'a run with an accepted secret match withholds every model statement and citation, but keeps progress and provenance',
  needsStore,
  async () => {
    const review = {
      observation: await modelObservation(),
      stage: 'review-general',
      unit: { id: 'w-review', revision: 2 },
      progress: {
        outcome: 'completed',
        turnsUsed: 3,
        turnCap: 12,
        filesRead: 1,
        filesGiven: 6,
        source: 'brokered',
      },
    };
    const out = await generateReport(
      (await baseInput('private', { reviews: [review], provenance: PROVENANCE })) as any,
    );
    const doc = withholdSecretRun(out.document, new Map());
    const valid = validateEnvelope('report', doc);
    assert.ok(valid.ok, JSON.stringify(valid));
    const r = doc.reviews[0];
    assert.equal(Object.hasOwn(r, 'message'), false);
    assert.deepEqual(r.progress, out.document.reviews[0].progress, 'generated progress survives secret withholding');
    assert.equal(r.progress.outcome, 'completed');
    assert.match(renderMarkdown(doc), /3 of 12 model exchanges used.*1 of 6 files opened for this review/);
    assert.match(renderHtml(doc), /3 of 12 model exchanges used.*1 of 6 files opened for this review/);
    assert.deepEqual(
      r.evidence.map((e: any) => [e.state, e.reasonCode, Object.hasOwn(e, 'location'), Object.hasOwn(e, 'excerpt')]),
      [['withheld', SECRET_RUN_WITHHELD, false, false]],
    );
    assert.ok(r.limitationKeys.includes(SECRET_RUN_WITHHELD));
    // Generated identity stays; the ledger's provenance keeps its words, and a host path is made opaque.
    assert.deepEqual([r.id, r.stage, r.model.requestedModel], ['obs-model-1', 'review-general', 'review-model:1']);
    assert.deepEqual(
      doc.provenance.map((p: any) => [p.kind, p.stage, p.where]),
      PROVENANCE.map((p) => [p.kind, p.stage, p.where]),
    );
    const script = doc.provenance.find((p: any) => p.kind === 'script');
    assert.equal(script.confinement, 'none');
    assert.equal(script.entryDigest, PROVENANCE[1]!.entryDigest);
    assert.match(script.interpreter.path, /^withheld-\d+$/);
    const text = JSON.stringify(doc) + renderMarkdown(doc) + renderHtml(doc);
    assert.doesNotMatch(text, /The total is built|createInvoice|\/opt\/runtime/);
  },
);

test('a model citation of a file the secret scan named is withheld in every profile', needsStore, async () => {
  const review = {
    observation: await modelObservation(),
    stage: 'review-general',
    unit: { id: 'w-review', revision: 2 },
  };
  const out = await generateReport(
    (await baseInput('private', {
      reviews: [review],
      withheldFiles: new Set(['workspace:src/server/invoiceService.ts']),
    })) as any,
  );
  const e = out.document.reviews[0].evidence[0];
  assert.deepEqual(
    [e.state, e.reasonCode, Object.hasOwn(e, 'location')],
    ['withheld', 'sentinel.report.withheld.secret', false],
  );
  const section = out.markdown.slice(out.markdown.indexOf('## Model observations'), out.markdown.indexOf('## Gaps'));
  assert.match(section, /location withheld/);
  assert.doesNotMatch(section, /invoiceService|createInvoice/);
});

test(
  'a model observation of another capture, or a scanner one passed as a review, refuses the report',
  needsStore,
  async () => {
    const other = { ...(await modelObservation()), snapshotId: 'snap-other' };
    await assert.rejects(
      generateReport(
        (await baseInput('private', {
          reviews: [{ observation: other, stage: 's', unit: { id: 'w', revision: 1 } }],
        })) as any,
      ),
      (e: any) => e.code === 'sentinel.report.invalidInput',
    );
    await assert.rejects(
      generateReport(
        (await baseInput('private', {
          reviews: [{ observation: await scannerObservation(), stage: 's', unit: { id: 'w', revision: 1 } }],
        })) as any,
      ),
      (e: any) => e.code === 'sentinel.report.invalidInput',
    );
  },
);

test('an agent stage cost known only as unobserved is printed with its reason, never as zero', needsStore, async () => {
  for (const reason of ['subscription', 'usage-unknown', 'no-rates']) {
    const provenance = PROVENANCE.map((p) =>
      p.kind === 'agent' ? { ...p, cost: { basis: 'unobserved', reason } } : p,
    );
    const out = await generateReport((await baseInput('private', { provenance })) as any);
    const words = `cost unobserved · ${reason.replace('-', ' ')}`;
    assert.ok(out.markdown.includes(words), words);
    assert.ok(renderHtml(out.document).includes(words), words);
    for (const text of [out.markdown, out.html]) assert.doesNotMatch(text, /\b0(?:\.0+)? USD\b/);
  }
  // A confirmed usage at the owner's rates is a list price, said so, and printed with its amount.
  const provenance = PROVENANCE.map((p) =>
    p.kind === 'agent' ? { ...p, cost: { basis: 'rates', amount: '0.0042', currency: 'USD' } } : p,
  );
  const out = await generateReport((await baseInput('private', { provenance })) as any);
  assert.ok(renderMarkdown(out.document).includes('0\\.0042 USD · list price, not billed'));
});

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The real CLI over one workspace, as the owner runs it, answering JSON. */
const cliOver =
  (ws: string, env: NodeJS.ProcessEnv) =>
  (...args: string[]) =>
    new Promise<any>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [CLI, ...args, '--workspace', ws, '--json'], {
        cwd: ws,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('fixture CLI timeout'));
      }, 90000);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        try {
          resolvePromise({ status, body: JSON.parse(out) });
        } catch {
          reject(Error('fixture CLI output unavailable ' + err.slice(0, 200)));
        }
      });
    });

test(
  "a scanner unit's provenance names its worker and version, and a Sentinel operation its module and version",
  needsStore,
  async (t) => {
    const dir = scratch(t, 'sentinel-report-tool-');
    const ws = join(dir, 'workspace');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(
      join(ws, 'src/query.ts'),
      'export const q = (id: string) => db.query("SELECT * FROM t WHERE id = " + id);\n',
    );
    const env = { ...process.env, HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
    mkdirSync(env.HOME);
    const cli = cliOver(ws, env);
    assert.equal((await cli('init')).status, 0);
    assert.equal((await cli('settings', 'adopt', '--confirm')).status, 0);
    assert.equal((await cli('rules', 'promote', 'builtin:foundation-preview', '--confirm')).status, 0);
    const planned = await cli('plan');
    assert.equal(planned.status, 0, JSON.stringify(planned.body));
    const id = planned.body.facts.planId;
    const ran = await cli('run', id, '--confirm');
    assert.equal(ran.body.facts.state, 'completed', JSON.stringify(ran.body));
    const sw = workspaceOf(ws, env);
    const store = await openStore(sw.storePath);
    try {
      const doc: any = (
        await fullReport({
          store,
          runId: id,
          workspace: ws,
          trustDir: sw.trustDir,
          disclosure: 'private',
          now: new Date('2026-10-28T09:00:00Z'),
        })
      ).document;
      assert.ok(validateEnvelope('report', doc).ok);
      assert.equal(Object.hasOwn(doc, 'reviews'), false, 'no model review planned, no review section');
      const tools = doc.provenance.filter((p: any) => p.kind === 'tool');
      assert.ok(tools.length >= 1, JSON.stringify(doc.provenance.map((p: any) => p.kind)));
      for (const p of tools) {
        assert.equal(p.adapterId, 'sentinel.preview.detector');
        assert.notEqual(p.adapterVersion, 'not recorded');
        assert.equal(p.where, 'child');
        // A built-in child's worker is its registered adapter, by the digest its invocation names.
        assert.match(p.workerDigest, /^sha256:[0-9a-f]{64}$/);
        const unit = await (await import('../dist/execution/plans.js')).loadPlan(store, id);
        const pin = unit.profile.adapters.find((a: any) => a.adapterId === p.adapterId);
        assert.equal(p.workerDigest, pin.digest);
        assert.ok(p.rules.length >= 1 && p.rules.every((r: any) => /^sha256:/.test(r.definitionDigest)));
        assert.match(p.invocation, /^sha256:/);
      }
      const builtins = doc.provenance.filter((p: any) => p.kind === 'builtin');
      assert.deepEqual(
        builtins.map((p: any) => p.operation),
        ['capture', 'parse', 'inventory'],
      );
      for (const b of builtins) assert.equal(b.sentinelVersion, VERSION);
    } finally {
      store.close();
    }
  },
);

test(
  'a model review run reports its cited observation with its model, and every stage provenance, after the source is gone',
  needsStore,
  async (t) => {
    const dir = scratch(t, 'sentinel-report-review-');
    const ws = join(dir, 'workspace');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src/query.ts'), 'export const q = (id: string) => "SELECT * FROM t WHERE id = " + id;\n');
    for (let i = 1; i <= 5; i++) writeFileSync(join(ws, `src/extra-${i}.ts`), `export const extra${i} = ${i};\n`);
    // The reviewer spends its full turn allowance, but opens only one of its six assigned files.
    let replies = 0;
    const endpoint = await mockEndpoint(t, (req: { body: string }, res: any) => {
      const msgs = JSON.parse(req.body).messages;
      const last = JSON.parse(msgs[msgs.length - 1].content);
      replies++;
      const content =
        replies === 12
          ? JSON.stringify({
              action: 'final',
              verdict: 'finding',
              inspected: ['src/query.ts'],
              claims: [{ statement: 'Request text reaches SQL.', citations: [last.evidence[0].id] }],
            })
          : JSON.stringify({ action: 'read', path: 'src/query.ts', startLine: 1, endLine: 1 });
      json(res, 200, ollamaReply({ message: { role: 'assistant', content } }));
    });
    const env = { ...process.env, HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
    mkdirSync(env.HOME);
    const cli = cliOver(ws, env);
    assert.equal((await cli('init')).status, 0);
    const file = join(ws, '.farsight/sentinel/settings.json');
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const provider = structuredClone(trustedPolicy({ ollama: endpoint.origin }).settings.providers[0]);
    provider.models[0]!.capability.revision = null;
    provider.models[0]!.limits.maxMessages = 64;
    s.mandatoryRules = [];
    s.hostedReviewSecretScan = 'when-selected';
    s.providers = [provider];
    s.reviewModels = {
      stages: [{ stage: 'general', providerId: provider.id, modelId: provider.models[0]!.id }],
      segments: [],
    };
    s.grants[0].scope.effects = ['local-artifacts', 'paid-inference'];
    s.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
    writeFileSync(file, JSON.stringify(s));
    assert.equal((await cli('settings', 'adopt', '--confirm')).status, 0);
    assert.equal((await cli('rules', 'promote', 'builtin:foundation-preview', '--confirm')).status, 0);
    const planned = await cli('plan');
    assert.equal(planned.status, 0, JSON.stringify(planned.body));
    const id = planned.body.facts.planId;
    const ran = await cli('run', id, '--confirm', '--confirm-models');
    assert.equal(ran.body.facts.state, 'completed', JSON.stringify(ran.body));
    assert.equal(endpoint.seen.length, 12, 'the reviewer reached its turn cap after repeatedly reading one file');

    const sw = workspaceOf(ws, env);
    const report = async (disclosure: 'private' | 'shareable') => {
      const store = await openStore(sw.storePath);
      try {
        return await fullReport({
          store,
          runId: id,
          workspace: ws,
          trustDir: sw.trustDir,
          disclosure,
          now: new Date('2026-10-28T09:00:00Z'),
        });
      } finally {
        store.close();
      }
    };
    const priv = await report('private');
    const doc: any = priv.document;
    assert.ok(validateEnvelope('report', doc).ok);
    assert.equal(doc.findings.length, 0, 'a model claim is never a finding');
    assert.equal(doc.counts.reviewObservations.n, 1);
    const r = doc.reviews[0];
    assert.equal(r.stage, 'review-general');
    assert.equal(r.model.requestedModel, provider.models[0]!.model);
    assert.equal(r.message, 'Request text reaches SQL.');
    assert.equal(r.evidence.length, 1);
    assert.equal(r.evidence[0].state, 'embedded');
    assert.equal(r.evidence[0].location.relativePath, 'src/query.ts');
    assert.match(r.evidence[0].excerpt, /SELECT \* FROM t WHERE id = /);
    assert.equal(r.progress.outcome, 'completed');
    assert.deepEqual([r.progress.turns.n, r.progress.turns.of], [12, 12]);
    assert.deepEqual([r.progress.filesRead.n, r.progress.filesRead.of], [1, 6]);
    assert.equal(r.progress.modelInspected, undefined);
    const { countedProblems } = await import('@farsight/core/dist/counts.js');
    for (const c of [r.progress.turns, r.progress.filesRead]) assert.deepEqual(countedProblems(c), []);
    // Every published unit has one record: the bootstrap operations, then the review with its tokens and cost.
    const kinds = doc.provenance.map((p: any) => `${p.kind}:${p.stage}`);
    assert.deepEqual(
      kinds,
      ['builtin:capture', 'builtin:parse', 'builtin:inventory', 'agent:review-general'],
      kinds.join(),
    );
    const agent = doc.provenance.find((p: any) => p.kind === 'agent');
    assert.equal(agent.attempt, r.attemptId);
    assert.equal(agent.model.requested, provider.models[0]!.model);
    assert.equal(agent.turns, 12);
    assert.equal(agent.wires.length, 12);
    assert.equal(agent.runner, 'ollama');
    // A local model with no fee: its confirmed usage at the provider's own (zero) rate is a list price, said so.
    assert.deepEqual(agent.cost, { basis: 'rates', amount: '0', currency: 'USD' });
    assert.equal(agent.tokens.certainty, 'confirmed');
    assert.ok(agent.tokens.input > 0 && agent.tokens.output > 0);
    for (const b of doc.provenance.filter((p: any) => p.kind === 'builtin')) {
      assert.equal(b.where, 'in-process');
      assert.match(b.moduleDigest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(b.sentinelVersion, VERSION, 'the version the operation recorded when it ran');
    }
    assert.ok(
      priv.markdown.indexOf('1 model observation') < priv.markdown.indexOf('## Findings'),
      'counted with the counts',
    );
    assert.match(priv.markdown, /Request text reaches SQL/);
    assert.match(priv.markdown, /12 of 12 model exchanges used.*1 of 6 files opened for this review/);
    assert.match(priv.html, /How each stage ran/);
    assert.match(priv.html, /12 of 12 model exchanges used.*1 of 6 files opened for this review/);
    assert.equal(priv.sarif.runs[0]?.results.length, 0, 'limited review progress is not a SARIF finding');

    const shared = await report('shareable');
    assert.equal((shared.document as any).reviews[0].evidence[0].reasonCode, 'sentinel.report.withheld.shareable');
    assert.doesNotMatch(shared.markdown, /Request text reaches SQL/);

    // The source removed: the same report from the retained ledger alone.
    rmSync(join(ws, 'src'), { recursive: true, force: true });
    assert.equal(existsSync(join(ws, 'src/query.ts')), false);
    const again = await report('private');
    assert.equal(again.json, priv.json);
    assert.equal(again.markdown, priv.markdown);
    assert.deepEqual(digests(again), digests(priv), 'all four brokered report formats regenerate from the same ledger');
  },
);

test('an unanswered brokered review names the configured model rather than its binding id', needsStore, async (t) => {
  const dir = scratch(t, 'sentinel-report-unanswered-');
  const ws = join(dir, 'workspace');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src/query.ts'), 'export const query = (id: string) => id;\n');
  const endpoint = await mockEndpoint(t, (_req, res) => json(res, 503, { error: 'unavailable' }));
  const env = { ...process.env, HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const cli = cliOver(ws, env);
  assert.equal((await cli('init')).status, 0);
  const settingsPath = join(ws, '.farsight/sentinel/settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const provider = structuredClone(trustedPolicy({ ollama: endpoint.origin }).settings.providers[0]);
  provider.models[0]!.id = 'luna';
  provider.models[0]!.model = 'gpt-6-luna';
  provider.models[0]!.capability.model = 'gpt-6-luna';
  provider.models[0]!.capability.revision = null;
  settings.mandatoryRules = [];
  settings.hostedReviewSecretScan = 'when-selected';
  settings.providers = [provider];
  settings.reviewModels = {
    stages: [{ stage: 'general', providerId: provider.id, modelId: 'luna' }],
    segments: [],
  };
  settings.grants[0].scope.effects = ['local-artifacts', 'paid-inference'];
  settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
  writeFileSync(settingsPath, JSON.stringify(settings));
  assert.equal((await cli('settings', 'adopt', '--confirm')).status, 0);
  assert.equal((await cli('rules', 'promote', 'builtin:foundation-preview', '--confirm')).status, 0);
  const planned = await cli('plan');
  assert.equal(planned.status, 0, JSON.stringify(planned.body));
  const runId = planned.body.facts.planId;
  const ran = await cli('run', runId, '--confirm', '--confirm-models');
  assert.equal(ran.body.facts.state, 'completed', JSON.stringify(ran.body));

  rmSync(join(ws, 'src'), { recursive: true, force: true });
  const sw = workspaceOf(ws, env);
  const store = await openStore(sw.storePath);
  try {
    const report = await fullReport({
      store,
      runId,
      workspace: ws,
      trustDir: sw.trustDir,
      disclosure: 'private',
      now: new Date('2026-10-28T09:00:00Z'),
    });
    const agent = report.document.provenance?.find((p) => p.kind === 'agent');
    assert.ok(agent && agent.kind === 'agent');
    assert.equal(agent.model.requested, 'gpt-6-luna');
    assert.equal(agent.model.reported, null);
    assert.match(report.markdown.replace(/\\(.)/g, '$1'), /model gpt-6-luna/);
    assert.match(report.html, /model gpt-6-luna/);
    assert.doesNotMatch(report.markdown, /model luna(?:\s|[·.])/);
  } finally {
    store.close();
  }
});
