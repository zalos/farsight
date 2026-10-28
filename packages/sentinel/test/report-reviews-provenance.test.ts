// Model observations and stage provenance in the report (Sentinel v2 P-6): a cited class beside the findings, never a
// finding and never coverage, and one provenance record per published attempt. A report without either keeps its
// bytes: the retained-report fixture below was recorded before these sections existed, and the same inputs still
// give the same document, renderings and digests.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalJson } from '@farsight/graph';
import { generateReport } from '../dist/reports/index.js';
import { validateEnvelope } from '../dist/validate.js';
import { needsStore } from './snapshot-helpers.ts';
import { invoiceApp } from './pipeline-golden-helpers.ts';

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
